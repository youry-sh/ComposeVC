package profile

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"anti/internal/fp"
)

// Profile is one isolated browser identity + disk profile dir.
type Profile struct {
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	// DataDir is relative to profiles root, e.g. "data/my-shop"
	DataDir string    `json:"data_dir"`
	FP      fp.Config `json:"fingerprint"`
	Notes   string    `json:"notes,omitempty"`

	// CaptchaSolver per-profile override: "" | "local" (paid providers removed).
	// Empty or "global" = use project config/captcha.json (local Turnstile).
	CaptchaSolver string `json:"captcha_solver,omitempty"`
}

// NormalizeCaptchaSolver returns "" (global) or "local" — paid farms removed.
func NormalizeCaptchaSolver(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	switch s {
	case "", "global", "default", "auto":
		return ""
	case "local", "boterdrop", "turnstile-local":
		return "local"
	default:
		return "local"
	}
}

// Store manages profiles under root (default: <anti>/profiles).
type Store struct {
	Root string
}

func NewStore(root string) *Store {
	return &Store{Root: root}
}

func (s *Store) metaPath(name string) string {
	return filepath.Join(s.Root, sanitize(name)+".json")
}

func (s *Store) dataPath(name string) string {
	return filepath.Join(s.Root, "data", sanitize(name))
}

func sanitize(name string) string {
	name = strings.TrimSpace(name)
	name = strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			return '_'
		default:
			return r
		}
	}, name)
	if name == "" {
		return "default"
	}
	return name
}

// List returns sorted profile names.
func (s *Store) List() ([]Profile, error) {
	entries, err := os.ReadDir(s.Root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []Profile
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		p, err := s.Get(strings.TrimSuffix(e.Name(), ".json"))
		if err != nil {
			continue
		}
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// Get loads a profile by name.
func (s *Store) Get(name string) (*Profile, error) {
	b, err := os.ReadFile(s.metaPath(name))
	if err != nil {
		return nil, err
	}
	var p Profile
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// Save writes profile metadata and ensures data dir exists.
func (s *Store) Save(p *Profile) error {
	if p.Name == "" {
		return fmt.Errorf("profile name required")
	}
	p.Name = sanitize(p.Name)
	if p.DataDir == "" {
		p.DataDir = filepath.Join("data", p.Name)
	}
	now := time.Now().UTC()
	if p.CreatedAt.IsZero() {
		p.CreatedAt = now
	}
	p.UpdatedAt = now

	if err := os.MkdirAll(s.Root, 0o755); err != nil {
		return err
	}
	absData := filepath.Join(s.Root, p.DataDir)
	if err := os.MkdirAll(absData, 0o755); err != nil {
		return err
	}

	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.metaPath(p.Name), b, 0o644)
}

// Delete removes metadata (optionally data dir).
func (s *Store) Delete(name string, wipeData bool) error {
	name = sanitize(name)
	_ = os.Remove(s.metaPath(name))
	if wipeData {
		_ = os.RemoveAll(s.dataPath(name))
	}
	return nil
}

// AbsDataDir returns absolute user-data-dir for chrome.
func (s *Store) AbsDataDir(p *Profile) string {
	if filepath.IsAbs(p.DataDir) {
		return p.DataDir
	}
	return filepath.Join(s.Root, p.DataDir)
}

// NewRandomSeed returns a large non-zero seed from crypto/rand.
// Always ≥ 1e8 (9-digit typical, e.g. 477486553) so unit-index leftovers (1, 4, 12)
// never collide with real fingerprint seeds. Range: 100_000_000 .. 0x7fffffff.
func NewRandomSeed() int64 {
	const minSeed int64 = 100_000_000 // 9 digits minimum
	var buf [4]byte
	if _, err := rand.Read(buf[:]); err != nil {
		v := time.Now().UnixNano() & 0x7fffffff
		if v < minSeed {
			v = minSeed + (v % (0x7fffffff - minSeed + 1))
		}
		if v == 0 {
			return 477486553
		}
		return v
	}
	v := int64(binary.LittleEndian.Uint32(buf[:])) & 0x7fffffff
	if v < minSeed {
		// Stretch small values into 9-digit+ range without clustering at min
		v = minSeed + (v % (0x7fffffff - minSeed + 1))
	}
	if v == 0 {
		v = 477486553
	}
	return v
}

// Create builds a new profile with seed-derived persona pack.
// HardwareConcurrency 0 → formula from seed (not forced 8).
// Screen empty → seed tables.
// Timezone/lang: if Proxy set → from proxy EXIT IP (proxygeo); else seed locale.
// Explicit -tz/-lang flags always win (non-empty before Create).
func (s *Store) Create(name string, base fp.Config) (*Profile, error) {
	if base.Seed == 0 {
		base.Seed = NewRandomSeed()
	}
	// Merge defaults for flags that ApplyPersona does not invent
	d := fp.DefaultConfig()
	if base.Platform == "" {
		base.Platform = d.Platform
	}
	if base.Brand == "" {
		base.Brand = d.Brand
	}
	base.DisableNonProxiedUDP = true
	base.NoFirstRun = true
	base.NoDefaultBrowser = true
	if !base.HeadlessHardening && d.HeadlessHardening {
		base.HeadlessHardening = true
	}
	if !base.LoadSpeechExtension && d.LoadSpeechExtension {
		base.LoadSpeechExtension = true
	}

	// Remember explicit locale overrides from CLI
	explicitTZ := strings.TrimSpace(base.Timezone) != ""
	explicitLang := strings.TrimSpace(base.Lang) != ""

// Seed persona first (screen/cores/etc + noise mode). Locale may be seed America/* temporarily.
		if base.NoiseMode == "" {
			// Default balanced: less Pixelscan "Masking" than full noise, still unique GPU per seed.
			// Use -noise full for max isolation; -noise native for max "clean Chrome".
			base.NoiseMode = fp.NoiseBalanced
		}
		fp.ApplyPersona(&base)
	// ONE proxy geo pass: EXIT IP / username country overwrites seed America/* when proxy set.
	// (Do not call twice — live exit lookup is slow.)
	if strings.TrimSpace(base.Proxy) != "" && (!explicitTZ || !explicitLang) {
		applyProxyLocaleToConfig(&base, !explicitTZ, !explicitLang)
	}

	notes := base.GPUHint + " | " + base.FontTier + " | speech=" + base.SpeechExpect
	if base.Timezone != "" {
		notes = notes + " | tz=" + base.Timezone
	}

	p := &Profile{
		Name:    name,
		DataDir: filepath.Join("data", sanitize(name)),
		FP:      base,
		Notes:   notes,
	}
	if err := s.Save(p); err != nil {
		return nil, err
	}
	return p, nil
}
