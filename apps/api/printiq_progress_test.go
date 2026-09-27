package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrintIQJournalResumeAfterRestart(t *testing.T) {
	j := &printIQJournal{Steps: map[string]*printIQSavedStep{}}
	var disk []byte
	j.save = func() error { var err error; disk, err = json.Marshal(j); return err }
	calls := map[string]int{}
	upload := func(key string, fail bool) *printIQSubmissionFailure {
		_, f := j.run(key, "UploadArtworkURL", map[string]any{"JobNo": key}, func() (any, *printIQSubmissionFailure) {
			calls[key]++
			if fail {
				return nil, &printIQSubmissionFailure{Status: 400, Body: map[string]any{"printIqMessage": "Artwork rejected"}}
			}
			return map[string]any{"isError": false}, nil
		})
		return f
	}
	if upload("J1", false) != nil || upload("J2", true) == nil || upload("J3", false) != nil {
		t.Fatal("initial upload states incorrect")
	}
	var restarted printIQJournal
	if err := json.Unmarshal(disk, &restarted); err != nil {
		t.Fatal(err)
	}
	j = &restarted
	j.save = func() error { return nil }
	for _, key := range []string{"J1", "J2", "J3"} {
		if upload(key, false) != nil {
			t.Fatal("resume failed")
		}
	}
	if calls["J1"] != 1 || calls["J2"] != 3 || calls["J3"] != 1 {
		t.Fatalf("replayed successful uploads: %v", calls)
	}
}

func TestPrintIQAutomaticUploadRetry(t *testing.T) {
	for _, tc := range []struct {
		name, step, message string
		recover             bool
		calls               int
	}{
		{"recovers", "UploadArtworkURL", "Artwork rejected", true, 2},
		{"stops after one retry", "UploadArtworkURL", "Artwork rejected", false, 2},
		{"application timeout", "UploadArtworkURL", "The operation has timed out", false, 1},
		{"network error", "UploadArtworkURL", "", false, 1},
		{"quote creation", "CreateQuoteWithDelivery", "Rejected", false, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls, waits := 0, 0
			j := &printIQJournal{Steps: map[string]*printIQSavedStep{}, save: func() error { return nil }, waitRetry: func() error { waits++; return nil }}
			_, failure := j.run("Sydney:0", tc.step, map[string]any{"JobNo": "J1"}, func() (any, *printIQSubmissionFailure) {
				calls++
				if tc.recover && calls == 2 {
					return map[string]any{"IsError": false}, nil
				}
				body := map[string]any{"error": "Failed"}
				if tc.message != "" {
					body["printIqMessage"] = tc.message
				}
				return nil, &printIQSubmissionFailure{Status: 400, Body: body}
			})
			if calls != tc.calls || waits != tc.calls-1 || (failure == nil) != tc.recover {
				t.Fatalf("calls=%d waits=%d failure=%v", calls, waits, failure)
			}
			if tc.recover {
				j.run("Sydney:0", tc.step, map[string]any{"JobNo": "J1"}, func() (any, *printIQSubmissionFailure) { t.Fatal("successful retry replayed"); return nil, nil })
			}
		})
	}
}

func TestPrintIQAutomaticRetryStopsOnCancellationOrPersistenceFailure(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		calls, saves := 0, 0
		j := &printIQJournal{Steps: map[string]*printIQSavedStep{}}
		j.save = func() error {
			saves++
			if !cancel && saves == 3 {
				return errors.New("database unavailable")
			}
			return nil
		}
		j.waitRetry = func() error { return errors.New("request cancelled") }
		_, failure := j.run("Sydney:0", "UploadArtworkURL", map[string]any{}, func() (any, *printIQSubmissionFailure) {
			calls++
			return nil, &printIQSubmissionFailure{Status: 400, Body: map[string]any{"printIqMessage": "Rejected"}}
		})
		if calls != 1 || failure == nil {
			t.Fatalf("unsafe retry: %d %v", calls, failure)
		}
	}
}

