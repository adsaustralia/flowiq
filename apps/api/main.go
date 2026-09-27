package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/joho/godotenv"
)

type contextKey string

const authUserKey contextKey = "authUser"
const activeUsersWindow = 1 * time.Minute
const printIQLogRetention = 30 * 24 * time.Hour
const printIQLogPrefix = "printiq-submissions-"
const printIQLogSuffix = ".log"

type app struct {
	authStore        *authStore
	campaignStore    *campaignStore
	mappingStore     *mappingStore
	calculator       *calculatorService
	optionService    *optionService
	jwtSecret        []byte
	jwtExpiry        time.Duration
	logDir           string
	uploadDir        string
	campaignImageDir string
	printIQBaseURL   string
	objectStorage    *campaignObjectStorage
	oneDriveImports  *oneDriveImportStore
	oneDriveWorkerID string
}

type authClaims struct {
	Role     string  `json:"role"`
	TenantID *string `json:"tenantId"`
	Email    string  `json:"email"`
	Name     string  `json:"name"`
	jwt.RegisteredClaims
}

func main() {
	loadEnvFiles()

	if len(os.Args) > 1 {
		runCLI(os.Args[1:])
		return
	}

	ctx := context.Background()
	pool, err := connectDatabase(ctx)
	if err != nil {
		log.Fatalf("database init failed: %v", err)
	}
	defer pool.Close()

	if err := runMigrations(ctx, pool); err != nil {
		log.Fatalf("database migration failed: %v", err)
	}

	baseDir := "."
	mappingStore := newMappingStore(pool)
	jwtSecret := []byte(envOrDefault("JWT_SECRET", "flowiq-dev-secret"))
	api := &app{
		authStore:        newAuthStore(pool),
		campaignStore:    newCampaignStore(pool),
		mappingStore:     mappingStore,
		calculator:       newCalculatorService(mappingStore),
		optionService:    newOptionService(envOrDefault("PRINTIQ_BASE_URL", "https://adsaust.printiq.com"), filepath.Join(baseDir, "storage", "data")),
		jwtSecret:        jwtSecret,
		jwtExpiry:        parseDurationOrDefault(envOrDefault("JWT_EXPIRES_IN", "8h"), 8*time.Hour),
		logDir:           filepath.Join(baseDir, "storage", "logs"),
		uploadDir:        filepath.Join(baseDir, "storage", "uploads", "purchase-orders"),
		campaignImageDir: filepath.Join(baseDir, "storage", "uploads", "campaign-images"),
		printIQBaseURL:   envOrDefault("PRINTIQ_BASE_URL", "https://adsaust.printiq.com"),
		oneDriveImports:  newOneDriveImportStore(pool),
		oneDriveWorkerID: uuid.NewString(),
	}

	if err := os.MkdirAll(api.logDir, 0o755); err != nil {
		log.Fatalf("failed to create log directory: %v", err)
	}
	if err := os.MkdirAll(api.uploadDir, 0o755); err != nil {
		log.Fatalf("failed to create upload directory: %v", err)
	}
	if err := os.MkdirAll(api.campaignImageDir, 0o755); err != nil {
		log.Fatalf("failed to create campaign image directory: %v", err)
	}
	if err := api.initCampaignObjectStorage(ctx); err != nil {
		log.Fatalf("failed to initialize campaign object storage: %v", err)
	}
	go api.runOneDriveImportWorker(ctx)
	go api.runLogRetentionWorker(ctx)

	address := fmt.Sprintf(":%s", envOrDefault("PORT", "4000"))
	log.Printf("FlowIQ API listening on http://localhost%s", address)
	if err := http.ListenAndServe(address, api.withCORS(api.routes())); err != nil {
		log.Fatal(err)
	}
}

func runCLI(args []string) {
	if len(args) == 0 {
		log.Fatal("missing command")
	}

	ctx := context.Background()
	pool, err := connectDatabase(ctx)
	if err != nil {
		log.Fatalf("database init failed: %v", err)
	}
	defer pool.Close()

	switch args[0] {
	case "migrate":
		if err := runMigrations(ctx, pool); err != nil {
			log.Fatalf("database migration failed: %v", err)
		}
		log.Println("Database migrations applied successfully")
	case "seed":
		if err := runMigrations(ctx, pool); err != nil {
			log.Fatalf("database migration failed: %v", err)
		}
		if err := seedDatabase(ctx, pool); err != nil {
			log.Fatalf("database seed failed: %v", err)
		}
		log.Println("Database seed completed successfully")
	case "backfill-maintenance-relations":
		if err := runMigrations(ctx, pool); err != nil {
			log.Fatalf("database migration failed: %v", err)
		}
		updatedRows, err := backfillMaintenanceRelations(ctx, pool)
		if err != nil {
			log.Fatalf("maintenance relation backfill failed: %v", err)
		}
		log.Printf("Maintenance relation backfill completed successfully (%d rows updated)", updatedRows)
	case "backfill-custom-sheet-product-mappings":
		if err := runMigrations(ctx, pool); err != nil {
			log.Fatalf("database migration failed: %v", err)
		}
		insertedRows, err := backfillCustomSheetProductMappings(ctx, pool)
		if err != nil {
			log.Fatalf("custom sheet product mapping backfill failed: %v", err)
		}
		log.Printf("Custom sheet product mapping backfill completed successfully (%d rows inserted)", insertedRows)
	default:
		log.Fatalf("unsupported command: %s", args[0])
	}
}

func loadEnvFiles() {
	_ = godotenv.Load()
	_ = godotenv.Overload(".env")
	_ = godotenv.Overload(filepath.Join("..", "..", ".env"))
	if repoRoot := resolvePrimaryRepoRoot(filepath.Join("..", "..", ".git")); repoRoot != "" {
		_ = godotenv.Overload(filepath.Join(repoRoot, ".env"))
	}
}

func resolvePrimaryRepoRoot(gitPointerPath string) string {
	content, err := os.ReadFile(gitPointerPath)
	if err != nil {
		return ""
	}

	line := strings.TrimSpace(string(content))
	if !strings.HasPrefix(strings.ToLower(line), "gitdir:") {
		return ""
	}

	gitDirValue := strings.TrimSpace(line[len("gitdir:"):])
	if gitDirValue == "" {
		return ""
	}

	if !filepath.IsAbs(gitDirValue) {
		gitDirValue = filepath.Join(filepath.Dir(gitPointerPath), gitDirValue)
	}

	gitDir := filepath.Clean(gitDirValue)
	worktreesSegment := string(filepath.Separator) + ".git" + string(filepath.Separator) + "worktrees" + string(filepath.Separator)
	if strings.Contains(gitDir, worktreesSegment) {
		return filepath.Dir(filepath.Dir(filepath.Dir(gitDir)))
	}

	if strings.EqualFold(filepath.Base(gitDir), ".git") {
		return filepath.Dir(gitDir)
	}

	return ""
}

func envOrDefault(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func requiredEnv(key string) (string, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return "", fmt.Errorf("Missing required environment variable: %s", key)
	}
	return value, nil
}

func parseDurationOrDefault(value string, fallback time.Duration) time.Duration {
	duration, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return duration
}

