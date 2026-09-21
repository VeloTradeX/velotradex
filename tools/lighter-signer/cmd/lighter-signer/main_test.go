package main

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestBinarySignSmoke(t *testing.T) {
	rootDir := moduleRoot(t)
	binPath := filepath.Join(t.TempDir(), "lighter-signer")

	build := exec.Command("go", "build", "-o", binPath, "./cmd/lighter-signer")
	build.Dir = rootDir
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build failed: %v\n%s", err, string(output))
	}

	payload := map[string]any{
		"apiPrivateKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"baseURL":       "https://mainnet.zklighter.elliot.ai",
		"accountIndex":  1,
		"apiKeyIndex":   0,
		"intent": map[string]any{
			"action": "place_order",
			"nonce":  "1",
			"payload": map[string]any{
				"market_index":       1,
				"client_order_index": 1001,
				"base_amount":        1,
				"price":              1,
				"is_ask":             false,
				"order_type":         "limit",
				"reduce_only":        false,
				"post_only":          false,
			},
		},
	}

	stdin, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}

	cmd := exec.Command(binPath, "sign")
	cmd.Dir = rootDir
	cmd.Stdin = bytes.NewReader(stdin)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("sign command failed: %v\n%s", err, string(out))
	}

	var result struct {
		TxType     uint8  `json:"txType"`
		TxInfo     string `json:"txInfo"`
		TxInfoHash string `json:"txInfoHash"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("unmarshal signer output: %v\n%s", err, string(out))
	}
	if result.TxType == 0 {
		t.Fatalf("expected non-zero txType, got %d", result.TxType)
	}
	if result.TxInfo == "" {
		t.Fatal("expected txInfo to be populated")
	}
	if result.TxInfoHash == "" {
		t.Fatal("expected txInfoHash to be populated")
	}
}

func TestBinaryAuthTokenSmoke(t *testing.T) {
	rootDir := moduleRoot(t)
	binPath := filepath.Join(t.TempDir(), "lighter-signer")

	build := exec.Command("go", "build", "-o", binPath, "./cmd/lighter-signer")
	build.Dir = rootDir
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build failed: %v\n%s", err, string(output))
	}

	payload := map[string]any{
		"apiPrivateKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"baseURL":       "https://mainnet.zklighter.elliot.ai",
		"accountIndex":  0,
		"apiKeyIndex":   0,
		"deadline":      0,
	}

	stdin, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}

	cmd := exec.Command(binPath, "auth-token")
	cmd.Dir = rootDir
	cmd.Stdin = bytes.NewReader(stdin)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("auth-token command failed: %v\n%s", err, string(out))
	}

	var result struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("unmarshal auth-token output: %v\n%s", err, string(out))
	}
	if result.Token == "" {
		t.Fatal("expected token to be populated")
	}
	if result.ExpiresAt == 0 {
		t.Fatal("expected expiresAt to be populated")
	}
}

func TestParseTimeInForce(t *testing.T) {
	tests := []struct {
		name      string
		payload   map[string]interface{}
		orderType uint8
		expected  uint8
	}{
		{"limit defaults to good-till-time", map[string]interface{}{}, orderTypeLimit, tifGoodTillTime},
		{"limit post_only", map[string]interface{}{"post_only": true}, orderTypeLimit, tifPostOnly},
		{"market returns IOC", map[string]interface{}{}, orderTypeMarket, tifImmediateOrCancel},
		{"market with post_only returns post-only", map[string]interface{}{"post_only": true}, orderTypeMarket, tifPostOnly},
		{"stop_loss must return IOC", map[string]interface{}{}, orderTypeStopLoss, tifImmediateOrCancel},
		{"stop_loss with post_only still returns IOC", map[string]interface{}{"post_only": true}, orderTypeStopLoss, tifImmediateOrCancel},
		{"take_profit must return IOC", map[string]interface{}{}, orderTypeTakeProfit, tifImmediateOrCancel},
		{"take_profit with post_only still returns IOC", map[string]interface{}{"post_only": true}, orderTypeTakeProfit, tifImmediateOrCancel},
		{"stop_loss_limit defaults to good-till-time", map[string]interface{}{}, orderTypeStopLossLimit, tifGoodTillTime},
		{"take_profit_limit defaults to good-till-time", map[string]interface{}{}, orderTypeTakeProfitLimit, tifGoodTillTime},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := parseTimeInForce(tt.payload, tt.orderType)
			if result != tt.expected {
				t.Errorf("parseTimeInForce(%v, %d) = %d, want %d", tt.payload, tt.orderType, result, tt.expected)
			}
		})
	}
}

func TestBinarySignSmokeStopLoss(t *testing.T) {
	rootDir := moduleRoot(t)
	binPath := filepath.Join(t.TempDir(), "lighter-signer")

	build := exec.Command("go", "build", "-o", binPath, "./cmd/lighter-signer")
	build.Dir = rootDir
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build failed: %v\n%s", err, string(output))
	}

	payload := map[string]any{
		"apiPrivateKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"baseURL":       "https://mainnet.zklighter.elliot.ai",
		"accountIndex":  1,
		"apiKeyIndex":   0,
		"intent": map[string]any{
			"action": "place_order",
			"nonce":  "1",
			"payload": map[string]any{
				"market_index":       1,
				"client_order_index": 1001,
				"base_amount":        1000000,
				"price":              6500000,
				"is_ask":             false,
				"order_type":         "stop_loss",
				"reduce_only":        true,
				"trigger_price":      6500000,
			},
		},
	}

	stdin, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}

	cmd := exec.Command(binPath, "sign")
	cmd.Dir = rootDir
	cmd.Stdin = bytes.NewReader(stdin)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("stop_loss sign command failed: %v\n%s", err, string(out))
	}

	var result struct {
		TxType     uint8  `json:"txType"`
		TxInfo     string `json:"txInfo"`
		TxInfoHash string `json:"txInfoHash"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("unmarshal signer output: %v\n%s", err, string(out))
	}
	if result.TxType == 0 {
		t.Fatalf("expected non-zero txType, got %d", result.TxType)
	}
	if result.TxInfo == "" {
		t.Fatal("expected txInfo to be populated")
	}
}

func TestParseMarginMode(t *testing.T) {
	tests := []struct {
		input    interface{}
		expected uint8
		wantErr  bool
	}{
		{"cross", 0, false},
		{"isolated", 1, false},
		{"0", 0, false},
		{"1", 1, false},
		{"", 0, false},
		{"invalid", 0, true},
	}
	for _, tt := range tests {
		result, err := parseMarginMode(tt.input)
		if (err != nil) != tt.wantErr {
			t.Errorf("parseMarginMode(%v) error = %v, wantErr %v", tt.input, err, tt.wantErr)
		}
		if !tt.wantErr && result != tt.expected {
			t.Errorf("parseMarginMode(%v) = %d, want %d", tt.input, result, tt.expected)
		}
	}
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("unable to resolve test file path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", ".."))
}
