package main

import (
	"fmt"
	"strings"
	"time"
)

type printIQMarketPlan struct {
	Market           string
	Values           orderFormValues
	Products         []printIQSheetProduct
	Freight          float64
	DeliveryPayloads []map[string]any
}

func printIQMarketDueDate(raw, market string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	date, err := time.Parse("2006-01-02", raw)
	if err != nil {
		return "", fmt.Errorf("Invalid delivery due date %q for %s", raw, market)
	}
	return date.Format("2006-01-02"), nil
}

// Plan every market before making external calls so configuration errors cannot
// leave a campaign partially submitted. Preserve product order within each quote.
func buildPrintIQMarketPlans(values orderFormValues, summary *campaignSummary, products []printIQSheetProduct, rates []marketShippingRateRecord, assetCosts []marketAssetShippingCostRecord, customFormats map[string]bool, customerCode string) ([]printIQMarketPlan, error) {
	plans := []printIQMarketPlan{}
	indexes := map[string]int{}
	for _, product := range products {
		key := printIQDeliveryProductCode(product.Market)
		if key == "" {
			return nil, fmt.Errorf("No PrintIQ delivery product configured for market %s", product.Market)
		}
		index, exists := indexes[key]
		if !exists {
			index = len(plans)
			indexes[key] = index
			marketValues := values
			marketValues.CampaignMarkets = nil
			for _, market := range values.CampaignMarkets {
				if printIQDeliveryProductCode(market.Market) == key {
					marketValues.CampaignMarkets = append(marketValues.CampaignMarkets, market)
				}
			}
			plans = append(plans, printIQMarketPlan{Market: strings.TrimSpace(product.Market), Values: marketValues})
		}
		plans[index].Products = append(plans[index].Products, product)
	}
	if len(plans) == 0 {
		return nil, fmt.Errorf("No print products available to submit")
	}
	for i := range plans {
		plan := &plans[i]
		plan.Freight = calculateCampaignShippingCost(plan.Values, summary, rates, assetCosts, customFormats)
		// Resolve the date before building any quote or delivery payload.
		plan.Values.DueDate = ""
		for _, market := range plan.Values.CampaignMarkets {
			dueDate, err := printIQMarketDueDate(market.DueDate, plan.Market)
			if err != nil {
				return nil, err
			}
			if dueDate == "" {
				return nil, fmt.Errorf("Add a due date for %s before submitting to PrintIQ", plan.Market)
			}
			if plan.Values.DueDate != "" && plan.Values.DueDate != dueDate {
				return nil, fmt.Errorf("Conflicting due dates for market %s", plan.Market)
			}
			plan.Values.DueDate = dueDate
		}
		if plan.Values.DueDate == "" {
			return nil, fmt.Errorf("Add a due date for %s before submitting to PrintIQ", plan.Market)
		}
		var err error
		plan.DeliveryPayloads, err = buildPrintIQDeliveryJobPayloads(plan.Values, summary, plan.Products, rates, assetCosts, customFormats, customerCode)
		if err != nil {
			return nil, err
		}
	}
	return plans, nil
}