func stringPtr(value string) *string {
	return &value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	a.registerOrderRoutes(mux)

	mux.HandleFunc("GET /api/health", a.handleHealth)
	mux.HandleFunc("POST /api/auth/login", a.handleLogin)
	mux.HandleFunc("POST /api/auth/change-password", a.handleChangePassword)
	mux.HandleFunc("POST /api/auth/password-reset/request", a.handleRequestPasswordReset)
	mux.HandleFunc("POST /api/auth/password-reset/confirm", a.handleConfirmPasswordReset)
	mux.Handle("GET /api/auth/me", a.withAuth(http.HandlerFunc(a.handleCurrentSession)))
	mux.Handle("POST /api/auth/logout", a.withAuth(http.HandlerFunc(a.handleLogout)))
	mux.Handle("GET /api/auth/active-users", a.withAuth(http.HandlerFunc(a.handleActiveUsersCount)))
	mux.Handle("GET /api/campaigns", a.withAuth(http.HandlerFunc(a.handleListCampaigns)))
	mux.Handle("POST /api/campaigns", a.withAuth(http.HandlerFunc(a.handleCreateCampaign)))
	mux.Handle("POST /api/campaigns/{campaignId}/sub-campaigns", a.withAuth(http.HandlerFunc(a.handleCreateSubCampaign)))
	mux.Handle("POST /api/campaigns/{campaignId}/clone", a.withAuth(http.HandlerFunc(a.handleCloneCampaign)))
	mux.Handle("GET /api/campaigns/{campaignId}", a.withAuth(http.HandlerFunc(a.handleGetCampaign)))
	mux.Handle("POST /api/campaigns/{campaignId}/edit-lock", a.withAuth(http.HandlerFunc(a.handleAcquireCampaignEditLock)))
	mux.Handle("DELETE /api/campaigns/{campaignId}/edit-lock", a.withAuth(http.HandlerFunc(a.handleReleaseCampaignEditLock)))
	mux.Handle("PUT /api/campaigns/{campaignId}", a.withAuth(http.HandlerFunc(a.handleUpdateCampaign)))
	mux.Handle("POST /api/campaigns/{campaignId}/print-images", a.withAuth(http.HandlerFunc(a.handleAppendCampaignPrintImages)))
	mux.Handle("POST /api/campaigns/{campaignId}/supporting-documents", a.withAuth(http.HandlerFunc(a.handleAppendCampaignSupportingDocuments)))
	mux.Handle("DELETE /api/campaigns/{campaignId}", a.withAuth(http.HandlerFunc(a.handleDeleteCampaign)))
	mux.Handle("POST /api/campaigns/{campaignId}/calculate", a.withAuth(http.HandlerFunc(a.handleCalculatePersistedCampaign)))
	mux.Handle("POST /api/campaigns/{campaignId}/submit-to-printiq", a.withAuth(http.HandlerFunc(a.handleSubmitCampaign)))
	mux.Handle("GET /api/campaigns/{campaignId}/submission-progress", a.withAuth(http.HandlerFunc(a.handleSubmissionProgress)))
	mux.Handle("GET /api/campaigns/{campaignId}/printiq-progress", a.withAuth(a.requireRoles(http.HandlerFunc(a.handlePrintIQProgress), "super_admin")))
	mux.Handle("POST /api/campaigns/{campaignId}/printiq-progress/resolve-upload", a.withAuth(a.requireRoles(http.HandlerFunc(a.handlePrintIQProgress), "super_admin")))
	mux.Handle("POST /api/campaigns/{campaignId}/mark-submitted", a.withAuth(http.HandlerFunc(a.handleMarkCampaignSubmitted)))
	mux.Handle("POST /api/campaigns/{campaignId}/reset-status", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleResetCampaignStatus), "super_admin")))
	mux.Handle("GET /api/campaigns/{campaignId}/purchase-order/download", a.withAuth(a.requireRoles(http.HandlerFunc(a.handlePurchaseOrderDownload), "super_admin")))
	mux.Handle("GET /api/market-delivery-addresses", a.withAuth(http.HandlerFunc(a.handleListCampaignMarketDeliveryAddresses)))
	mux.Handle("PUT /api/market-delivery-addresses", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleUpsertCampaignMarketDeliveryAddress), "super_admin", "admin")))
	mux.Handle("GET /api/market-shipping-rates", a.withAuth(http.HandlerFunc(a.handleListCampaignMarketShippingRates)))
	mux.Handle("GET /api/market-asset-shipping-costs", a.withAuth(http.HandlerFunc(a.handleListCampaignMarketAssetShippingCosts)))
	mux.Handle("GET /api/market-asset-printing-costs", a.withAuth(http.HandlerFunc(a.handleListCampaignMarketAssetPrintingCosts)))
	mux.Handle("GET /api/custom-print-costs", a.withAuth(http.HandlerFunc(a.handleListCampaignCustomPrintCosts)))
	mux.Handle("GET /api/materials", a.withAuth(http.HandlerFunc(a.handleListCampaignMaterials)))
	mux.Handle("GET /api/material-mappings", a.withAuth(http.HandlerFunc(a.handleListCampaignMaterialMappings)))
	mux.Handle("GET /api/sheet-name-overrides", a.withAuth(http.HandlerFunc(a.handleGetCampaignSheetNameOverrides)))
	mux.Handle("GET /api/calculator/metadata", a.withAuth(http.HandlerFunc(a.handleCalculatorMetadata)))
	mux.Handle("POST /api/calculator/calculate", a.withAuth(http.HandlerFunc(a.handleCalculateCampaign)))
	mux.Handle("GET /api/printiq/options/stocks", a.withAuth(http.HandlerFunc(a.handleSearchStocks)))
	mux.Handle("GET /api/printiq/options/processes", a.withAuth(http.HandlerFunc(a.handleSearchProcesses)))
	mux.Handle("GET /api/printiq/token", a.withAuth(http.HandlerFunc(a.handlePrintIQToken)))
	mux.Handle("POST /api/purchase-orders/upload", a.withAuth(http.HandlerFunc(a.handlePurchaseOrderUpload)))
	mux.Handle("GET /api/purchase-orders/{storedName}/download", http.HandlerFunc(a.handlePurchaseOrderPublicDownload))
	mux.Handle("POST /api/finalize/send-email-to-ads", a.withAuth(http.HandlerFunc(a.handleSendEmailToADS)))
	mux.Handle("POST /api/campaign-images/upload", a.withAuth(http.HandlerFunc(a.handleCampaignImageUpload)))
	mux.Handle("POST /api/campaign-image-uploads/init", a.withAuth(http.HandlerFunc(a.handleResumableCampaignImageInit)))
	mux.Handle("GET /api/campaign-image-uploads/{uploadId}", a.withAuth(http.HandlerFunc(a.handleResumableCampaignImageStatus)))
	mux.Handle("PUT /api/campaign-image-uploads/{uploadId}/chunks/{chunkIndex}", a.withAuth(http.HandlerFunc(a.handleResumableCampaignImageChunk)))
	mux.Handle("POST /api/campaign-image-uploads/{uploadId}/complete", a.withAuth(http.HandlerFunc(a.handleResumableCampaignImageComplete)))
	mux.Handle("POST /api/onedrive-artwork-imports", a.withAuth(http.HandlerFunc(a.handleCreateOneDriveArtworkImport)))
	mux.Handle("GET /api/onedrive-artwork-imports", a.withAuth(http.HandlerFunc(a.handleListOneDriveArtworkImports)))
	mux.Handle("GET /api/onedrive-artwork-imports/{importId}", a.withAuth(http.HandlerFunc(a.handleGetOneDriveArtworkImport)))
	mux.Handle("GET /api/onedrive/config", a.withAuth(http.HandlerFunc(a.handleOneDriveConfig)))
	mux.Handle("DELETE /api/campaign-images/{storedName}", a.withAuth(http.HandlerFunc(a.handleCampaignImageDelete)))
	mux.Handle("GET /api/campaign-images/{storedName}", http.HandlerFunc(a.handleCampaignImageGet))
	mux.Handle("GET /api/campaign-images/{storedName}/download", http.HandlerFunc(a.handleCampaignImageDownload))
	mux.Handle("GET /api/campaign-images/{storedName}/meta", http.HandlerFunc(a.handleCampaignImageMeta))
	mux.Handle("GET /api/campaign-images/{storedName}/chunk", http.HandlerFunc(a.handleCampaignImageChunk))
	mux.Handle("GET /uploads/", http.StripPrefix("/uploads/", http.FileServer(http.Dir(filepath.Join(".", "storage", "uploads")))))
	mux.Handle("GET /api/admin/tenants", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleListTenants), "super_admin")))
	mux.Handle("GET /api/tenant", a.withAuth(http.HandlerFunc(a.handleGetTenant)))
	mux.Handle("POST /api/admin/tenants", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleCreateTenant), "super_admin")))
	mux.Handle("PATCH /api/admin/tenants/{tenantId}", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleUpdateTenant), "super_admin")))
	mux.Handle("DELETE /api/admin/tenants/{tenantId}", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleDeleteTenant), "super_admin")))
	mux.Handle("GET /api/admin/users", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleListUsers), "super_admin", "admin")))
	mux.Handle("POST /api/admin/users", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleCreateUser), "super_admin", "admin")))
	mux.Handle("PATCH /api/admin/users/{userId}", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleUpdateUser), "super_admin", "admin")))
	mux.Handle("DELETE /api/admin/users/{userId}", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleDeleteUser), "super_admin", "admin")))
	mux.Handle("GET /api/admin/calculator-mappings", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleListCalculatorMappings), "super_admin", "admin")))
	mux.Handle("POST /api/admin/calculator-mappings", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleCreateCalculatorMapping), "super_admin")))
	mux.Handle("PATCH /api/admin/calculator-mappings/{mappingId}", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleUpdateCalculatorMapping), "super_admin")))
	mux.Handle("DELETE /api/admin/calculator-mappings/{mappingId}", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleDeleteCalculatorMapping), "super_admin")))
	mux.Handle("POST /api/admin/calculator-mappings/import", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleImportCalculatorMappings), "super_admin")))
	mux.Handle("GET /api/admin/market-delivery-addresses", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleListMarketDeliveryAddresses), "super_admin", "admin")))
	mux.Handle("PUT /api/admin/market-delivery-addresses", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleUpsertMarketDeliveryAddress), "super_admin", "admin")))
	mux.Handle("DELETE /api/admin/market-delivery-addresses", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleDeleteMarketDeliveryAddress), "super_admin", "admin")))
	mux.Handle("GET /api/admin/market-shipping-rates", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleListMarketShippingRates), "super_admin")))
	mux.Handle("PUT /api/admin/market-shipping-rates", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleUpsertMarketShippingRate), "super_admin")))
	mux.Handle("GET /api/admin/market-asset-shipping-costs", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleListMarketAssetShippingCosts), "super_admin")))
	mux.Handle("PUT /api/admin/market-asset-shipping-costs", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleUpsertMarketAssetShippingCosts), "super_admin")))
	mux.Handle("GET /api/admin/market-printing-costs", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleListMarketPrintingCosts), "super_admin")))
	mux.Handle("PUT /api/admin/market-printing-costs", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleUpsertMarketPrintingCosts), "super_admin")))
	mux.Handle("GET /api/admin/market-asset-printing-costs", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleListMarketAssetPrintingCosts), "super_admin")))
	mux.Handle("PUT /api/admin/market-asset-printing-costs", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleUpsertMarketAssetPrintingCosts), "super_admin")))
	mux.Handle("GET /api/admin/custom-print-costs", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleListCustomPrintCosts), "super_admin")))
	mux.Handle("PUT /api/admin/custom-print-costs", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleUpsertCustomPrintCosts), "super_admin")))
	mux.Handle("GET /api/admin/market-sheet-sizes", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleListMarketSheetSizes), "super_admin", "admin")))
	mux.Handle("PUT /api/admin/market-sheet-sizes", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleUpsertMarketSheetSizes), "super_admin", "admin")))
	mux.Handle("GET /api/admin/sheet-name-overrides", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleGetSheetNameOverrides), "super_admin", "admin")))
	mux.Handle("PUT /api/admin/sheet-name-overrides", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleUpsertSheetNameOverrides), "super_admin", "admin")))
	mux.Handle("GET /api/admin/material-mappings", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleListMaterialMappings), "super_admin")))
	mux.Handle("PUT /api/admin/material-mappings", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleUpsertMaterialMappings), "super_admin")))
	mux.Handle("GET /api/admin/materials", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleListMaterials), "super_admin", "admin")))
	mux.Handle("PUT /api/admin/materials", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleReplaceMaterials), "super_admin", "admin")))
	mux.Handle("GET /api/admin/printiq-options/status", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleOptionsStatus), "super_admin")))
	mux.Handle("POST /api/admin/printiq-options/refresh", a.withAuth(a.requireRoles(http.HandlerFunc(a.handleRefreshOptions), "super_admin")))

	return mux
}

func (a *app) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *app) signAuthToken(user AuthUser) (string, error) {
	claims := authClaims{
		Role:     user.Role,
		TenantID: user.TenantID,
		Email:    user.Email,
		Name:     user.Name,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   user.ID,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(a.jwtExpiry)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(a.jwtSecret)
}

func (a *app) withAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Authentication required"})
			return
		}

		tokenString := strings.TrimPrefix(header, "Bearer ")
		token, err := jwt.ParseWithClaims(tokenString, &authClaims{}, func(token *jwt.Token) (any, error) {
			return a.jwtSecret, nil
		})
		if err != nil || !token.Valid {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid or expired token"})
			return
		}

		claims, ok := token.Claims.(*authClaims)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid or expired token"})
			return
		}

		user, err := a.authStore.userByID(r.Context(), claims.Subject)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if user == nil || !user.Active {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Session is no longer valid"})
			return
		}
		if err := a.authStore.touchPresence(r.Context(), *user); err != nil {
			log.Printf("touch presence failed for user %s: %v", user.ID, err)
		}

		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), authUserKey, *user)))
	})
}

func (a *app) requireRoles(next http.Handler, roles ...string) http.Handler {
	allowed := map[string]bool{}
	for _, role := range roles {
		allowed[role] = true
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := currentUser(r.Context())
		if user == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Authentication required"})
			return
		}
		if !allowed[user.Role] {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "You do not have permission to perform this action"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func currentUser(ctx context.Context) *AuthUser {
	authUser, ok := ctx.Value(authUserKey).(AuthUser)
	if !ok {
		return nil
	}
	return &authUser
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func decodeJSONBody(r *http.Request, target any) error {
	defer r.Body.Close()
	return json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(target)
}

func (a *app) appendPrintIQLog(entry any) {
	bytes, err := json.Marshal(entry)
	if err != nil {
		return
	}
	file, err := os.OpenFile(a.printIQLogPath(time.Now()), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.Write(append(bytes, '\n'))
}

func (a *app) printIQLogPath(now time.Time) string {
	return filepath.Join(a.logDir, printIQLogPrefix+now.UTC().Format("2006-01-02")+printIQLogSuffix)
}

func (a *app) runLogRetentionWorker(ctx context.Context) {
	a.deleteOldPrintIQLogs()
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.deleteOldPrintIQLogs()
		}
	}
}

func (a *app) deleteOldPrintIQLogs() {
	entries, err := os.ReadDir(a.logDir)
	if err != nil {
		log.Printf("PrintIQ log retention failed: %v", err)
		return
	}
	cutoff := time.Now().Add(-printIQLogRetention)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, printIQLogPrefix) || !strings.HasSuffix(name, printIQLogSuffix) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(cutoff) {
			continue
		}
		if err := os.Remove(filepath.Join(a.logDir, name)); err != nil {
			log.Printf("PrintIQ log retention delete failed for %s: %v", name, err)
		}
	}
}

