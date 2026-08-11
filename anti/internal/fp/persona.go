package fp

import (
	"fmt"
	"strings"
)

// ScreenPreset is a common desktop resolution pack (test comment edit).
type ScreenPreset struct {
	Width  int
	Height int
	Scale  float64
	// AvailHeightDelta ≈ taskbar (CreepJS avail height)
	AvailDelta int
}

// Common desktop screens as CSS pixels (screen.width/height) + devicePixelRatio.
// CRITICAL: at scale 1.25, CSS stays 1920×1080 (not 2400×1350) — 2400×1350 is
// physical device pixels (1920*1.25 × 1080*1.25). Detectors flag CSS=2400 + dpr=1.25.
// AvailDelta ≈ Windows taskbar in CSS px (so availHeight = height - delta).
var screenTable = []ScreenPreset{
	{1920, 1080, 1.0, 40},  // classic FHD
	{1920, 1080, 1.25, 40}, // FHD @125% — CSS still 1920×1080, physical 2400×1350
	{1920, 1080, 1.5, 48},  // FHD @150%
	{2560, 1440, 1.0, 40},
	{2560, 1440, 1.25, 48},
	{1366, 768, 1.0, 40},
	{1440, 900, 1.0, 40},
	{1680, 1050, 1.0, 40},
	{1600, 900, 1.0, 40},
	{1920, 1200, 1.0, 40},
	{1536, 864, 1.25, 40}, // effective CSS of 1920×1080@125% in some Win scaling modes
	{1280, 720, 1.0, 40},
}

// LocalePack keeps lang/tz coherent for a region.
type LocalePack struct {
	Lang       string
	AcceptLang string
	Timezone   string
	// SpeechNote: expected speechSynthesis locale (OS must match until C++ patch)
	SpeechExpect string
}

var localeTable = []LocalePack{
	{"en-US", "en-US,en", "America/New_York", "en-US"},
	{"en-US", "en-US,en", "America/Chicago", "en-US"},
	{"en-US", "en-US,en", "America/Los_Angeles", "en-US"},
	{"en-US", "en-US,en", "America/Denver", "en-US"},
	{"en-GB", "en-GB,en", "Europe/London", "en-GB"},
	{"en-US", "en-US,en", "America/Phoenix", "en-US"},
}

// Persona is the full coherent identity derived from seed (+ optional overrides).
type Persona struct {
	Seed                int64  `json:"seed"`
	Platform            string `json:"platform"`
	PlatformVersion     string `json:"platform_version"`
	Brand               string `json:"brand"`
	HardwareConcurrency int    `json:"hardware_concurrency"`
	// DeviceMemoryGB is what navigator.deviceMemory SHOULD report.
	// Current fingerprint-chromium patch hardcodes 8 — see docs.
	DeviceMemoryGB int     `json:"device_memory_gb"`
	ScreenWidth    int     `json:"screen_width"`
	ScreenHeight   int     `json:"screen_height"`
	DeviceScale    float64 `json:"device_scale_factor"`
	Lang           string  `json:"lang"`
	AcceptLang     string  `json:"accept_lang"`
	Timezone       string  `json:"timezone"`
	SpeechExpect   string  `json:"speech_expect"`
	// FontTier labels which subset strategy engine should use (docs / future patch)
	FontTier string `json:"font_tier"`
	// GPUHint is informational (engine picks GPU from seed tables in C++)
	GPUHint string `json:"gpu_hint"`
	// Notes for profile JSON
	Notes string `json:"notes"`
}

