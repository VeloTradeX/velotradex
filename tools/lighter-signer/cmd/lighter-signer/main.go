package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	lighterclient "github.com/elliottech/lighter-go/client"
	lightertypes "github.com/elliottech/lighter-go/types"
)

const (
	orderTypeLimit           uint8 = 0
	orderTypeMarket          uint8 = 1
	orderTypeStopLoss        uint8 = 2
	orderTypeStopLossLimit   uint8 = 3
	orderTypeTakeProfit      uint8 = 4
	orderTypeTakeProfitLimit uint8 = 5

	tifImmediateOrCancel uint8 = 0
	tifGoodTillTime      uint8 = 1
	tifPostOnly          uint8 = 2

	defaultOrderExpiryDelay       = 30 * 24 * time.Hour // 30 days
	defaultIOCExpiry        int64 = 0
	defaultExpirySkew             = 10*time.Minute - time.Second
)

type input struct {
	APIPrivateKey string          `json:"apiPrivateKey"`
	BaseURL       string          `json:"baseURL"`
	AccountIndex  int64           `json:"accountIndex"`
	APIKeyIndex   uint8           `json:"apiKeyIndex"`
	Deadline      int64           `json:"deadline"`
	Intent        intent          `json:"intent"`
	Raw           json.RawMessage `json:"-"`
}

type intent struct {
	Action  string                 `json:"action"`
	Nonce   string                 `json:"nonce"`
	Payload map[string]interface{} `json:"payload"`
}

type signerOutput struct {
	TxType     uint8  `json:"txType"`
	TxInfo     string `json:"txInfo"`
	TxInfoHash string `json:"txInfoHash"`
}

type authTokenOutput struct {
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expiresAt"`
}

type signedTx interface {
	GetTxType() uint8
	GetTxInfo() (string, error)
	GetTxHash() string
}

