package captcha

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// truncate limits a string to n runes for error messages.
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// solveLocalTurnstile talks to tools/turnstile-solver (Boterdrop / Camoufox API).
// Flow: GET /turnstile?url=&sitekey= → poll GET /result?id=
func solveLocalTurnstile(ctx context.Context, baseURL string, task Task) (*Solution, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8000"
	}
	if task.WebsiteURL == "" || task.WebsiteKey == "" {
		return nil, fmt.Errorf("local turnstile: website_url and website_key required")
	}

	q := url.Values{}
	q.Set("url", task.WebsiteURL)
	q.Set("sitekey", task.WebsiteKey)
	if task.Action != "" {
		q.Set("action", task.Action)
	}
	if task.CData != "" {
		q.Set("cdata", task.CData)
	}

	client := &http.Client{Timeout: 20 * time.Second}
	submitURL := baseURL + "/turnstile?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, submitURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("local turnstile unreachable (%s): %w — start tools/turnstile-solver", baseURL, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, fmt.Errorf("local turnstile busy (no free slots)")
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("local turnstile submit HTTP %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}
	var submit struct {
		TaskID  string `json:"task_id"`
		Status  string `json:"status"`
		Message string `json:"message"`
		Error   string `json:"error"`
	}
	if err := json.Unmarshal(raw, &submit); err != nil {
		return nil, fmt.Errorf("local turnstile submit parse: %w", err)
	}
	taskID := submit.TaskID
	if taskID == "" {
		return nil, fmt.Errorf("local turnstile: no task_id (%s)", truncate(string(raw), 200))
	}

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	// brief delay before first poll
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(1500 * time.Millisecond):
	}

	for {
		resultURL := baseURL + "/result?id=" + url.QueryEscape(taskID)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, resultURL, nil)
		if err != nil {
			return nil, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("local turnstile poll: %w", err)
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()

		var res struct {
			Status     string  `json:"status"`
			Value      string  `json:"value"`
			Token      string  `json:"token"`
			Message    string  `json:"message"`
			UserAgent  string  `json:"user_agent"`
			Elapsed    float64 `json:"elapsed_time"`
		}
		if err := json.Unmarshal(body, &res); err != nil {
			return nil, fmt.Errorf("local turnstile result parse: %w", err)
		}
		st := strings.ToLower(res.Status)
		switch st {
		case "success", "ready", "completed":
			tok := res.Value
			if tok == "" {
				tok = res.Token
			}
			if tok == "" {
				return nil, fmt.Errorf("local turnstile: empty token")
			}
			return &Solution{
				Token:     tok,
				UserAgent: res.UserAgent,
				TaskID:    taskID,
				Provider:  "local",
			}, nil
		case "error", "fail", "failed":
			msg := res.Message
			if msg == "" {
				msg = string(body)
			}
			return nil, fmt.Errorf("local turnstile failed: %s", truncate(msg, 240))
		}
		// process / pending / processing
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("local turnstile timeout: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

// LocalHealth pings tools/turnstile-solver /health.
func LocalHealth(ctx context.Context, baseURL string) (map[string]any, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8000"
	}
	if ctx == nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/health", nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{"raw": string(raw), "status_code": resp.StatusCode}, nil
	}
	out["ok"] = resp.StatusCode == 200
	out["base_url"] = baseURL
	return out, nil
}
