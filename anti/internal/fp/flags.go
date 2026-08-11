// Package fp maps fingerprint-chromium engine switches (from real patches).
// Source: adryfish/fingerprint-chromium patches/extra/fingerprint/*
package fp

import (
	"fmt"
	"strconv"
	"strings"
)

// Known switches from 000-add-fingerprint-switches.patch (ungoogled_switches).
const (
	SwitchFingerprint                    = "fingerprint"
	SwitchFingerprintBrand               = "fingerprint-brand"
	SwitchFingerprintBrandVersion        = "fingerprint-brand-version"
	SwitchDisableSpoofing                = "disable-spoofing"
	SwitchFingerprintScreenWidth         = "fingerprint-screen-width"
	SwitchFingerprintScreenHeight        = "fingerprint-screen-height"
	SwitchFingerprintDeviceScale         = "fingerprint-device-scale-factor"
	SwitchFingerprintHardwareConcurrency = "fingerprint-hardware-concurrency"
	SwitchFingerprintPlatform            = "fingerprint-platform"
	SwitchFingerprintPlatformVersion     = "fingerprint-platform-version"
	SwitchFingerprintLocation            = "fingerprint-location"
	SwitchTimezone                       = "timezone"
)

const (
	PlatformWindows = "windows"
	PlatformLinux   = "linux"
	PlatformMacOS   = "macos"
)

// Noise modes — trade isolation vs "masking detected".
const (
	// NoiseFull: all engine noise ON — max uniqueness, Pixelscan often "Masking detected".
	NoiseFull = "full"
	// NoiseBalanced: no canvas/audio/clientrects noise; keep gpu+font spoof (default).
	NoiseBalanced = "balanced"
	// NoiseNative: disable canvas/audio/clientrects/font/gpu noise; only screen/cores/tz.
	NoiseNative = "native"
)

// Config is a deterministic persona for the patched Chromium binary.
type Config struct {
	Seed int64 `json:"seed"`

	Platform        string `json:"platform,omitempty"`
	PlatformVersion string `json:"platform_version,omitempty"`

	Brand        string `json:"brand,omitempty"`
	BrandVersion string `json:"brand_version,omitempty"`

	// 0 = ApplyPersona uses seed formula
	HardwareConcurrency int `json:"hardware_concurrency,omitempty"`
	// Expected navigator.deviceMemory for profile docs / JS inject.
	// Engine patch 005 hardcodes 8; host leak (32) needs inject or rebuild.
	DeviceMemoryGB int `json:"device_memory_gb,omitempty"`

	ScreenWidth  int     `json:"screen_width,omitempty"`
	ScreenHeight int     `json:"screen_height,omitempty"`
	DeviceScale  float64 `json:"device_scale_factor,omitempty"`

	Lang       string `json:"lang,omitempty"`
	AcceptLang string `json:"accept_lang,omitempty"`
	Timezone   string `json:"timezone,omitempty"`
	Location   string `json:"location,omitempty"`

	SpeechExpect string `json:"speech_expect,omitempty"`
	FontTier     string `json:"font_tier,omitempty"`
	GPUHint      string `json:"gpu_hint,omitempty"`

	Proxy string `json:"proxy,omitempty"`

	// DisableSpoofing → --disable-spoofing=… (engine find() tokens: canvas,audio,clientrects,font,gpu)
	// Empty = full spoof/noise. See ResolveNoiseMode / ApplyNoiseMode.
	DisableSpoofing string `json:"disable_spoofing,omitempty"`
	// NoiseMode: full | balanced | native
	NoiseMode string `json:"noise_mode,omitempty"`

	ExtraArgs []string `json:"extra_args,omitempty"`

	HeadlessHardening   bool `json:"headless_hardening"`
	LoadSpeechExtension bool `json:"load_speech_extension"`
	WantSpeechExtension bool `json:"-"`

	DisableNonProxiedUDP bool `json:"disable_non_proxied_udp"`
	NoFirstRun           bool `json:"no_first_run"`
	NoDefaultBrowser     bool `json:"no_default_browser_check"`
}

// ResolveNoiseMode maps full|balanced|native → disable-spoofing value.
func ResolveNoiseMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "", NoiseFull, "default", "max", "all":
		return "" // omit flag → all noise ON
	case NoiseBalanced, "balance", "soft", "less-mask":
		return "canvas,audio,clientrects"
	case NoiseNative, "off", "none", "clean":
		return "canvas,audio,clientrects,font,gpu"
	default:
		return strings.TrimSpace(mode)
	}
}

