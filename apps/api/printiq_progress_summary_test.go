package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestProgressWeightsUploadsAndExcludesUncertainCalls(t *testing.T) {
	j := &printIQJournal{
		Plans:    []printIQMarketPlan{{Market: "Sydney", Products: []printIQSheetProduct{{ArtworkImageID: "a"}, {ArtworkImageID: "a"}}, DeliveryPayloads: []map[string]any{{}}}},
		Artworks: map[string]*printIQArtworkUpload{"a": {}}, PurchaseOrder: &printIQArtworkUpload{}, Visuals: &printIQArtworkUpload{},
		Steps: map[string]*printIQSavedStep{},
	}
	// Seven quote/job/contact calls are complete, but all four uploads remain.
	for i := 0; i < 7; i++ {
		j.Steps[fmt.Sprintf("Sydney:%d", i)] = &printIQSavedStep{Name: "GetPrice", State: "done"}
	}
	j.CurrentStep = "Sydney:7"
	j.Steps[j.CurrentStep] = &printIQSavedStep{Name: "UploadArtworkURL", State: "pending"}
	before := j.progressSummary()
	if before.TotalUploads != 4 || before.TotalCalls != 11 || before.Progress >= 40 || !strings.Contains(before.Label, "0 of 4") {
		t.Fatalf("uploads not reserved sufficient weight: %+v", before)
	}
	j.Steps[j.CurrentStep].State = "failed"
	if got := j.progressSummary(); got.Progress != before.Progress {
		t.Fatal("failed upload advanced progress")
	}
	j.Steps[j.CurrentStep].State = "done"
	after := j.progressSummary()
	if after.Progress <= before.Progress || after.CompletedUploads != 1 || !strings.Contains(after.Label, "1 of 4") {
		t.Fatalf("completed upload not reflected: %+v", after)
	}
	// Count attachments per job, even when two jobs use the same source image.
	if after.TotalUploads != 4 {
		t.Fatal("shared artwork URL incorrectly deduplicated")
	}
}
