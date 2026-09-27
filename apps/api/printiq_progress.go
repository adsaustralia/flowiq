package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type printIQSavedStep struct {
	Name     string
	Payload  string
	State    string
	Response any
	Failure  *printIQSubmissionFailure
}

type printIQJournal struct {
	ID            string
	Fingerprint   string
	Test          bool
	Creator       string
	Plans         []printIQMarketPlan
	CustomerCode  string
	PurchaseOrder *printIQArtworkUpload
	Visuals       *printIQArtworkUpload
	Artworks      map[string]*printIQArtworkUpload
	Steps         map[string]*printIQSavedStep
	Resolutions   []printIQUploadResolution
	save          func() error
	wait          func() error
}

func progressFailure(message string) *printIQSubmissionFailure {
	return &printIQSubmissionFailure{Status: 409, Body: map[string]any{"error": message}}
}

func (j *printIQJournal) run(key, step string, payload any, call func() (any, *printIQSubmissionFailure)) (any, *printIQSubmissionFailure) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, progressFailure("Unable to encode submission progress")
	}
	previous := j.Steps[key]
	if previous != nil {
		if previous.Payload != string(encoded) {
			return nil, progressFailure("Submission inputs changed. ADS must reconcile the existing PrintIQ quote before continuing")
		}
		if previous.State == "done" {
			return previous.Response, nil
		}
		// No idempotency guarantee: a lost response must never trigger a blind resend.
		if previous.State == "pending" {
			return nil, progressFailure("PrintIQ call outcome is uncertain. ADS must check the existing quote/job before this step can be retried")
		}
		if step != "UploadArtworkURL" {
			return nil, previous.Failure
		}
	}
	if step == "UploadArtworkURL" && j.wait != nil {
		if err := j.wait(); err != nil {
			return nil, progressFailure("Submission interrupted; completed steps are saved")
		}
	}
	saved := &printIQSavedStep{Name: step, Payload: string(encoded), State: "pending"}
	j.Steps[key] = saved
	if err := j.save(); err != nil {
		return nil, progressFailure("Unable to save submission progress; no further PrintIQ request was sent")
	}
	response, failure := call()
	saved.Response, saved.Failure = response, failure
	if failure == nil {
		saved.State = "done"
	} else {
		// Only an explicit PrintIQ application error is a known failed request.
		// Network/HTTP errors retain pending and require reconciliation.
		message, explicit := failure.Body["printIqMessage"].(string)
		lower := strings.ToLower(message)
		if explicit && !strings.Contains(lower, "timed out") && !strings.Contains(lower, "timeout") {
			saved.State = "failed"
		}
	}
	if err := j.save(); err != nil {
		saved.State = "pending"
		return nil, progressFailure("PrintIQ replied but progress could not be saved. ADS must reconcile this call before retrying")
	}
	return response, failure
}

func campaignSubmissionFingerprint(c *campaignRecord) string {
	encoded, _ := json.Marshal([]any{c.Values, c.PurchaseOrder})
	return fmt.Sprintf("%x", sha256.Sum256(encoded))
}

