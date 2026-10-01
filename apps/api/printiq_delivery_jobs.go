package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Delivery jobs are appended after print products and never receive artwork.
func buildPrintIQDeliveryJobPayloads(values orderFormValues, summary *campaignSummary, products []printIQSheetProduct, rates []marketShippingRateRecord, assetCosts []marketAssetShippingCostRecord, customFormats map[string]bool, customerCode string) ([]map[string]any, error) {
	payloads := make([]map[string]any, 0)
	seen := map[string]bool{}
	for _, market := range values.CampaignMarkets {
		name := strings.TrimSpace(market.Market)
		if seen[name] {
			continue
		}
		seen[name] = true
		code := printIQDeliveryProductCode(name)
		if code == "" {
			return nil, fmt.Errorf("No PrintIQ product code configured for market %s, job type Delivery (dummy job without artwork). Contact Support", name)
		}
		marketValues := values
		marketValues.CampaignMarkets = nil
		for _, entry := range values.CampaignMarkets {
			if strings.TrimSpace(entry.Market) == name {
				marketValues.CampaignMarkets = append(marketValues.CampaignMarkets, entry)
			}
		}
		cost := calculateCampaignShippingCost(marketValues, summary, rates, assetCosts, customFormats)
		title := fmt.Sprintf("%s ($%s) Direct Deliver", name, strconv.FormatFloat(cost, 'f', -1, 64))
		date := printIQDeliveryDate(market.DueDate)
		if date != "" {
			title += " " + date
		}
		if campaign := strings.TrimSpace(values.CampaignName); campaign != "" {
			title += " (" + campaign + ")"
		}
		sections := []string{}
		addresses := []string{}
		addressSeen := map[string]bool{}
		for _, entry := range marketValues.CampaignMarkets {
			for _, asset := range entry.Assets {
				address := strings.TrimSpace(asset.DeliveryAddress)
				if address != "" && !addressSeen[address] {
					addressSeen[address] = true
					addresses = append(addresses, address)
				}
			}
		}
		for _, address := range addresses {
			intro := "Deliver to " + parseCampaignDeliveryAddress(address).Name
			if date != "" {
				intro += " by " + date + " by COB"
			}
			lines := []string{intro + ":", ""}
			for _, product := range products {
				if strings.TrimSpace(product.Market) == name && strings.TrimSpace(product.DeliveryAddress) == address {
					lines = append(lines, printIQDeliveryCreativeLine(values, product))
				}
			}
			lines = append(lines, "", "Please note:", address)
			sections = append(sections, strings.Join(lines, "\n"))
		}
		unassigned := []string{}
		for _, product := range products {
			if strings.TrimSpace(product.Market) == name && strings.TrimSpace(product.DeliveryAddress) == "" {
				unassigned = append(unassigned, printIQDeliveryCreativeLine(values, product))
			}
		}
		if len(unassigned) > 0 {
			sections = append(sections, strings.Join(unassigned, "\n"))
		}
		payload := buildPrintIQGetPricePayload(values, printIQSheetProduct{ProductCode: code, Quantity: 1}, "", customerCode)
		payload["JobTitle"] = title
		payload["JobDescription"] = strings.Join(sections, "\n\n")
		payloads = append(payloads, payload)
	}
	return payloads, nil
}

func printIQDeliveryProductCode(market string) string {
	switch strings.ToLower(strings.TrimSpace(market)) {
	case "vic", "melbourne":
		return "VIC Delivery"
	case "nsw", "sydney":
		return "NSW Delivery"
	case "qld", "brisbane":
		return "QLD Delivery"
	default:
		return ""
	}
}

func printIQDeliveryCreativeLine(values orderFormValues, product printIQSheetProduct) string {
	format := product.FormatKey
	if format == "8-sheet" {
		format = "Quad"
	}
	return fmt.Sprintf("• Creative %d (%s): %d x %s", resolveCreativeNumber(values, product.ArtworkImageID), format, product.Quantity, product.ProductCode)
}

func printIQDeliveryDate(raw string) string {
	date, err := time.Parse("2006-01-02", strings.TrimSpace(raw))
	if err != nil {
		return strings.TrimSpace(raw)
	}
	suffix := "th"
	if date.Day()%100 < 11 || date.Day()%100 > 13 {
		switch date.Day() % 10 {
		case 1:
			suffix = "st"
		case 2:
			suffix = "nd"
		case 3:
			suffix = "rd"
		}
	}
	return fmt.Sprintf("%s %d%s %s", date.Weekday(), date.Day(), suffix, date.Month())
}
