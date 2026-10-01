package main

import (
	"encoding/json"
	"testing"
)

func TestPrintIQPrintingTitlesIncludeCampaignCreator(t *testing.T) {
	values := orderFormValues{
		ClientName: "Client", PurchaseOrderNumber: "PO-123", CampaignName: "Campaign",
		CreatedByDisplayName: "  Dean Wright  ",
		CampaignMarkets:      []campaignMarket{{Market: "VIC", DueDate: "2026-10-05"}},
	}
	products := []printIQSheetProduct{
		{Market: "VIC", SheetCode: "S1", ProductCode: "Quad", Quantity: 1},
		{Market: "VIC", SheetCode: "S2", ProductCode: "Double", Quantity: 2},
	}
	plans, err := buildPrintIQMarketPlans(values, nil, products, nil, nil, nil, "C123")
	if err != nil {
		t.Fatal(err)
	}
	plan := plans[0]
	initial := buildPrintIQCreateQuotePayload(plan.Values, nil, plan.Products[0], 0)
	additional := buildPrintIQGetPricePayload(plan.Values, plan.Products[1], "Q123", "C123")
	if got := initial["JobTitle"]; got != "C1_Client_PO-123_S1-Quad-Campaign_Dean Wright" {
		t.Fatalf("initial title = %v", got)
	}
	if got := additional["JobTitle"]; got != "C1_Client_PO-123_S2-Double-Campaign_Dean Wright" {
		t.Fatalf("additional title = %v", got)
	}
	if got := plan.DeliveryPayloads[0]["JobTitle"]; got != "VIC ($0) Direct Deliver Monday 5th October (Campaign)" {
		t.Fatalf("delivery title changed: %v", got)
	}
}

func TestCampaignCreatorTitleCannotComeFromClientJSON(t *testing.T) {
	var values orderFormValues
	if err := json.Unmarshal([]byte(`{"CreatedByDisplayName":"Submitter","createdByDisplayName":"Spoofed"}`), &values); err != nil {
		t.Fatal(err)
	}
	if values.CreatedByDisplayName != "" {
		t.Fatal("creator name must be resolved on the server")
	}
}
