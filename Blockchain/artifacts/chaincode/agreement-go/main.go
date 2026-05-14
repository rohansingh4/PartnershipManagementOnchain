package main

import (
	"log"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

func main() {
	chaincode, err := contractapi.NewChaincode(&AgreementContract{})
	if err != nil {
		log.Panicf("Error creating agreement chaincode: %v", err)
	}
	if err := chaincode.Start(); err != nil {
		log.Panicf("Error starting agreement chaincode: %v", err)
	}
}
