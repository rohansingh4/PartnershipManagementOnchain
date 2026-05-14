package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/shim"
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

const (
	collectionOrg1   = "Org1AgreementPrivate"
	collectionShared = "SharedAgreementTerms"
)

// AgreementContract embeds contractapi.Contract so the framework discovers
// all exported methods as chaincode functions automatically.
type AgreementContract struct {
	contractapi.Contract
}

// QueryRecord mirrors the JS _collectResults output for state queries.
type QueryRecord struct {
	Key    string      `json:"key"`
	Record interface{} `json:"record"`
}

// ─── World State: Public Agreement Lifecycle ─────────────────────────────────

func (c *AgreementContract) CreateAgreement(ctx contractapi.TransactionContextInterface, agreementData string) (string, error) {
	var agreement map[string]interface{}
	if err := json.Unmarshal([]byte(agreementData), &agreement); err != nil {
		return "", fmt.Errorf("failed to parse agreement data: %w", err)
	}

	id, ok := agreement["id"].(string)
	if !ok || id == "" {
		return "", fmt.Errorf("agreement must have an id field")
	}

	exists, err := c.agreementExists(ctx, id)
	if err != nil {
		return "", err
	}
	if exists {
		return "", fmt.Errorf("agreement %s already exists", id)
	}

	clientID, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return "", fmt.Errorf("failed to get client identity: %w", err)
	}
	mspID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return "", fmt.Errorf("failed to get MSP ID: %w", err)
	}

	agreement["status"] = "PENDING"
	agreement["createdAt"] = time.Now().UTC().Format(time.RFC3339)
	agreement["createdBy"] = clientID
	agreement["createdByMSP"] = mspID

	data, err := json.Marshal(agreement)
	if err != nil {
		return "", fmt.Errorf("failed to marshal agreement: %w", err)
	}

	if err := ctx.GetStub().PutState(id, data); err != nil {
		return "", fmt.Errorf("failed to put state: %w", err)
	}

	if err := ctx.GetStub().SetEvent("AgreementCreated", data); err != nil {
		return "", fmt.Errorf("failed to set event: %w", err)
	}

	return ctx.GetStub().GetTxID(), nil
}

func (c *AgreementContract) ApproveAgreement(ctx contractapi.TransactionContextInterface, agreementID string) (string, error) {
	data, err := ctx.GetStub().GetState(agreementID)
	if err != nil {
		return "", fmt.Errorf("failed to get state: %w", err)
	}
	if len(data) == 0 {
		return "", fmt.Errorf("agreement %s does not exist", agreementID)
	}

	var agreement map[string]interface{}
	if err := json.Unmarshal(data, &agreement); err != nil {
		return "", fmt.Errorf("failed to parse agreement: %w", err)
	}

	if agreement["status"] != "PENDING" {
		return "", fmt.Errorf("agreement %s must be PENDING to approve, current status: %v", agreementID, agreement["status"])
	}

	clientID, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return "", err
	}

	agreement["status"] = "APPROVED"
	agreement["approvedBy"] = clientID
	agreement["approvedAt"] = time.Now().UTC().Format(time.RFC3339)

	updated, err := json.Marshal(agreement)
	if err != nil {
		return "", err
	}

	if err := ctx.GetStub().PutState(agreementID, updated); err != nil {
		return "", err
	}

	eventPayload, _ := json.Marshal(map[string]string{"id": agreementID})
	ctx.GetStub().SetEvent("AgreementApproved", eventPayload)

	return ctx.GetStub().GetTxID(), nil
}

