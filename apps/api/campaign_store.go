package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type campaignStore struct {
	pool *pgxpool.Pool
}

// Match the dashboard's Created By name/email fallback, including its N/A display.
func (s *campaignStore) campaignCreatorDisplayName(ctx context.Context, campaignID, tenantID string) (string, error) {
	var name string
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(NULLIF(TRIM(COALESCE(NULLIF(TRIM(u.name), ''), u.email)), ''), 'N/A')
		FROM campaigns c
		LEFT JOIN users u ON u.id = c.created_by_user_id
		WHERE c.id = $1 AND c.tenant_id = $2
	`, campaignID, tenantID).Scan(&name)
	return name, err
}

type campaignRow struct {
	ID                string
	TenantID          string
	ParentCampaignID  *string
	CreatedByUserID   string
	UpdatedByUserID   string
	Status            string
	FormData          []byte
	SummaryData       []byte
	PurchaseOrderData []byte
	LatestQuoteAmount *string
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

func newCampaignStore(pool *pgxpool.Pool) *campaignStore {
	return &campaignStore{pool: pool}
}

func parseDateOrNil(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func parseWeeks(value string) int {
	weeks, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || weeks < 1 {
		return 1
	}
	if weeks > 52 {
		return 52
	}
	return weeks
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func validateDateIsTodayOrFuture(rawValue, fieldLabel string) error {
	trimmed := strings.TrimSpace(rawValue)
	if trimmed == "" {
		return nil
	}

	location := time.Now().Location()
	parsed, err := time.ParseInLocation("2006-01-02", trimmed, location)
	if err != nil {
		return fmt.Errorf("%s must be a valid date (YYYY-MM-DD)", fieldLabel)
	}

	now := time.Now().In(location)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, location)
	if parsed.Before(today) {
		return fmt.Errorf("%s cannot be in the past", fieldLabel)
	}
	return nil
}

func validateCampaignDates(values orderFormValues) error {
	if err := validateDateIsTodayOrFuture(values.CampaignStartDate, "Campaign start date"); err != nil {
		return err
	}
	if err := validateDateIsTodayOrFuture(values.DueDate, "Delivery Due Date"); err != nil {
		return err
	}
	return nil
}

func cloneOrderFormValues(values orderFormValues) orderFormValues {
	cloned := values
	cloned.PrintImages = append([]campaignPrintImage(nil), values.PrintImages...)
	cloned.SupportingDocuments = append([]supportingDocument(nil), values.SupportingDocuments...)
	if values.CreativeNameAssignments != nil {
		cloned.CreativeNameAssignments = make(map[string]string, len(values.CreativeNameAssignments))
		for key, value := range values.CreativeNameAssignments {
			cloned.CreativeNameAssignments[key] = value
		}
	}
	if values.ArtworkCodes != nil {
		cloned.ArtworkCodes = make(map[string]string, len(values.ArtworkCodes))
		for key, value := range values.ArtworkCodes {
			cloned.ArtworkCodes[key] = value
		}
	}
	cloned.CampaignMarkets = append([]campaignMarket(nil), values.CampaignMarkets...)
	for marketIndex := range cloned.CampaignMarkets {
		if sourceOverrides := values.CampaignMarkets[marketIndex].QuantityOverrides; sourceOverrides != nil {
			cloned.CampaignMarkets[marketIndex].QuantityOverrides = &campaignQuantityOverrides{
				Posters: cloneQuantityBreakdown(sourceOverrides.Posters),
				Frames:  cloneQuantityBreakdown(sourceOverrides.Frames),
			}
		}
		cloned.CampaignMarkets[marketIndex].Assets = append([]campaignAsset(nil), values.CampaignMarkets[marketIndex].Assets...)
		for assetIndex := range cloned.CampaignMarkets[marketIndex].Assets {
			sourceAsset := values.CampaignMarkets[marketIndex].Assets[assetIndex]
			clonedAsset := &cloned.CampaignMarkets[marketIndex].Assets[assetIndex]
			clonedAsset.SelectedWeeks = append([]int(nil), sourceAsset.SelectedWeeks...)
			if sourceAsset.QuantityOverrides != nil {
				clonedAsset.QuantityOverrides = &campaignQuantityOverrides{
					Posters: cloneQuantityBreakdown(sourceAsset.QuantityOverrides.Posters),
				}
			}
			if sourceAsset.CreativeImageIDs != nil {
				clonedAsset.CreativeImageIDs = make(map[string]string, len(sourceAsset.CreativeImageIDs))
				for key, value := range sourceAsset.CreativeImageIDs {
					clonedAsset.CreativeImageIDs[key] = value
				}
			}
			if sourceAsset.ArtworkMaterialAssignments != nil {
				clonedAsset.ArtworkMaterialAssignments = make(map[string][]artworkMaterialAssignment, len(sourceAsset.ArtworkMaterialAssignments))
				for key, value := range sourceAsset.ArtworkMaterialAssignments {
					clonedAsset.ArtworkMaterialAssignments[key] = append([]artworkMaterialAssignment(nil), value...)
				}
			}
		}
	}
	return cloned
}

func marshalJSON(value any) ([]byte, error) {
	return json.Marshal(value)
}

func decodeCampaignRow(row campaignRow) (*campaignRecord, error) {
	values := orderFormValues{}
	if len(row.FormData) > 0 {
		if err := json.Unmarshal(row.FormData, &values); err != nil {
			return nil, err
		}
	}

	var summary *campaignSummary
	if len(row.SummaryData) > 0 {
		var decoded campaignSummary
		if err := json.Unmarshal(row.SummaryData, &decoded); err != nil {
			return nil, err
		}
		summary = &decoded
	}

	var purchaseOrder *purchaseOrderDetails
	if len(row.PurchaseOrderData) > 0 {
		var decoded purchaseOrderDetails
		if err := json.Unmarshal(row.PurchaseOrderData, &decoded); err != nil {
			return nil, err
		}
		purchaseOrder = &decoded
	}

	var latestQuoteAmount any
	if row.LatestQuoteAmount != nil {
		latestQuoteAmount = *row.LatestQuoteAmount
	}

	return &campaignRecord{
		ID:                row.ID,
		TenantID:          row.TenantID,
		ParentCampaignID:  row.ParentCampaignID,
		CreatedByUserID:   row.CreatedByUserID,
		UpdatedByUserID:   row.UpdatedByUserID,
		Status:            row.Status,
		Values:            values,
		Summary:           summary,
		PurchaseOrder:     purchaseOrder,
		LatestQuoteAmount: latestQuoteAmount,
		CreatedAt:         row.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:         row.UpdatedAt.UTC().Format(time.RFC3339),
	}, nil
}

type campaignListItem struct {
	ID                 string                `json:"id"`
	TenantID           string                `json:"tenantId"`
	ParentCampaignID   string                `json:"parentCampaignId,omitempty"`
	ParentCampaignName string                `json:"parentCampaignName,omitempty"`
	ChildCampaignCount int                   `json:"childCampaignCount"`
	Status             string                `json:"status"`
	CreatedBy          string                `json:"createdBy"`
	UpdatedBy          string                `json:"updatedBy"`
	CampaignName       string                `json:"campaignName"`
	CampaignStartDate  string                `json:"campaignStartDate"`
	DueDate            string                `json:"dueDate"`
	NumberOfWeeks      string                `json:"numberOfWeeks"`
	MarketCount        int                   `json:"marketCount"`
	AssetCount         int                   `json:"assetCount"`
	PurchaseOrder      *purchaseOrderDetails `json:"purchaseOrder"`
	LatestQuoteAmount  any                   `json:"latestQuoteAmount"`
	UpdatedAt          string                `json:"updatedAt"`
	CreatedAt          string                `json:"createdAt"`
}

func scanCampaignRow(scanner interface {
	Scan(dest ...any) error
}) (campaignRow, error) {
	var row campaignRow
	err := scanner.Scan(
		&row.ID,
		&row.TenantID,
		&row.ParentCampaignID,
		&row.CreatedByUserID,
		&row.UpdatedByUserID,
		&row.Status,
		&row.FormData,
		&row.SummaryData,
		&row.PurchaseOrderData,
		&row.LatestQuoteAmount,
		&row.CreatedAt,
		&row.UpdatedAt,
	)
	return row, err
}

func normalizeCampaignLines(values orderFormValues) []campaignLine {
	lines := make([]campaignLine, 0)
	for _, market := range values.CampaignMarkets {
		for _, asset := range market.Assets {
			lines = append(lines, campaignLine{
				ID:                      asset.ID,
				AssetID:                 asset.AssetID,
				AssetSearch:             asset.AssetSearch,
				SelectedWeeks:           append([]int(nil), asset.SelectedWeeks...),
				Market:                  market.Market,
				QuantityOverrides:       asset.QuantityOverrides,
				MarketQuantityOverrides: market.QuantityOverrides,
			})
		}
	}
	return lines
}

func normalizeCampaignLineID(value string) string {
	lineID := strings.TrimSpace(value)
	if lineID == "" {
		return uuid.NewString()
	}
	if _, err := uuid.Parse(lineID); err != nil {
		return uuid.NewString()
	}
	return lineID
}

func (s *campaignStore) replaceCampaignLines(ctx context.Context, tx pgx.Tx, campaignID, tenantID string, values orderFormValues) error {
	if _, err := tx.Exec(ctx, `DELETE FROM campaign_lines WHERE campaign_id = $1 AND tenant_id = $2`, campaignID, tenantID); err != nil {
		return err
	}

	sortOrder := 0
	for _, market := range values.CampaignMarkets {
		for _, asset := range market.Assets {
			selectedWeeksJSON, err := marshalJSON(asset.SelectedWeeks)
			if err != nil {
				return err
			}
			lineID := normalizeCampaignLineID(asset.ID)
			if _, err := tx.Exec(ctx, `
				INSERT INTO campaign_lines (id, tenant_id, campaign_id, market, asset_id, asset_label, selected_weeks, sort_order, created_at, updated_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW())
			`, lineID, tenantID, campaignID, market.Market, asset.AssetID, asset.AssetSearch, string(selectedWeeksJSON), sortOrder); err != nil {
				return err
			}
			sortOrder++
		}
	}
	return nil
}

func (s *campaignStore) createCampaign(ctx context.Context, user AuthUser, values orderFormValues) (*campaignRecord, error) {
	if user.TenantID == nil {
		return nil, errors.New("current user is not assigned to a tenant")
	}
	if err := validateCampaignDates(values); err != nil {
		return nil, err
	}

	formData, err := marshalJSON(values)
	if err != nil {
		return nil, err
	}

	campaignID := uuid.NewString()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `
		INSERT INTO campaigns (
			id, tenant_id, name, start_date, due_date, weeks, status, form_data, created_by_user_id, updated_by_user_id, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, 'in_progress', $7::jsonb, $8, $8, NOW(), NOW())
	`, campaignID, *user.TenantID, strings.TrimSpace(values.CampaignName), parseDateOrNil(values.CampaignStartDate), parseDateOrNil(values.DueDate), parseWeeks(values.NumberOfWeeks), string(formData), user.ID); err != nil {
		return nil, err
	}

	if err := s.replaceCampaignLines(ctx, tx, campaignID, *user.TenantID, values); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.getCampaign(ctx, user, campaignID)
}

func buildSubCampaignValues(parent *campaignRecord, sequence int) orderFormValues {
	values := cloneOrderFormValues(parent.Values)
	parentName := strings.TrimSpace(parent.Values.CampaignName)
	if parentName == "" {
		parentName = "Untitled Campaign " + parent.ID[:6]
	}
	values.CampaignName = fmt.Sprintf("%s - subcampaign - %d", parentName, sequence)
	values.Quantity = ""
	values.CreativeNameAssignments = map[string]string{}
	values.SupportingDocuments = []supportingDocument{}

	for marketIndex := range values.CampaignMarkets {
		values.CampaignMarkets[marketIndex].ID = uuid.NewString()
		for assetIndex := range values.CampaignMarkets[marketIndex].Assets {
			asset := &values.CampaignMarkets[marketIndex].Assets[assetIndex]
			asset.ID = uuid.NewString()
			asset.SelectedWeeks = []int{}
			asset.CreativeImageID = ""
			asset.CreativeImageIDs = map[string]string{}
			asset.ArtworkMaterialAssignments = map[string][]artworkMaterialAssignment{}
		}
	}

	return values
}

func (s *campaignStore) createSubCampaign(ctx context.Context, user AuthUser, parentCampaignID string) (*campaignRecord, error) {
	if user.TenantID == nil {
		return nil, errors.New("current user is not assigned to a tenant")
	}

	parent, err := s.getCampaign(ctx, user, parentCampaignID)
	if err != nil {
		return nil, err
	}
	if strings.EqualFold(strings.TrimSpace(parent.Status), "submitted") {
		return nil, errors.New("Submitted campaigns cannot be edited")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var existingChildren int
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM campaigns
		WHERE tenant_id = $1 AND parent_campaign_id = $2
	`, *user.TenantID, parent.ID).Scan(&existingChildren); err != nil {
		return nil, err
	}

	values := buildSubCampaignValues(parent, existingChildren+1)
	formData, err := marshalJSON(values)
	if err != nil {
		return nil, err
	}

	campaignID := uuid.NewString()
	if _, err := tx.Exec(ctx, `
		INSERT INTO campaigns (
			id, tenant_id, parent_campaign_id, name, start_date, due_date, weeks, status, form_data, created_by_user_id, updated_by_user_id, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, 'in_progress', $8::jsonb, $9, $9, NOW(), NOW())
	`, campaignID, *user.TenantID, parent.ID, strings.TrimSpace(values.CampaignName), parseDateOrNil(values.CampaignStartDate), parseDateOrNil(values.DueDate), parseWeeks(values.NumberOfWeeks), string(formData), user.ID); err != nil {
		return nil, err
	}

	if err := s.replaceCampaignLines(ctx, tx, campaignID, *user.TenantID, values); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.getCampaign(ctx, user, campaignID)
}