// ApplyNoiseMode sets DisableSpoofing from NoiseMode when DisableSpoofing empty.
func ApplyNoiseMode(c *Config) {
	if c == nil {
		return
	}
	if strings.TrimSpace(c.DisableSpoofing) != "" {
		return
	}
	mode := c.NoiseMode
	if mode == "" {
		mode = NoiseFull
	}
	c.NoiseMode = strings.ToLower(strings.TrimSpace(mode))
	if c.NoiseMode == "" {
		c.NoiseMode = NoiseFull
	}
	c.DisableSpoofing = ResolveNoiseMode(c.NoiseMode)
}

// DefaultConfig — no forced cores=8; call ApplyPersona after Seed is set.
func DefaultConfig() Config {
	return Config{
		Platform:             PlatformWindows,
		PlatformVersion:      "10.0.19045",
		Brand:                "Chrome",
		Lang:                 "",
		AcceptLang:           "",
		Timezone:             "",
		DeviceScale:          0,
		DisableNonProxiedUDP: true,
		NoFirstRun:           true,
		NoDefaultBrowser:     true,
		HeadlessHardening:    true,
		LoadSpeechExtension:  true,
		NoiseMode:            NoiseBalanced,
	}
}

func DerivedHardwareConcurrency(seed int64) int {
	u := uint32(seed)
	return int(((u % 13) + 4) * 2)
}

func (c Config) Args(userDataDir string) []string {
	var args []string

	if userDataDir != "" {
		args = append(args, "--user-data-dir="+userDataDir)
	}
	if c.Seed != 0 {
		args = append(args, fmt.Sprintf("--%s=%d", SwitchFingerprint, c.Seed))
	}
	if p := strings.ToLower(strings.TrimSpace(c.Platform)); p != "" {
		args = append(args, "--"+SwitchFingerprintPlatform+"="+p)
	}
	if c.PlatformVersion != "" {
		args = append(args, "--"+SwitchFingerprintPlatformVersion+"="+c.PlatformVersion)
	}
	if c.Brand != "" {
		args = append(args, "--"+SwitchFingerprintBrand+"="+c.Brand)
	}
	if c.BrandVersion != "" {
		args = append(args, "--"+SwitchFingerprintBrandVersion+"="+c.BrandVersion)
	}
	if c.HardwareConcurrency > 0 {
		args = append(args, "--"+SwitchFingerprintHardwareConcurrency+"="+strconv.Itoa(c.HardwareConcurrency))
	}
	if c.ScreenWidth > 0 {
		args = append(args, "--"+SwitchFingerprintScreenWidth+"="+strconv.Itoa(c.ScreenWidth))
	}
	if c.ScreenHeight > 0 {
		args = append(args, "--"+SwitchFingerprintScreenHeight+"="+strconv.Itoa(c.ScreenHeight))
	}
	if c.DeviceScale > 0 {
		args = append(args, fmt.Sprintf("--%s=%g", SwitchFingerprintDeviceScale, c.DeviceScale))
	}
	if c.Location != "" {
		args = append(args, "--"+SwitchFingerprintLocation+"="+c.Location)
	}
	if c.Timezone != "" {
		args = append(args, "--"+SwitchTimezone+"="+c.Timezone)
	}
	if c.Lang != "" {
		args = append(args, "--lang="+c.Lang)
	}
	if c.AcceptLang != "" {
		args = append(args, "--accept-lang="+c.AcceptLang)
	}
	if c.Proxy != "" {
		args = append(args, "--proxy-server="+c.Proxy)
	}
	// Noise policy → --disable-spoofing
	if c.DisableSpoofing == "" && c.NoiseMode != "" {
		ApplyNoiseMode(&c)
	}
	if c.DisableSpoofing != "" {
		args = append(args, "--"+SwitchDisableSpoofing+"="+c.DisableSpoofing)
	}
	if c.DisableNonProxiedUDP {
		args = append(args, "--disable-non-proxied-udp")
	}
	if c.NoFirstRun {
		args = append(args, "--no-first-run")
	}
	if c.NoDefaultBrowser {
		args = append(args, "--no-default-browser-check")
	}
	args = append(args, c.ExtraArgs...)
	return args
}

func (c Config) Validate() error {
	if c.Seed == 0 {
		return fmt.Errorf("seed must be non-zero (--fingerprint master switch)")
	}
	switch strings.ToLower(strings.TrimSpace(c.Platform)) {
	case "", PlatformWindows, PlatformLinux, PlatformMacOS:
	default:
		return fmt.Errorf("platform must be windows|linux|macos, got %q", c.Platform)
	}
	return nil
}