func (c *AgreementContract) UpdateAgreement(ctx contractapi.TransactionContextInterface, agreementData string) (string, error) {
	var update map[string]interface{}
	if err := json.Unmarshal([]byte(agreementData), &update); err != nil {
		return "", fmt.Errorf("failed to parse agreement data: %w", err)
	}

	id, ok := update["id"].(string)
	if !ok || id == "" {
		return "", fmt.Errorf("agreement must have an id field")
	}

	exists, err := c.agreementExists(ctx, id)
	if err != nil {
		return "", err
	}
	if !exists {
		return "", fmt.Errorf("agreement %s does not exist", id)
	}

	clientID, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return "", err
	}

	update["updatedAt"] = time.Now().UTC().Format(time.RFC3339)
	update["updatedBy"] = clientID

	data, err := json.Marshal(update)
	if err != nil {
		return "", err
	}

	if err := ctx.GetStub().PutState(id, data); err != nil {
		return "", err
	}

	return ctx.GetStub().GetTxID(), nil
}

func (c *AgreementContract) DeleteAgreement(ctx contractapi.TransactionContextInterface, id string) (string, error) {
	exists, err := c.agreementExists(ctx, id)
	if err != nil {
		return "", err
	}
	if !exists {
		return "", fmt.Errorf("agreement %s does not exist", id)
	}

	if err := ctx.GetStub().DelState(id); err != nil {
		return "", err
	}

	eventPayload, _ := json.Marshal(map[string]string{"id": id})
	ctx.GetStub().SetEvent("AgreementDeleted", eventPayload)

	return ctx.GetStub().GetTxID(), nil
}

func (c *AgreementContract) GetAgreement(ctx contractapi.TransactionContextInterface, id string) (string, error) {
	data, err := ctx.GetStub().GetState(id)
	if err != nil {
		return "", fmt.Errorf("failed to get state: %w", err)
	}
	if len(data) == 0 {
		return "", fmt.Errorf("agreement %s does not exist", id)
	}
	return string(data), nil
}

func (c *AgreementContract) agreementExists(ctx contractapi.TransactionContextInterface, id string) (bool, error) {
	data, err := ctx.GetStub().GetState(id)
	if err != nil {
		return false, fmt.Errorf("failed to read from world state: %w", err)
	}
	return len(data) > 0, nil
}

// ─── ABAC: Attribute-Based Access Control ────────────────────────────────────
//
// Attributes are embedded in the user's enrollment certificate by the CA.
// fabric-ca enrolls users with --id.attrs "department=financial:ecert"

func (c *AgreementContract) CreateRestrictedAgreement(ctx contractapi.TransactionContextInterface, agreementData string) (string, error) {
	ok, err := ctx.GetClientIdentity().AssertAttributeValue("department", "financial")
	if err != nil {
		return "", fmt.Errorf("failed to check attribute: %w", err)
	}
	if !ok {
		mspID, _ := ctx.GetClientIdentity().GetMSPID()
		return "", fmt.Errorf("access denied: caller MSP=%s does not have department=financial attribute", mspID)
	}

	var agreement map[string]interface{}
	if err := json.Unmarshal([]byte(agreementData), &agreement); err != nil {
		return "", fmt.Errorf("failed to parse agreement data: %w", err)
	}

	id, ok2 := agreement["id"].(string)
	if !ok2 || id == "" {
		return "", fmt.Errorf("agreement must have an id field")
	}

	exists, err := c.agreementExists(ctx, id)
	if err != nil {
		return "", err
	}
	if exists {
		return "", fmt.Errorf("agreement %s already exists", id)
	}

	clientID, _ := ctx.GetClientIdentity().GetID()
	mspID, _ := ctx.GetClientIdentity().GetMSPID()

	agreement["restricted"] = true
	agreement["status"] = "PENDING"
	agreement["createdBy"] = clientID
	agreement["createdByMSP"] = mspID
	agreement["createdAt"] = time.Now().UTC().Format(time.RFC3339)

	data, err := json.Marshal(agreement)
	if err != nil {
		return "", err
	}

	if err := ctx.GetStub().PutState(id, data); err != nil {
		return "", err
	}

	return ctx.GetStub().GetTxID(), nil
}

// ─── Private Data Collections ─────────────────────────────────────────────────
//
// Transient data is passed by the client SDK without being written to the block.
// The chaincode reads it via GetTransient() and writes it to a private collection.

