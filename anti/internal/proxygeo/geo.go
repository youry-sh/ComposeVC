// Package proxygeo resolves timezone/lang from the proxy EXIT, not the gateway host.
// Order:
//  1. Live exit IP via proxy (ip-api / ipwho / ipinfo through tunnel)
//  2. Country targeting in proxy username (…-country-IN-…, country-US, etc.)
//  3. Gateway host IP last-resort (often wrong for mobile/resi)
// Supports all ISO country codes for TZ/lang tables.
package proxygeo

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"anti/internal/proxyfmt"
	"anti/internal/proxyping"
)

// Info is a lightweight geo result for UI / profile fill.
type Info struct {
	Proxy       string `json:"proxy"`
	Host        string `json:"host"`                   // proxy gateway host
	IP          string `json:"ip,omitempty"`           // exit (or host fallback) IP
	Timezone    string `json:"timezone,omitempty"`     // IANA e.g. Asia/Kolkata
	Country     string `json:"country,omitempty"`
	CountryCode string `json:"country_code,omitempty"` // ISO2
	Region      string `json:"region,omitempty"`
	City        string `json:"city,omitempty"`
	Lang        string `json:"lang,omitempty"`
	Source      string `json:"source,omitempty"`
	Via         string `json:"via,omitempty"` // exit | username | host-fallback
	Error       string `json:"error,omitempty"`
}

const ipAPIFields = "status,message,country,countryCode,regionName,city,timezone,query"

// country from vendor usernames: country-IN, res-country-US, -cc-DE-, country=BR
var (
	reCountryDash = regexp.MustCompile(`(?i)(?:^|[-_;.])(?:res-)?country[-_=]([a-z]{2})(?:[-_;.]|$)`)
	reCountryCC   = regexp.MustCompile(`(?i)(?:^|[-_;.])cc[-_=]([a-z]{2})(?:[-_;.]|$)`)
)