func createRequestID() string {
	return fmt.Sprintf("%d-%d", time.Now().UnixMilli(), time.Now().UnixNano()%1_000_000)
}

func (a *app) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"printIqBaseUrl": a.printIQBaseURL,
	})
}

func (a *app) handleLogin(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	user, err := a.authStore.authenticate(payload.Email, payload.Password)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid email or password"})
		return
	}

	token, err := a.signAuthToken(*user)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": user})
}

func (a *app) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Email       string `json:"email"`
		OldPassword string `json:"oldPassword"`
		NewPassword string `json:"newPassword"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}
	if len(strings.TrimSpace(payload.NewPassword)) < 8 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "New password must be at least 8 characters"})
		return
	}
	if err := a.authStore.changePasswordWithCredentials(r.Context(), payload.Email, payload.OldPassword, payload.NewPassword); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "Your password has been changed. You can sign in now."})
}

func (a *app) handleCurrentSession(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, currentUser(r.Context()))
}

func (a *app) handleLogout(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r.Context())
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Authentication required"})
		return
	}

	if err := a.authStore.clearPresence(r.Context(), user.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"loggedOut": true})
}

func (a *app) handleActiveUsersCount(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r.Context())
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Authentication required"})
		return
	}

	count, err := a.authStore.countRecentlyActiveUsers(r.Context(), user.TenantID, activeUsersWindow)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"activeUsers":   count,
		"windowMinutes": int(activeUsersWindow / time.Minute),
	})
}

func (a *app) writeCampaignLockError(w http.ResponseWriter, err error) bool {
	var lockErr *campaignLockedError
	if errors.As(err, &lockErr) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": lockErr.Error()})
		return true
	}
	return false
}

func campaignMutationErrorStatus(err error) int {
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "not found") {
		return http.StatusNotFound
	}
	if strings.Contains(message, "submitted") {
		return http.StatusConflict
	}
	return http.StatusBadRequest
}

func (a *app) handleAcquireCampaignEditLock(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}
	lock, err := a.campaignStore.acquireCampaignEditLock(r.Context(), *user, r.PathValue("campaignId"))
	if err != nil {
		if a.writeCampaignLockError(w, err) {
			return
		}
		writeJSON(w, campaignMutationErrorStatus(err), map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"lock": map[string]any{
			"campaignId": lock.CampaignID,
			"userId":     lock.UserID,
			"userName":   normalizeLockOwnerName(lock.UserName, lock.UserEmail),
			"expiresAt":  lock.ExpiresAt.UTC().Format(time.RFC3339),
		},
	})
}

func (a *app) handleReleaseCampaignEditLock(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}
	if err := a.campaignStore.releaseCampaignEditLock(r.Context(), *user, r.PathValue("campaignId")); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"released": true})
}

func (a *app) handleRequestPasswordReset(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Email string `json:"email"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	cfg, err := loadSMTPConfig()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Password reset email is not configured"})
		return
	}

	user, err := a.authStore.userByEmail(r.Context(), payload.Email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	if user != nil {
		token, err := a.authStore.createPasswordResetToken(r.Context(), user.ID, time.Now().Add(cfg.resetTokenTTL))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		resetURL := buildPasswordResetURL(cfg.appBaseURL, token)
		if err := sendPasswordResetEmail(cfg, user.Email, user.Name, resetURL); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to send password reset email"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{
			"message": "Password reset link has been sent",
		})
		return
	}

	requestedEmail := strings.TrimSpace(payload.Email)
	if requestedEmail == "" {
		requestedEmail = "that email address"
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"message": fmt.Sprintf("No account exists for %s.", requestedEmail),
	})
}

func (a *app) handleConfirmPasswordReset(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}
	if len(strings.TrimSpace(payload.Password)) < 8 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Password must be at least 8 characters"})
		return
	}
	if err := a.authStore.resetPasswordWithToken(r.Context(), payload.Token, payload.Password); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "Your password has been updated. You can sign in now."})
}

func (a *app) handleCreateCampaign(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}
	var payload struct {
		Values orderFormValues `json:"values"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	campaign, err := a.campaignStore.createCampaign(r.Context(), *user, payload.Values)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"campaign": campaign})
}

func (a *app) handleCreateSubCampaign(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}
	campaign, err := a.campaignStore.createSubCampaign(r.Context(), *user, r.PathValue("campaignId"))
	if err != nil {
		writeJSON(w, campaignMutationErrorStatus(err), map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"campaign": campaign})
}

func (a *app) handleCloneCampaign(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}

	sourceCampaign, err := a.campaignStore.getCampaign(r.Context(), *user, r.PathValue("campaignId"))
	if err != nil {
		writeJSON(w, campaignMutationErrorStatus(err), map[string]string{"error": err.Error()})
		return
	}

	values, purchaseOrder, err := a.cloneCampaignPayload(r.Context(), sourceCampaign)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	campaign, err := a.campaignStore.createCampaignClone(r.Context(), *user, sourceCampaign, values, purchaseOrder)
	if err != nil {
		writeJSON(w, campaignMutationErrorStatus(err), map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"campaign": campaign})
}

func (a *app) handleListCampaigns(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}
	campaigns, err := a.campaignStore.listCampaigns(r.Context(), *user)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaigns": campaigns})
}

func (a *app) handleGetCampaign(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}

	campaign, err := a.campaignStore.getCampaign(r.Context(), *user, r.PathValue("campaignId"))
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaign": campaign})
}

func (a *app) handleUpdateCampaign(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}
	if err := a.campaignStore.assertCampaignEditable(r.Context(), *user, r.PathValue("campaignId")); err != nil {
		if a.writeCampaignLockError(w, err) {
			return
		}
		writeJSON(w, campaignMutationErrorStatus(err), map[string]string{"error": err.Error()})
		return
	}

	var payload struct {
		Values orderFormValues `json:"values"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	campaign, err := a.campaignStore.updateCampaign(r.Context(), *user, r.PathValue("campaignId"), payload.Values)
	if err != nil {
		writeJSON(w, campaignMutationErrorStatus(err), map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaign": campaign})
}

func (a *app) handleAppendCampaignPrintImages(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}

	var payload struct {
		Images []campaignPrintImage `json:"images"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}
	if len(payload.Images) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "images is required"})
		return
	}

	campaign, err := a.campaignStore.appendCampaignPrintImages(r.Context(), *user, r.PathValue("campaignId"), payload.Images)
	if err != nil {
		writeJSON(w, campaignMutationErrorStatus(err), map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaign": campaign})
}

func (a *app) handleAppendCampaignSupportingDocuments(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}

	var payload struct {
		Documents []supportingDocument `json:"documents"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}
	if len(payload.Documents) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "documents is required"})
		return
	}

	campaign, err := a.campaignStore.appendCampaignSupportingDocuments(r.Context(), *user, r.PathValue("campaignId"), payload.Documents)
	if err != nil {
		writeJSON(w, campaignMutationErrorStatus(err), map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaign": campaign})
}

func (a *app) handleDeleteCampaign(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}
	campaign, err := a.campaignStore.getCampaign(r.Context(), *user, r.PathValue("campaignId"))
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}

	storedNames := collectCampaignImageStoredNames(campaign)
	err = a.campaignStore.deleteCampaign(r.Context(), *user, r.PathValue("campaignId"))
	if err != nil {
		writeJSON(w, campaignMutationErrorStatus(err), map[string]string{"error": err.Error()})
		return
	}

	if err := a.deleteCampaignStoredImages(r.Context(), storedNames); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Campaign deleted, but failed to clean up one or more campaign images"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (a *app) handleCalculatePersistedCampaign(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}
	if err := a.campaignStore.assertCampaignEditable(r.Context(), *user, r.PathValue("campaignId")); err != nil {
		if a.writeCampaignLockError(w, err) {
			return
		}
		writeJSON(w, campaignMutationErrorStatus(err), map[string]string{"error": err.Error()})
		return
	}

	campaign, summary, err := a.campaignStore.calculateCampaign(r.Context(), *user, r.PathValue("campaignId"), a.calculator)
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaign": campaign, "summary": summary})
}

func (a *app) handleCalculatorMetadata(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}

	markets, err := a.calculator.loadMarkets(*user.TenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"markets":    markets,
		"formatKeys": formatKeys,
	})
}