func (a *app) loadPrintIQJournal(ctx context.Context, campaign *campaignRecord) (*printIQJournal, error) {
	var raw []byte
	err := a.campaignStore.pool.QueryRow(ctx, `SELECT data FROM printiq_submission_progress WHERE campaign_id=$1 AND tenant_id=$2 AND NOT completed`, campaign.ID, campaign.TenantID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var journal printIQJournal
	if err := json.Unmarshal(raw, &journal); err != nil {
		return nil, err
	}
	for i := range journal.Plans {
		journal.Plans[i].Values.CreatedByDisplayName = journal.Creator
	}
	return &journal, nil
}

func (a *app) bindPrintIQJournal(requestContext context.Context, j *printIQJournal) {
	j.save = func() error {
		// Persist even when the browser disconnects while PrintIQ is responding.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		raw, err := json.Marshal(j)
		if err != nil {
			return err
		}
		tag, err := a.campaignStore.pool.Exec(ctx, `UPDATE printiq_submission_progress SET data=$2::jsonb, updated_at=NOW() WHERE id=$1 AND NOT completed`, j.ID, raw)
		if err == nil && tag.RowsAffected() != 1 {
			return fmt.Errorf("submission progress missing")
		}
		return err
	}
	j.wait = func() error {
		timer := time.NewTimer(time.Second)
		defer timer.Stop()
		select {
		case <-requestContext.Done():
			return requestContext.Err()
		case <-timer.C:
			return nil
		}
	}
}

func (a *app) createPrintIQJournal(ctx context.Context, campaign *campaignRecord, j *printIQJournal) error {
	j.ID = uuid.NewString()
	j.Fingerprint = campaignSubmissionFingerprint(campaign)
	j.Steps = map[string]*printIQSavedStep{}
	raw, err := json.Marshal(j)
	if err != nil {
		return err
	}
	_, err = a.campaignStore.pool.Exec(ctx, `INSERT INTO printiq_submission_progress(id,campaign_id,tenant_id,data) VALUES($1,$2,$3,$4::jsonb)`, j.ID, campaign.ID, campaign.TenantID, raw)
	return err
}

type printIQRecordCheckpoint struct {
	ID     string
	Market string
	Final  bool
}

type printIQUploadResolution struct {
	StepKey string    `json:"stepKey"`
	Action  string    `json:"action"`
	Note    string    `json:"note"`
	UserID  string    `json:"userId"`
	At      time.Time `json:"at"`
}

func (j *printIQJournal) resolveUpload(key, action, note, userID string) error {
	step := j.Steps[key]
	if step == nil || step.Name != "UploadArtworkURL" || (step.State != "pending" && step.State != "failed") {
		return errors.New("Only an unresolved artwork upload can be reconciled")
	}
	if strings.TrimSpace(note) == "" {
		return errors.New("Record what was verified in PrintIQ")
	}
	switch action {
	case "confirmed_uploaded":
		step.State = "done"
		step.Response = map[string]any{"IsError": false, "Reconciled": true}
		step.Failure = nil
	case "confirmed_missing":
		step.State = "failed"
		step.Failure = progressFailure("Attachment confirmed missing; ready for retry")
	default:
		return errors.New("Action must be confirmed_uploaded or confirmed_missing")
	}
	j.Resolutions = append(j.Resolutions, printIQUploadResolution{StepKey: key, Action: action, Note: note, UserID: userID, At: time.Now().UTC()})
	return nil
}

// Read/reconcile endpoints are restricted to super admins and the managed tenant.
// They never send a PrintIQ request or reset quote/job creation steps.
func (a *app) handlePrintIQProgress(w http.ResponseWriter, r *http.Request) {
	user, err := a.userWithManagedTenant(r)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	if user.Role != "super_admin" {
		writeJSON(w, 403, map[string]string{"error": "Only super admins can reconcile PrintIQ uploads"})
		return
	}
	campaign, err := a.campaignStore.getCampaign(r.Context(), *user, r.PathValue("campaignId"))
	if err != nil {
		writeJSON(w, 404, map[string]string{"error": "Campaign not found"})
		return
	}
	if r.Method == http.MethodGet {
		j, err := a.loadPrintIQJournal(r.Context(), campaign)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": "Unable to load submission progress"})
			return
		}
		if j == nil {
			writeJSON(w, 404, map[string]string{"error": "No active submission progress"})
			return
		}
		writeJSON(w, 200, map[string]any{"submissionId": j.ID, "steps": j.Steps, "resolutions": j.Resolutions})
		return
	}
	var input struct {
		SubmissionID string `json:"submissionId"`
		StepKey      string `json:"stepKey"`
		Action       string `json:"action"`
		Note         string `json:"note"`
		Confirmed    bool   `json:"confirmedInPrintIQ"`
	}
	if err := decodeJSONBody(r, &input); err != nil || !input.Confirmed {
		writeJSON(w, 400, map[string]string{"error": "Confirm the attachment state in PrintIQ before resolving it"})
		return
	}
	tx, err := a.campaignStore.pool.Begin(r.Context())
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "Unable to lock progress"})
		return
	}
	defer tx.Rollback(r.Context())
	var locked bool
	if err = tx.QueryRow(r.Context(), "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))", "printiq:"+campaign.ID).Scan(&locked); err != nil || !locked {
		writeJSON(w, 409, map[string]string{"error": "Campaign submission is running; try after it finishes"})
		return
	}
	var raw []byte
	if err = tx.QueryRow(r.Context(), `SELECT data FROM printiq_submission_progress WHERE id=$1 AND campaign_id=$2 AND tenant_id=$3 AND NOT completed FOR UPDATE`, input.SubmissionID, campaign.ID, campaign.TenantID).Scan(&raw); err != nil {
		writeJSON(w, 409, map[string]string{"error": "Active submission not found"})
		return
	}
	var j printIQJournal
	if err = json.Unmarshal(raw, &j); err != nil {
		writeJSON(w, 500, map[string]string{"error": "Unable to read submission"})
		return
	}
	if err = j.resolveUpload(input.StepKey, input.Action, input.Note, user.ID); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	raw, err = json.Marshal(j)
	if err == nil {
		_, err = tx.Exec(r.Context(), `UPDATE printiq_submission_progress SET data=$2::jsonb,updated_at=NOW() WHERE id=$1`, j.ID, raw)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "Unable to save reconciliation"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "message": "Attachment reconciled. Submit again to resume the saved submission."})
}