func main() {
	if err := run(os.Args, os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, stdin *os.File, stdout *os.File) error {
	if len(args) != 2 || (args[1] != "sign" && args[1] != "auth-token") {
		return errors.New("usage: lighter-signer sign|auth-token")
	}

	var req input
	decoder := json.NewDecoder(stdin)
	decoder.UseNumber()
	if err := decoder.Decode(&req); err != nil {
		return fmt.Errorf("invalid JSON stdin: %w", err)
	}
	if req.APIPrivateKey == "" {
		return errors.New("apiPrivateKey is required")
	}
	if req.AccountIndex < 0 {
		return errors.New("accountIndex must be non-negative")
	}

	txClient, err := lighterclient.NewTxClient(
		nil,
		req.APIPrivateKey,
		req.AccountIndex,
		req.APIKeyIndex,
		chainID(req.BaseURL),
	)
	if err != nil {
		return fmt.Errorf("create Lighter tx client: %w", err)
	}

	if args[1] == "auth-token" {
		return createAuthToken(stdout, txClient, req)
	}

	if req.Intent.Action == "" {
		return errors.New("intent.action is required")
	}
	if req.Intent.Payload == nil {
		return errors.New("intent.payload is required")
	}

	ops, err := transactOpts(req)
	if err != nil {
		return err
	}

	var tx signedTx
	switch req.Intent.Action {
	case "place_order":
		tx, err = signCreateOrder(txClient, req.Intent.Payload, ops)
	case "create_grouped_orders":
		tx, err = signCreateGroupedOrders(txClient, req.Intent.Payload, ops)
	case "cancel_order":
		tx, err = signCancelOrder(txClient, req.Intent.Payload, ops)
	case "amend_order":
		tx, err = signAmendOrder(txClient, req.Intent.Payload, ops)
	case "set_leverage":
		tx, err = signSetLeverage(txClient, req.Intent.Payload, ops)
	case "set_margin_mode":
		tx, err = signSetMarginMode(txClient, req.Intent.Payload, ops)
	default:
		err = fmt.Errorf("unsupported signer action: %s", req.Intent.Action)
	}
	if err != nil {
		return err
	}

	txInfo, err := tx.GetTxInfo()
	if err != nil {
		return fmt.Errorf("encode tx info: %w", err)
	}

	return json.NewEncoder(stdout).Encode(signerOutput{
		TxType:     tx.GetTxType(),
		TxInfo:     txInfo,
		TxInfoHash: tx.GetTxHash(),
	})
}

func createAuthToken(stdout *os.File, txClient *lighterclient.TxClient, req input) error {
	deadline := req.Deadline
	if deadline == 0 {
		deadline = time.Now().Add(7 * time.Hour).Unix()
	}
	token, err := txClient.GetAuthToken(time.Unix(deadline, 0))
	if err != nil {
		return fmt.Errorf("create auth token: %w", err)
	}

	return json.NewEncoder(stdout).Encode(authTokenOutput{
		Token:     token,
		ExpiresAt: deadline,
	})
}

func chainID(baseURL string) uint32 {
	normalized := strings.ToLower(baseURL)
	if strings.Contains(normalized, "mainnet") || strings.Contains(normalized, "api.") {
		return 304
	}
	return 300
}

func transactOpts(req input) (*lightertypes.TransactOpts, error) {
	nonce, err := parseInt64(req.Intent.Nonce, "intent.nonce")
	if err != nil {
		return nil, err
	}
	accountIndex := req.AccountIndex
	apiKeyIndex := req.APIKeyIndex
	return &lightertypes.TransactOpts{
		FromAccountIndex: &accountIndex,
		ApiKeyIndex:      &apiKeyIndex,
		ExpiredAt:        time.Now().Add(defaultExpirySkew).UnixMilli(),
		Nonce:            &nonce,
	}, nil
}

func signCreateOrder(txClient *lighterclient.TxClient, payload map[string]interface{}, ops *lightertypes.TransactOpts) (signedTx, error) {
	orderType, err := parseOrderType(payload["order_type"])
	if err != nil {
		return nil, err
	}
	timeInForce := parseTimeInForce(payload, orderType)
	orderExpiry := time.Now().Add(defaultOrderExpiryDelay).UnixMilli()
	if timeInForce == tifImmediateOrCancel && !isTriggerOrder(orderType) {
		orderExpiry = defaultIOCExpiry
	}
	marketIndex, err := parseInt64Range(payload["market_index"], "market_index", -32768, 32767)
	if err != nil {
		return nil, err
	}
	clientOrderIndex, err := parseInt64Value(payload["client_order_index"], "client_order_index")
	if err != nil {
		return nil, err
	}
	baseAmount, err := parseInt64Value(payload["base_amount"], "base_amount")
	if err != nil {
		return nil, err
	}
	price, err := parseInt64Range(payload["price"], "price", 0, 4294967295)
	if err != nil {
		return nil, err
	}
	triggerPrice, err := parseOptionalInt64Range(payload["trigger_price"], "trigger_price", 0, 4294967295)
	if err != nil {
		return nil, err
	}

	tx := &lightertypes.CreateOrderTxReq{
		MarketIndex:      int16(marketIndex),
		ClientOrderIndex: clientOrderIndex,
		BaseAmount:       baseAmount,
		Price:            uint32(price),
		IsAsk:            boolUint8(payload["is_ask"]),
		Type:             orderType,
		TimeInForce:      timeInForce,
		ReduceOnly:       boolUint8(payload["reduce_only"]),
		TriggerPrice:     uint32(triggerPrice),
		OrderExpiry:      orderExpiry,
	}

	return txClient.GetCreateOrderTransaction(tx, ops)
}

func signCreateGroupedOrders(txClient *lighterclient.TxClient, payload map[string]interface{}, ops *lightertypes.TransactOpts) (signedTx, error) {
	groupingType, err := parseUint8(payload["grouping_type"], "grouping_type")
	if err != nil {
		return nil, err
	}

	ordersRaw, ok := payload["orders"].([]interface{})
	if !ok || len(ordersRaw) == 0 {
		return nil, errors.New("orders must be a non-empty array")
	}

	orders := make([]*lightertypes.CreateOrderTxReq, 0, len(ordersRaw))
	for i, orderRaw := range ordersRaw {
		orderMap, ok := orderRaw.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("orders[%d] must be an object", i)
		}

		orderType, err := parseOrderType(orderMap["order_type"])
		if err != nil {
			return nil, fmt.Errorf("orders[%d]: %w", i, err)
		}
		timeInForce := parseTimeInForce(orderMap, orderType)
		orderExpiry := time.Now().Add(defaultOrderExpiryDelay).UnixMilli()
		if timeInForce == tifImmediateOrCancel && !isTriggerOrder(orderType) {
			orderExpiry = defaultIOCExpiry
		}
		marketIndex, err := parseInt64Range(orderMap["market_index"], "market_index", -32768, 32767)
		if err != nil {
			return nil, fmt.Errorf("orders[%d]: %w", i, err)
		}
		clientOrderIndex, err := parseInt64Value(orderMap["client_order_index"], "client_order_index")
		if err != nil {
			return nil, fmt.Errorf("orders[%d]: %w", i, err)
		}
		baseAmount, err := parseInt64Value(orderMap["base_amount"], "base_amount")
		if err != nil {
			return nil, fmt.Errorf("orders[%d]: %w", i, err)
		}
		price, err := parseInt64Range(orderMap["price"], "price", 0, 4294967295)
		if err != nil {
			return nil, fmt.Errorf("orders[%d]: %w", i, err)
		}
		triggerPrice, err := parseOptionalInt64Range(orderMap["trigger_price"], "trigger_price", 0, 4294967295)
		if err != nil {
			return nil, fmt.Errorf("orders[%d]: %w", i, err)
		}

		order := &lightertypes.CreateOrderTxReq{
			MarketIndex:      int16(marketIndex),
			ClientOrderIndex: clientOrderIndex,
			BaseAmount:       baseAmount,
			Price:            uint32(price),
			IsAsk:            boolUint8(orderMap["is_ask"]),
			Type:             orderType,
			TimeInForce:      timeInForce,
			ReduceOnly:       boolUint8(orderMap["reduce_only"]),
			TriggerPrice:     uint32(triggerPrice),
			OrderExpiry:      orderExpiry,
		}
		orders = append(orders, order)
	}

	tx := &lightertypes.CreateGroupedOrdersTxReq{
		GroupingType: groupingType,
		Orders:       orders,
	}

	return txClient.GetCreateGroupedOrdersTransaction(tx, ops)
}