func (a *app) handleCalculateCampaign(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}

	var payload struct {
		CampaignLines []campaignLine `json:"campaignLines"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}
	summary, err := a.calculator.calculateCampaign(*user.TenantID, payload.CampaignLines)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (a *app) handleSearchStocks(w http.ResponseWriter, r *http.Request) {
	results, err := a.optionService.searchStockDefinitions(r.URL.Query().Get("q"))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, results)
}

func (a *app) handleSearchProcesses(w http.ResponseWriter, r *http.Request) {
	results, err := a.optionService.searchProcessTypes(r.URL.Query().Get("q"))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, results)
}

func (a *app) handlePrintIQToken(w http.ResponseWriter, _ *http.Request) {
	token, err := a.optionService.getLoginToken()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

func printIQResponseError(parsed any) (bool, string) {
	payloadMap, ok := parsed.(map[string]any)
	if !ok {
		return false, ""
	}
	isError, ok := payloadMap["IsError"].(bool)
	if !ok || !isError {
		return false, ""
	}
	message := "PrintIQ returned an error"
	if rawMessage, ok := payloadMap["ErrorMessage"].(string); ok && strings.TrimSpace(rawMessage) != "" {
		message = strings.TrimSpace(rawMessage)
	}
	return true, message
}

func printIQStepLabel(step string) string {
	switch step {
	case "CreateQuoteWithDelivery":
		return "create the PrintIQ quote"
	case "GetPrice":
		return "add one of the product lines to the PrintIQ quote"
	case "GetQuoteQuestions":
		return "retrieve PrintIQ quote questions"
	case "SaveQuoteQuestions":
		return "set the PrintIQ proof contact"
	case "AcceptQuote":
		return "accept the PrintIQ quote and create jobs"
	case "UploadArtworkURL":
		return "upload artwork to the PrintIQ job"
	default:
		return "submit the order to PrintIQ"
	}
}

func printIQStepFailureMessage(step string, status int, parsed any, err error) string {
	if err != nil {
		return fmt.Sprintf("Unable to %s. %s", printIQStepLabel(step), err.Error())
	}
	if isError, message := printIQResponseError(parsed); isError {
		return fmt.Sprintf("Unable to %s. PrintIQ said: %s", printIQStepLabel(step), message)
	}
	if status == http.StatusBadGateway {
		return fmt.Sprintf("Unable to %s. PrintIQ returned a bad gateway response. Check with ADS before retrying.", printIQStepLabel(step))
	}
	if status >= 500 {
		return fmt.Sprintf("Unable to %s. PrintIQ returned status %d. Check with ADS before retrying.", printIQStepLabel(step), status)
	}
	return fmt.Sprintf("Unable to %s. PrintIQ returned status %d.", printIQStepLabel(step), status)
}

func printIQProductFailureDetails(message string, payload any, products []printIQSheetProduct) string {
	details := []string{}
	if len(products) > 0 {
		if market := strings.TrimSpace(products[0].Market); market != "" {
			details = append(details, "market "+market)
		}
		if sheet := strings.TrimSpace(products[0].FormatKey); sheet != "" {
			details = append(details, "sheet type "+sheet)
		}
	}
	if code := printIQStringValue(valueAtPath(payload, "ProductCode")); code != "" {
		details = append(details, "ProductCode: "+code)
	}
	if len(details) == 0 {
		return message
	}
	return message + " (" + strings.Join(details, ", ") + ")"
}

func summarizePrintIQPayload(step string, payload any) map[string]any {
	summary := map[string]any{"step": step}
	payloadMap, ok := payload.(map[string]any)
	if !ok {
		return summary
	}
	copyStringField(summary, payloadMap, "QuoteNo")
	copyStringField(summary, payloadMap, "CustomerCode")
	copyStringField(summary, payloadMap, "ProductCode")
	copyStringField(summary, payloadMap, "JobTitle")
	copyStringField(summary, payloadMap, "Quantity")
	copyStringField(summary, payloadMap, "JobNo")
	copyStringField(summary, payloadMap, "OverrideFileName")
	copyStringField(summary, payloadMap, "QQDKey")
	copyNumberField(summary, payloadMap, "TargetQuoteFreightPrice")
	if step == "SaveQuoteQuestions" {
		if answers, ok := payloadMap["Answers"].([]map[string]any); ok {
			qqdpKeys := make([]string, 0, len(answers))
			for _, answer := range answers {
				if qqdpKey := printIQStringValue(answer["QQDPKey"]); qqdpKey != "" {
					qqdpKeys = append(qqdpKeys, qqdpKey)
				}
			}
			summary["answerCount"] = len(answers)
			if len(qqdpKeys) > 0 {
				summary["qqdpKeys"] = qqdpKeys
			}
		}
	}
	if step == "UploadArtworkURL" {
		copyStringField(summary, payloadMap, "ArtworkUrl")
		copyBoolField(summary, payloadMap, "IsSupportingDocument")
		copyBoolField(summary, payloadMap, "IsLastArtworkFile")
	} else if _, ok := payloadMap["ArtworkUrl"]; ok {
		summary["hasArtworkUrl"] = true
	}
	if _, ok := payloadMap["QSTKey"]; ok {
		summary["hasQSTKey"] = true
	}
	return summary
}

func summarizePrintIQResponse(step string, parsed any) map[string]any {
	summary := map[string]any{"step": step}
	if quoteNo := extractQuoteNo(parsed); quoteNo != "" {
		summary["quoteNo"] = quoteNo
	}
	if qqdKey := printIQStringValue(extractQQDKey(parsed)); qqdKey != "" {
		summary["qqdKey"] = qqdKey
	}
	if qqdpKey := printIQStringValue(extractQQDPKey(parsed)); qqdpKey != "" {
		summary["qqdpKey"] = qqdpKey
	}
	acceptedProducts := extractAcceptedProducts(parsed)
	if len(acceptedProducts) > 0 {
		jobNos := make([]string, 0, len(acceptedProducts))
		qstKeyCount := 0
		for _, product := range acceptedProducts {
			if product.JobNo != "" {
				jobNos = append(jobNos, product.JobNo)
			}
			if product.QSTKey != nil {
				qstKeyCount++
			}
		}
		summary["acceptedProductCount"] = len(acceptedProducts)
		if len(jobNos) > 0 {
			summary["jobNos"] = jobNos
		}
		if qstKeyCount > 0 {
			summary["qstKeyCount"] = qstKeyCount
		}
	}
	if isError, message := printIQResponseError(parsed); isError {
		summary["isError"] = true
		summary["errorMessage"] = message
	}
	if parsed == nil {
		summary["emptyResponse"] = true
	}
	return summary
}

func copyStringField(target map[string]any, source map[string]any, key string) {
	if value := printIQStringValue(source[key]); value != "" {
		target[key] = value
	}
}

func copyBoolField(target map[string]any, source map[string]any, key string) {
	if value, ok := source[key].(bool); ok {
		target[key] = value
	}
}

func copyNumberField(target map[string]any, source map[string]any, key string) {
	switch value := source[key].(type) {
	case float64:
		target[key] = value
	case float32:
		target[key] = value
	case int:
		target[key] = value
	case int64:
		target[key] = value
	case json.Number:
		target[key] = value
	}
}

func (a *app) runPrintIQSubmissionStep(
	requestID string,
	campaign *campaignRecord,
	user AuthUser,
	step string,
	payload any,
	call func(any) (any, int, error),
	products ...printIQSheetProduct,
) (any, *printIQSubmissionFailure) {
	a.appendPrintIQLog(map[string]any{
		"requestId":  requestID,
		"timestamp":  time.Now().UTC().Format(time.RFC3339),
		"type":       "request",
		"step":       step,
		"tenantId":   campaign.TenantID,
		"userId":     user.ID,
		"campaignId": campaign.ID,
		"payload":    summarizePrintIQPayload(step, payload),
	})

	parsed, status, err := call(payload)
	if err != nil {
		message := printIQProductFailureDetails(printIQStepFailureMessage(step, status, parsed, err), payload, products)
		a.appendPrintIQLog(map[string]any{
			"requestId":  requestID,
			"timestamp":  time.Now().UTC().Format(time.RFC3339),
			"type":       "error",
			"step":       step,
			"tenantId":   campaign.TenantID,
			"userId":     user.ID,
			"campaignId": campaign.ID,
			"message":    message,
			"status":     500,
		})
		return nil, &printIQSubmissionFailure{Status: http.StatusInternalServerError, Body: map[string]any{"error": message, "step": step, "requestId": requestID}}
	}
	if status < 200 || status >= 300 {
		message := printIQProductFailureDetails(printIQStepFailureMessage(step, status, parsed, nil), payload, products)
		a.appendPrintIQLog(map[string]any{
			"requestId":  requestID,
			"timestamp":  time.Now().UTC().Format(time.RFC3339),
			"type":       "error",
			"step":       step,
			"tenantId":   campaign.TenantID,
			"userId":     user.ID,
			"campaignId": campaign.ID,
			"message":    message,
			"response":   summarizePrintIQResponse(step, parsed),
			"status":     status,
		})
		return nil, &printIQSubmissionFailure{Status: status, Body: map[string]any{"error": message, "step": step, "requestId": requestID}}
	}
	if isError, message := printIQResponseError(parsed); isError {
		displayMessage := printIQProductFailureDetails(printIQStepFailureMessage(step, status, parsed, nil), payload, products)
		a.appendPrintIQLog(map[string]any{
			"requestId":  requestID,
			"timestamp":  time.Now().UTC().Format(time.RFC3339),
			"type":       "error",
			"step":       step,
			"tenantId":   campaign.TenantID,
			"userId":     user.ID,
			"campaignId": campaign.ID,
			"message":    displayMessage,
			"response":   summarizePrintIQResponse(step, parsed),
			"status":     status,
		})
		return nil, &printIQSubmissionFailure{Status: http.StatusBadRequest, Body: map[string]any{"error": displayMessage, "printIqMessage": message, "step": step, "requestId": requestID}}
	}

	a.appendPrintIQLog(map[string]any{
		"requestId":  requestID,
		"timestamp":  time.Now().UTC().Format(time.RFC3339),
		"type":       "response",
		"step":       step,
		"tenantId":   campaign.TenantID,
		"userId":     user.ID,
		"campaignId": campaign.ID,
		"response":   summarizePrintIQResponse(step, parsed),
		"status":     status,
	})
	return parsed, nil
}

func (a *app) handleSubmitCampaign(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}
	testSubmission := parseBoolQuery(r.URL.Query().Get("test"))
	if testSubmission && !strings.EqualFold(strings.TrimSpace(user.Role), "super_admin") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Test submit is available only for super admin"})
		return
	}

	campaignID := r.PathValue("campaignId")
	// Serialize submissions across tabs, users and API replicas.
	lockConn, err := a.campaignStore.pool.Acquire(r.Context())
	if err != nil {
		writeJSON(w, 503, map[string]string{"error": "Unable to lock submission"})
		return
	}
	defer lockConn.Release()
	var locked bool
	if err := lockConn.QueryRow(r.Context(), "SELECT pg_try_advisory_lock(hashtextextended($1, 0))", "printiq:"+campaignID).Scan(&locked); err != nil || !locked {
		writeJSON(w, 409, map[string]string{"error": "A submission for this campaign is already running"})
		return
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := lockConn.Exec(ctx, "SELECT pg_advisory_unlock(hashtextextended($1, 0))", "printiq:"+campaignID); err != nil {
			_ = lockConn.Conn().Close(ctx)
		}
	}()

	campaign, err := a.campaignStore.getCampaign(r.Context(), *user, campaignID)
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	isSubmittedCampaign := strings.EqualFold(strings.TrimSpace(campaign.Status), "submitted")
	if isSubmittedCampaign && !canResubmitSubmittedCampaign(*user) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "Campaign has already been submitted"})
		return
	}
	if !isSubmittedCampaign {
		if err := a.campaignStore.assertCampaignEditable(r.Context(), *user, campaignID); err != nil {
			if a.writeCampaignLockError(w, err) {
				return
			}
			writeJSON(w, campaignMutationErrorStatus(err), map[string]string{"error": err.Error()})
			return
		}
	}
	if strings.TrimSpace(campaign.Values.PurchaseOrderNumber) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Enter a purchase order number before submitting."})
		return
	}
	if campaign.PurchaseOrder == nil || strings.TrimSpace(campaign.PurchaseOrder.OriginalName) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Upload a purchase order file before submitting."})
		return
	}
	if campaign.Summary == nil {
		if isSubmittedCampaign {
			summary, err := a.calculator.calculateCampaign(campaign.TenantID, normalizeCampaignLines(campaign.Values))
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			campaign.Summary = &summary
			campaign.Values.Quantity = strconv.Itoa(summary.GrandTotal.TotalUnits)
		} else {
			campaign, _, err = a.campaignStore.calculateCampaign(r.Context(), *user, campaign.ID, a.calculator)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
		}
	}

	requestID := createRequestID()

	journal, err := a.loadPrintIQJournal(r.Context(), campaign)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "Unable to load submission progress"})
		return
	}
	if journal != nil && (journal.Fingerprint != campaignSubmissionFingerprint(campaign) || journal.Test != testSubmission) {
		writeJSON(w, 409, map[string]string{"error": "This campaign has an unfinished PrintIQ submission with different inputs. ADS must reconcile it before submitting changed data"})
		return
	}
	if journal == nil {
		if err := a.checkPrintIQHistory(r.Context(), campaign); err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		tenant, err := a.authStore.getTenant(campaign.TenantID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		sheetSettings, err := a.mappingStore.listSheetNameOverrides(r.Context(), campaign.TenantID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		materialProductMappings, err := a.mappingStore.listMaterialProductMappingsByMarket(r.Context(), campaign.TenantID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		shippingRates, err := a.mappingStore.listMarketShippingRates(r.Context(), campaign.TenantID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		assetShippingCosts, err := a.mappingStore.listMarketAssetShippingCosts(r.Context(), campaign.TenantID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		sheetProducts, err := resolvePrintIQSheetProducts(campaign.Values, campaign.Summary, materialProductMappings, sheetSettings.ProductCodes, sheetSettings.CustomSheetSizeFormats)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		creatorName, err := a.campaignStore.campaignCreatorDisplayName(r.Context(), campaign.ID, campaign.TenantID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to resolve campaign creator"})
			return
		}
		submissionValues := campaign.Values
		submissionValues.CreatedByDisplayName = creatorName
		plans, err := buildPrintIQMarketPlans(submissionValues, campaign.Summary, sheetProducts, shippingRates, assetShippingCosts, sheetSettings.CustomSheetSizeFormats, tenant.Code)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		visualsUpload, err := a.receivePrintIQVisuals(w, r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		purchaseOrderUpload, err := a.extractPurchaseOrderUpload(r.Context(), campaign.PurchaseOrder)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		// Resolve every attachment before creating any external quotes.
		artworkUploads := map[string]*printIQArtworkUpload{}
		for _, product := range sheetProducts {
			if _, exists := artworkUploads[product.ArtworkImageID]; exists {
				continue
			}
			artwork, err := a.extractCampaignArtworkUpload(r.Context(), campaign.Values, product.ArtworkImageID)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			artworkUploads[product.ArtworkImageID] = artwork
		}
		journal = &printIQJournal{Test: testSubmission, Creator: creatorName, Plans: plans, CustomerCode: tenant.Code, PurchaseOrder: purchaseOrderUpload, Visuals: visualsUpload, Artworks: artworkUploads}
		if err := a.createPrintIQJournal(r.Context(), campaign, journal); err != nil {
			writeJSON(w, 500, map[string]string{"error": "Unable to save submission progress"})
			return
		}
	}
	a.bindPrintIQJournal(r.Context(), journal)
	plans := journal.Plans

	submissions := make([]*printIQMarketSubmission, 0, len(plans))
	quoteNos := make([]string, 0, len(plans))
	jobNos := []string{}
	updatedCampaign := campaign
	for index, plan := range plans {
		submission, failure := a.submitPrintIQMarket(requestID, campaign, *user, plan, journal.CustomerCode, journal.PurchaseOrder, journal.Visuals, journal.Artworks, journal)
		if failure != nil {
			writePrintIQMarketFailure(w, failure, plan.Market, submissions, submission)
			return
		}
		// Persist each quote and its jobs separately. Only the final market completes the campaign.
		updatedCampaign, err = a.campaignStore.recordSubmission(r.Context(), *user, campaign.ID, submission.RequestPayload, submission.ResponsePayload, nil, submission.JobNos, !testSubmission && index == len(plans)-1, printIQRecordCheckpoint{ID: journal.ID, Market: plan.Market, Final: index == len(plans)-1})
		if err != nil {
			writePrintIQMarketFailure(w, &printIQSubmissionFailure{Status: http.StatusInternalServerError, Body: map[string]any{"error": "Unable to save the PrintIQ submission: " + err.Error()}}, plan.Market, submissions, submission)
			return
		}
		submissions = append(submissions, submission)
		quoteNos = append(quoteNos, submission.QuoteNo)
		jobNos = append(jobNos, submission.JobNos...)
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaign": updatedCampaign, "amount": nil, "quoteNo": quoteNos[0], "quoteNos": quoteNos, "marketQuotes": submissions, "jobNo": jobNos[0], "jobNos": jobNos, "test": testSubmission})
}

func (a *app) handleResetCampaignStatus(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r.Context())
	if user == nil || user.Role != "super_admin" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Only super admins can reset campaign status"})
		return
	}
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}
	campaign, err := a.campaignStore.resetCampaignStatus(r.Context(), *user, r.PathValue("campaignId"))
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errCampaignNotSubmitted) {
			status = http.StatusConflict
		} else if strings.Contains(strings.ToLower(err.Error()), "not found") {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaign": campaign})
}

func (a *app) handleMarkCampaignSubmitted(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}
	campaign, err := a.campaignStore.markCampaignSubmitted(r.Context(), *user, r.PathValue("campaignId"))
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaign": campaign})
}

func (a *app) handleListCampaignMarketDeliveryAddresses(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}

	records, err := a.mappingStore.listMarketDeliveryAddresses(r.Context(), *user.TenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"addresses": records})
}

func (a *app) handleUpsertCampaignMarketDeliveryAddress(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}

	var payload marketDeliveryAddressInput
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	record, err := a.mappingStore.upsertMarketDeliveryAddress(r.Context(), *user.TenantID, payload)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"address": record})
}

func (a *app) handleListCampaignMarketShippingRates(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}

	records, err := a.mappingStore.listMarketShippingRates(r.Context(), *user.TenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rates": records})
}

func (a *app) handleListCampaignMarketAssetPrintingCosts(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}

	records, err := a.mappingStore.listMarketAssetPrintingCosts(r.Context(), *user.TenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"costs": records})
}

func (a *app) handleListCampaignCustomPrintCosts(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}
	records, err := a.mappingStore.listCustomPrintCosts(r.Context(), *user.TenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"costs": records})
}

func (a *app) handleListCampaignMaterials(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}
	records, err := a.mappingStore.listMaterials(r.Context(), *user.TenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"materials": records})
}

func (a *app) handleListCampaignMaterialMappings(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}
	records, err := a.mappingStore.listMaterialMappings(r.Context(), *user.TenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mappings": records})
}

func (a *app) handleListCampaignMarketAssetShippingCosts(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}

	records, err := a.mappingStore.listMarketAssetShippingCosts(r.Context(), *user.TenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"costs": records})
}

func (a *app) handleGetCampaignSheetNameOverrides(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}

	record, err := a.mappingStore.listSheetNameOverrides(r.Context(), *user.TenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": record})
}

var unsafeFilenamePattern = regexp.MustCompile(`[^a-zA-Z0-9-_]`)

func (a *app) handlePurchaseOrderUpload(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r.Context())
	if err := r.ParseMultipartForm(25 << 20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "No file uploaded"})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "No file uploaded"})
		return
	}
	defer file.Close()

	extension := filepath.Ext(header.Filename)
	baseName := strings.TrimSuffix(header.Filename, extension)
	safeBaseName := unsafeFilenamePattern.ReplaceAllString(baseName, "_")
	safeBaseName = strings.TrimSpace(safeBaseName)
	if safeBaseName == "" {
		safeBaseName = "purchase-order"
	}
	if len(safeBaseName) > 64 {
		safeBaseName = safeBaseName[:64]
	}

	storedName := fmt.Sprintf("%d-%s%s", time.Now().UnixMilli(), safeBaseName, extension)
	targetPath := filepath.Join(a.uploadDir, storedName)
	out, err := os.Create(targetPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer out.Close()

	size, err := io.Copy(out, file)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	response := uploadResponse{
		OriginalName: header.Filename,
		StoredName:   storedName,
		Size:         size,
		MimeType:     header.Header.Get("Content-Type"),
		UploadedAt:   time.Now().UTC().Format(time.RFC3339),
	}

	if campaignID := strings.TrimSpace(r.FormValue("campaignId")); campaignID != "" && user != nil {
		effectiveUser, resolveErr := a.userWithManagedTenant(r)
		if resolveErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
			return
		}
		if err := a.campaignStore.assertCampaignEditable(r.Context(), *effectiveUser, campaignID); err != nil {
			if a.writeCampaignLockError(w, err) {
				return
			}
			writeJSON(w, campaignMutationErrorStatus(err), map[string]string{"error": err.Error()})
			return
		}
		if _, err := a.campaignStore.setPurchaseOrder(r.Context(), *effectiveUser, campaignID, response); err != nil {
			writeJSON(w, campaignMutationErrorStatus(err), map[string]string{"error": err.Error()})
			return
		}
	}

	writeJSON(w, http.StatusCreated, response)
}

func (a *app) handlePurchaseOrderDownload(w http.ResponseWriter, r *http.Request) {
	user, resolveErr := a.userWithManagedTenant(r)
	if resolveErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": resolveErr.Error()})
		return
	}
	campaign, err := a.campaignStore.getCampaign(r.Context(), *user, r.PathValue("campaignId"))
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	if campaign.PurchaseOrder == nil || strings.TrimSpace(campaign.PurchaseOrder.StoredName) == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Purchase order file not found"})
		return
	}

	storedName := strings.TrimSpace(campaign.PurchaseOrder.StoredName)
	if !isSafeStoredName(storedName) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Purchase order file not found"})
		return
	}

	targetPath := filepath.Join(a.uploadDir, storedName)
	info, err := os.Stat(targetPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Purchase order file not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to read purchase order file"})
		return
	}
	if info.IsDir() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Purchase order file not found"})
		return
	}

	file, err := os.Open(targetPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Purchase order file not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to read purchase order file"})
		return
	}
	defer file.Close()

	downloadName := strings.TrimSpace(campaign.PurchaseOrder.OriginalName)
	if downloadName == "" {
		downloadName = storedName
	}
	contentType := strings.TrimSpace(campaign.PurchaseOrder.MimeType)
	if contentType == "" {
		contentType = mime.TypeByExtension(strings.ToLower(filepath.Ext(downloadName)))
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	safeDownloadName := strings.NewReplacer("\\", "_", "/", "_", "\"", "'").Replace(downloadName)

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", safeDownloadName))
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)

	if _, err := io.Copy(w, file); err != nil {
		log.Printf("purchase order download failed for campaign %s: %v", campaign.ID, err)
	}
}

func (a *app) handlePurchaseOrderPublicDownload(w http.ResponseWriter, r *http.Request) {
	storedName := strings.TrimSpace(r.PathValue("storedName"))
	if !isSafeStoredName(storedName) {
		http.NotFound(w, r)
		return
	}

	targetPath := filepath.Join(a.uploadDir, storedName)
	info, err := os.Stat(targetPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to read purchase order file"})
		return
	}
	if info.IsDir() {
		http.NotFound(w, r)
		return
	}

	file, err := os.Open(targetPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to read purchase order file"})
		return
	}
	defer file.Close()

	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(storedName)))
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", storedName))
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("Accept-Ranges", "none")
	w.Header().Set("Cache-Control", "no-store, no-transform")
	w.WriteHeader(http.StatusOK)

	if _, err := io.Copy(w, file); err != nil {
		log.Printf("public purchase order download failed for %s: %v", storedName, err)
	}
}

func (a *app) handleCampaignImageUpload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(25 << 20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "No file uploaded"})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "No file uploaded"})
		return
	}
	defer file.Close()

	contentType := strings.TrimSpace(header.Header.Get("Content-Type"))
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	extension := filepath.Ext(header.Filename)
	baseName := strings.TrimSuffix(header.Filename, extension)
	safeBaseName := unsafeFilenamePattern.ReplaceAllString(baseName, "_")
	safeBaseName = strings.TrimSpace(safeBaseName)
	if safeBaseName == "" {
		safeBaseName = "campaign-artwork"
	}
	if len(safeBaseName) > 64 {
		safeBaseName = safeBaseName[:64]
	}

	storedName := fmt.Sprintf("%d-%s%s", time.Now().UnixMilli(), safeBaseName, extension)
	fileContents, err := io.ReadAll(file)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	size := int64(len(fileContents))
	if err := a.storeCampaignImage(r.Context(), storedName, contentType, fileContents); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	response := uploadResponse{
		OriginalName: header.Filename,
		StoredName:   storedName,
		Size:         size,
		MimeType:     contentType,
		UploadedAt:   time.Now().UTC().Format(time.RFC3339),
		URL:          "/api/campaign-images/" + storedName,
	}
	writeJSON(w, http.StatusCreated, response)
}

func (a *app) handleCampaignImageDelete(w http.ResponseWriter, r *http.Request) {
	storedName := strings.TrimSpace(r.PathValue("storedName"))
	if !isSafeStoredName(storedName) {
		http.NotFound(w, r)
		return
	}

	if err := a.deleteCampaignImage(r.Context(), storedName); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to delete campaign image"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (a *app) handleCampaignImageGet(w http.ResponseWriter, r *http.Request) {
	storedName := strings.TrimSpace(r.PathValue("storedName"))
	if !isSafeStoredName(storedName) {
		http.NotFound(w, r)
		return
	}
	if wantsCampaignImageProxy(r) {
		handled, err := a.streamCampaignImageFromObjectStorage(w, r, storedName, "", storedName)
		if handled {
			if err == nil {
				return
			}
			if errors.Is(err, os.ErrNotExist) {
				http.NotFound(w, r)
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to read campaign image"})
			return
		}
	}
	if signedURL, ok, err := a.campaignImageReadURL(r.Context(), storedName, ""); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to read campaign image"})
		return
	} else if ok {
		http.Redirect(w, r, signedURL, http.StatusTemporaryRedirect)
		return
	}

	targetPath, _, _, err := a.resolveCampaignImageFile(r)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to read campaign image"})
		return
	}
	http.ServeFile(w, r, targetPath)
}

func (a *app) handleCampaignImageDownload(w http.ResponseWriter, r *http.Request) {
	storedName := strings.TrimSpace(r.PathValue("storedName"))
	if !isSafeStoredName(storedName) {
		http.NotFound(w, r)
		return
	}

	requestedName := strings.TrimSpace(r.URL.Query().Get("filename"))
	if requestedName == "" {
		requestedName = storedName
	}
	safeName := strings.NewReplacer("\r", "", "\n", "", "\"", "'", "\\", "_").Replace(requestedName)
	if wantsCampaignImageProxy(r) {
		handled, err := a.streamCampaignImageFromObjectStorage(w, r, storedName, fmt.Sprintf("attachment; filename=\"%s\"", safeName), safeName)
		if handled {
			if err == nil {
				return
			}
			if errors.Is(err, os.ErrNotExist) {
				http.NotFound(w, r)
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to read campaign image"})
			return
		}
	}
	if signedURL, ok, err := a.campaignImageReadURL(r.Context(), storedName, fmt.Sprintf("attachment; filename=\"%s\"", safeName)); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to read campaign image"})
		return
	} else if ok {
		http.Redirect(w, r, signedURL, http.StatusTemporaryRedirect)
		return
	}

	targetPath, info, storedName, err := a.resolveCampaignImageFile(r)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to read campaign image"})
		return
	}

	file, err := os.Open(targetPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to read campaign image"})
		return
	}
	defer file.Close()

	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(safeName)))
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", safeName))
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("Accept-Ranges", "none")
	w.Header().Set("Cache-Control", "no-store, no-transform")
	w.WriteHeader(http.StatusOK)

	if _, err := io.Copy(w, file); err != nil {
		log.Printf("campaign image download failed for %s: %v", storedName, err)
	}
}

func (a *app) handleCampaignImageMeta(w http.ResponseWriter, r *http.Request) {
	_, info, storedName, err := a.resolveCampaignImageFile(r)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to read campaign image"})
		return
	}

	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(storedName)))
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"storedName":   storedName,
		"size":         info.Size(),
		"contentType":  contentType,
		"chunkMaxSize": 1024 * 1024,
	})
}

func (a *app) handleCampaignImageChunk(w http.ResponseWriter, r *http.Request) {
	targetPath, info, _, err := a.resolveCampaignImageFile(r)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to read campaign image"})
		return
	}

	offset, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("offset")), 10, 64)
	if err != nil || offset < 0 || offset >= info.Size() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid chunk offset"})
		return
	}

	length, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("length")), 10, 64)
	if err != nil || length <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid chunk length"})
		return
	}

	const maxChunkSize int64 = 1024 * 1024
	if length > maxChunkSize {
		length = maxChunkSize
	}

	remaining := info.Size() - offset
	if length > remaining {
		length = remaining
	}

	file, err := os.Open(targetPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Unable to read campaign image"})
		return
	}
	defer file.Close()

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	w.Header().Set("Cache-Control", "no-store, no-transform")
	w.Header().Set("Accept-Ranges", "none")
	w.Header().Set("X-File-Size", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("X-Chunk-Offset", strconv.FormatInt(offset, 10))
	w.Header().Set("X-Chunk-Length", strconv.FormatInt(length, 10))
	w.WriteHeader(http.StatusOK)

	reader := io.NewSectionReader(file, offset, length)
	if _, err := io.Copy(w, reader); err != nil {
		log.Printf("campaign image chunk download failed (%s offset=%d length=%d): %v", targetPath, offset, length, err)
	}
}

func (a *app) resolveCampaignImageFile(r *http.Request) (string, os.FileInfo, string, error) {
	storedName := strings.TrimSpace(r.PathValue("storedName"))
	if storedName == "" {
		return "", nil, "", os.ErrNotExist
	}

	if !isSafeStoredName(storedName) {
		return "", nil, "", os.ErrNotExist
	}

	targetPath := filepath.Join(a.campaignImageDir, storedName)
	info, err := os.Stat(targetPath)
	if err != nil {
		return "", nil, "", err
	}
	return targetPath, info, storedName, nil
}

func isSafeStoredName(storedName string) bool {
	return storedName != "" && filepath.Base(storedName) == storedName && !strings.Contains(storedName, "..")
}

func wantsCampaignImageProxy(r *http.Request) bool {
	value := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("proxy")))
	return value == "1" || value == "true" || value == "yes" || value == "on"
}

func (a *app) streamCampaignImageFromObjectStorage(
	w http.ResponseWriter,
	r *http.Request,
	storedName string,
	contentDisposition string,
	fileNameHint string,
) (bool, error) {
	if a.objectStorage == nil {
		return false, nil
	}

	result, err := a.objectStorage.client.GetObject(r.Context(), &s3.GetObjectInput{
		Bucket: aws.String(a.objectStorage.bucket),
		Key:    aws.String(storedName),
	})
	if err != nil {
		if isMissingObjectStorageObject(err) {
			return true, os.ErrNotExist
		}
		return true, fmt.Errorf("get DigitalOcean Spaces object: %w", err)
	}
	defer result.Body.Close()

	contentType := strings.TrimSpace(aws.ToString(result.ContentType))
	if contentType == "" {
		contentType = mime.TypeByExtension(strings.ToLower(filepath.Ext(fileNameHint)))
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store, no-transform")
	w.Header().Set("Accept-Ranges", "none")
	if contentDisposition != "" {
		w.Header().Set("Content-Disposition", contentDisposition)
	}
	if result.ContentLength != nil && *result.ContentLength > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(*result.ContentLength, 10))
	}
	w.WriteHeader(http.StatusOK)

	if _, err := io.Copy(w, result.Body); err != nil {
		log.Printf("campaign image object stream failed for %s: %v", storedName, err)
		return true, err
	}
	return true, nil
}

func cloneCampaignDisplayName(campaign *campaignRecord) string {
	sourceName := strings.TrimSpace(campaign.Values.CampaignName)
	if sourceName == "" {
		sourceName = "Untitled Campaign " + campaign.ID[:6]
	}
	if strings.HasPrefix(strings.ToLower(sourceName), "copy of ") {
		return sourceName
	}
	return "Copy of " + sourceName
}

func buildClonedStoredName(sourceStoredName string) string {
	extension := filepath.Ext(sourceStoredName)
	baseName := strings.TrimSuffix(filepath.Base(sourceStoredName), extension)
	safeBaseName := unsafeFilenamePattern.ReplaceAllString(baseName, "_")
	safeBaseName = strings.TrimSpace(safeBaseName)
	if safeBaseName == "" {
		safeBaseName = "campaign-upload"
	}
	if len(safeBaseName) > 56 {
		safeBaseName = safeBaseName[:56]
	}
	return fmt.Sprintf("%d-%s-%s%s", time.Now().UnixMilli(), uuid.NewString()[:8], safeBaseName, extension)
}

func (a *app) cloneCampaignImageObject(ctx context.Context, sourceStoredName, contentType string) (string, error) {
	sourceStoredName = strings.TrimSpace(sourceStoredName)
	if sourceStoredName == "" {
		return "", nil
	}
	if !isSafeStoredName(sourceStoredName) {
		return "", fmt.Errorf("Unable to clone unsafe campaign upload reference")
	}

	nextStoredName := buildClonedStoredName(sourceStoredName)
	if contentType = strings.TrimSpace(contentType); contentType == "" {
		contentType = mime.TypeByExtension(strings.ToLower(filepath.Ext(sourceStoredName)))
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	tempFile, err := os.CreateTemp("", "flowiq-clone-*"+filepath.Ext(sourceStoredName))
	if err != nil {
		return "", err
	}
	tempPath := tempFile.Name()
	tempFile.Close()
	defer os.Remove(tempPath)

	if err := a.copyCampaignImageToFile(ctx, sourceStoredName, tempPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("Unable to clone campaign because an uploaded file is missing")
		}
		return "", err
	}
	sourceFile, err := os.Open(tempPath)
	if err != nil {
		return "", err
	}
	defer sourceFile.Close()
	info, err := sourceFile.Stat()
	if err != nil {
		return "", err
	}
	if err := a.storeCampaignImageReader(ctx, nextStoredName, contentType, sourceFile, info.Size()); err != nil {
		return "", err
	}
	return nextStoredName, nil
}

func (a *app) cloneCampaignImageStoredName(ctx context.Context, sourceStoredName, contentType string, storedNameMap map[string]string) (string, error) {
	sourceStoredName = strings.TrimSpace(sourceStoredName)
	if sourceStoredName == "" {
		return "", nil
	}
	if clonedStoredName, exists := storedNameMap[sourceStoredName]; exists {
		return clonedStoredName, nil
	}
	clonedStoredName, err := a.cloneCampaignImageObject(ctx, sourceStoredName, contentType)
	if err != nil {
		return "", err
	}
	storedNameMap[sourceStoredName] = clonedStoredName
	return clonedStoredName, nil
}

func campaignImageURLForStoredName(storedName string) string {
	if strings.TrimSpace(storedName) == "" {
		return ""
	}
	return "/api/campaign-images/" + storedName
}

func remapCreativeImageID(value string, imageIDMap map[string]string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if nextValue, exists := imageIDMap[trimmed]; exists {
		return nextValue
	}
	return value
}

func remapCreativeImageIDs(values map[string]string, imageIDMap map[string]string) map[string]string {
	if values == nil {
		return nil
	}
	remapped := make(map[string]string, len(values))
	for key, value := range values {
		remapped[key] = remapCreativeImageID(value, imageIDMap)
	}
	return remapped
}

func remapCreativeNameAssignments(values map[string]string, imageIDMap map[string]string) map[string]string {
	if values == nil {
		return nil
	}
	remapped := make(map[string]string, len(values))
	for key, value := range values {
		nextKey := key
		if mappedKey, exists := imageIDMap[strings.TrimSpace(key)]; exists {
			nextKey = mappedKey
		}
		remapped[nextKey] = value
	}
	return remapped
}

func remapArtworkCodes(values map[string]string, imageIDMap map[string]string) map[string]string {
	if values == nil {
		return nil
	}
	remapped := make(map[string]string, len(values))
	for key, value := range values {
		nextKey := key
		if mappedKey, exists := imageIDMap[strings.TrimSpace(key)]; exists {
			nextKey = mappedKey
		}
		remapped[nextKey] = value
	}
	return remapped
}

func remapArtworkMaterialAssignments(values map[string][]artworkMaterialAssignment, imageIDMap map[string]string) map[string][]artworkMaterialAssignment {
	if values == nil {
		return nil
	}
	remapped := make(map[string][]artworkMaterialAssignment, len(values))
	for key, assignments := range values {
		remappedAssignments := append([]artworkMaterialAssignment(nil), assignments...)
		for index := range remappedAssignments {
			remappedAssignments[index].ArtworkImageID = remapCreativeImageID(remappedAssignments[index].ArtworkImageID, imageIDMap)
		}
		remapped[key] = remappedAssignments
	}
	return remapped
}

func (a *app) cloneCampaignPayload(ctx context.Context, source *campaignRecord) (orderFormValues, *purchaseOrderDetails, error) {
	values := cloneOrderFormValues(source.Values)
	values.CampaignName = cloneCampaignDisplayName(source)

	storedNameMap := map[string]string{}
	imageIDMap := map[string]string{}
	for index := range values.PrintImages {
		image := &values.PrintImages[index]
		sourceID := strings.TrimSpace(image.ID)
		image.ID = uuid.NewString()
		if sourceID != "" {
			imageIDMap[sourceID] = image.ID
		}

		storedName, err := a.cloneCampaignImageStoredName(ctx, image.StoredName, image.MimeType, storedNameMap)
		if err != nil {
			return orderFormValues{}, nil, err
		}
		image.StoredName = storedName
		image.ImageURL = campaignImageURLForStoredName(storedName)

		thumbnailStoredName, err := a.cloneCampaignImageStoredName(ctx, image.ThumbnailStoredName, "image/jpeg", storedNameMap)
		if err != nil {
			return orderFormValues{}, nil, err
		}
		image.ThumbnailStoredName = thumbnailStoredName
		image.ThumbnailURL = campaignImageURLForStoredName(thumbnailStoredName)

		previewStoredName, err := a.cloneCampaignImageStoredName(ctx, image.PreviewStoredName, "image/jpeg", storedNameMap)
		if err != nil {
			return orderFormValues{}, nil, err
		}
		image.PreviewStoredName = previewStoredName
		image.PreviewURL = campaignImageURLForStoredName(previewStoredName)

		sourcePDFStoredName, err := a.cloneCampaignImageStoredName(ctx, image.SourcePDFStoredName, "application/pdf", storedNameMap)
		if err != nil {
			return orderFormValues{}, nil, err
		}
		image.SourcePDFStoredName = sourcePDFStoredName
		image.SourcePDFURL = campaignImageURLForStoredName(sourcePDFStoredName)
	}

	for index := range values.SupportingDocuments {
		document := &values.SupportingDocuments[index]
		storedName, err := a.cloneCampaignImageStoredName(ctx, document.StoredName, document.MimeType, storedNameMap)
		if err != nil {
			return orderFormValues{}, nil, err
		}
		document.StoredName = storedName
		document.UploadedAt = time.Now().UTC().Format(time.RFC3339)
	}

	values.CreativeNameAssignments = remapCreativeNameAssignments(values.CreativeNameAssignments, imageIDMap)
	values.ArtworkCodes = remapArtworkCodes(values.ArtworkCodes, imageIDMap)
	for marketIndex := range values.CampaignMarkets {
		values.CampaignMarkets[marketIndex].ID = uuid.NewString()
		for assetIndex := range values.CampaignMarkets[marketIndex].Assets {
			asset := &values.CampaignMarkets[marketIndex].Assets[assetIndex]
			asset.ID = uuid.NewString()
			asset.CreativeImageID = remapCreativeImageID(asset.CreativeImageID, imageIDMap)
			asset.CreativeImageIDs = remapCreativeImageIDs(asset.CreativeImageIDs, imageIDMap)
			asset.ArtworkMaterialAssignments = remapArtworkMaterialAssignments(asset.ArtworkMaterialAssignments, imageIDMap)
		}
	}

	var purchaseOrder *purchaseOrderDetails
	if source.PurchaseOrder != nil && strings.TrimSpace(source.PurchaseOrder.StoredName) != "" {
		clonedPurchaseOrder, err := a.clonePurchaseOrder(source.PurchaseOrder)
		if err != nil {
			return orderFormValues{}, nil, err
		}
		purchaseOrder = clonedPurchaseOrder
	}

	return values, purchaseOrder, nil
}

func (a *app) clonePurchaseOrder(source *purchaseOrderDetails) (*purchaseOrderDetails, error) {
	sourceStoredName := strings.TrimSpace(source.StoredName)
	if !isSafeStoredName(sourceStoredName) {
		return nil, fmt.Errorf("Unable to clone unsafe purchase order reference")
	}

	nextStoredName := buildClonedStoredName(sourceStoredName)
	sourcePath := filepath.Join(a.uploadDir, sourceStoredName)
	targetPath := filepath.Join(a.uploadDir, nextStoredName)

	sourceFile, err := os.Open(sourcePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("Unable to clone campaign because the purchase order file is missing")
		}
		return nil, err
	}
	defer sourceFile.Close()

	targetFile, err := os.OpenFile(targetPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	defer targetFile.Close()
	size, err := io.Copy(targetFile, sourceFile)
	if err != nil {
		return nil, err
	}

	cloned := *source
	cloned.StoredName = nextStoredName
	cloned.Size = size
	cloned.UploadedAt = time.Now().UTC().Format(time.RFC3339)
	return &cloned, nil
}

func collectCampaignImageStoredNames(campaign *campaignRecord) []string {
	if campaign == nil {
		return nil
	}

	storedNameSet := map[string]struct{}{}
	for _, image := range campaign.Values.PrintImages {
		candidates := []string{
			strings.TrimSpace(image.StoredName),
			strings.TrimSpace(image.ThumbnailStoredName),
			strings.TrimSpace(image.PreviewStoredName),
			strings.TrimSpace(image.SourcePDFStoredName),
		}
		for _, candidate := range candidates {
			if candidate == "" || !isSafeStoredName(candidate) {
				continue
			}
			storedNameSet[candidate] = struct{}{}
		}
	}

	storedNames := make([]string, 0, len(storedNameSet))
	for storedName := range storedNameSet {
		storedNames = append(storedNames, storedName)
	}
	return storedNames
}

func (a *app) deleteCampaignStoredImages(ctx context.Context, storedNames []string) error {
	for _, storedName := range storedNames {
		if err := a.deleteCampaignImage(ctx, storedName); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (a *app) handleListTenants(w http.ResponseWriter, _ *http.Request) {
	tenants, err := a.authStore.listTenants()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tenants": tenants})
}

func (a *app) handleGetTenant(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	tenant, err := a.authStore.getTenant(*tenantID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tenant": tenant})
}

func (a *app) handleCreateTenant(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Type string `json:"type"`
		Name string `json:"name"`
		Code string `json:"code"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	tenant, err := a.authStore.createTenant(payload.Name, payload.Code, payload.Type)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"tenant": tenant})
}

