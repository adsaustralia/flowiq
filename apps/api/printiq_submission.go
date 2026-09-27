package main

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

type printIQMarketSubmission struct {
	Market          string         `json:"market"`
	DueDate         string         `json:"dueDate"`
	QuoteNo         string         `json:"quoteNo"`
	JobNos          []string       `json:"jobNos"`
	RequestPayload  map[string]any `json:"-"`
	ResponsePayload map[string]any `json:"-"`
}

type printIQSubmissionFailure struct {
	Status int
	Body   map[string]any
}

func writePrintIQMarketFailure(w http.ResponseWriter, failure *printIQSubmissionFailure, market string, completed []*printIQMarketSubmission, current *printIQMarketSubmission) {
	quotes := make([]string, 0, len(completed)+1)
	for _, submission := range completed {
		quotes = append(quotes, submission.QuoteNo)
	}
	if current != nil && current.QuoteNo != "" {
		quotes = append(quotes, current.QuoteNo)
	}
	message := fmt.Sprintf("%s: %v", market, failure.Body["error"])
	if len(quotes) > 0 {
		if failure.Body["progressSaved"] == true {
			message += fmt.Sprintf(" Existing PrintIQ quotes: %s.", strings.Join(quotes, ", "))
		} else {
			message += fmt.Sprintf(" PrintIQ quotes already created: %s. Check with ADS before retrying to avoid duplicate quotes.", strings.Join(quotes, ", "))
		}
	}
	failure.Body["error"] = message
	failure.Body["market"] = market
	failure.Body["quoteNos"] = quotes
	failure.Body["completedMarketQuotes"] = completed
	failure.Body["currentMarketQuote"] = current
	writeJSON(w, failure.Status, failure.Body)
}

