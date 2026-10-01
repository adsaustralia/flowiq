package main

import (
	"strings"
	"testing"
)

func TestDeliveryJobsUseMarketCodesCostsAndDescriptions(t *testing.T) {
	address := "Shay Mehin\n6 Bakehouse St\nKensington VIC 3031\nPhone: 0411 491 541\nDelivery time: 10am-3pm\nNotes: Pallet jack required\nAustralia"
	values := orderFormValues{CampaignName: "Marc Jacobs", DueDate: "2026-09-16", CreativeNameAssignments: map[string]string{"Creative4": "art"}, CampaignMarkets: []campaignMarket{
		{Market: "VIC", DueDate: "2026-09-16", Assets: []campaignAsset{{ID: "vic", CreativeImageID: "art", DeliveryAddress: address}}},
		{Market: "NSW"}, {Market: "QLD"}, {Market: "VIC"},
	}}
	summary := &campaignSummary{Lines: []campaignLineResult{{ID: "vic", Market: "VIC", Breakdown: quantityBreakdown{"8-sheet": 8}}}, PerMarket: []campaignTotals{{Market: "VIC", Breakdown: quantityBreakdown{"8-sheet": 8}}}}
	products := []printIQSheetProduct{{Market: "VIC", FormatKey: "8-sheet", Quantity: 8, ProductCode: "Melb Quad", ArtworkImageID: "art", DeliveryAddress: address}, {Market: "NSW", FormatKey: "4-sheet", Quantity: 2, ProductCode: "Sydney Product"}}
	payloads, err := buildPrintIQDeliveryJobPayloads(values, summary, products, []marketShippingRateRecord{{Market: "VIC", UseFlatRateSheeters: true, EightSheeterPrice: 65}}, nil, nil, "C00003")
	if err != nil || len(payloads) != 3 {
		t.Fatalf("payloads=%#v error=%v", payloads, err)
	}
	for i, code := range []string{"VIC Delivery", "NSW Delivery", "QLD Delivery"} {
		p := payloads[i]
		if p["ProductCode"] != code || p["CustomerCode"] != "C00003" || p["AcceptQuote"] != false {
			t.Fatalf("wrong delivery payload: %#v", p)
		}
		if p["SelectedQuantity"].(map[string]any)["Quantity"] != 1 {
			t.Fatalf("dummy quantity must be one: %#v", p)
		}
		for _, field := range []string{"ArtworkUrl", "Deliveries", "Notes", "TargetFreightPrice"} {
			if _, exists := p[field]; exists {
				t.Fatalf("unexpected field %s: %#v", field, p)
			}
		}
	}
	if title := payloads[0]["JobTitle"]; title != "VIC ($65) Direct Deliver Wednesday 16th September (Marc Jacobs)" {
		t.Fatalf("wrong title: %v", title)
	}
	description := payloads[0]["JobDescription"].(string)
	for _, expected := range []string{"Deliver to Shay Mehin by Wednesday 16th September by COB:", "Creative 4 (Quad): 8 x Melb Quad", address} {
		if !strings.Contains(description, expected) {
			t.Fatalf("description missing %q: %s", expected, description)
		}
	}
	if strings.Contains(description, "Sydney Product") {
		t.Fatal("description included another market")
	}
}

func TestDeliveryJobsRejectUnconfiguredMarket(t *testing.T) {
	_, err := buildPrintIQDeliveryJobPayloads(orderFormValues{CampaignMarkets: []campaignMarket{{Market: "WA"}}}, nil, nil, nil, nil, nil, "C00003")
	if err == nil {
		t.Fatal("expected unknown delivery product error before submission")
	}
}

func TestPrintIQDeliveryDate(t *testing.T) {
	for input, expected := range map[string]string{"2026-09-01": "Tuesday 1st September", "2026-09-02": "Wednesday 2nd September", "2026-09-03": "Thursday 3rd September", "2026-09-11": "Friday 11th September", "": ""} {
		if got := printIQDeliveryDate(input); got != expected {
			t.Fatalf("%s: got %q want %q", input, got, expected)
		}
	}
}

func TestDeliveryJobsAcceptCityMarkets(t *testing.T) {
	for market, code := range map[string]string{"Brisbane": "QLD Delivery", "Sydney": "NSW Delivery", "Melbourne": "VIC Delivery", " brisbane ": "QLD Delivery", "qld": "QLD Delivery"} {
		payloads, err := buildPrintIQDeliveryJobPayloads(orderFormValues{CampaignMarkets: []campaignMarket{{Market: market}}}, nil, nil, nil, nil, nil, "C00003")
		if err != nil || len(payloads) != 1 || payloads[0]["ProductCode"] != code {
			t.Fatalf("market %q: payloads=%#v error=%v", market, payloads, err)
		}
	}
	_, err := buildPrintIQDeliveryJobPayloads(orderFormValues{CampaignMarkets: []campaignMarket{{Market: "Perth"}}}, nil, nil, nil, nil, nil, "C00003")
	if err == nil || !strings.Contains(err.Error(), "market Perth, job type Delivery") {
		t.Fatalf("expected the affected delivery job in error: %v", err)
	}
}