func (a *app) handleUpdateTenant(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Name string `json:"name"`
		Code string `json:"code"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	tenant, err := a.authStore.updateTenant(r.PathValue("tenantId"), payload.Name, payload.Code)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tenant": tenant})
}

func (a *app) handleDeleteTenant(w http.ResponseWriter, r *http.Request) {
	if err := a.authStore.deleteTenant(r.PathValue("tenantId")); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func canManageTargetTenant(user *AuthUser, targetTenantID *string) bool {
	if user == nil {
		return false
	}
	if user.Role == "super_admin" {
		return true
	}
	if user.TenantID == nil || targetTenantID == nil {
		return false
	}
	return *user.TenantID == *targetTenantID
}

func canResubmitSubmittedCampaign(user AuthUser) bool {
	return strings.EqualFold(strings.TrimSpace(user.Role), "super_admin")
}

func parseBoolQuery(value string) bool {
	parsed, err := strconv.ParseBool(strings.TrimSpace(value))
	return err == nil && parsed
}

func canManageUser(actor *AuthUser, target *AuthUser) bool {
	if actor == nil || target == nil {
		return false
	}
	if actor.Role == "super_admin" {
		return true
	}
	if actor.Role == "admin" {
		if target.Role != "user" {
			return false
		}
		if actor.TenantID == nil || target.TenantID == nil {
			return false
		}
		return *actor.TenantID == *target.TenantID
	}
	return false
}

func (a *app) managedTenantID(r *http.Request) (*string, error) {
	user := currentUser(r.Context())
	if user == nil {
		return nil, errors.New("authentication required")
	}
	if user.Role == "super_admin" {
		if raw := strings.TrimSpace(r.URL.Query().Get("tenantId")); raw != "" {
			return &raw, nil
		}
		return nil, errors.New("super admin must select a tenant")
	}
	if user.TenantID == nil || strings.TrimSpace(*user.TenantID) == "" {
		return nil, errors.New("tenantId is required")
	}
	return user.TenantID, nil
}

func (a *app) userWithManagedTenant(r *http.Request) (*AuthUser, error) {
	user := currentUser(r.Context())
	if user == nil {
		return nil, errors.New("authentication required")
	}
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		return nil, err
	}
	effectiveUser := *user
	effectiveUser.TenantID = tenantID
	return &effectiveUser, nil
}

func (a *app) handleListUsers(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r.Context())
	var tenantID *string
	if user.Role == "super_admin" {
		if raw := strings.TrimSpace(r.URL.Query().Get("tenantId")); raw != "" {
			tenantID = &raw
		}
	} else {
		tenantID = user.TenantID
	}

	users, err := a.authStore.listUsers(tenantID, user.Role == "super_admin")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

func (a *app) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r.Context())
	var payload struct {
		Name     string  `json:"name"`
		Email    string  `json:"email"`
		Password string  `json:"password"`
		Role     string  `json:"role"`
		TenantID *string `json:"tenantId"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	targetTenantID := payload.TenantID
	if user.Role != "super_admin" {
		targetTenantID = user.TenantID
	}
	if !canManageTargetTenant(user, targetTenantID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "You cannot create users for another tenant"})
		return
	}
	if user.Role != "super_admin" && payload.Role == "super_admin" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Only a super admin can create a super admin user"})
		return
	}

	createdUser, err := a.authStore.createUser(payload.Name, payload.Email, payload.Password, payload.Role, targetTenantID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": createdUser})
}

