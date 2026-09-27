package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSubmitPrintIQMarketsRoutesQuotesDatesAndAttachments(t *testing.T) {
	_, plans := marketSubmissionFixture(t)
	quoteIndex := -1
	productCount := 0
	quoteNo := ""
	uploads := map[string][]string{}
	accepts := 0
	failedUploadsRemaining := 2
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p map[string]any
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			t.Error(err)
		}
		var response any = map[string]any{"IsError": false}
		switch strings.TrimPrefix(r.URL.Path, "/api/QuoteProcess/") {
		case "CreateQuoteWithDelivery":
			quoteIndex++
			productCount = 1
			quoteNo = fmt.Sprintf("Q%d", quoteIndex+1)
			plan := plans[quoteIndex]
			if p["ProductCode"] != plan.Products[0].ProductCode || p["DueDate"] != plan.Values.DueDate || p["CustomerExpectedDate"] != plan.Values.DueDate || p["TargetQuoteFreightPrice"] != plan.Freight {
				t.Errorf("wrong market quote payload: %#v", p)
			}
			if valueAtPath(p, "Quantity", "Quantity") != "8" {
				t.Errorf("first product must use its own quantity: %#v", p)
			}
			response = map[string]any{"QuoteNo": quoteNo, "QQDKey": quoteNo + "-1"}
		case "GetPrice":
			productCount++
			plan := plans[quoteIndex]
			wantCode := plan.Products[1].ProductCode
			if productCount == 3 {
				wantCode = printIQDeliveryProductCode(plan.Market)
			}
			if p["QuoteNo"] != quoteNo || p["ProductCode"] != wantCode {
				t.Errorf("product routed to wrong quote: %#v", p)
			}
			if _, exists := p["JobDueDate"]; exists {
				t.Errorf("GetPrice date override must be removed: %#v", p)
			}
			if _, exists := p["CustomerExpectedDate"]; exists {
				t.Errorf("GetPrice date override must be removed: %#v", p)
			}
			response = map[string]any{"ProductKey": productCount, "QuoteDetails": map[string]any{"Products": []any{map[string]any{"ProductKey": productCount, "QQDKey": quoteNo + "-2"}}}}
		case "GetQuoteQuestions":
			if !strings.HasPrefix(printIQStringValue(p["QQDKey"]), quoteNo+"-") {
				t.Errorf("proof contact routed to wrong quote: %#v", p)
			}
			response = map[string]any{"QQDPKey": p["QQDKey"]}
		case "SaveQuoteQuestions":
		case "AcceptQuote":
			accepts++
			if p["QuoteNo"] != quoteNo || p["DueDate"] != plans[quoteIndex].Values.DueDate || productCount != 3 {
				t.Errorf("wrong accepted quote/date/product count: %#v, %d", p, productCount)
			}
			products := []any{}
			for i := 1; i <= productCount; i++ {
				products = append(products, map[string]any{"JobNo": fmt.Sprintf("%s-J%d", quoteNo, i)})
			}
			response = map[string]any{"AcceptanceDetails": map[string]any{"Products": products}}
		case "UploadArtworkURL":
			job := printIQStringValue(p["JobNo"])
			if !strings.HasPrefix(job, quoteNo+"-") || strings.HasSuffix(job, "-J3") {
				t.Errorf("attachment sent to wrong job: %#v", p)
			}
			uploads[job] = append(uploads[job], printIQStringValue(p["ArtworkUrl"]))
			if job == "Q1-J1" && strings.HasSuffix(printIQStringValue(p["ArtworkUrl"]), "/po") && failedUploadsRemaining > 0 {
				failedUploadsRemaining--
				response = map[string]any{"IsError": true, "ErrorMessage": "Artwork rejected"}
			}

		default:
			t.Errorf("unexpected endpoint %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()
	service := newOptionService(server.URL, t.TempDir())
	service.setCachedLoginToken("test")
	a := &app{optionService: service, logDir: t.TempDir()}
	artworks := map[string]*printIQArtworkUpload{}
	for _, plan := range plans {
		for _, product := range plan.Products {
			artworks[product.ArtworkImageID] = &printIQArtworkUpload{ArtworkURL: "https://example.test/" + product.ArtworkImageID}
		}
	}
	for i, plan := range plans {
		journal := &printIQJournal{Steps: map[string]*printIQSavedStep{}, Plans: []printIQMarketPlan{plan}, Artworks: artworks, PurchaseOrder: &printIQArtworkUpload{}, Visuals: &printIQArtworkUpload{}}
		var persisted []byte
		journal.save = func() error { var err error; persisted, err = json.Marshal(journal); return err }
		result, failure := a.submitPrintIQMarket("test", &campaignRecord{}, AuthUser{}, plan, "C123", &printIQArtworkUpload{ArtworkURL: "https://example.test/po"}, &printIQArtworkUpload{ArtworkURL: "https://example.test/visuals"}, artworks, journal)
		if i == 0 {
			if failure == nil || len(uploads["Q1-J2"]) != 1 {
				t.Fatal("failure must continue to later jobs")
			}
			// Simulate process restart: quote acceptance and successful uploads must replay locally.
			var restored printIQJournal
			if err := json.Unmarshal(persisted, &restored); err != nil {
				t.Fatal(err)
			}
			restored.save = func() error { return nil }
			result, failure = a.submitPrintIQMarket("retry", &campaignRecord{}, AuthUser{}, plan, "C123", &printIQArtworkUpload{ArtworkURL: "https://example.test/po"}, &printIQArtworkUpload{ArtworkURL: "https://example.test/visuals"}, artworks, &restored)
			journal = &restored
			// Drop the failed attempt from the count used by the ordering assertion below.
			uploads["Q1-J1"] = uploads["Q1-J1"][1:4]
		}
		if failure != nil {
			t.Fatalf("submission failed: %#v", failure)
		}
		progress := journal.progressSummary()
		if progress.TotalCalls != len(journal.Steps) || progress.CompletedCalls != progress.TotalCalls || progress.CompletedUploads != progress.TotalUploads || progress.Progress != 95 {
			t.Fatalf("planned progress disagrees with actual PrintIQ calls: %+v (%d steps)", progress, len(journal.Steps))
		}
		wantQuote := fmt.Sprintf("Q%d", i+1)
		if result.QuoteNo != wantQuote || result.Market != plan.Market || result.DueDate != plan.Values.DueDate || len(result.JobNos) != 3 {
			t.Fatalf("incorrect market result: %#v", result)
		}
		if result.ResponsePayload["quoteNo"] != wantQuote || result.ResponsePayload["market"] != plan.Market {
			t.Fatal("persisted payload does not identify this market quote")
		}
	}
	if accepts != 3 {
		t.Fatalf("expected three distinct accepted quotes, got %d", accepts)
	}
	for i, plan := range plans {
		first := uploads[fmt.Sprintf("Q%d-J1", i+1)]
		second := uploads[fmt.Sprintf("Q%d-J2", i+1)]
		if len(first) != 3 || first[0] != "https://example.test/po" || first[1] != "https://example.test/visuals" || first[2] != artworks[plan.Products[0].ArtworkImageID].ArtworkURL || len(second) != 1 || second[0] != artworks[plan.Products[1].ArtworkImageID].ArtworkURL {
			t.Fatalf("attachments crossed market quotes or were lost: %#v", uploads)
		}
	}
}

func TestMarketFailureReportsPreviouslyCreatedQuotes(t *testing.T) {
	_, plans := marketSubmissionFixture(t)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if strings.HasSuffix(r.URL.Path, "/CreateQuoteWithDelivery") {
			_, _ = w.Write([]byte(`{"QuoteNo":"Q2","QQDKey":1}`))
			return
		}
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"Message":"Failed"}`))
	}))
	defer server.Close()
	service := newOptionService(server.URL, t.TempDir())
	service.setCachedLoginToken("test")
	a := &app{optionService: service, logDir: t.TempDir()}
	result, failure := a.submitPrintIQMarket("test", &campaignRecord{}, AuthUser{}, plans[1], "C123", nil, nil, nil)
	if failure == nil || result.QuoteNo != "Q2" || calls != 2 {
		t.Fatalf("failure lost created quote or continued submitting: %#v %#v calls=%d", result, failure, calls)
	}
	w := httptest.NewRecorder()
	writePrintIQMarketFailure(w, failure, "Sydney", []*printIQMarketSubmission{{Market: "Brisbane", QuoteNo: "Q1"}}, result)
	if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "Q1, Q2") || !strings.Contains(w.Body.String(), "before retrying") {
		t.Fatalf("partial submission was not reported: %s", w.Body.String())
	}
}