func (c *AgreementContract) AddConfidentialTerms(ctx contractapi.TransactionContextInterface) (string, error) {
	transientMap, err := ctx.GetStub().GetTransient()
	if err != nil {
		return "", fmt.Errorf("failed to get transient data: %w", err)
	}

	termsBytes, ok := transientMap["terms"]
	if !ok {
		return "", fmt.Errorf(`transient field "terms" is required (pass via --transient flag)`)
	}

	var terms map[string]interface{}
	if err := json.Unmarshal(termsBytes, &terms); err != nil {
		return "", fmt.Errorf("failed to parse terms: %w", err)
	}

	agreementID, ok := terms["agreementId"].(string)
	if !ok || agreementID == "" {
		return "", fmt.Errorf("terms must include agreementId")
	}

	exists, err := c.agreementExists(ctx, agreementID)
	if err != nil {
		return "", err
	}
	if !exists {
		return "", fmt.Errorf("agreement %s does not exist", agreementID)
	}

	if err := ctx.GetStub().PutPrivateData(collectionOrg1, agreementID, termsBytes); err != nil {
		return "", fmt.Errorf("failed to put private data: %w", err)
	}

	return ctx.GetStub().GetTxID(), nil
}

func (c *AgreementContract) AddSharedConfidentialTerms(ctx contractapi.TransactionContextInterface) (string, error) {
	transientMap, err := ctx.GetStub().GetTransient()
	if err != nil {
		return "", fmt.Errorf("failed to get transient data: %w", err)
	}

	termsBytes, ok := transientMap["terms"]
	if !ok {
		return "", fmt.Errorf(`transient field "terms" is required`)
	}

	var terms map[string]interface{}
	if err := json.Unmarshal(termsBytes, &terms); err != nil {
		return "", fmt.Errorf("failed to parse terms: %w", err)
	}

	agreementID, ok := terms["agreementId"].(string)
	if !ok || agreementID == "" {
		return "", fmt.Errorf("terms must include agreementId")
	}

	if err := ctx.GetStub().PutPrivateData(collectionShared, agreementID, termsBytes); err != nil {
		return "", fmt.Errorf("failed to put private data: %w", err)
	}

	return ctx.GetStub().GetTxID(), nil
}

func (c *AgreementContract) GetConfidentialTerms(ctx contractapi.TransactionContextInterface, agreementID string) (string, error) {
	data, err := ctx.GetStub().GetPrivateData(collectionOrg1, agreementID)
	if err != nil {
		return "", fmt.Errorf("failed to get private data: %w", err)
	}
	if len(data) == 0 {
		return "", fmt.Errorf("no confidential terms found for agreement %s", agreementID)
	}
	return string(data), nil
}

func (c *AgreementContract) GetSharedConfidentialTerms(ctx contractapi.TransactionContextInterface, agreementID string) (string, error) {
	data, err := ctx.GetStub().GetPrivateData(collectionShared, agreementID)
	if err != nil {
		return "", fmt.Errorf("failed to get private data: %w", err)
	}
	if len(data) == 0 {
		return "", fmt.Errorf("no shared terms found for agreement %s", agreementID)
	}
	return string(data), nil
}

func (c *AgreementContract) GetConfidentialTermsHash(ctx contractapi.TransactionContextInterface, agreementID string) (string, error) {
	hashBytes, err := ctx.GetStub().GetPrivateDataHash(collectionOrg1, agreementID)
	if err != nil {
		return "", fmt.Errorf("failed to get private data hash: %w", err)
	}
	if len(hashBytes) == 0 {
		return "", fmt.Errorf("no private data hash found for agreement %s", agreementID)
	}
	return hex.EncodeToString(hashBytes), nil
}

// ─── Bulk Operations ──────────────────────────────────────────────────────────