func (a *app) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r.Context())
	targetUser, err := a.authStore.userByID(r.Context(), r.PathValue("userId"))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if targetUser == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "User not found"})
		return
	}
	if !canManageUser(user, targetUser) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "You do not have permission to edit this user"})
		return
	}

	var payload map[string]any
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	if role, ok := payload["role"].(string); ok && user.Role != "super_admin" && role == "super_admin" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Only a super admin can assign the super_admin role"})
		return
	}
	if user.Role != "super_admin" {
		payload["tenantId"] = user.TenantID
	}

	updatedUser, err := a.authStore.updateUser(r.PathValue("userId"), payload)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if user.Role != "super_admin" {
		if user.TenantID == nil || updatedUser.TenantID == nil || *updatedUser.TenantID != *user.TenantID {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "You cannot move users to another tenant"})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": updatedUser})
}

func (a *app) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r.Context())
	targetUser, err := a.authStore.userByID(r.Context(), r.PathValue("userId"))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if targetUser == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "User not found"})
		return
	}
	if !canManageUser(user, targetUser) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "You do not have permission to delete this user"})
		return
	}
	if err := a.authStore.deleteUser(r.PathValue("userId")); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (a *app) handleOptionsStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.optionService.getOptionsCacheStatus())
}

func (a *app) handleRefreshOptions(w http.ResponseWriter, _ *http.Request) {
	stocks, processes, err := a.optionService.refreshOptionsCache()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"message":   "PrintIQ option cache refreshed successfully",
		"stocks":    stocks,
		"processes": processes,
	})
}

