// Package captcha solves Turnstile / reCAPTCHA / hCaptcha via the local
// Turnstile solver (tools/turnstile-solver) — paid farm providers were removed.
// Token-widget solving happens in the browser (extension-native widget click).
package captcha

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// TurnstileMode exclusive routing for Cloudflare Turnstile only.
// local = only tools/turnstile-solver (no external providers anymore).
type TurnstileMode string

const (
	TurnstileLocal TurnstileMode = "local"
)

// Settings is project-level captcha config.
type Settings struct {
	Enabled  bool `json:"enabled"`
	AutoSolve bool `json:"auto_solve"`
	// Types: empty = all supported
	Types []string `json:"types,omitempty"`
	// TimeoutSec max wait for solution
	TimeoutSec int `json:"timeout_sec,omitempty"`

	// TurnstileMode: "local" — exclusive, providers were removed.
	TurnstileMode TurnstileMode `json:"turnstile_mode"`
	// LocalURL base of Boterdrop solver (default http://127.0.0.1:8000)
	LocalURL string `json:"local_url,omitempty"`
	// AutoStartLocal start Python solver with anti-ui when mode=local
	AutoStartLocal bool `json:"auto_start_local"`
}

func (s Settings) EffectiveTimeout() int {
	if s.TimeoutSec <= 0 {
		return 120
	}
	return s.TimeoutSec
}

func (s Settings) EffectiveLocalURL() string {
	u := strings.TrimSpace(s.LocalURL)
	if u == "" {
		return "http://127.0.0.1:8000"
	}
	return strings.TrimRight(u, "/")
}

func (s Settings) EffectiveTurnstileMode() TurnstileMode {
	if s.TurnstileMode == TurnstileLocal {
		return TurnstileLocal
	}
	// default: local Turnstile (from Boterdrop)
	return TurnstileLocal
}

func (s Settings) Allows(kind string) bool {
	if len(s.Types) == 0 {
		return true
	}
	kind = strings.ToLower(strings.TrimSpace(kind))
	for _, t := range s.Types {
		if strings.EqualFold(strings.TrimSpace(t), kind) {
			return true
		}
	}
	return false
}

// Ready is true when auto-solve can run for at least one path.
func (s Settings) Ready() bool {
	if !s.Enabled {
		return false
	}
	// local turnstile alone is enough for Turnstile-only workflows
	return s.EffectiveTurnstileMode() == TurnstileLocal
}

// Public returns settings safe for UI.
func (s Settings) Public(includeKey bool) map[string]any {
	return map[string]any{
		"enabled":          s.Enabled,
		"auto_solve":       s.AutoSolve,
		"types":            s.Types,
		"timeout_sec":      s.EffectiveTimeout(),
		"ready":            s.Ready(),
		"turnstile_mode":   s.EffectiveTurnstileMode(),
		"local_url":        s.EffectiveLocalURL(),
		"auto_start_local": s.AutoStartLocal,
	}
}

var (
	mu   sync.Mutex
	path string
	cur  Settings
)

// Path returns default settings path under project root.
func Path(projectRoot string) string {
	return filepath.Join(projectRoot, "config", "captcha.json")
}

// Load reads settings from disk (or defaults).
func Load(projectRoot string) (Settings, error) {
	mu.Lock()
	defer mu.Unlock()
	path = Path(projectRoot)
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			cur = Settings{
				Enabled:        false,
				AutoSolve:      true,
				TimeoutSec:     120,
				Types: []string{
						"turnstile", "recaptcha_v2", "recaptcha_v2_enterprise",
						"recaptcha_v3", "recaptcha_v3_enterprise", "hcaptcha",
						"funcaptcha", "geetest", "geetest_v4", "aws_waf", "mtcaptcha",
						"datadome", "cloudflare_challenge", "image_to_text",
						"text_captcha", "friendly_captcha", "lemin", "capy",
					},
				TurnstileMode:  TurnstileLocal,
				LocalURL:       "http://127.0.0.1:8000",
				AutoStartLocal: true,
			}
			return cur, nil
		}
		return Settings{}, err
	}
	var s Settings
	if err := json.Unmarshal(b, &s); err != nil {
		return Settings{}, err
	}
	if s.TimeoutSec <= 0 {
		s.TimeoutSec = 120
	}
	if s.TurnstileMode == "" {
		s.TurnstileMode = TurnstileLocal
	}
	if s.LocalURL == "" {
		s.LocalURL = "http://127.0.0.1:8000"
	}
	if os.Getenv("ANTI_TURNSTILE_MODE") != "" {
		s.TurnstileMode = TurnstileLocal
	}
	if u := strings.TrimSpace(os.Getenv("ANTI_TURNSTILE_LOCAL_URL")); u != "" {
		s.LocalURL = u
	}
	if os.Getenv("ANTI_CAPTCHA_ENABLE") == "1" {
		s.Enabled = true
		s.AutoSolve = true
	}
	cur = s
	return cur, nil
}

// Get returns last loaded settings (Load first if empty path).
func Get(projectRoot string) Settings {
	mu.Lock()
	defer mu.Unlock()
	if path == "" || path != Path(projectRoot) {
		mu.Unlock()
		s, _ := Load(projectRoot)
		return s
	}
	return cur
}

// Save writes settings to disk.
func Save(projectRoot string, s Settings) error {
	mu.Lock()
	defer mu.Unlock()
	if s.TimeoutSec <= 0 {
		s.TimeoutSec = 120
	}
	if s.TurnstileMode == "" {
		s.TurnstileMode = TurnstileLocal
	}
	if s.LocalURL == "" {
		s.LocalURL = "http://127.0.0.1:8000"
	}
	dir := filepath.Join(projectRoot, "config")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	p := Path(projectRoot)
	if err := os.WriteFile(p, b, 0o600); err != nil {
		return err
	}
	path = p
	cur = s
	return nil
}
