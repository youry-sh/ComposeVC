package profile

import (
	"fmt"
	"os"
	"strings"
	"time"

	"anti/internal/fp"
	"anti/internal/proxygeo"
)

// applyProxyLocaleToConfig resolves proxy EXIT geo and fills empty (or seed-US) locale fields.
// applyTZ / applyLang control which fields may be written (false = explicit user override).
// Order: (1) instant username country-XX (2) live exit lookup with short timeout.
func applyProxyLocaleToConfig(cfg *fp.Config, applyTZ, applyLang bool) {
	if cfg == nil || strings.TrimSpace(cfg.Proxy) == "" {
		return
	}
	if os.Getenv("ANTI_KEEP_LOCALE") == "1" {
		return
	}
	if os.Getenv("ANTI_NO_PROXY_GEO") == "1" {
		return
	}

	// 1) Instant: country in proxy username / string (country-IN, cc-DE, …)
	//    Always apply first so dead proxies still get correct TZ without waiting.
	hadUsername := false
	if quick := proxygeo.LookupUsernameOnly(cfg.Proxy); quick.Timezone != "" || quick.Lang != "" {
		hadUsername = true
		applyInfo(cfg, quick, applyTZ, applyLang)
		fmt.Fprintf(os.Stderr,
			"  proxy geo (username): tz=%s lang=%s via=%s\n",
			cfg.Timezone, cfg.Lang, quick.Via,
		)
	}

	// Optional skip live exit (username-only mode)
	if os.Getenv("ANTI_PROXY_GEO_USERNAME_ONLY") == "1" && hadUsername {
		return
	}

	// 2) Live exit IP (preferred when proxy works) — short timeout, non-blocking past limit
	type result struct {
		info proxygeo.Info
	}
	ch := make(chan result, 1)
	go func() {
		ch <- result{info: proxygeo.Lookup(cfg.Proxy)}
	}()

	// If username already set locale, don't stall create/launch long on dead exit.
	timeout := 2500 * time.Millisecond
	if hadUsername {
		timeout = 800 * time.Millisecond
	}
	if v := strings.TrimSpace(os.Getenv("ANTI_PROXY_GEO_TIMEOUT_MS")); v != "" {
		if n, err := time.ParseDuration(v + "ms"); err == nil && n > 0 {
			timeout = n
		}
	}

	select {
	case r := <-ch:
		info := r.info
		if info.Timezone == "" && info.Lang == "" {
			if info.Error != "" {
				fmt.Fprintf(os.Stderr, "  proxy geo exit: %s (kept username/seed)\n", info.Error)
			}
			return
		}
		// Prefer live exit over username when available
		applyInfo(cfg, info, applyTZ, applyLang)
		fmt.Fprintf(os.Stderr,
			"  proxy geo (exit): tz=%s lang=%s ip=%s via=%s (%s)\n",
			cfg.Timezone, cfg.Lang, info.IP, info.Via, info.Source,
		)
	case <-time.After(timeout):
		// Username already applied if present — do not block launch further
		fmt.Fprintf(os.Stderr, "  proxy geo: exit lookup timeout after %s (using username/seed)\n", timeout)
	}
}

func applyInfo(cfg *fp.Config, info proxygeo.Info, applyTZ, applyLang bool) {
	g := fp.ProxyGeo{
		Timezone:    info.Timezone,
		Lang:        info.Lang,
		CountryCode: info.CountryCode,
		Country:     info.Country,
		City:        info.City,
		IP:          info.IP,
		Via:         info.Via,
		Source:      info.Source,
	}
	if !applyTZ {
		g.Timezone = ""
	}
	if !applyLang {
		g.Lang = ""
	}
	if g.Timezone == "" && g.Lang == "" {
		return
	}
	fp.ApplyProxyGeo(cfg, g, true)
}

// RefreshProxyLocaleOnLaunch updates profile FP locale from live proxy exit.
// Returns true if profile was mutated (caller should Save).
func RefreshProxyLocaleOnLaunch(p *Profile) bool {
	if p == nil || strings.TrimSpace(p.FP.Proxy) == "" {
		return false
	}
	if os.Getenv("ANTI_KEEP_LOCALE") == "1" || os.Getenv("ANTI_NO_PROXY_GEO") == "1" {
		return false
	}
	beforeTZ, beforeLang := p.FP.Timezone, p.FP.Lang
	// Always refresh from exit on launch (important: seed America/* must not stick)
	applyProxyLocaleToConfig(&p.FP, true, true)
	return p.FP.Timezone != beforeTZ || p.FP.Lang != beforeLang
}