func (a *app) handleListCalculatorMappings(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	records, err := a.mappingStore.listRecords(r.Context(), *tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mappings": records})
}

func (a *app) handleCreateCalculatorMapping(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var payload calculatorMappingInput
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	record, err := a.mappingStore.createMapping(r.Context(), *tenantID, payload)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if user := currentUser(r.Context()); user != nil {
		tenantIDValue := *tenantID
		recordValue := *record
		userValue := *user
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			a.notifyMissingProductMappings(ctx, tenantIDValue, recordValue, userValue)
		}()
	}
	writeJSON(w, http.StatusCreated, map[string]any{"mapping": record})
}

func (a *app) handleUpdateCalculatorMapping(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var payload calculatorMappingInput
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	record, err := a.mappingStore.updateMapping(r.Context(), *tenantID, r.PathValue("mappingId"), payload)
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	if user := currentUser(r.Context()); user != nil {
		tenantIDValue := *tenantID
		recordValue := *record
		userValue := *user
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			a.notifyMissingProductMappings(ctx, tenantIDValue, recordValue, userValue)
		}()
	}
	writeJSON(w, http.StatusOK, map[string]any{"mapping": record})
}

func (a *app) handleDeleteCalculatorMapping(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	if err := a.mappingStore.deleteMapping(r.Context(), *tenantID, r.PathValue("mappingId")); err != nil {
		status := http.StatusBadRequest
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (a *app) handleImportCalculatorMappings(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var payload struct {
		Markets []marketMetadata `json:"markets"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}
	if len(payload.Markets) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "markets is required"})
		return
	}

	count, err := a.mappingStore.replaceMappingsFromImport(r.Context(), *tenantID, payload.Markets)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message": fmt.Sprintf("Imported %d mappings successfully", count),
		"count":   count,
	})
}

func (a *app) handleListMarketDeliveryAddresses(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	records, err := a.mappingStore.listMarketDeliveryAddresses(r.Context(), *tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"addresses": records})
}

func (a *app) handleUpsertMarketDeliveryAddress(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var payload marketDeliveryAddressInput
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	record, err := a.mappingStore.upsertMarketDeliveryAddress(r.Context(), *tenantID, payload)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"address": record})
}

func (a *app) handleDeleteMarketDeliveryAddress(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var payload marketDeliveryAddressDeleteInput
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	if err := a.mappingStore.deleteMarketDeliveryAddress(r.Context(), *tenantID, payload); err != nil {
		status := http.StatusBadRequest
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (a *app) handleListMarketShippingRates(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	records, err := a.mappingStore.listMarketShippingRates(r.Context(), *tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rates": records})
}

func (a *app) handleUpsertMarketShippingRate(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var payload marketShippingRateInput
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	record, err := a.mappingStore.upsertMarketShippingRate(r.Context(), *tenantID, payload)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rate": record})
}

func (a *app) handleListMarketAssetPrintingCosts(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	records, err := a.mappingStore.listMarketAssetPrintingCosts(r.Context(), *tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"costs": records})
}

func (a *app) handleListMarketPrintingCosts(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	records, err := a.mappingStore.listMarketPrintingCosts(r.Context(), *tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"costs": records})
}

func (a *app) handleUpsertMarketPrintingCosts(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var payload struct {
		Costs []marketPrintingCostInput `json:"costs"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	records, err := a.mappingStore.upsertMarketPrintingCosts(r.Context(), *tenantID, payload.Costs)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"costs": records})
}

func (a *app) handleUpsertMarketAssetPrintingCosts(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var payload struct {
		Costs []marketAssetPrintingCostInput `json:"costs"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	records, err := a.mappingStore.upsertMarketAssetPrintingCosts(r.Context(), *tenantID, payload.Costs)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"costs": records})
}

func (a *app) handleListCustomPrintCosts(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	records, err := a.mappingStore.listCustomPrintCosts(r.Context(), *tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"costs": records})
}

func (a *app) handleUpsertCustomPrintCosts(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var payload struct {
		Costs []customPrintCostInput `json:"costs"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}
	records, err := a.mappingStore.upsertCustomPrintCosts(r.Context(), *tenantID, payload.Costs)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"costs": records})
}

