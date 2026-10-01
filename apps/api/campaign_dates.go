package main

import "encoding/json"

// Older campaigns have only a campaign date. Populate missing market dates on
// read, but preserve an explicitly cleared market date. New saves clear the old date.
func (values *orderFormValues) UnmarshalJSON(data []byte) error {
	type plainValues orderFormValues
	var decoded plainValues
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var fields struct {
		CampaignMarkets []map[string]json.RawMessage `json:"campaignMarkets"`
	}
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for i := range decoded.CampaignMarkets {
		if _, exists := fields.CampaignMarkets[i]["dueDate"]; !exists {
			decoded.CampaignMarkets[i].DueDate = decoded.DueDate
		}
	}
	decoded.DueDate = ""
	*values = orderFormValues(decoded)
	return nil
}