func (s *campaignStore) createCampaignClone(ctx context.Context, user AuthUser, source *campaignRecord, values orderFormValues, purchaseOrder *purchaseOrderDetails) (*campaignRecord, error) {
	if user.TenantID == nil {
		return nil, errors.New("current user is not assigned to a tenant")
	}
	if source == nil {
		return nil, errors.New("Campaign not found")
	}

	formData, err := marshalJSON(values)
	if err != nil {
		return nil, err
	}

	var purchaseOrderData any
	if purchaseOrder != nil {
		payload, err := marshalJSON(purchaseOrder)
		if err != nil {
			return nil, err
		}
		purchaseOrderData = string(payload)
	}

	campaignID := uuid.NewString()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `
		INSERT INTO campaigns (
			id, tenant_id, name, start_date, due_date, weeks, status, form_data, purchase_order, created_by_user_id, updated_by_user_id, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, 'in_progress', $7::jsonb, $8::jsonb, $9, $9, NOW(), NOW())
	`, campaignID, source.TenantID, strings.TrimSpace(values.CampaignName), parseDateOrNil(values.CampaignStartDate), parseDateOrNil(values.DueDate), parseWeeks(values.NumberOfWeeks), string(formData), purchaseOrderData, user.ID); err != nil {
		return nil, err
	}

	if err := s.replaceCampaignLines(ctx, tx, campaignID, source.TenantID, values); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.getCampaign(ctx, user, campaignID)
}