// DerivePersona builds a coherent pack from seed. Platform defaults to windows.
func DerivePersona(seed int64, platform string) Persona {
	if seed == 0 {
		seed = 1
	}
	if platform == "" {
		platform = PlatformWindows
	}
	platform = strings.ToLower(platform)

	u := uint32(seed)
	// Desktop-realistic even core counts. Engine formula ((seed%13)+4)*2 goes
	// up to 32; we map seed → stable pick from common set so profiles differ.
	coreTable := []int{4, 6, 8, 8, 8, 10, 12, 12, 14, 16, 8, 12, 6, 10, 16, 8}
	cores := coreTable[int(u%uint32(len(coreTable)))]

	// deviceMemory: Chrome buckets 4|8 only. Never 16/32 (Pixelscan inconsistency).
	// Engine patch 005 often hardcodes 8 or leaks host — persona + JS inject keep 4/8.
	memBuckets := []int{4, 8, 8, 8, 8, 4, 8, 8}
	mem := memBuckets[int(u%uint32(len(memBuckets)))]
	if cores <= 6 {
		mem = 4
	} else {
		mem = 8
	}

	sc := screenTable[int(u%uint32(len(screenTable)))]
	loc := localeTable[int((u/7)%uint32(len(localeTable)))]

	fontTier := []string{"win-full", "win-common", "win-office"}[int(u%3)]
	// GPUHint is NOTES only — real WebGL comes from C++ seed tables in the binary.
	gpuHint := fmt.Sprintf(
		"engine-seed-gpu (WebGL from chromium fingerprint seed=%d)",
		seed,
	)
	platVer := "10.0.19045"
	if platform == PlatformMacOS {
		platVer = "14.5.0"
		fontTier = "mac-common"
	}
	if platform == PlatformLinux {
		platVer = "6.5.0"
		fontTier = "linux-dejavu"
	}

	p := Persona{
		Seed:                seed,
		Platform:            platform,
		PlatformVersion:     platVer,
		Brand:               "Chrome",
		HardwareConcurrency: cores,
		DeviceMemoryGB:      mem,
		ScreenWidth:         sc.Width,
		ScreenHeight:        sc.Height,
		DeviceScale:         sc.Scale,
		Lang:                loc.Lang,
		AcceptLang:          loc.AcceptLang,
		Timezone:            loc.Timezone,
		SpeechExpect:        loc.SpeechExpect,
		FontTier:            fontTier,
		GPUHint:             gpuHint,
	}
	p.Notes = fmt.Sprintf(
		"persona seed=%d cores=%d mem=%dGB screen=%dx%d@%g tz=%s speech=%s fonts=%s | %s",
		seed, cores, mem, sc.Width, sc.Height, sc.Scale, loc.Timezone, loc.SpeechExpect, fontTier, gpuHint,
	)
	return p
} // ApplyPersona fills empty/auto fields on Config from seed-derived persona.
// Explicit non-zero / non-empty fields on c are preserved (override).
//
// Cores: if HardwareConcurrency==0, use seed formula (do NOT force 8).
// Screen/lang/tz: fill only when empty/zero.
// IMPORTANT: when Proxy is set, timezone/lang should be applied from proxy EXIT
// (ApplyProxyGeo) BEFORE or AFTER this — never leave America/* from seed when
// the exit IP is elsewhere. Call ApplyProxyGeo first when proxy is present.
func ApplyPersona(c *Config) {
	if c.Seed == 0 {
		return
	}
	p := DerivePersona(c.Seed, c.Platform)

	if c.Platform == "" {
		c.Platform = p.Platform
	}
	if c.PlatformVersion == "" {
		c.PlatformVersion = p.PlatformVersion
	}
	if c.Brand == "" {
		c.Brand = p.Brand
	}
	if c.HardwareConcurrency == 0 {
		c.HardwareConcurrency = p.HardwareConcurrency
	}
	if c.ScreenWidth == 0 {
		c.ScreenWidth = p.ScreenWidth
	}
	if c.ScreenHeight == 0 {
		c.ScreenHeight = p.ScreenHeight
	}
	if c.DeviceScale == 0 {
		c.DeviceScale = p.DeviceScale
	}
	// Locale: seed is last resort. Prefer values already set by ApplyProxyGeo.
	if c.Lang == "" {
		c.Lang = p.Lang
	}
	if c.AcceptLang == "" {
		c.AcceptLang = p.AcceptLang
	}
	if c.Timezone == "" {
		c.Timezone = p.Timezone
	}

	// Expected device memory for documentation / future engine flag
	if c.DeviceMemoryGB == 0 {
		c.DeviceMemoryGB = p.DeviceMemoryGB
	}
	if c.FontTier == "" {
		c.FontTier = p.FontTier
	}
	if c.SpeechExpect == "" {
		// Align speech with lang when proxy geo set a non-seed lang
		if c.Lang != "" && c.Lang != p.Lang {
			c.SpeechExpect = c.Lang
		} else {
			c.SpeechExpect = p.SpeechExpect
		}
	}
	if c.GPUHint == "" {
		c.GPUHint = p.GPUHint
	}

	// Hardening defaults
	// WebRTC UDP: with proxy always block non-proxied UDP (no real-IP leak).
	// Trade-off: CreepJS may mark "WebRTC blocked" as privacy — better than IP leak.
	if strings.TrimSpace(c.Proxy) != "" {
		c.DisableNonProxiedUDP = true
	}
	c.NoFirstRun = true
	c.NoDefaultBrowser = true
	if c.HeadlessHardening {
		c.ExtraArgs = mergeUniqueArgs(c.ExtraArgs, HeadlessHardeningArgs())
	}
	if c.LoadSpeechExtension {
		// path filled by launch package (needs project root)
		c.WantSpeechExtension = true
	}
	// Noise / disable-spoofing policy (full|balanced|native)
	ApplyNoiseMode(c)
}

// HeadlessHardeningArgs — keep automation quiet without privacy-browser signals.
// Extra: disable site isolation + 3P storage partitioning so Stripe/CF iframes
// share cookies/storage like a normal desktop Chrome (Elements often hang otherwise).
func HeadlessHardeningArgs() []string {
	return []string{
		"--exclude-switches=enable-automation",
		"--disable-infobars",
		"--password-store=basic",
		"--use-mock-keychain",
		"--no-service-autorun",
		"--disable-blink-features=AutomationControlled",
		"--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests,ThirdPartyStoragePartitioning",
		"--disable-site-isolation-trials",
	}
}

func mergeUniqueArgs(base, extra []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, a := range base {
		if a == "" || seen[a] {
			continue
		}
		seen[a] = true
		out = append(out, a)
	}
	for _, a := range extra {
		if a == "" || seen[a] {
			continue
		}
		seen[a] = true
		out = append(out, a)
	}
	return out
}

// Summary line for CLI.
func (p Persona) Summary() string {
	return p.Notes
}