func (a *app) submitPrintIQMarket(requestID string, campaign *campaignRecord, user AuthUser, plan printIQMarketPlan, customerCode string, purchaseOrderUpload, visualsUpload *printIQArtworkUpload, artworkUploads map[string]*printIQArtworkUpload, journals ...*printIQJournal) (*printIQMarketSubmission, *printIQSubmissionFailure) {
	stepIndex := 0
	run := func(requestID string, campaign *campaignRecord, user AuthUser, step string, payload any, call func(any) (any, int, error), products ...printIQSheetProduct) (any, *printIQSubmissionFailure) {
		key := fmt.Sprintf("%s:%d", plan.Market, stepIndex)
		stepIndex++
		if len(journals) > 0 {
			return journals[0].run(key, step, payload, func() (any, *printIQSubmissionFailure) {
				return a.runPrintIQSubmissionStep(requestID, campaign, user, step, payload, call, products...)
			})
		}
		return a.runPrintIQSubmissionStep(requestID, campaign, user, step, payload, call, products...)
	}
	result := &printIQMarketSubmission{Market: plan.Market, DueDate: plan.Values.DueDate}
	sheetProducts := plan.Products
	deliveryJobPayloads := plan.DeliveryPayloads
	targetQuoteFreightPrice := plan.Freight
	firstProduct := sheetProducts[0]
	createQuoteValues := plan.Values
	createQuoteValues.CustomerCode = customerCode
	createQuoteValues.ProductCode = firstProduct.ProductCode
	createQuoteValues.Quantity = strconv.Itoa(firstProduct.Quantity)
	createQuotePayload := buildPrintIQCreateQuotePayload(createQuoteValues, nil, firstProduct, targetQuoteFreightPrice)
	createQuoteResponse, failure := run(requestID, campaign, user, "CreateQuoteWithDelivery", createQuotePayload, a.optionService.createQuoteWithDelivery, firstProduct)
	if failure != nil {
		return result, failure
	}

	quoteNo := extractQuoteNo(createQuoteResponse)
	if quoteNo == "" {
		return result, &printIQSubmissionFailure{Status: http.StatusBadRequest, Body: map[string]any{"error": "PrintIQ create quote response did not include QuoteNo", "details": createQuoteResponse}}
	}
	result.QuoteNo = quoteNo
	quoteQuestionQQDKeys := make([]any, 0, len(sheetProducts))
	quoteQuestionQQDKeys = append(quoteQuestionQQDKeys, extractQQDKeyForProductIndex(createQuoteResponse, 0))

	getPricePayloads := make([]any, 0, len(sheetProducts)-1)
	getPriceResponses := make([]any, 0, len(sheetProducts)-1)
	for _, product := range sheetProducts[1:] {
		getPricePayload := buildPrintIQGetPricePayload(plan.Values, product, quoteNo, customerCode)
		getPricePayloads = append(getPricePayloads, getPricePayload)
		getPriceResponse, failure := run(requestID, campaign, user, "GetPrice", getPricePayload, a.optionService.getPrice, product)
		if failure != nil {
			return result, failure
		}
		getPriceResponses = append(getPriceResponses, getPriceResponse)
		qqdKey := extractGetPriceQQDKey(getPriceResponse)
		if qqdKey == nil {
			return result, &printIQSubmissionFailure{Status: http.StatusBadRequest, Body: map[string]any{"error": "PrintIQ GetPrice response did not identify the new product quantity for proof contact", "details": getPriceResponse}}
		}
		quoteQuestionQQDKeys = append(quoteQuestionQQDKeys, qqdKey)
	}

	getQuoteQuestionsPayloads := make([]any, 0, len(quoteQuestionQQDKeys))
	getQuoteQuestionsResponses := make([]any, 0, len(quoteQuestionQQDKeys))
	quoteQuestionQQDPKeys := make([]any, 0, len(quoteQuestionQQDKeys))
	for index, qqdKey := range quoteQuestionQQDKeys {
		if qqdKey == nil {
			return result, &printIQSubmissionFailure{Status: http.StatusBadRequest, Body: map[string]any{"error": fmt.Sprintf("PrintIQ product %d did not include QQDKey for proof contact", index+1), "details": map[string]any{"createQuoteWithDelivery": createQuoteResponse, "getPrice": getPriceResponses}}}
		}
		getQuoteQuestionsPayload := buildPrintIQGetQuoteQuestionsPayload(qqdKey)
		getQuoteQuestionsPayloads = append(getQuoteQuestionsPayloads, getQuoteQuestionsPayload)
		getQuoteQuestionsResponse, failure := run(requestID, campaign, user, "GetQuoteQuestions", getQuoteQuestionsPayload, a.optionService.getQuoteQuestions)
		if failure != nil {
			return result, failure
		}
		getQuoteQuestionsResponses = append(getQuoteQuestionsResponses, getQuoteQuestionsResponse)
		qqdpKey := extractQQDPKey(getQuoteQuestionsResponse)
		if qqdpKey == nil {
			return result, &printIQSubmissionFailure{Status: http.StatusBadRequest, Body: map[string]any{"error": fmt.Sprintf("PrintIQ quote questions for product %d did not include QQDPKey for proof contact", index+1), "details": getQuoteQuestionsResponse}}
		}
		quoteQuestionQQDPKeys = append(quoteQuestionQQDPKeys, qqdpKey)
	}

	saveQuoteQuestionsPayload := buildPrintIQSaveProofContactQuestionsPayload(quoteQuestionQQDPKeys)
	saveQuoteQuestionsResponse, failure := run(requestID, campaign, user, "SaveQuoteQuestions", saveQuoteQuestionsPayload, a.optionService.saveQuoteQuestions)
	if failure != nil {
		return result, failure
	}

	for _, payload := range deliveryJobPayloads {
		payload["QuoteNo"] = quoteNo
		getPricePayloads = append(getPricePayloads, payload)
		response, failure := run(requestID, campaign, user, "GetPrice", payload, a.optionService.getPrice, printIQSheetProduct{Market: strings.TrimSuffix(printIQStringValue(payload["ProductCode"]), " Delivery"), FormatKey: "Delivery"})
		if failure != nil {
			return result, failure
		}
		getPriceResponses = append(getPriceResponses, response)
		if isZeroValue(valueAtPath(response, "ProductKey")) {
			return result, &printIQSubmissionFailure{Status: http.StatusBadRequest, Body: map[string]any{"error": "PrintIQ did not create the delivery product", "details": response}}
		}
	}
	acceptQuotePayload := buildPrintIQAcceptQuotePayload(quoteNo, plan.Values.DueDate)
	acceptQuoteResponse, failure := run(requestID, campaign, user, "AcceptQuote", acceptQuotePayload, a.optionService.acceptQuote, firstProduct)
	if failure != nil {
		return result, failure
	}

	acceptedProducts := extractAcceptedProducts(acceptQuoteResponse)
	if len(acceptedProducts) != len(sheetProducts)+len(deliveryJobPayloads) {
		return result, &printIQSubmissionFailure{Status: http.StatusBadRequest, Body: map[string]any{"error": fmt.Sprintf("PrintIQ returned %d accepted products for %d submitted product lines", len(acceptedProducts), len(sheetProducts)+len(deliveryJobPayloads)), "details": acceptQuoteResponse}}
	}
	jobNos := make([]string, len(acceptedProducts))
	for index, acceptedProduct := range acceptedProducts {
		if acceptedProduct.JobNo == "" {
			return result, &printIQSubmissionFailure{Status: http.StatusBadRequest, Body: map[string]any{"error": fmt.Sprintf("PrintIQ accepted product %d did not include JobNo", index+1), "details": acceptQuoteResponse}}
		}
		jobNos[index] = acceptedProduct.JobNo
	}

	result.JobNos = jobNos
	var uploadFailure *printIQSubmissionFailure
	failedUploads := []map[string]any{}
	uploadArtworkPayloads := make([]any, 0, len(sheetProducts)+2)
	uploadArtworkResponses := make([]any, 0, len(sheetProducts)+2)
	for index, product := range sheetProducts {
		artwork := artworkUploads[product.ArtworkImageID]
		if index == 0 && purchaseOrderUpload != nil {
			uploadPayload := buildPrintIQUploadArtworkPayload(acceptedProducts[index].JobNo, *purchaseOrderUpload, true, false)
			uploadArtworkPayloads = append(uploadArtworkPayloads, uploadPayload)
			uploadResponse, failure := run(requestID, campaign, user, "UploadArtworkURL", uploadPayload, a.optionService.uploadArtworkURL)
			if failure != nil {
				uploadFailure = failure
				failedUploads = append(failedUploads, map[string]any{"jobNo": uploadPayload["JobNo"], "artworkUrl": uploadPayload["ArtworkUrl"], "error": failure.Body["error"]})
			}
			uploadArtworkResponses = append(uploadArtworkResponses, uploadResponse)
		}

		if index == 0 && visualsUpload != nil {
			uploadPayload := buildPrintIQUploadArtworkPayload(acceptedProducts[index].JobNo, *visualsUpload, true, false)
			uploadArtworkPayloads = append(uploadArtworkPayloads, uploadPayload)
			uploadResponse, failure := run(requestID, campaign, user, "UploadArtworkURL", uploadPayload, a.optionService.uploadArtworkURL)
			if failure != nil {
				uploadFailure = failure
				failedUploads = append(failedUploads, map[string]any{"jobNo": uploadPayload["JobNo"], "artworkUrl": uploadPayload["ArtworkUrl"], "error": failure.Body["error"]})
			}
			uploadArtworkResponses = append(uploadArtworkResponses, uploadResponse)
		}

		if artwork != nil {
			uploadPayload := buildPrintIQUploadArtworkPayload(acceptedProducts[index].JobNo, *artwork, false, true)
			uploadArtworkPayloads = append(uploadArtworkPayloads, uploadPayload)
			uploadResponse, failure := run(requestID, campaign, user, "UploadArtworkURL", uploadPayload, a.optionService.uploadArtworkURL)
			if failure != nil {
				uploadFailure = failure
				failedUploads = append(failedUploads, map[string]any{"jobNo": uploadPayload["JobNo"], "artworkUrl": uploadPayload["ArtworkUrl"], "error": failure.Body["error"]})
			}
			uploadArtworkResponses = append(uploadArtworkResponses, uploadResponse)
		}
	}

	if uploadFailure != nil {
		body := map[string]any{}
		for key, value := range uploadFailure.Body {
			body[key] = value
		}
		uploadFailure = &printIQSubmissionFailure{Status: uploadFailure.Status, Body: body}
		uploadFailure.Body["failedUploads"] = failedUploads
		failedJobs := []string{}
		for _, failed := range failedUploads {
			failedJobs = append(failedJobs, fmt.Sprint(failed["jobNo"]))
		}
		uploadFailure.Body["error"] = fmt.Sprintf("%v. Unresolved attachments on jobs: %s", uploadFailure.Body["error"], strings.Join(failedJobs, ", "))
		if len(journals) > 0 {
			uploadFailure.Body["progressSaved"] = true
			uploadFailure.Body["error"] = fmt.Sprintf("%v. Other attachments were attempted. Submission progress is saved; retry uses the existing quotes and jobs. Calls with uncertain outcomes require ADS reconciliation", uploadFailure.Body["error"])
		}
		return result, uploadFailure
	}

	requestPayload := map[string]any{
		"createQuoteWithDelivery": createQuotePayload,
		"getPrice":                getPricePayloads,
		"getQuoteQuestions":       getQuoteQuestionsPayloads,
		"saveQuoteQuestions":      saveQuoteQuestionsPayload,
		"acceptQuote":             acceptQuotePayload,
		"uploadArtworkURL":        uploadArtworkPayloads,
	}
	responsePayload := map[string]any{
		"createQuoteWithDelivery": createQuoteResponse,
		"getPrice":                getPriceResponses,
		"getQuoteQuestions":       getQuoteQuestionsResponses,
		"saveQuoteQuestions":      saveQuoteQuestionsResponse,
		"acceptQuote":             acceptQuoteResponse,
		"uploadArtworkURL":        uploadArtworkResponses,
		"market":                  plan.Market,
		"dueDate":                 plan.Values.DueDate,
		"quoteNo":                 quoteNo,
		"jobNos":                  jobNos,
	}

	return &printIQMarketSubmission{Market: plan.Market, DueDate: plan.Values.DueDate, QuoteNo: quoteNo, JobNos: jobNos, RequestPayload: requestPayload, ResponsePayload: responsePayload}, nil
}