func (c *AgreementContract) CreateBulkAgreements(ctx contractapi.TransactionContextInterface, data string) (string, error) {
	var agreements []map[string]interface{}
	if err := json.Unmarshal([]byte(data), &agreements); err != nil {
		return "", fmt.Errorf("input must be a JSON array: %w", err)
	}

	for _, agreement := range agreements {
		id, ok := agreement["id"].(string)
		if !ok || id == "" {
			return "", fmt.Errorf("each agreement must have an id field")
		}
		agreement["status"] = "PENDING"
		agreement["createdAt"] = time.Now().UTC().Format(time.RFC3339)

		bytes, err := json.Marshal(agreement)
		if err != nil {
			return "", err
		}
		if err := ctx.GetStub().PutState(id, bytes); err != nil {
			return "", err
		}
	}

	return ctx.GetStub().GetTxID(), nil
}

// ─── Rich Queries (CouchDB only — not LevelDB) ───────────────────────────────

func (c *AgreementContract) GetAllAgreements(ctx contractapi.TransactionContextInterface) (string, error) {
	iterator, err := ctx.GetStub().GetStateByRange("", "")
	if err != nil {
		return "", fmt.Errorf("failed to get state by range: %w", err)
	}
	defer iterator.Close()

	results, err := collectQueryResults(iterator)
	if err != nil {
		return "", err
	}

	out, err := json.Marshal(results)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func (c *AgreementContract) QueryAgreementsByStatus(ctx contractapi.TransactionContextInterface, status string) (string, error) {
	queryString := fmt.Sprintf(`{"selector":{"status":"%s"}}`, status)
	return c.QueryAgreements(ctx, queryString)
}

func (c *AgreementContract) QueryAgreements(ctx contractapi.TransactionContextInterface, queryString string) (string, error) {
	iterator, err := ctx.GetStub().GetQueryResult(queryString)
	if err != nil {
		return "", fmt.Errorf("failed to get query result: %w", err)
	}
	defer iterator.Close()

	results, err := collectQueryResults(iterator)
	if err != nil {
		return "", err
	}

	out, err := json.Marshal(results)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func (c *AgreementContract) GetAgreementsWithPagination(ctx contractapi.TransactionContextInterface, queryString string, pageSize int, bookmark string) (string, error) {
	iterator, metadata, err := ctx.GetStub().GetQueryResultWithPagination(queryString, int32(pageSize), bookmark)
	if err != nil {
		return "", fmt.Errorf("failed to get paginated query result: %w", err)
	}
	defer iterator.Close()

	results, err := collectQueryResults(iterator)
	if err != nil {
		return "", err
	}

	out, err := json.Marshal(map[string]interface{}{
		"data": results,
		"metadata": map[string]interface{}{
			"recordsCount": metadata.FetchedRecordsCount,
			"bookmark":     metadata.Bookmark,
		},
	})
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func (c *AgreementContract) GetAgreementHistory(ctx contractapi.TransactionContextInterface, id string) (string, error) {
	iterator, err := ctx.GetStub().GetHistoryForKey(id)
	if err != nil {
		return "", fmt.Errorf("failed to get history: %w", err)
	}
	defer iterator.Close()

	var results []map[string]interface{}
	for iterator.HasNext() {
		response, err := iterator.Next()
		if err != nil {
			return "", err
		}

		var value interface{}
		if jsonErr := json.Unmarshal(response.Value, &value); jsonErr != nil {
			value = string(response.Value)
		}

		results = append(results, map[string]interface{}{
			"txId":      response.TxId,
			"timestamp": response.Timestamp,
			"isDelete":  fmt.Sprintf("%v", response.IsDelete),
			"value":     value,
		})
	}

	out, err := json.Marshal(results)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// ─── Internal Helper ──────────────────────────────────────────────────────────

func collectQueryResults(iterator shim.StateQueryIteratorInterface) ([]QueryRecord, error) {
	var results []QueryRecord
	for iterator.HasNext() {
		response, err := iterator.Next()
		if err != nil {
			return nil, err
		}

		var record interface{}
		if err := json.Unmarshal(response.Value, &record); err != nil {
			record = string(response.Value)
		}

		results = append(results, QueryRecord{Key: response.Key, Record: record})
	}
	return results, nil
}