// ParseHost extracts host from proxy URL or host:port / scheme://user:pass@host:port
func ParseHost(proxy string) (string, error) {
	proxy = proxyfmt.NormalizeInput(proxy)
	if pp, err := proxyfmt.Parse(proxy); err == nil && pp.Host != "" {
		return pp.Host, nil
	}
	proxy = strings.TrimSpace(proxy)
	if proxy == "" {
		return "", fmt.Errorf("empty proxy")
	}
	// ensure scheme for url.Parse
	raw := proxy
	if !strings.Contains(proxy, "://") {
		raw = "http://" + proxy
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	host := u.Hostname()
	if host == "" {
		return "", fmt.Errorf("no host in %q", proxy)
	}
	return host, nil
}

// Lookup returns geo for the proxy EXIT (preferred), then username country target,
// then gateway host as last resort.
func Lookup(proxy string) Info {
	proxy = proxyfmt.NormalizeInput(proxy)
	info := Info{Proxy: proxy}

	pp, err := proxyfmt.Parse(proxy)
	if err != nil {
		if host, herr := ParseHost(proxy); herr == nil {
			info.Host = host
			if cc := countryFromText(proxy); cc != "" {
				return fromCountryCode(info, cc, "username", "proxy string country-XX")
			}
			return lookupHostIP(info, host)
		}
		info.Error = "parse: " + err.Error()
		return info
	}
	info.Host = pp.Host

	// 1) Live exit through proxy (multi-source).
	if exit, exitErr := lookupExit(pp); exitErr == nil && exit.Timezone != "" {
		exit.Proxy = proxy
		exit.Host = pp.Host
		exit.Via = "exit"
		// Prefer username country TZ only if exit somehow matches gateway nonsense
		// and username targets another country (detect common relay mismatch).
		if cc := countryFromProxyUser(pp); cc != "" &&
			exit.CountryCode != "" &&
			!strings.EqualFold(exit.CountryCode, cc) &&
			sameIP(exit.IP, pp.Host) {
			// exit IP == gateway host IP → tunnel not used; trust username target
			return fromCountryCode(info, cc, "username", "country in user (exit matched gateway)")
		}
		return exit
	} else if exitErr != nil {
		info.Error = "exit: " + exitErr.Error()
	}

	// 2) Country targeting in username (DataImpulse / mobile / resi style).
	if cc := countryFromProxyUser(pp); cc != "" {
		out := fromCountryCode(info, cc, "username", "country in proxy user")
		if info.Error != "" {
			out.Error = info.Error + "; used username country"
		}
		return out
	}

	// 3) Host gateway last resort (often wrong).
	fb := lookupHostIP(info, pp.Host)
	if fb.Timezone != "" {
		if info.Error != "" {
			fb.Error = info.Error + "; used host fallback"
		}
		fb.Via = "host-fallback"
		fb.Source = "ip-api.com host (fallback)"
		return fb
	}
	if info.Error == "" {
		info.Error = "geo lookup failed"
	}
	return info
}

func sameIP(a, b string) bool {
	a = strings.TrimSpace(a)
	b = strings.TrimSpace(b)
	if a == "" || b == "" {
		return false
	}
	if a == b {
		return true
	}
	// host may be hostname; if b is hostname resolve? skip — compare string only
	return false
}

func countryFromProxyUser(pp proxyfmt.Proxy) string {
	if cc := countryFromText(pp.User); cc != "" {
		return cc
	}
	return countryFromText(pp.Raw)
}

func countryFromText(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if m := reCountryDash.FindStringSubmatch(s); len(m) == 2 {
		return strings.ToUpper(m[1])
	}
	if m := reCountryCC.FindStringSubmatch(s); len(m) == 2 {
		return strings.ToUpper(m[1])
	}
	return ""
}

func fromCountryCode(base Info, cc, via, source string) Info {
	cc = strings.ToUpper(strings.TrimSpace(cc))
	out := base
	out.CountryCode = cc
	out.Country = countryName(cc)
	out.Timezone = timezoneForCountry(cc)
	out.Lang = langForCountry(cc)
	out.Via = via
	out.Source = source
	if out.Timezone == "" {
		out.Timezone = "UTC"
	}
	return out
}

// LookupUsernameOnly extracts country-XX / cc-XX from proxy user/string and
// maps to timezone/lang instantly (no network). Used so create/launch never
// waits on a dead proxy before applying locale.
func LookupUsernameOnly(proxy string) Info {
	proxy = proxyfmt.NormalizeInput(proxy)
	info := Info{Proxy: proxy}
	pp, err := proxyfmt.Parse(proxy)
	if err != nil {
		if cc := countryFromText(proxy); cc != "" {
			return fromCountryCode(info, cc, "username", "proxy string country-XX")
		}
		return info
	}
	info.Host = pp.Host
	if cc := countryFromProxyUser(pp); cc != "" {
		return fromCountryCode(info, cc, "username", "country in proxy user")
	}
	if cc := countryFromText(proxy); cc != "" {
		return fromCountryCode(info, cc, "username", "proxy string country-XX")
	}
	return info
}

func lookupExit(pp proxyfmt.Proxy) (Info, error) {
	client, err := proxyping.Client(pp, 15*time.Second)
	if err != nil {
		return Info{}, err
	}
	var errs []string

	// A) ip-api.com (HTTP) — sees connecting exit IP
	if info, err := fetchIPAPI(client, "http://ip-api.com/json/?fields="+ipAPIFields); err == nil && info.Timezone != "" {
		info.Source = "ip-api.com via proxy"
		return info, nil
	} else if err != nil {
		errs = append(errs, "ip-api: "+err.Error())
	}

	// B) ipwho.is (HTTPS JSON)
	if info, err := fetchIPWho(client); err == nil && info.Timezone != "" {
		info.Source = "ipwho.is via proxy"
		return info, nil
	} else if err != nil {
		errs = append(errs, "ipwho: "+err.Error())
	}

	// C) ipinfo.io (HTTPS minimal)
	if info, err := fetchIPInfo(client); err == nil && (info.Timezone != "" || info.CountryCode != "") {
		if info.Timezone == "" && info.CountryCode != "" {
			info.Timezone = timezoneForCountry(info.CountryCode)
			info.Lang = langForCountry(info.CountryCode)
			if info.Country == "" {
				info.Country = countryName(info.CountryCode)
			}
		}
		info.Source = "ipinfo.io via proxy"
		return info, nil
	} else if err != nil {
		errs = append(errs, "ipinfo: "+err.Error())
	}

	return Info{}, fmt.Errorf("%s", strings.Join(errs, "; "))
}

func fetchIPAPI(client *http.Client, apiURL string) (Info, error) {
	req, err := http.NewRequest(http.MethodGet, apiURL, nil)
	if err != nil {
		return Info{}, err
	}
	req.Header.Set("User-Agent", "ANTI-proxy-geo/1.1")
	resp, err := client.Do(req)
	if err != nil {
		return Info{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Info{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return decodeIPAPI(resp.Body)
}

func fetchIPWho(client *http.Client) (Info, error) {
	req, err := http.NewRequest(http.MethodGet, "https://ipwho.is/", nil)
	if err != nil {
		return Info{}, err
	}
	req.Header.Set("User-Agent", "ANTI-proxy-geo/1.1")
	resp, err := client.Do(req)
	if err != nil {
		return Info{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Info{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var raw struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		IP      string `json:"ip"`
		Country string `json:"country"`
		CC      string `json:"country_code"`
		Region  string `json:"region"`
		City    string `json:"city"`
		TZ      struct {
			ID string `json:"id"`
		} `json:"timezone"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return Info{}, err
	}
	if !raw.Success {
		msg := raw.Message
		if msg == "" {
			msg = "ipwho failed"
		}
		return Info{}, fmt.Errorf("%s", msg)
	}
	cc := strings.ToUpper(raw.CC)
	return Info{
		IP:          raw.IP,
		Country:     raw.Country,
		CountryCode: cc,
		Region:      raw.Region,
		City:        raw.City,
		Timezone:    raw.TZ.ID,
		Lang:        langForCountry(cc),
	}, nil
}

func fetchIPInfo(client *http.Client) (Info, error) {
	req, err := http.NewRequest(http.MethodGet, "https://ipinfo.io/json", nil)
	if err != nil {
		return Info{}, err
	}
	req.Header.Set("User-Agent", "ANTI-proxy-geo/1.1")
	// free tier may rate-limit; still useful as 3rd source
	resp, err := client.Do(req)
	if err != nil {
		return Info{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Info{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var raw struct {
		IP       string `json:"ip"`
		City     string `json:"city"`
		Region   string `json:"region"`
		Country  string `json:"country"`
		Timezone string `json:"timezone"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return Info{}, err
	}
	cc := strings.ToUpper(raw.Country)
	return Info{
		IP:          raw.IP,
		City:        raw.City,
		Region:      raw.Region,
		CountryCode: cc,
		Country:     countryName(cc),
		Timezone:    raw.Timezone,
		Lang:        langForCountry(cc),
	}, nil
}

func lookupHostIP(base Info, host string) Info {
	info := base
	info.Host = host
	ip := host
	if net.ParseIP(host) == nil {
		addrs, err := net.LookupIP(host)
		if err != nil || len(addrs) == 0 {
			info.Error = fmt.Sprintf("dns: %v", err)
			return info
		}
		for _, a := range addrs {
			if v4 := a.To4(); v4 != nil {
				ip = v4.String()
				break
			}
			ip = a.String()
		}
	}
	info.IP = ip

	client := &http.Client{Timeout: 6 * time.Second}
	apiURL := "http://ip-api.com/json/" + url.PathEscape(ip) + "?fields=" + ipAPIFields
	resp, err := client.Get(apiURL)
	if err != nil {
		info.Error = err.Error()
		return info
	}
	defer resp.Body.Close()
	decoded, err := decodeIPAPI(resp.Body)
	if err != nil {
		info.Error = err.Error()
		return info
	}
	decoded.Proxy = info.Proxy
	decoded.Host = host
	decoded.Source = info.Source
	return decoded
}

func decodeIPAPI(r io.Reader) (Info, error) {
	var raw struct {
		Status      string `json:"status"`
		Message     string `json:"message"`
		Country     string `json:"country"`
		CountryCode string `json:"countryCode"`
		RegionName  string `json:"regionName"`
		City        string `json:"city"`
		Timezone    string `json:"timezone"`
		Query       string `json:"query"`
	}
	if err := json.NewDecoder(r).Decode(&raw); err != nil {
		return Info{}, err
	}
	if raw.Status != "success" {
		msg := raw.Message
		if msg == "" {
			msg = "geo lookup failed"
		}
		return Info{}, fmt.Errorf("%s", msg)
	}
	cc := strings.ToUpper(raw.CountryCode)
	return Info{
		Timezone:    raw.Timezone,
		Country:     raw.Country,
		CountryCode: cc,
		Region:      raw.RegionName,
		City:        raw.City,
		IP:          raw.Query,
		Lang:        langForCountry(cc),
		Source:      "ip-api.com",
	}, nil
}

// timezoneForCountry — primary IANA zone for ISO2 (covers essentially all countries).
func timezoneForCountry(cc string) string {
	cc = strings.ToUpper(cc)
	if z, ok := countryTZ[cc]; ok {
		return z
	}
	return "UTC"
}

func countryName(cc string) string {
	cc = strings.ToUpper(cc)
	if n, ok := countryNames[cc]; ok {
		return n
	}
	return cc
}

// langForCountry — primary BCP47 tag; default en-US for unknown.
func langForCountry(cc string) string {
	cc = strings.ToUpper(cc)
	if l, ok := countryLang[cc]; ok {
		return l
	}
	return "en-US"
}

// Primary timezone per ISO 3166-1 alpha-2 (capital / main zone).
var countryTZ = map[string]string{
	"AD": "Europe/Andorra", "AE": "Asia/Dubai", "AF": "Asia/Kabul", "AG": "America/Antigua",
	"AI": "America/Anguilla", "AL": "Europe/Tirane", "AM": "Asia/Yerevan", "AO": "Africa/Luanda",
	"AQ": "Antarctica/Palmer", "AR": "America/Argentina/Buenos_Aires", "AS": "Pacific/Pago_Pago",
	"AT": "Europe/Vienna", "AU": "Australia/Sydney", "AW": "America/Aruba", "AX": "Europe/Mariehamn",
	"AZ": "Asia/Baku", "BA": "Europe/Sarajevo", "BB": "America/Barbados", "BD": "Asia/Dhaka",
	"BE": "Europe/Brussels", "BF": "Africa/Ouagadougou", "BG": "Europe/Sofia", "BH": "Asia/Bahrain",
	"BI": "Africa/Bujumbura", "BJ": "Africa/Porto-Novo", "BL": "America/St_Barthelemy",
	"BM": "Atlantic/Bermuda", "BN": "Asia/Brunei", "BO": "America/La_Paz", "BQ": "America/Kralendijk",
	"BR": "America/Sao_Paulo", "BS": "America/Nassau", "BT": "Asia/Thimphu", "BW": "Africa/Gaborone",
	"BY": "Europe/Minsk", "BZ": "America/Belize", "CA": "America/Toronto", "CC": "Indian/Cocos",
	"CD": "Africa/Kinshasa", "CF": "Africa/Bangui", "CG": "Africa/Brazzaville", "CH": "Europe/Zurich",
	"CI": "Africa/Abidjan", "CK": "Pacific/Rarotonga", "CL": "America/Santiago", "CM": "Africa/Douala",
	"CN": "Asia/Shanghai", "CO": "America/Bogota", "CR": "America/Costa_Rica", "CU": "America/Havana",
	"CV": "Atlantic/Cape_Verde", "CW": "America/Curacao", "CX": "Indian/Christmas", "CY": "Asia/Nicosia",
	"CZ": "Europe/Prague", "DE": "Europe/Berlin", "DJ": "Africa/Djibouti", "DK": "Europe/Copenhagen",
	"DM": "America/Dominica", "DO": "America/Santo_Domingo", "DZ": "Africa/Algiers", "EC": "America/Guayaquil",
	"EE": "Europe/Tallinn", "EG": "Africa/Cairo", "EH": "Africa/El_Aaiun", "ER": "Africa/Asmara",
	"ES": "Europe/Madrid", "ET": "Africa/Addis_Ababa", "FI": "Europe/Helsinki", "FJ": "Pacific/Fiji",
	"FK": "Atlantic/Stanley", "FM": "Pacific/Pohnpei", "FO": "Atlantic/Faroe", "FR": "Europe/Paris",
	"GA": "Africa/Libreville", "GB": "Europe/London", "GD": "America/Grenada", "GE": "Asia/Tbilisi",
	"GF": "America/Cayenne", "GG": "Europe/Guernsey", "GH": "Africa/Accra", "GI": "Europe/Gibraltar",
	"GL": "America/Godthab", "GM": "Africa/Banjul", "GN": "Africa/Conakry", "GP": "America/Guadeloupe",
	"GQ": "Africa/Malabo", "GR": "Europe/Athens", "GT": "America/Guatemala", "GU": "Pacific/Guam",
	"GW": "Africa/Bissau", "GY": "America/Guyana", "HK": "Asia/Hong_Kong", "HN": "America/Tegucigalpa",
	"HR": "Europe/Zagreb", "HT": "America/Port-au-Prince", "HU": "Europe/Budapest", "ID": "Asia/Jakarta",
	"IE": "Europe/Dublin", "IL": "Asia/Jerusalem", "IM": "Europe/Isle_of_Man", "IN": "Asia/Kolkata",
	"IO": "Indian/Chagos", "IQ": "Asia/Baghdad", "IR": "Asia/Tehran", "IS": "Atlantic/Reykjavik",
	"IT": "Europe/Rome", "JE": "Europe/Jersey", "JM": "America/Jamaica", "JO": "Asia/Amman",
	"JP": "Asia/Tokyo", "KE": "Africa/Nairobi", "KG": "Asia/Bishkek", "KH": "Asia/Phnom_Penh",
	"KI": "Pacific/Tarawa", "KM": "Indian/Comoro", "KN": "America/St_Kitts", "KP": "Asia/Pyongyang",
	"KR": "Asia/Seoul", "KW": "Asia/Kuwait", "KY": "America/Cayman", "KZ": "Asia/Almaty",
	"LA": "Asia/Vientiane", "LB": "Asia/Beirut", "LC": "America/St_Lucia", "LI": "Europe/Vaduz",
	"LK": "Asia/Colombo", "LR": "Africa/Monrovia", "LS": "Africa/Maseru", "LT": "Europe/Vilnius",
	"LU": "Europe/Luxembourg", "LV": "Europe/Riga", "LY": "Africa/Tripoli", "MA": "Africa/Casablanca",
	"MC": "Europe/Monaco", "MD": "Europe/Chisinau", "ME": "Europe/Podgorica", "MF": "America/Marigot",
	"MG": "Indian/Antananarivo", "MH": "Pacific/Majuro", "MK": "Europe/Skopje", "ML": "Africa/Bamako",
	"MM": "Asia/Yangon", "MN": "Asia/Ulaanbaatar", "MO": "Asia/Macau", "MP": "Pacific/Saipan",
	"MQ": "America/Martinique", "MR": "Africa/Nouakchott", "MS": "America/Montserrat", "MT": "Europe/Malta",
	"MU": "Indian/Mauritius", "MV": "Indian/Maldives", "MW": "Africa/Blantyre", "MX": "America/Mexico_City",
	"MY": "Asia/Kuala_Lumpur", "MZ": "Africa/Maputo", "NA": "Africa/Windhoek", "NC": "Pacific/Noumea",
	"NE": "Africa/Niamey", "NF": "Pacific/Norfolk", "NG": "Africa/Lagos", "NI": "America/Managua",
	"NL": "Europe/Amsterdam", "NO": "Europe/Oslo", "NP": "Asia/Kathmandu", "NR": "Pacific/Nauru",
	"NU": "Pacific/Niue", "NZ": "Pacific/Auckland", "OM": "Asia/Muscat", "PA": "America/Panama",
	"PE": "America/Lima", "PF": "Pacific/Tahiti", "PG": "Pacific/Port_Moresby", "PH": "Asia/Manila",
	"PK": "Asia/Karachi", "PL": "Europe/Warsaw", "PM": "America/Miquelon", "PR": "America/Puerto_Rico",
	"PS": "Asia/Gaza", "PT": "Europe/Lisbon", "PW": "Pacific/Palau", "PY": "America/Asuncion",
	"QA": "Asia/Qatar", "RE": "Indian/Reunion", "RO": "Europe/Bucharest", "RS": "Europe/Belgrade",
	"RU": "Europe/Moscow", "RW": "Africa/Kigali", "SA": "Asia/Riyadh", "SB": "Pacific/Guadalcanal",
	"SC": "Indian/Mahe", "SD": "Africa/Khartoum", "SE": "Europe/Stockholm", "SG": "Asia/Singapore",
	"SH": "Atlantic/St_Helena", "SI": "Europe/Ljubljana", "SJ": "Arctic/Longyearbyen", "SK": "Europe/Bratislava",
	"SL": "Africa/Freetown", "SM": "Europe/San_Marino", "SN": "Africa/Dakar", "SO": "Africa/Mogadishu",
	"SR": "America/Paramaribo", "SS": "Africa/Juba", "ST": "Africa/Sao_Tome", "SV": "America/El_Salvador",
	"SX": "America/Lower_Princes", "SY": "Asia/Damascus", "SZ": "Africa/Mbabane", "TC": "America/Grand_Turk",
	"TD": "Africa/Ndjamena", "TF": "Indian/Kerguelen", "TG": "Africa/Lome", "TH": "Asia/Bangkok",
	"TJ": "Asia/Dushanbe", "TK": "Pacific/Fakaofo", "TL": "Asia/Dili", "TM": "Asia/Ashgabat",
	"TN": "Africa/Tunis", "TO": "Pacific/Tongatapu", "TR": "Europe/Istanbul", "TT": "America/Port_of_Spain",
	"TV": "Pacific/Funafuti", "TW": "Asia/Taipei", "TZ": "Africa/Dar_es_Salaam", "UA": "Europe/Kyiv",
	"UG": "Africa/Kampala", "UM": "Pacific/Wake", "US": "America/New_York", "UY": "America/Montevideo",
	"UZ": "Asia/Tashkent", "VA": "Europe/Vatican", "VC": "America/St_Vincent", "VE": "America/Caracas",
	"VG": "America/Tortola", "VI": "America/St_Thomas", "VN": "Asia/Ho_Chi_Minh", "VU": "Pacific/Efate",
	"WF": "Pacific/Wallis", "WS": "Pacific/Apia", "XK": "Europe/Belgrade", "YE": "Asia/Aden",
	"YT": "Indian/Mayotte", "ZA": "Africa/Johannesburg", "ZM": "Africa/Lusaka", "ZW": "Africa/Harare",
}

var countryNames = map[string]string{
	"AD": "Andorra", "AE": "United Arab Emirates", "AF": "Afghanistan", "AG": "Antigua and Barbuda",
	"AI": "Anguilla", "AL": "Albania", "AM": "Armenia", "AO": "Angola", "AQ": "Antarctica",
	"AR": "Argentina", "AS": "American Samoa", "AT": "Austria", "AU": "Australia", "AW": "Aruba",
	"AX": "Åland Islands", "AZ": "Azerbaijan", "BA": "Bosnia and Herzegovina", "BB": "Barbados",
	"BD": "Bangladesh", "BE": "Belgium", "BF": "Burkina Faso", "BG": "Bulgaria", "BH": "Bahrain",
	"BI": "Burundi", "BJ": "Benin", "BL": "Saint Barthélemy", "BM": "Bermuda", "BN": "Brunei",
	"BO": "Bolivia", "BQ": "Caribbean Netherlands", "BR": "Brazil", "BS": "Bahamas", "BT": "Bhutan",
	"BW": "Botswana", "BY": "Belarus", "BZ": "Belize", "CA": "Canada", "CC": "Cocos Islands",
	"CD": "DR Congo", "CF": "Central African Republic", "CG": "Congo", "CH": "Switzerland",
	"CI": "Côte d'Ivoire", "CK": "Cook Islands", "CL": "Chile", "CM": "Cameroon", "CN": "China",
	"CO": "Colombia", "CR": "Costa Rica", "CU": "Cuba", "CV": "Cabo Verde", "CW": "Curaçao",
	"CX": "Christmas Island", "CY": "Cyprus", "CZ": "Czechia", "DE": "Germany", "DJ": "Djibouti",
	"DK": "Denmark", "DM": "Dominica", "DO": "Dominican Republic", "DZ": "Algeria", "EC": "Ecuador",
	"EE": "Estonia", "EG": "Egypt", "EH": "Western Sahara", "ER": "Eritrea", "ES": "Spain",
	"ET": "Ethiopia", "FI": "Finland", "FJ": "Fiji", "FK": "Falkland Islands", "FM": "Micronesia",
	"FO": "Faroe Islands", "FR": "France", "GA": "Gabon", "GB": "United Kingdom", "GD": "Grenada",
	"GE": "Georgia", "GF": "French Guiana", "GG": "Guernsey", "GH": "Ghana", "GI": "Gibraltar",
	"GL": "Greenland", "GM": "Gambia", "GN": "Guinea", "GP": "Guadeloupe", "GQ": "Equatorial Guinea",
	"GR": "Greece", "GT": "Guatemala", "GU": "Guam", "GW": "Guinea-Bissau", "GY": "Guyana",
	"HK": "Hong Kong", "HN": "Honduras", "HR": "Croatia", "HT": "Haiti", "HU": "Hungary",
	"ID": "Indonesia", "IE": "Ireland", "IL": "Israel", "IM": "Isle of Man", "IN": "India",
	"IO": "British Indian Ocean Territory", "IQ": "Iraq", "IR": "Iran", "IS": "Iceland",
	"IT": "Italy", "JE": "Jersey", "JM": "Jamaica", "JO": "Jordan", "JP": "Japan", "KE": "Kenya",
	"KG": "Kyrgyzstan", "KH": "Cambodia", "KI": "Kiribati", "KM": "Comoros", "KN": "Saint Kitts and Nevis",
	"KP": "North Korea", "KR": "South Korea", "KW": "Kuwait", "KY": "Cayman Islands", "KZ": "Kazakhstan",
	"LA": "Laos", "LB": "Lebanon", "LC": "Saint Lucia", "LI": "Liechtenstein", "LK": "Sri Lanka",
	"LR": "Liberia", "LS": "Lesotho", "LT": "Lithuania", "LU": "Luxembourg", "LV": "Latvia",
	"LY": "Libya", "MA": "Morocco", "MC": "Monaco", "MD": "Moldova", "ME": "Montenegro",
	"MF": "Saint Martin", "MG": "Madagascar", "MH": "Marshall Islands", "MK": "North Macedonia",
	"ML": "Mali", "MM": "Myanmar", "MN": "Mongolia", "MO": "Macao", "MP": "Northern Mariana Islands",
	"MQ": "Martinique", "MR": "Mauritania", "MS": "Montserrat", "MT": "Malta", "MU": "Mauritius",
	"MV": "Maldives", "MW": "Malawi", "MX": "Mexico", "MY": "Malaysia", "MZ": "Mozambique",
	"NA": "Namibia", "NC": "New Caledonia", "NE": "Niger", "NF": "Norfolk Island", "NG": "Nigeria",
	"NI": "Nicaragua", "NL": "Netherlands", "NO": "Norway", "NP": "Nepal", "NR": "Nauru",
	"NU": "Niue", "NZ": "New Zealand", "OM": "Oman", "PA": "Panama", "PE": "Peru", "PF": "French Polynesia",
	"PG": "Papua New Guinea", "PH": "Philippines", "PK": "Pakistan", "PL": "Poland", "PM": "Saint Pierre and Miquelon",
	"PR": "Puerto Rico", "PS": "Palestine", "PT": "Portugal", "PW": "Palau", "PY": "Paraguay",
	"QA": "Qatar", "RE": "Réunion", "RO": "Romania", "RS": "Serbia", "RU": "Russia", "RW": "Rwanda",
	"SA": "Saudi Arabia", "SB": "Solomon Islands", "SC": "Seychelles", "SD": "Sudan", "SE": "Sweden",
	"SG": "Singapore", "SH": "Saint Helena", "SI": "Slovenia", "SJ": "Svalbard and Jan Mayen",
	"SK": "Slovakia", "SL": "Sierra Leone", "SM": "San Marino", "SN": "Senegal", "SO": "Somalia",
	"SR": "Suriname", "SS": "South Sudan", "ST": "São Tomé and Príncipe", "SV": "El Salvador",
	"SX": "Sint Maarten", "SY": "Syria", "SZ": "Eswatini", "TC": "Turks and Caicos Islands",
	"TD": "Chad", "TF": "French Southern Territories", "TG": "Togo", "TH": "Thailand", "TJ": "Tajikistan",
	"TK": "Tokelau", "TL": "Timor-Leste", "TM": "Turkmenistan", "TN": "Tunisia", "TO": "Tonga",
	"TR": "Turkey", "TT": "Trinidad and Tobago", "TV": "Tuvalu", "TW": "Taiwan", "TZ": "Tanzania",
	"UA": "Ukraine", "UG": "Uganda", "UM": "U.S. Outlying Islands", "US": "United States",
	"UY": "Uruguay", "UZ": "Uzbekistan", "VA": "Vatican City", "VC": "Saint Vincent and the Grenadines",
	"VE": "Venezuela", "VG": "British Virgin Islands", "VI": "U.S. Virgin Islands", "VN": "Vietnam",
	"VU": "Vanuatu", "WF": "Wallis and Futuna", "WS": "Samoa", "XK": "Kosovo", "YE": "Yemen",
	"YT": "Mayotte", "ZA": "South Africa", "ZM": "Zambia", "ZW": "Zimbabwe",
}

// Primary browser language per country (BCP47).
var countryLang = map[string]string{
	"AD": "ca-AD", "AE": "ar-AE", "AF": "fa-AF", "AG": "en-AG", "AI": "en-AI", "AL": "sq-AL",
	"AM": "hy-AM", "AO": "pt-AO", "AR": "es-AR", "AS": "en-AS", "AT": "de-AT", "AU": "en-AU",
	"AW": "nl-AW", "AX": "sv-AX", "AZ": "az-AZ", "BA": "bs-BA", "BB": "en-BB", "BD": "bn-BD",
	"BE": "nl-BE", "BF": "fr-BF", "BG": "bg-BG", "BH": "ar-BH", "BI": "fr-BI", "BJ": "fr-BJ",
	"BL": "fr-BL", "BM": "en-BM", "BN": "ms-BN", "BO": "es-BO", "BQ": "nl-BQ", "BR": "pt-BR",
	"BS": "en-BS", "BT": "dz-BT", "BW": "en-BW", "BY": "be-BY", "BZ": "en-BZ", "CA": "en-CA",
	"CC": "en-CC", "CD": "fr-CD", "CF": "fr-CF", "CG": "fr-CG", "CH": "de-CH", "CI": "fr-CI",
	"CK": "en-CK", "CL": "es-CL", "CM": "fr-CM", "CN": "zh-CN", "CO": "es-CO", "CR": "es-CR",
	"CU": "es-CU", "CV": "pt-CV", "CW": "nl-CW", "CX": "en-CX", "CY": "el-CY", "CZ": "cs-CZ",
	"DE": "de-DE", "DJ": "fr-DJ", "DK": "da-DK", "DM": "en-DM", "DO": "es-DO", "DZ": "ar-DZ",
	"EC": "es-EC", "EE": "et-EE", "EG": "ar-EG", "EH": "ar-EH", "ER": "ti-ER", "ES": "es-ES",
	"ET": "am-ET", "FI": "fi-FI", "FJ": "en-FJ", "FK": "en-FK", "FM": "en-FM", "FO": "fo-FO",
	"FR": "fr-FR", "GA": "fr-GA", "GB": "en-GB", "GD": "en-GD", "GE": "ka-GE", "GF": "fr-GF",
	"GG": "en-GG", "GH": "en-GH", "GI": "en-GI", "GL": "kl-GL", "GM": "en-GM", "GN": "fr-GN",
	"GP": "fr-GP", "GQ": "es-GQ", "GR": "el-GR", "GT": "es-GT", "GU": "en-GU", "GW": "pt-GW",
	"GY": "en-GY", "HK": "zh-HK", "HN": "es-HN", "HR": "hr-HR", "HT": "fr-HT", "HU": "hu-HU",
	"ID": "id-ID", "IE": "en-IE", "IL": "he-IL", "IM": "en-IM", "IN": "en-IN", "IO": "en-IO",
	"IQ": "ar-IQ", "IR": "fa-IR", "IS": "is-IS", "IT": "it-IT", "JE": "en-JE", "JM": "en-JM",
	"JO": "ar-JO", "JP": "ja-JP", "KE": "en-KE", "KG": "ky-KG", "KH": "km-KH", "KI": "en-KI",
	"KM": "ar-KM", "KN": "en-KN", "KP": "ko-KP", "KR": "ko-KR", "KW": "ar-KW", "KY": "en-KY",
	"KZ": "kk-KZ", "LA": "lo-LA", "LB": "ar-LB", "LC": "en-LC", "LI": "de-LI", "LK": "si-LK",
	"LR": "en-LR", "LS": "en-LS", "LT": "lt-LT", "LU": "fr-LU", "LV": "lv-LV", "LY": "ar-LY",
	"MA": "ar-MA", "MC": "fr-MC", "MD": "ro-MD", "ME": "sr-ME", "MF": "fr-MF", "MG": "fr-MG",
	"MH": "en-MH", "MK": "mk-MK", "ML": "fr-ML", "MM": "my-MM", "MN": "mn-MN", "MO": "zh-MO",
	"MP": "en-MP", "MQ": "fr-MQ", "MR": "ar-MR", "MS": "en-MS", "MT": "mt-MT", "MU": "en-MU",
	"MV": "dv-MV", "MW": "en-MW", "MX": "es-MX", "MY": "ms-MY", "MZ": "pt-MZ", "NA": "en-NA",
	"NC": "fr-NC", "NE": "fr-NE", "NF": "en-NF", "NG": "en-NG", "NI": "es-NI", "NL": "nl-NL",
	"NO": "nb-NO", "NP": "ne-NP", "NR": "en-NR", "NU": "en-NU", "NZ": "en-NZ", "OM": "ar-OM",
	"PA": "es-PA", "PE": "es-PE", "PF": "fr-PF", "PG": "en-PG", "PH": "en-PH", "PK": "ur-PK",
	"PL": "pl-PL", "PM": "fr-PM", "PR": "es-PR", "PS": "ar-PS", "PT": "pt-PT", "PW": "en-PW",
	"PY": "es-PY", "QA": "ar-QA", "RE": "fr-RE", "RO": "ro-RO", "RS": "sr-RS", "RU": "ru-RU",
	"RW": "rw-RW", "SA": "ar-SA", "SB": "en-SB", "SC": "en-SC", "SD": "ar-SD", "SE": "sv-SE",
	"SG": "en-SG", "SH": "en-SH", "SI": "sl-SI", "SJ": "nb-SJ", "SK": "sk-SK", "SL": "en-SL",
	"SM": "it-SM", "SN": "fr-SN", "SO": "so-SO", "SR": "nl-SR", "SS": "en-SS", "ST": "pt-ST",
	"SV": "es-SV", "SX": "nl-SX", "SY": "ar-SY", "SZ": "en-SZ", "TC": "en-TC", "TD": "fr-TD",
	"TF": "fr-TF", "TG": "fr-TG", "TH": "th-TH", "TJ": "tg-TJ", "TK": "en-TK", "TL": "pt-TL",
	"TM": "tk-TM", "TN": "ar-TN", "TO": "to-TO", "TR": "tr-TR", "TT": "en-TT", "TV": "en-TV",
	"TW": "zh-TW", "TZ": "sw-TZ", "UA": "uk-UA", "UG": "en-UG", "UM": "en-UM", "US": "en-US",
	"UY": "es-UY", "UZ": "uz-UZ", "VA": "it-VA", "VC": "en-VC", "VE": "es-VE", "VG": "en-VG",
	"VI": "en-VI", "VN": "vi-VN", "VU": "bi-VU", "WF": "fr-WF", "WS": "sm-WS", "XK": "sq-XK",
	"YE": "ar-YE", "YT": "fr-YT", "ZA": "en-ZA", "ZM": "en-ZM", "ZW": "en-ZW",
}
