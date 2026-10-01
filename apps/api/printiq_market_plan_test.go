package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestPrintIQMarketDueDate(t *testing.T) {
	for _, tc := range []struct{ market, date, want string }{
		{"Brisbane", "2026-09-21", "2026-09-21"},
		{" qLd ", "2026-01-02", "2026-01-02"},
		{"Sydney", "2026-09-21", "2026-09-21"},
		{"NSW", "2024-03-01", "2024-03-01"},
		{"Melbourne", "2026-09-21", "2026-09-21"},
		{"VIC", " 2026-09-21 ", "2026-09-21"},
		{"Brisbane", "", ""},
	} {
		t.Run(tc.market+tc.date, func(t *testing.T) {
			got, err := printIQMarketDueDate(tc.date, tc.market)
			if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
		})
	}
	if _, err := printIQMarketDueDate("2026-02-30", "Brisbane"); err == nil {
		t.Fatal("expected invalid date to fail before submission")
	}
}

func marketSubmissionFixture(t *testing.T) (orderFormValues, []printIQMarketPlan) {
	t.Helper()
	values := orderFormValues{DueDate: "2026-10-01", CampaignName: "Campaign", PurchaseOrderNumber: "PO123"}
	summary := &campaignSummary{}
	products := []printIQSheetProduct{}
	rates := []marketShippingRateRecord{}
	for i, market := range []string{"Brisbane", "Sydney", "Melbourne"} {
		values.CampaignMarkets = append(values.CampaignMarkets, campaignMarket{Market: market, DueDate: []string{"2026-10-05", "2026-10-02", "2026-10-08"}[i], Assets: []campaignAsset{{ID: market, CreativeImageID: market, DeliveryAddress: "Warehouse\n1 Main Street"}}})
		summary.Lines = append(summary.Lines, campaignLineResult{ID: market, Market: market, Breakdown: quantityBreakdown{"8-sheet": 8}})
		summary.PerMarket = append(summary.PerMarket, campaignTotals{Market: market, Breakdown: quantityBreakdown{"8-sheet": 8}})
		products = append(products, printIQSheetProduct{Market: market, ProductCode: market + " Print", Quantity: 8, ArtworkImageID: market})
		rates = append(rates, marketShippingRateRecord{Market: market, UseMarketFlatRate: true, MarketFlatRate: float64(100 + i)})
	}
	// Interleaved products must be regrouped without crossing markets or reordering jobs.
	for _, market := range []string{"Brisbane", "Sydney", "Melbourne"} {
		products = append(products, printIQSheetProduct{Market: market, ProductCode: market + " Second", Quantity: 2, ArtworkImageID: market + "2"})
	}
	plans, err := buildPrintIQMarketPlans(values, summary, products, rates, nil, nil, "C123")
	if err != nil {
		t.Fatal(err)
	}
	return values, plans
}

func TestMarketPlansSeparateProductsFreightAndDates(t *testing.T) {
	values, plans := marketSubmissionFixture(t)
	if len(plans) != 3 {
		t.Fatalf("expected 3 market quotes, got %d", len(plans))
	}
	for i, plan := range plans {
		if len(plan.Products) != 2 || len(plan.Values.CampaignMarkets) != 1 || len(plan.DeliveryPayloads) != 1 {
			t.Fatalf("unexpected market grouping: %#v", plan)
		}
		if plan.Freight != float64(100+i) {
			t.Fatalf("%s freight includes another market: %v", plan.Market, plan.Freight)
		}
		for _, product := range plan.Products {
			if product.Market != plan.Market {
				t.Fatalf("product from another market: %#v", product)
			}
		}
		wantDate := []string{"2026-10-05", "2026-10-02", "2026-10-08"}[i]
		if plan.Values.DueDate != wantDate {
			t.Fatalf("%s: got %s want %s", plan.Market, plan.Values.DueDate, wantDate)
		}
		if !strings.Contains(plan.DeliveryPayloads[0]["JobTitle"].(string), printIQDeliveryDate(wantDate)) {
			t.Fatal("delivery deadline should use the market date")
		}
		if !strings.Contains(plan.DeliveryPayloads[0]["JobDescription"].(string), printIQDeliveryDate(wantDate)) {
			t.Fatal("delivery instructions must use the market date")
		}
		if plan.DeliveryPayloads[0]["ProductCode"] != printIQDeliveryProductCode(plan.Market) {
			t.Fatal("delivery job belongs to another market")
		}
	}
	if values.DueDate != "2026-10-01" || len(values.CampaignMarkets) != 3 {
		t.Fatal("planning changed the saved campaign")
	}
	if _, err := buildPrintIQMarketPlans(values, nil, nil, nil, nil, nil, "C123"); err == nil {
		t.Fatal("expected empty products to fail before submission")
	}
}

func TestMarketPlansGroupAliases(t *testing.T) {
	products := []printIQSheetProduct{{Market: "QLD", Quantity: 1}, {Market: " brisbane ", Quantity: 2}, {Market: "NSW", Quantity: 1}}
	plans, err := buildPrintIQMarketPlans(orderFormValues{CampaignMarkets: []campaignMarket{{Market: "Brisbane", DueDate: "2026-10-05"}, {Market: "Sydney", DueDate: "2026-10-02"}}}, nil, products, nil, nil, nil, "C123")
	if err != nil || len(plans) != 2 || !reflect.DeepEqual(plans[0].Products, products[:2]) {
		t.Fatalf("aliases were not grouped: %#v, %v", plans, err)
	}
	if _, err := buildPrintIQMarketPlans(orderFormValues{}, nil, []printIQSheetProduct{{Market: "Perth"}}, nil, nil, nil, "C123"); err == nil {
		t.Fatal("unsupported market must fail before submission")
	}
}