func signCancelOrder(txClient *lighterclient.TxClient, payload map[string]interface{}, ops *lightertypes.TransactOpts) (signedTx, error) {
	orderIndexValue := payload["order_index"]
	if orderIndexValue == nil {
		orderIndexValue = payload["client_order_index"]
	}
	marketIndex, err := parseInt64Range(payload["market_index"], "market_index", -32768, 32767)
	if err != nil {
		return nil, err
	}
	orderIndex, err := parseInt64Value(orderIndexValue, "order_index")
	if err != nil {
		return nil, err
	}

	tx := &lightertypes.CancelOrderTxReq{
		MarketIndex: int16(marketIndex),
		Index:       orderIndex,
	}

	return txClient.GetCancelOrderTransaction(tx, ops)
}

func signAmendOrder(txClient *lighterclient.TxClient, payload map[string]interface{}, ops *lightertypes.TransactOpts) (signedTx, error) {
	marketIndex, err := parseInt64Range(payload["market_index"], "market_index", -32768, 32767)
	if err != nil {
		return nil, err
	}
	orderIndexValue := payload["order_index"]
	if orderIndexValue == nil {
		orderIndexValue = payload["client_order_index"]
	}
	orderIndex, err := parseInt64Value(orderIndexValue, "order_index")
	if err != nil {
		return nil, err
	}
	baseAmount, err := parseInt64Value(payload["base_amount"], "base_amount")
	if err != nil {
		return nil, err
	}
	price, err := parseInt64Range(payload["price"], "price", 0, 4294967295)
	if err != nil {
		return nil, err
	}
	triggerPrice, err := parseOptionalInt64Range(payload["trigger_price"], "trigger_price", 0, 4294967295)
	if err != nil {
		return nil, err
	}
	tx := &lightertypes.ModifyOrderTxReq{
		MarketIndex:  int16(marketIndex),
		Index:        orderIndex,
		BaseAmount:   baseAmount,
		Price:        uint32(price),
		TriggerPrice: uint32(triggerPrice),
	}
	return txClient.GetModifyOrderTransaction(tx, ops)
}

func signSetLeverage(txClient *lighterclient.TxClient, payload map[string]interface{}, ops *lightertypes.TransactOpts) (signedTx, error) {
	marketIndex, err := parseInt64Range(payload["market_index"], "market_index", -32768, 32767)
	if err != nil {
		return nil, err
	}
	initialMarginFraction, err := parseInt64Range(payload["initial_margin_fraction"], "initial_margin_fraction", 1, 65535)
	if err != nil {
		return nil, err
	}
	tx := &lightertypes.UpdateLeverageTxReq{
		MarketIndex:           int16(marketIndex),
		InitialMarginFraction: uint16(initialMarginFraction),
	}
	return txClient.GetUpdateLeverageTransaction(tx, ops)
}