func TestPrintIQTimeoutRequiresReconciliation(t *testing.T) {
	j := &printIQJournal{Steps: map[string]*printIQSavedStep{}, save: func() error { return nil }}
	calls := 0
	call := func() (any, *printIQSubmissionFailure) {
		calls++
		return nil, &printIQSubmissionFailure{Status: 400, Body: map[string]any{"printIqMessage": "The operation has timed out"}}
	}
	for i := 0; i < 2; i++ {
		j.run("Sydney:5", "UploadArtworkURL", map[string]any{"JobNo": "J1"}, call)
	}
	if calls != 1 {
		t.Fatal("timeout was blindly retried")
	}
	if err := j.resolveUpload("Sydney:5", "confirmed_uploaded", "Verified attachment on J1", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, failure := j.run("Sydney:5", "UploadArtworkURL", map[string]any{"JobNo": "J1"}, call); failure != nil || calls != 1 {
		t.Fatal("confirmed upload resent")
	}
	j.Steps["create"] = &printIQSavedStep{Name: "CreateQuoteWithDelivery", State: "pending"}
	if err := j.resolveUpload("create", "confirmed_missing", "checked", "admin"); err == nil {
		t.Fatal("allowed quote creation replay")
	}
	j.Steps["Sydney:6"] = &printIQSavedStep{Name: "UploadArtworkURL", State: "pending"}
	if err := j.resolveUpload("Sydney:6", "confirmed_missing", "Not present in PrintIQ", "admin"); err != nil {
		t.Fatal(err)
	}
	if j.Steps["Sydney:6"].State != "failed" || len(j.Resolutions) != 2 {
		t.Fatal("resolution not recorded")
	}
}

func TestPrintIQResponseCheckpointFailureDoesNotResend(t *testing.T) {
	saves, calls := 0, 0
	var disk []byte
	j := &printIQJournal{Steps: map[string]*printIQSavedStep{}}
	j.save = func() error {
		saves++
		if saves == 2 {
			return errors.New("lost database")
		}
		disk, _ = json.Marshal(j)
		return nil
	}
	j.run("key", "AcceptQuote", map[string]any{}, func() (any, *printIQSubmissionFailure) { calls++; return map[string]any{"JobNo": "J1"}, nil })
	var restored printIQJournal
	if err := json.Unmarshal(disk, &restored); err != nil {
		t.Fatal(err)
	}
	restored.save = func() error { return nil }
	restored.run("key", "AcceptQuote", map[string]any{}, func() (any, *printIQSubmissionFailure) { calls++; return nil, nil })
	if calls != 1 {
		t.Fatal("uncertain acceptance resent")
	}
}

func TestLegacySubmissionPreventsDuplicateQuote(t *testing.T) {
	dir := t.TempDir()
	a := &app{logDir: dir}
	campaign := &campaignRecord{ID: "campaign", TenantID: "tenant"}
	path := filepath.Join(dir, printIQLogPrefix+"2026-09-22"+printIQLogSuffix)
	rows := []string{
		`{"campaignId":"campaign","tenantId":"tenant","requestId":"r1","timestamp":"2026-09-22T14:06:02Z","type":"response","response":{"quoteNo":"Q51146"}}`,
		`{"campaignId":"campaign","tenantId":"tenant","requestId":"r1","timestamp":"2026-09-22T14:06:14Z","type":"error"}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(rows, "\n")+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := a.checkLegacyPrintIQProgress(campaign); err == nil || !strings.Contains(err.Error(), "Q51146") {
		t.Fatal("historical partial quote unprotected", err)
	}
	campaign.TenantID = "other"
	if err := a.checkLegacyPrintIQProgress(campaign); err != nil {
		t.Fatal("cross-tenant match", err)
	}
}

func TestPrintIQJournalNeverReplaysUncertainCalls(t *testing.T) {
	for _, step := range []string{"CreateQuoteWithDelivery", "AcceptQuote", "UploadArtworkURL"} {
		t.Run(step, func(t *testing.T) {
			calls := 0
			j := &printIQJournal{Steps: map[string]*printIQSavedStep{}, save: func() error { return nil }}
			call := func() (any, *printIQSubmissionFailure) {
				calls++
				return nil, &printIQSubmissionFailure{Status: 500, Body: map[string]any{"error": "connection lost"}}
			}
			for i := 0; i < 2; i++ {
				if _, f := j.run("key", step, map[string]any{}, call); f == nil {
					t.Fatal("expected failure")
				}
			}
			if calls != 1 {
				t.Fatalf("uncertain request resent %d times", calls)
			}
		})
	}
}

func TestPrintIQJournalPersistenceFailurePreventsCall(t *testing.T) {
	j := &printIQJournal{Steps: map[string]*printIQSavedStep{}, save: func() error { return errors.New("database unavailable") }}
	_, f := j.run("key", "CreateQuoteWithDelivery", map[string]any{}, func() (any, *printIQSubmissionFailure) { t.Fatal("sent without durable checkpoint"); return nil, nil })
	if f == nil {
		t.Fatal("missing error")
	}
}

func TestPrintIQJournalQuoteReplayAndChangedPayload(t *testing.T) {
	j := &printIQJournal{Steps: map[string]*printIQSavedStep{}, save: func() error { return nil }}
	calls := 0
	call := func() (any, *printIQSubmissionFailure) { calls++; return map[string]any{"QuoteNo": "Q1"}, nil }
	for i := 0; i < 2; i++ {
		r, f := j.run("key", "CreateQuoteWithDelivery", map[string]any{"Quantity": 1}, call)
		if f != nil || fmt.Sprint(r) != "map[QuoteNo:Q1]" {
			t.Fatal(r, f)
		}
	}
	if _, f := j.run("key", "CreateQuoteWithDelivery", map[string]any{"Quantity": 2}, call); f == nil {
		t.Fatal("allowed changed payload")
	}
	if calls != 1 {
		t.Fatal("quote duplicated")
	}
}
