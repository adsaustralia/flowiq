package main

import (
	"encoding/json"
	"testing"
)

func TestLegacyCampaignMarketDates(t *testing.T) {
	var values orderFormValues
	err := json.Unmarshal([]byte(`{"dueDate":"2026-10-10","campaignMarkets":[{"market":"Brisbane"},{"market":"Sydney","dueDate":"2026-10-12"},{"market":"Melbourne","dueDate":""}]}`), &values)
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{"2026-10-10", "2026-10-12", ""} {
		if values.CampaignMarkets[i].DueDate != want {
			t.Fatalf("market %d: got %q, want %q", i, values.CampaignMarkets[i].DueDate, want)
		}
	}
	if values.DueDate != "" {
		t.Fatal("legacy campaign date must not survive normalization")
	}
	data, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	var reloaded orderFormValues
	if err := json.Unmarshal(data, &reloaded); err != nil {
		t.Fatal(err)
	}
	if reloaded.CampaignMarkets[0].DueDate != "2026-10-10" || reloaded.CampaignMarkets[2].DueDate != "" {
		t.Fatal("market dates changed after save/reload")
	}
}

func TestMarketPlansRejectMissingInvalidOrConflictingDates(t *testing.T) {
	for _, markets := range [][]campaignMarket{
		{{Market: "Sydney"}},
		{{Market: "Sydney", DueDate: "2026-02-30"}},
		{{Market: "Sydney", DueDate: "2026-10-05"}, {Market: "NSW", DueDate: "2026-10-06"}},
	} {
		_, err := buildPrintIQMarketPlans(orderFormValues{DueDate: "2026-10-20", CampaignMarkets: markets}, nil, []printIQSheetProduct{{Market: "Sydney"}}, nil, nil, nil, "C1")
		if err == nil {
			t.Fatalf("expected invalid market dates to fail: %#v", markets)
		}
	}
}

func TestValidateCampaignMarketDates(t *testing.T) {
	if err := validateCampaignDates(orderFormValues{CampaignMarkets: []campaignMarket{{Market: "Sydney", DueDate: "2000-01-01"}}}); err == nil {
		t.Fatal("past market date must fail")
	}
	if err := validateCampaignDates(orderFormValues{CampaignMarkets: []campaignMarket{{Market: "Sydney", DueDate: "invalid"}}}); err == nil {
		t.Fatal("invalid market date must fail")
	}
	if err := validateCampaignDates(orderFormValues{CampaignMarkets: []campaignMarket{{Market: "Sydney"}}}); err != nil {
		t.Fatalf("draft may omit date: %v", err)
	}
}
