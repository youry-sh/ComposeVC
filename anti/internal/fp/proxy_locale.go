package fp

import (
	"fmt"
	"os"
	"strings"
)

// ProxyGeo is a minimal geo snapshot applied onto Config (from proxygeo package).
// Kept in fp to avoid import cycles; launch/profile call proxygeo then ApplyProxyGeo.
type ProxyGeo struct {
	Timezone    string
	Lang        string
	CountryCode string
	Country     string
	City        string
	IP          string
	Via         string
	Source      string
}

// ApplyProxyGeo sets timezone/lang from proxy EXIT geo when fields are empty
// OR when force=true (launch-time refresh from live exit).
// Never invents America/* from seed while a real exit TZ is known.
func ApplyProxyGeo(c *Config, g ProxyGeo, force bool) {
	if c == nil {
		return
	}
	if g.Timezone == "" && g.Lang == "" {
		return
	}
	// Skip if user forced ANTI_KEEP_LOCALE=1
	if os.Getenv("ANTI_KEEP_LOCALE") == "1" {
		return
	}
	if g.Timezone != "" {
		if force || c.Timezone == "" || (isSeedyUSTimezone(c.Timezone) && !isSeedyUSTimezone(g.Timezone)) {
			c.Timezone = g.Timezone
		}
	}
	if g.Lang != "" {
		if force || c.Lang == "" {
			c.Lang = g.Lang
			if force || c.AcceptLang == "" {
				c.AcceptLang = acceptLangFrom(g.Lang)
			}
			if force || c.SpeechExpect == "" || isSeedyUSSpeech(c.SpeechExpect) {
				c.SpeechExpect = g.Lang
			}
		}
	}
}

func isSeedyUSTimezone(tz string) bool {
	tz = strings.TrimSpace(tz)
	return strings.HasPrefix(tz, "America/")
}

func isSeedyUSSpeech(s string) bool {
	s = strings.ToLower(strings.TrimSpace(s))
	return s == "en-us" || s == "en"
}

func acceptLangFrom(lang string) string {
	lang = strings.TrimSpace(lang)
	if lang == "" {
		return "en-US,en"
	}
	parts := strings.SplitN(lang, "-", 2)
	base := parts[0]
	if base == "" {
		return lang
	}
	if strings.EqualFold(base, "en") {
		return lang + ",en"
	}
	return fmt.Sprintf("%s,%s;q=0.9,en;q=0.8", lang, base)
}