func (a *app) handleListMarketSheetSizes(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	records, err := a.mappingStore.listMarketSheetSizes(r.Context(), *tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sizes": records})
}

func (a *app) handleUpsertMarketSheetSizes(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var payload struct {
		Sizes []marketSheetSizeInput `json:"sizes"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	records, err := a.mappingStore.upsertMarketSheetSizes(r.Context(), *tenantID, payload.Sizes)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sizes": records})
}

func (a *app) handleListMarketAssetShippingCosts(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	records, err := a.mappingStore.listMarketAssetShippingCosts(r.Context(), *tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"costs": records})
}

func (a *app) handleUpsertMarketAssetShippingCosts(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var payload struct {
		Costs []marketAssetShippingCostInput `json:"costs"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	records, err := a.mappingStore.upsertMarketAssetShippingCosts(r.Context(), *tenantID, payload.Costs)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"costs": records})
}

func (a *app) handleListMaterials(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	records, err := a.mappingStore.listMaterials(r.Context(), *tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"materials": records})
}

func (a *app) handleReplaceMaterials(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var payload struct {
		Materials []materialInput `json:"materials"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}
	if payload.Materials == nil {
		payload.Materials = []materialInput{}
	}
	records, err := a.mappingStore.replaceMaterials(r.Context(), *tenantID, payload.Materials)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"materials": records})
}

func (a *app) handleGetSheetNameOverrides(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	record, err := a.mappingStore.listSheetNameOverrides(r.Context(), *tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": record})
}

func (a *app) handleUpsertSheetNameOverrides(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var payload struct {
		Overrides              sheetNameOverrides `json:"overrides"`
		MultipleArtworkFormats map[string]bool    `json:"multipleArtworkFormats"`
		CustomPrintCostFormats map[string]bool    `json:"customPrintCostFormats"`
		CustomSheetSizeFormats map[string]bool    `json:"customSheetSizeFormats"`
		ProductCodes           sheetNameOverrides `json:"productCodes"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}
	if payload.Overrides == nil {
		payload.Overrides = sheetNameOverrides{}
	}
	if payload.MultipleArtworkFormats == nil {
		payload.MultipleArtworkFormats = map[string]bool{}
	}
	if payload.CustomPrintCostFormats == nil {
		payload.CustomPrintCostFormats = map[string]bool{}
	}
	if payload.CustomSheetSizeFormats == nil {
		payload.CustomSheetSizeFormats = map[string]bool{}
	}
	if payload.ProductCodes == nil {
		payload.ProductCodes = sheetNameOverrides{}
	}
	existing, loadErr := a.mappingStore.listSheetNameOverrides(r.Context(), *tenantID)
	if loadErr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": loadErr.Error()})
		return
	}
	payload.ProductCodes = existing.ProductCodes
	if user := currentUser(r.Context()); user == nil || user.Role != "super_admin" {
		payload.CustomPrintCostFormats = existing.CustomPrintCostFormats
	}

	record, err := a.mappingStore.upsertSheetNameOverrides(r.Context(), *tenantID, payload.Overrides, payload.MultipleArtworkFormats, payload.CustomPrintCostFormats, payload.CustomSheetSizeFormats, payload.ProductCodes)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": record})
}

func (a *app) handleListMaterialMappings(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	records, err := a.mappingStore.listMaterialMappings(r.Context(), *tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mappings": records})
}

func (a *app) handleUpsertMaterialMappings(w http.ResponseWriter, r *http.Request) {
	tenantID, err := a.managedTenantID(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var payload struct {
		Mappings []materialMappingInput `json:"mappings"`
	}
	if err := decodeJSONBody(r, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}
	if payload.Mappings == nil {
		payload.Mappings = []materialMappingInput{}
	}

	records, err := a.mappingStore.upsertMaterialMappings(r.Context(), *tenantID, payload.Mappings)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mappings": records})
}