func (s *campaignStore) listCampaigns(ctx context.Context, user AuthUser) ([]campaignListItem, error) {
	if user.TenantID == nil {
		return nil, errors.New("current user is not assigned to a tenant")
	}

	rows, err := s.pool.Query(ctx, `
		SELECT c.id, c.tenant_id, c.parent_campaign_id::text,
			COALESCE(NULLIF(TRIM(parent.name), ''), NULLIF(TRIM(parent.form_data->>'campaignName'), ''), '') AS parent_campaign_name,
			COALESCE(child_counts.child_count, 0) AS child_campaign_count,
			c.status, c.form_data, c.purchase_order, c.latest_quote_amount::text, c.updated_at, c.created_at,
			COALESCE(NULLIF(TRIM(uc.name), ''), uc.email) AS created_by,
			COALESCE(NULLIF(TRIM(uu.name), ''), uu.email) AS updated_by
		FROM campaigns c
		LEFT JOIN campaigns parent ON parent.id = c.parent_campaign_id AND parent.tenant_id = c.tenant_id
		LEFT JOIN (
			SELECT parent_campaign_id, COUNT(*) AS child_count
			FROM campaigns
			WHERE tenant_id = $1 AND parent_campaign_id IS NOT NULL
			GROUP BY parent_campaign_id
		) child_counts ON child_counts.parent_campaign_id = c.id
		LEFT JOIN users uc ON uc.id = c.created_by_user_id
		LEFT JOIN users uu ON uu.id = c.updated_by_user_id
		WHERE c.tenant_id = $1
		ORDER BY c.created_at DESC, c.id DESC
	`, *user.TenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]campaignListItem, 0)
	for rows.Next() {
		var id string
		var tenantID string
		var parentCampaignID *string
		var parentCampaignName string
		var childCampaignCount int
		var status string
		var formData []byte
		var purchaseOrderData []byte
		var latestQuoteAmount *string
		var updatedAt time.Time
		var createdAt time.Time
		var createdBy string
		var updatedBy string
		if err := rows.Scan(&id, &tenantID, &parentCampaignID, &parentCampaignName, &childCampaignCount, &status, &formData, &purchaseOrderData, &latestQuoteAmount, &updatedAt, &createdAt, &createdBy, &updatedBy); err != nil {
			return nil, err
		}

		values := orderFormValues{}
		if len(formData) > 0 {
			if err := json.Unmarshal(formData, &values); err != nil {
				return nil, err
			}
		}
		var purchaseOrder *purchaseOrderDetails
		if len(purchaseOrderData) > 0 {
			var decoded purchaseOrderDetails
			if err := json.Unmarshal(purchaseOrderData, &decoded); err != nil {
				return nil, err
			}
			purchaseOrder = &decoded
		}

		var quoteAmount any
		if latestQuoteAmount != nil {
			quoteAmount = *latestQuoteAmount
		}

		marketCount := len(values.CampaignMarkets)
		assetCount := 0
		for _, market := range values.CampaignMarkets {
			assetCount += len(market.Assets)
		}

		items = append(items, campaignListItem{
			ID:                 id,
			TenantID:           tenantID,
			ParentCampaignID:   stringValue(parentCampaignID),
			ParentCampaignName: strings.TrimSpace(parentCampaignName),
			ChildCampaignCount: childCampaignCount,
			Status:             status,
			CreatedBy:          strings.TrimSpace(createdBy),
			UpdatedBy:          strings.TrimSpace(updatedBy),
			CampaignName:       strings.TrimSpace(values.CampaignName),
			CampaignStartDate:  strings.TrimSpace(values.CampaignStartDate),
			DueDate:            strings.TrimSpace(values.DueDate),
			NumberOfWeeks:      strings.TrimSpace(values.NumberOfWeeks),
			MarketCount:        marketCount,
			AssetCount:         assetCount,
			PurchaseOrder:      purchaseOrder,
			LatestQuoteAmount:  quoteAmount,
			UpdatedAt:          updatedAt.UTC().Format(time.RFC3339),
			CreatedAt:          createdAt.UTC().Format(time.RFC3339),
		})
	}

	return items, rows.Err()
}