func signSetMarginMode(txClient *lighterclient.TxClient, payload map[string]interface{}, ops *lightertypes.TransactOpts) (signedTx, error) {
	marketIndex, err := parseInt64Range(payload["market_index"], "market_index", -32768, 32767)
	if err != nil {
		return nil, err
	}
	initialMarginFraction, err := parseInt64Range(payload["initial_margin_fraction"], "initial_margin_fraction", 1, 65535)
	if err != nil {
		return nil, err
	}
	marginMode, err := parseMarginMode(payload["margin_mode"])
	if err != nil {
		return nil, err
	}
	tx := &lightertypes.UpdateLeverageTxReq{
		MarketIndex:           int16(marketIndex),
		InitialMarginFraction: uint16(initialMarginFraction),
		MarginMode:            marginMode,
	}
	return txClient.GetUpdateLeverageTransaction(tx, ops)
}

func parseMarginMode(value interface{}) (uint8, error) {
	normalized := strings.ToLower(fmt.Sprint(value))
	switch normalized {
	case "cross", "0", "":
		return 0, nil
	case "isolated", "1":
		return 1, nil
	default:
		return 0, fmt.Errorf("unsupported margin_mode: %v", value)
	}
}

func parseOrderType(value interface{}) (uint8, error) {
	normalized := strings.ToLower(fmt.Sprint(value))
	switch normalized {
	case "", "<nil>", "limit":
		return orderTypeLimit, nil
	case "market":
		return orderTypeMarket, nil
	case "stop_loss", "stop-loss":
		return orderTypeStopLoss, nil
	case "stop_loss_limit", "stop-loss-limit":
		return orderTypeStopLossLimit, nil
	case "take_profit", "take-profit":
		return orderTypeTakeProfit, nil
	case "take_profit_limit", "take-profit-limit":
		return orderTypeTakeProfitLimit, nil
	default:
		return 0, fmt.Errorf("unsupported order_type: %v", value)
	}
}

func parseTimeInForce(payload map[string]interface{}, orderType uint8) uint8 {
	if orderType == orderTypeStopLoss || orderType == orderTypeTakeProfit {
		return tifImmediateOrCancel
	}
	if boolUint8(payload["post_only"]) == 1 {
		return tifPostOnly
	}
	if orderType == orderTypeMarket {
		return tifImmediateOrCancel
	}
	return tifGoodTillTime
}

func isTriggerOrder(orderType uint8) bool {
	return orderType == orderTypeStopLoss || orderType == orderTypeStopLossLimit ||
		orderType == orderTypeTakeProfit || orderType == orderTypeTakeProfitLimit
}

func boolUint8(value interface{}) uint8 {
	if b, ok := value.(bool); ok && b {
		return 1
	}
	if s, ok := value.(string); ok {
		switch strings.ToLower(s) {
		case "1", "true", "yes":
			return 1
		}
	}
	if n, ok := value.(json.Number); ok {
		i, _ := n.Int64()
		if i != 0 {
			return 1
		}
	}
	return 0
}

func parseOptionalInt64(value interface{}, name string) (int64, error) {
	if value == nil {
		return 0, nil
	}
	return parseInt64Value(value, name)
}

func parseOptionalInt64Range(value interface{}, name string, min int64, max int64) (int64, error) {
	parsed, err := parseOptionalInt64(value, name)
	if err != nil {
		return 0, err
	}
	if parsed < min || parsed > max {
		return 0, fmt.Errorf("%s out of range", name)
	}
	return parsed, nil
}

func parseInt64Range(value interface{}, name string, min int64, max int64) (int64, error) {
	parsed, err := parseInt64Value(value, name)
	if err != nil {
		return 0, err
	}
	if parsed < min || parsed > max {
		return 0, fmt.Errorf("%s out of range", name)
	}
	return parsed, nil
}

func parseInt64Value(value interface{}, name string) (int64, error) {
	switch typed := value.(type) {
	case json.Number:
		return typed.Int64()
	case string:
		return parseInt64(typed, name)
	case float64:
		if typed != float64(int64(typed)) {
			return 0, fmt.Errorf("%s must be an integer", name)
		}
		return int64(typed), nil
	default:
		return 0, fmt.Errorf("%s must be an integer", name)
	}
}

func parseInt64(value string, name string) (int64, error) {
	if value == "" {
		return 0, fmt.Errorf("%s is required", name)
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer: %w", name, err)
	}
	return parsed, nil
}

func parseUint8(value interface{}, name string) (uint8, error) {
	parsed, err := parseInt64Value(value, name)
	if err != nil {
		return 0, err
	}
	if parsed < 0 || parsed > 255 {
		return 0, fmt.Errorf("%s out of range (0-255)", name)
	}
	return uint8(parsed), nil
}
