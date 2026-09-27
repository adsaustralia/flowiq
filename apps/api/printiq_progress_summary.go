package main

import (
	"fmt"
	"net/http"
	"strings"
)

type printIQProgressSummary struct {
	Progress         int    `json:"progress"`
	Label            string `json:"label"`
	CompletedCalls   int    `json:"completedCalls"`
	TotalCalls       int    `json:"totalCalls"`
	CompletedUploads int    `json:"completedUploads"`
	TotalUploads     int    `json:"totalUploads"`
}

// Weights describe completed work, not elapsed time or bytes transferred.
// Each upload includes PrintIQ downloading/processing the file and our pacing.
func (j *printIQJournal) progressSummary() printIQProgressSummary {
	result := printIQProgressSummary{Progress: 5, Label: "Preparing PrintIQ submission"}
	for _, plan := range j.Plans {
		result.TotalCalls += 2*len(plan.Products) + 2 + len(plan.DeliveryPayloads)
		if j.PurchaseOrder != nil {
			result.TotalUploads++
		}
		if j.Visuals != nil {
			result.TotalUploads++
		}
		for _, product := range plan.Products {
			if j.Artworks[product.ArtworkImageID] != nil {
				result.TotalUploads++
			}
		}
	}
	result.TotalCalls += result.TotalUploads
	completedWeight := 0
	for _, step := range j.Steps {
		if step.State != "done" {
			continue
		}
		result.CompletedCalls++
		completedWeight++
		if step.Name == "UploadArtworkURL" {
			result.CompletedUploads++
			completedWeight += 4
		}
	}
	totalWeight := result.TotalCalls + 4*result.TotalUploads
	if totalWeight > 0 {
		result.Progress = min(95, 5+90*completedWeight/totalWeight)
	}
	if step := j.Steps[j.CurrentStep]; step != nil {
		labels := map[string]string{
			"CreateQuoteWithDelivery": "Creating quote",
			"GetPrice":                "Adding jobs",
			"GetQuoteQuestions":       "Preparing proof contact",
			"SaveQuoteQuestions":      "Saving proof contact",
			"AcceptQuote":             "Accepting quote",
			"UploadArtworkURL":        "Uploading attachments",
		}
		result.Label = labels[step.Name]
		if result.Label == "" {
			result.Label = "Processing submission"
		}
		if index := strings.LastIndex(j.CurrentStep, ":"); index > 0 {
			result.Label = j.CurrentStep[:index] + ": " + result.Label
		}
		if step.Name == "UploadArtworkURL" {
			result.Label += fmt.Sprintf(" — %d of %d complete", result.CompletedUploads, result.TotalUploads)
			if step.AutoRetry && step.State != "done" {
				result.Label += " (automatic retry 1 of 1)"
			}
		}
	}
	if result.TotalCalls > 0 && result.CompletedCalls == result.TotalCalls {
		result.Label = "Saving submission results"
	}
	return result
}

// Regular campaign viewers receive counts only, never saved payloads or URLs.
// The separate reconciliation endpoint remains restricted to super admins.
func (a *app) handleSubmissionProgress(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, err := a.userWithManagedTenant(r)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	campaign, err := a.campaignStore.getCampaign(r.Context(), *user, r.PathValue("campaignId"))
	if err != nil {
		writeJSON(w, 404, map[string]string{"error": "Campaign not found"})
		return
	}
	j, err := a.loadPrintIQJournal(r.Context(), campaign)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "Unable to load submission progress"})
		return
	}
	if j == nil {
		writeJSON(w, 200, printIQProgressSummary{Progress: 5, Label: "Preparing PrintIQ submission"})
		return
	}
	writeJSON(w, 200, j.progressSummary())
}