func (s *campaignStore) getCampaign(ctx context.Context, user AuthUser, campaignID string) (*campaignRecord, error) {
	if user.TenantID == nil {
		return nil, errors.New("current user is not assigned to a tenant")
	}

	row, err := scanCampaignRow(s.pool.QueryRow(ctx, `
		SELECT id, tenant_id, parent_campaign_id::text, created_by_user_id, updated_by_user_id, status, form_data, calculation_summary, purchase_order, latest_quote_amount::text, created_at, updated_at
		FROM campaigns
		WHERE id = $1 AND tenant_id = $2
		LIMIT 1
	`, campaignID, *user.TenantID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errors.New("Campaign not found")
	}
	if err != nil {
		return nil, err
	}
	return decodeCampaignRow(row)
}

func (s *campaignStore) submittedCampaignEditError(ctx context.Context, user AuthUser, campaignID string) error {
	if user.TenantID == nil {
		return errors.New("current user is not assigned to a tenant")
	}

	var status string
	err := s.pool.QueryRow(ctx, `
		SELECT status
		FROM campaigns
		WHERE id = $1 AND tenant_id = $2
		LIMIT 1
	`, campaignID, *user.TenantID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("Campaign not found")
	}
	if err != nil {
		return err
	}
	if strings.EqualFold(strings.TrimSpace(status), "submitted") {
		return errors.New("Submitted campaigns cannot be edited")
	}
	return errors.New("Campaign not found")
}

func (s *campaignStore) updateCampaign(ctx context.Context, user AuthUser, campaignID string, values orderFormValues) (*campaignRecord, error) {
	if user.TenantID == nil {
		return nil, errors.New("current user is not assigned to a tenant")
	}
	if err := validateCampaignDates(values); err != nil {
		return nil, err
	}
	formData, err := marshalJSON(values)
	if err != nil {
		return nil, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	commandTag, err := tx.Exec(ctx, `
		UPDATE campaigns
		SET name = $3,
			start_date = $4,
			due_date = $5,
			weeks = $6,
			status = 'in_progress',
			form_data = $7::jsonb,
			calculation_summary = NULL,
			latest_quote_amount = NULL,
			submitted_at = NULL,
			updated_by_user_id = $8,
			updated_at = NOW()
		WHERE id = $1 AND tenant_id = $2 AND status <> 'submitted'
	`, campaignID, *user.TenantID, strings.TrimSpace(values.CampaignName), parseDateOrNil(values.CampaignStartDate), parseDateOrNil(values.DueDate), parseWeeks(values.NumberOfWeeks), string(formData), user.ID)
	if err != nil {
		return nil, err
	}
	if commandTag.RowsAffected() == 0 {
		return nil, s.submittedCampaignEditError(ctx, user, campaignID)
	}

	if err := s.replaceCampaignLines(ctx, tx, campaignID, *user.TenantID, values); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.getCampaign(ctx, user, campaignID)
}

func (s *campaignStore) appendCampaignPrintImages(ctx context.Context, user AuthUser, campaignID string, images []campaignPrintImage) (*campaignRecord, error) {
	if user.TenantID == nil {
		return nil, errors.New("current user is not assigned to a tenant")
	}
	for _, image := range images {
		if strings.TrimSpace(image.ID) == "" {
			return nil, errors.New("Artwork image id is required")
		}
		if strings.TrimSpace(image.StoredName) == "" {
			return nil, errors.New("Artwork stored name is required")
		}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var formData []byte
	var status string
	err = tx.QueryRow(ctx, `
		SELECT form_data, status
		FROM campaigns
		WHERE id = $1 AND tenant_id = $2
		FOR UPDATE
	`, campaignID, *user.TenantID).Scan(&formData, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errors.New("Campaign not found")
	}
	if err != nil {
		return nil, err
	}
	if strings.EqualFold(strings.TrimSpace(status), "submitted") {
		return nil, errors.New("Submitted campaigns cannot be edited")
	}

	values := orderFormValues{}
	if len(formData) > 0 {
		if err := json.Unmarshal(formData, &values); err != nil {
			return nil, err
		}
	}
	imageIndexByID := make(map[string]int, len(values.PrintImages)+len(images))
	for index, image := range values.PrintImages {
		imageIndexByID[image.ID] = index
	}
	for _, image := range images {
		if index, exists := imageIndexByID[image.ID]; exists {
			values.PrintImages[index] = image
			continue
		}
		imageIndexByID[image.ID] = len(values.PrintImages)
		values.PrintImages = append(values.PrintImages, image)
	}

	nextFormData, err := marshalJSON(values)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE campaigns
		SET form_data = $3::jsonb,
			updated_by_user_id = $4,
			updated_at = NOW()
		WHERE id = $1 AND tenant_id = $2
	`, campaignID, *user.TenantID, string(nextFormData), user.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.getCampaign(ctx, user, campaignID)
}

func (s *campaignStore) appendCampaignSupportingDocuments(ctx context.Context, user AuthUser, campaignID string, documents []supportingDocument) (*campaignRecord, error) {
	if user.TenantID == nil {
		return nil, errors.New("current user is not assigned to a tenant")
	}
	for _, document := range documents {
		if strings.TrimSpace(document.OriginalName) == "" {
			return nil, errors.New("Supporting document name is required")
		}
		if strings.TrimSpace(document.StoredName) == "" {
			return nil, errors.New("Supporting document stored name is required")
		}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var formData []byte
	var status string
	err = tx.QueryRow(ctx, `
		SELECT form_data, status
		FROM campaigns
		WHERE id = $1 AND tenant_id = $2
		FOR UPDATE
	`, campaignID, *user.TenantID).Scan(&formData, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errors.New("Campaign not found")
	}
	if err != nil {
		return nil, err
	}
	if strings.EqualFold(strings.TrimSpace(status), "submitted") {
		return nil, errors.New("Submitted campaigns cannot be edited")
	}

	values := orderFormValues{}
	if len(formData) > 0 {
		if err := json.Unmarshal(formData, &values); err != nil {
			return nil, err
		}
	}
	documentIndexByStoredName := make(map[string]int, len(values.SupportingDocuments)+len(documents))
	for index, document := range values.SupportingDocuments {
		documentIndexByStoredName[document.StoredName] = index
	}
	for _, document := range documents {
		if index, exists := documentIndexByStoredName[document.StoredName]; exists {
			values.SupportingDocuments[index] = document
			continue
		}
		documentIndexByStoredName[document.StoredName] = len(values.SupportingDocuments)
		values.SupportingDocuments = append(values.SupportingDocuments, document)
	}

	nextFormData, err := marshalJSON(values)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE campaigns
		SET form_data = $3::jsonb,
			updated_by_user_id = $4,
			updated_at = NOW()
		WHERE id = $1 AND tenant_id = $2
	`, campaignID, *user.TenantID, string(nextFormData), user.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.getCampaign(ctx, user, campaignID)
}

func (s *campaignStore) setPurchaseOrder(ctx context.Context, user AuthUser, campaignID string, upload uploadResponse) (*campaignRecord, error) {
	if user.TenantID == nil {
		return nil, errors.New("current user is not assigned to a tenant")
	}

	purchaseOrder := purchaseOrderDetails{
		OriginalName: upload.OriginalName,
		StoredName:   upload.StoredName,
		MimeType:     upload.MimeType,
		Size:         upload.Size,
		UploadedAt:   upload.UploadedAt,
	}
	payload, err := marshalJSON(purchaseOrder)
	if err != nil {
		return nil, err
	}

	commandTag, err := s.pool.Exec(ctx, `
		UPDATE campaigns
		SET purchase_order = $3::jsonb,
			updated_by_user_id = $4,
			updated_at = NOW()
		WHERE id = $1 AND tenant_id = $2 AND status <> 'submitted'
	`, campaignID, *user.TenantID, string(payload), user.ID)
	if err != nil {
		return nil, err
	}
	if commandTag.RowsAffected() == 0 {
		return nil, s.submittedCampaignEditError(ctx, user, campaignID)
	}
	return s.getCampaign(ctx, user, campaignID)
}

func (s *campaignStore) calculateCampaign(ctx context.Context, user AuthUser, campaignID string, calculator *calculatorService) (*campaignRecord, campaignSummary, error) {
	campaign, err := s.getCampaign(ctx, user, campaignID)
	if err != nil {
		return nil, campaignSummary{}, err
	}
	if strings.EqualFold(strings.TrimSpace(campaign.Status), "submitted") {
		return nil, campaignSummary{}, errors.New("Submitted campaigns cannot be edited")
	}

	lines := normalizeCampaignLines(campaign.Values)
	summary, err := calculator.calculateCampaign(campaign.TenantID, lines)
	if err != nil {
		return nil, campaignSummary{}, err
	}
	campaign.Values.Quantity = strconv.Itoa(summary.GrandTotal.TotalUnits)

	formData, err := marshalJSON(campaign.Values)
	if err != nil {
		return nil, campaignSummary{}, err
	}
	summaryData, err := marshalJSON(summary)
	if err != nil {
		return nil, campaignSummary{}, err
	}

	commandTag, err := s.pool.Exec(ctx, `
		UPDATE campaigns
		SET status = 'in_progress',
			form_data = $3::jsonb,
			calculation_summary = $4::jsonb,
			updated_by_user_id = $5,
			updated_at = NOW()
		WHERE id = $1 AND tenant_id = $2 AND status <> 'submitted'
	`, campaignID, campaign.TenantID, string(formData), string(summaryData), user.ID)
	if err != nil {
		return nil, campaignSummary{}, err
	}
	if commandTag.RowsAffected() == 0 {
		return nil, campaignSummary{}, s.submittedCampaignEditError(ctx, user, campaignID)
	}

	updatedCampaign, err := s.getCampaign(ctx, user, campaignID)
	if err != nil {
		return nil, campaignSummary{}, err
	}
	return updatedCampaign, summary, nil
}

func (s *campaignStore) recordSubmission(ctx context.Context, user AuthUser, campaignID string, requestPayload, responsePayload any, amount any, externalJobIDs []string, markSubmitted bool, checkpoints ...printIQRecordCheckpoint) (*campaignRecord, error) {
	campaign, err := s.getCampaign(ctx, user, campaignID)
	if err != nil {
		return nil, err
	}
	if strings.EqualFold(strings.TrimSpace(campaign.Status), "submitted") && !canResubmitSubmittedCampaign(user) {
		return nil, errors.New("Campaign has already been submitted")
	}

	requestPayloadJSON, err := marshalJSON(requestPayload)
	if err != nil {
		return nil, err
	}
	responsePayloadJSON, err := marshalJSON(responsePayload)
	if err != nil {
		return nil, err
	}

	var amountText *string
	if amount != nil {
		value := fmt.Sprintf("%v", amount)
		amountText = &value
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if len(checkpoints) > 0 {
		checkpoint := checkpoints[0]
		var recorded bool
		if err := tx.QueryRow(ctx, `SELECT recorded_markets ? $2 FROM printiq_submission_progress WHERE id=$1 AND campaign_id=$3 AND tenant_id=$4 FOR UPDATE`, checkpoint.ID, checkpoint.Market, campaign.ID, campaign.TenantID).Scan(&recorded); err != nil {
			return nil, err
		}
		if recorded {
			return s.getCampaign(ctx, user, campaign.ID)
		}
		if _, err := tx.Exec(ctx, `UPDATE printiq_submission_progress SET recorded_markets=recorded_markets || jsonb_build_object($2::text,true), completed=$3, updated_at=NOW() WHERE id=$1`, checkpoint.ID, checkpoint.Market, checkpoint.Final); err != nil {
			return nil, err
		}
	}

	quoteID := uuid.NewString()
	if _, err := tx.Exec(ctx, `
		INSERT INTO quotes (id, tenant_id, campaign_id, amount, status, request_payload, response_payload, created_by_user_id, created_at, updated_at)
		VALUES ($1, $2, $3, $4, 'priced', $5::jsonb, $6::jsonb, $7, NOW(), NOW())
	`, quoteID, campaign.TenantID, campaign.ID, amountText, string(requestPayloadJSON), string(responsePayloadJSON), user.ID); err != nil {
		return nil, err
	}

	for _, externalJobID := range externalJobIDs {
		trimmedJobID := strings.TrimSpace(externalJobID)
		if trimmedJobID == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO jobs (id, tenant_id, campaign_id, quote_id, external_job_id, status, request_payload, response_payload, created_by_user_id, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, 'submitted_to_printiq', $6::jsonb, $7::jsonb, $8, NOW(), NOW())
		`, uuid.NewString(), campaign.TenantID, campaign.ID, quoteID, trimmedJobID, string(requestPayloadJSON), string(responsePayloadJSON), user.ID); err != nil {
			return nil, err
		}
	}

	if markSubmitted {
		if _, err := tx.Exec(ctx, `
			UPDATE campaigns
			SET status = 'submitted',
				latest_quote_amount = $3,
				submitted_at = NOW(),
				updated_by_user_id = $4,
				updated_at = NOW()
			WHERE id = $1 AND tenant_id = $2
		`, campaign.ID, campaign.TenantID, amountText, user.ID); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	return s.getCampaign(ctx, user, campaign.ID)
}

func (s *campaignStore) deleteCampaign(ctx context.Context, user AuthUser, campaignID string) error {
	if user.TenantID == nil {
		return errors.New("current user is not assigned to a tenant")
	}

	commandTag, err := s.pool.Exec(ctx, `
		DELETE FROM campaigns
		WHERE id = $1 AND tenant_id = $2 AND status <> 'submitted'
	`, campaignID, *user.TenantID)
	if err != nil {
		return err
	}
	if commandTag.RowsAffected() == 0 {
		return s.submittedCampaignEditError(ctx, user, campaignID)
	}
	return nil
}

func (s *campaignStore) markCampaignSubmitted(ctx context.Context, user AuthUser, campaignID string) (*campaignRecord, error) {
	if user.TenantID == nil {
		return nil, errors.New("current user is not assigned to a tenant")
	}

	commandTag, err := s.pool.Exec(ctx, `
		UPDATE campaigns
		SET status = 'submitted',
			submitted_at = NOW(),
			updated_by_user_id = $3,
			updated_at = NOW()
		WHERE id = $1 AND tenant_id = $2
	`, campaignID, *user.TenantID, user.ID)
	if err != nil {
		return nil, err
	}
	if commandTag.RowsAffected() == 0 {
		return nil, errors.New("Campaign not found")
	}

	return s.getCampaign(ctx, user, campaignID)
}

var errCampaignNotSubmitted = errors.New("Only submitted campaigns can be reset to In Progress")

func (s *campaignStore) resetCampaignStatus(ctx context.Context, user AuthUser, campaignID string) (*campaignRecord, error) {
	if user.Role != "super_admin" {
		return nil, errors.New("Only super admins can reset campaign status")
	}
	if user.TenantID == nil {
		return nil, errors.New("current user is not assigned to a tenant")
	}
	row, err := scanCampaignRow(s.pool.QueryRow(ctx, `
		UPDATE campaigns
		SET status = 'in_progress', submitted_at = NULL,
			updated_by_user_id = $3, updated_at = NOW()
		WHERE id = $1 AND tenant_id = $2 AND status = 'submitted'
		RETURNING id, tenant_id, parent_campaign_id::text, created_by_user_id, updated_by_user_id, status, form_data, calculation_summary, purchase_order, latest_quote_amount::text, created_at, updated_at
	`, campaignID, *user.TenantID, user.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		if _, lookupErr := s.getCampaign(ctx, user, campaignID); lookupErr != nil {
			return nil, lookupErr
		}
		return nil, errCampaignNotSubmitted
	}
	if err != nil {
		return nil, err
	}
	return decodeCampaignRow(row)
}
