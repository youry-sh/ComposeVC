// Package proxyping checks that a proxy works (like curl -x ... https://i.pn).
package proxyping

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/proxy"

	"anti/internal/proxyfmt"
)

// DefaultCheckURL is a lightweight endpoint to verify exit connectivity.
const DefaultCheckURL = "https://i.pn"

// Result of a proxy ping.
type Result struct {
	OK         bool   `json:"ok"`
	Proxy      string `json:"proxy_display"`
	CheckURL   string `json:"check_url"`
	StatusCode int    `json:"status_code,omitempty"`
	BodyPreview string `json:"body_preview,omitempty"`
	LatencyMS  int64  `json:"latency_ms"`
	Error      string `json:"error,omitempty"`
	Scheme     string `json:"scheme"`
	Host       string `json:"host"`
	Port       int    `json:"port"`
	HasAuth    bool   `json:"has_auth"`
}

// Ping parses raw proxy string and GETs checkURL through it.
func Ping(raw string, checkURL string, timeout time.Duration) Result {
	if checkURL == "" {
		checkURL = DefaultCheckURL
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	raw = proxyfmt.NormalizeInput(raw)
	p, err := proxyfmt.Parse(raw)
	if err != nil {
		return Result{OK: false, Error: "parse: " + err.Error(), CheckURL: checkURL}
	}
	return PingProxy(p, checkURL, timeout)
}

// Client returns an *http.Client whose traffic goes through p (HTTP or SOCKS5).
// Used by ping and by proxygeo exit-IP lookup.
func Client(p proxyfmt.Proxy, timeout time.Duration) (*http.Client, error) {
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	return httpClientFor(p, timeout)
}

// PingProxy tests an already-parsed proxy.
func PingProxy(p proxyfmt.Proxy, checkURL string, timeout time.Duration) Result {
	if checkURL == "" {
		checkURL = DefaultCheckURL
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	res := Result{
		Proxy:    p.Display(),
		CheckURL: checkURL,
		Scheme:   p.Scheme,
		Host:     p.Host,
		Port:     p.Port,
		HasAuth:  p.HasAuth(),
	}

	client, err := Client(p, timeout)
	if err != nil {
		res.Error = err.Error()
		return res
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, checkURL, nil)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	req.Header.Set("User-Agent", "ANTI-proxy-ping/1.0")

	start := time.Now()
	resp, err := client.Do(req)
	res.LatencyMS = time.Since(start).Milliseconds()
	if err != nil {
		res.Error = err.Error()
		return res
	}
	defer resp.Body.Close()
	res.StatusCode = resp.StatusCode
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	res.BodyPreview = strings.TrimSpace(string(body))
	if len(res.BodyPreview) > 200 {
		res.BodyPreview = res.BodyPreview[:200] + "…"
	}
	// Any HTTP response through proxy means tunnel works (even 4xx from site).
	// Fail only on transport errors or 407 Proxy Auth Required.
	if resp.StatusCode == http.StatusProxyAuthRequired {
		res.OK = false
		res.Error = "407 proxy authentication required"
		return res
	}
	res.OK = true
	return res
}

func httpClientFor(p proxyfmt.Proxy, timeout time.Duration) (*http.Client, error) {
	scheme := strings.ToLower(p.Scheme)
	if scheme == "" {
		scheme = "http"
	}

	switch scheme {
	case "http", "https":
		u, err := url.Parse(p.URLWithAuth())
		if err != nil {
			return nil, err
		}
		// For https proxy scheme, still use HTTP proxy URL type with host:port
		if scheme == "https" {
			u.Scheme = "http"
		}
		tr := &http.Transport{
			Proxy: http.ProxyURL(u),
			DialContext: (&net.Dialer{
				Timeout:   timeout,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			TLSHandshakeTimeout: timeout,
			// Force HTTP/1.1 CONNECT for wider proxy compatibility
			ForceAttemptHTTP2: false,
		}
		return &http.Client{Transport: tr, Timeout: timeout}, nil

	case "socks5", "socks4":
		var auth *proxy.Auth
		if p.HasAuth() {
			auth = &proxy.Auth{User: p.User, Password: p.Pass}
		}
		addr := net.JoinHostPort(p.Host, fmt.Sprintf("%d", p.Port))
		// socks4 via x/net only socks5 dialer — use SOCKS5 for both if socks4
		dialer, err := proxy.SOCKS5("tcp", addr, auth, proxy.Direct)
		if err != nil {
			return nil, fmt.Errorf("socks dialer: %w", err)
		}
		tr := &http.Transport{
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				return dialContext(ctx, dialer, network, address)
			},
			TLSHandshakeTimeout: timeout,
			ForceAttemptHTTP2:   false,
		}
		return &http.Client{Transport: tr, Timeout: timeout}, nil
	default:
		return nil, fmt.Errorf("unsupported scheme %q", scheme)
	}
}

type contextDialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}

func dialContext(ctx context.Context, d proxy.Dialer, network, address string) (net.Conn, error) {
	if cd, ok := d.(contextDialer); ok {
		return cd.DialContext(ctx, network, address)
	}
	type result struct {
		c   net.Conn
		err error
	}
	ch := make(chan result, 1)
	go func() {
		c, err := d.Dial(network, address)
		ch <- result{c, err}
	}()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case r := <-ch:
		return r.c, r.err
	}
}
