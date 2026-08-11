package captcha

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Kind of captcha widget.
type Kind string

const (
	KindTurnstile            Kind = "turnstile"
	KindRecaptchaV2          Kind = "recaptcha_v2"
	KindRecaptchaV2Enterprise Kind = "recaptcha_v2_enterprise"
	KindRecaptchaV3          Kind = "recaptcha_v3"
	KindRecaptchaV3Enterprise Kind = "recaptcha_v3_enterprise"
	KindHCaptcha             Kind = "hcaptcha"
	KindFunCaptcha           Kind = "funcaptcha"
	KindGeeTest              Kind = "geetest"
	KindGeeTestV4            Kind = "geetest_v4"
	KindAwsWaf               Kind = "aws_waf"
	KindMTCaptcha            Kind = "mtcaptcha"
	KindDataDome             Kind = "datadome"
	KindCloudflareChallenge  Kind = "cloudflare_challenge"
	KindImageToText          Kind = "image_to_text"
	KindTextCaptcha          Kind = "text_captcha"
	KindFriendlyCaptcha      Kind = "friendly_captcha"
	KindLemin                Kind = "lemin"
	KindCapy                 Kind = "capy"
)

// Task is a solve request from UI / extension / CDP helper.
type Task struct {
	Kind       Kind   `json:"kind"`
	WebsiteURL string `json:"website_url"`
	WebsiteKey string `json:"website_key"` // sitekey / public key
	// Turnstile challenge extras (optional)
	Action   string `json:"action,omitempty"`
	CData    string `json:"cdata,omitempty"`
	PageData string `json:"pagedata,omitempty"`
	// reCAPTCHA v3
	PageAction string  `json:"page_action,omitempty"`
	MinScore   float64 `json:"min_score,omitempty"`
	// GeeTest
	GT        string `json:"gt,omitempty"`
	Challenge string `json:"challenge,omitempty"`
	CaptchaID string `json:"captcha_id,omitempty"`
	// FunCaptcha subdomain
	Subdomain string `json:"subdomain,omitempty"`
	// AWS WAF
	AwsKey         string `json:"aws_key,omitempty"`
	AwsIv          string `json:"aws_iv,omitempty"`
	AwsContext     string `json:"aws_context,omitempty"`
	AwsChallengeJS string `json:"aws_challenge_js,omitempty"`
	AwsApiJs       string `json:"aws_api_js,omitempty"`
	// Image OCR (base64)
	Body   string `json:"body,omitempty"`
	Module string `json:"module,omitempty"`
	// Text captcha
	Comment string `json:"comment,omitempty"`
	// DataDome etc.
	CaptchaURL string `json:"captcha_url,omitempty"`
	// Optional user proxy for provider (TurnstileTask with user proxy)
	Proxy string `json:"proxy,omitempty"`
	// UserAgent hint (some challenge flows)
	UserAgent string `json:"user_agent,omitempty"`
}

// Solution returned by provider.
type Solution struct {
	Token     string `json:"token"`
	UserAgent string `json:"user_agent,omitempty"`
	Provider  string `json:"provider"`
	Kind      Kind   `json:"kind"`
	TaskID    string `json:"task_id,omitempty"`
	ElapsedMS int64  `json:"elapsed_ms"`
}

// Solve routes captcha tasks using global config/captcha.json.
// Paid farm providers (CapSolver/2captcha) were REMOVED — only the local
// Turnstile solver remains (tools/turnstile-solver). All other captcha kinds
// are solved in-browser by the extension-native widget click (antiBrowser).
func Solve(ctx context.Context, projectRoot string, task Task) (*Solution, error) {
	s, err := Load(projectRoot)
	if err != nil {
		return nil, err
	}
	return SolveWithSettings(ctx, projectRoot, s, task)
}

// SolveWithSettings is like Solve but uses the provided settings (e.g. profile override).
func SolveWithSettings(ctx context.Context, projectRoot string, s Settings, task Task) (*Solution, error) {
	if !s.Enabled {
		return nil, fmt.Errorf("captcha disabled in settings")
	}
	task.Kind = Kind(strings.ToLower(string(task.Kind)))
	if task.Kind == "" {
		task.Kind = KindTurnstile
	}
	if !s.Allows(string(task.Kind)) {
		return nil, fmt.Errorf("captcha kind %q disabled in settings", task.Kind)
	}
	task.WebsiteURL = strings.TrimSpace(task.WebsiteURL)
	task.WebsiteKey = strings.TrimSpace(task.WebsiteKey)
	if err := validateTaskFields(task); err != nil {
		return nil, err
	}
	timeout := time.Duration(s.EffectiveTimeout()) * time.Second
	if ctx == nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.Background(), timeout)
		defer cancel()
	} else {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	start := time.Now()
	var sol *Solution
	var err error

	// ── Local Turnstile only (providers removed) ──
	if task.Kind == KindTurnstile {
		if s.AutoStartLocal {
			_ = EnsureLocalRunning(projectRoot, s.EffectiveLocalURL())
		}
		sol, err = solveLocalTurnstile(ctx, s.EffectiveLocalURL(), task)
		if err != nil {
			return nil, fmt.Errorf("local turnstile: %w", err)
		}
		sol.Provider = "local"
	} else {
		return nil, fmt.Errorf(
			"kind %q has no solver — paid providers were removed; solve this captcha in-browser via captcha_pass (extension-native widget click)",
			task.Kind,
		)
	}

	sol.Kind = task.Kind
	sol.ElapsedMS = time.Since(start).Milliseconds()
	return sol, nil
}

// validateTaskFields checks required fields per captcha kind.
func validateTaskFields(task Task) error {
	switch task.Kind {
	case KindImageToText:
		if strings.TrimSpace(task.Body) == "" {
			return fmt.Errorf("body (base64 image) required for image_to_text")
		}
		return nil
	case KindTextCaptcha:
		if strings.TrimSpace(task.Comment) == "" {
			return fmt.Errorf("comment required for text_captcha")
		}
		return nil
	case KindGeeTest:
		if task.WebsiteURL == "" {
			return fmt.Errorf("website_url required")
		}
		if strings.TrimSpace(task.GT) == "" && task.WebsiteKey == "" {
			return fmt.Errorf("gt (or website_key) required for geetest")
		}
		if strings.TrimSpace(task.Challenge) == "" {
			return fmt.Errorf("challenge required for geetest v3")
		}
		return nil
	case KindGeeTestV4:
		if task.WebsiteURL == "" {
			return fmt.Errorf("website_url required")
		}
		if strings.TrimSpace(task.CaptchaID) == "" && task.WebsiteKey == "" {
			return fmt.Errorf("captcha_id (or website_key) required for geetest_v4")
		}
		return nil
	case KindDataDome, KindCloudflareChallenge:
		if task.WebsiteURL == "" {
			return fmt.Errorf("website_url required")
		}
		return nil
	case KindAwsWaf:
		if task.WebsiteURL == "" {
			return fmt.Errorf("website_url required")
		}
		// key/iv/context optional depending on site situation
		return nil
	default:
		// token widgets: turnstile, recaptcha*, hcaptcha, funcaptcha, mtcaptcha, friendly, lemin, capy
		if task.WebsiteURL == "" || task.WebsiteKey == "" {
			return fmt.Errorf("website_url and website_key required")
		}
		return nil
	}
}
