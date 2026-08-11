// Package proxyfmt parses many commercial proxy string formats into a
// normalized Proxy value (scheme, host, port, user, pass).
package proxyfmt

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// Proxy is a normalized proxy endpoint.
type Proxy struct {
	// Raw is the original input string.
	Raw string `json:"raw"`
	// Scheme: http | https | socks5 | socks4 (default http for vendor strings)
	Scheme string `json:"scheme"`
	Host   string `json:"host"`
	Port   int    `json:"port"`
	User   string `json:"user,omitempty"`
	Pass   string `json:"pass,omitempty"`
}

// ChromeProxyServer returns value for --proxy-server= (no credentials).
// Auth must go through local bridge when User/Pass set.
func (p Proxy) ChromeProxyServer() string {
	if p.Host == "" || p.Port == 0 {
		return ""
	}
	scheme := p.Scheme
	if scheme == "" {
		scheme = "http"
	}
	// Chromium: socks5://host:port or http://host:port
	return fmt.Sprintf("%s://%s:%d", scheme, p.Host, p.Port)
}

// HasAuth reports user/pass present.
func (p Proxy) HasAuth() bool {
	return p.User != "" || p.Pass != ""
}

// URLWithAuth builds a full URL including credentials (for Go http.Transport / curl -x).
func (p Proxy) URLWithAuth() string {
	if p.Host == "" || p.Port == 0 {
		return ""
	}
	scheme := p.Scheme
	if scheme == "" {
		scheme = "http"
	}
	u := &url.URL{
		Scheme: scheme,
		Host:   net.JoinHostPort(p.Host, strconv.Itoa(p.Port)),
	}
	if p.User != "" || p.Pass != "" {
		u.User = url.UserPassword(p.User, p.Pass)
	}
	return u.String()
}

// Display redacts password.
func (p Proxy) Display() string {
	if p.Host == "" {
		return p.Raw
	}
	if p.User != "" {
		return fmt.Sprintf("%s://%s:***@%s:%d", or(p.Scheme, "http"), p.User, p.Host, p.Port)
	}
	return p.ChromeProxyServer()
}

func or(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// Parse accepts many formats:
//
//	http://user:pass@host:port
//	socks5://user:pass@host:port
//	user:pass@host:port
//	user:pass@host:port (user may contain ; targeting params — DataImpulse style)
//	host:port:user:pass
//	host:port@user:pass          (rare)
//	user@host:port:pass          (rare)
//	host:port                    (no auth)
//	Host + Login + Password via ParseParts
func Parse(raw string) (Proxy, error) {
	raw = strings.TrimSpace(raw)
	// strip accidental "Host"/"Логін" labels if pasted multi-line — take first non-empty line
	if strings.Contains(raw, "\n") {
		for _, line := range strings.Split(raw, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			low := strings.ToLower(line)
			if strings.HasPrefix(low, "host") || strings.HasPrefix(low, "login") ||
				strings.HasPrefix(low, "pass") || strings.HasPrefix(low, "логін") ||
				strings.HasPrefix(low, "пароль") {
				continue
			}
			raw = line
			break
		}
	}
	if raw == "" {
		return Proxy{}, fmt.Errorf("empty proxy")
	}
	p := Proxy{Raw: raw, Scheme: "http"}

	// Explicit scheme
	if strings.Contains(raw, "://") {
		return parseURL(raw)
	}

	// user:pass@host:port  (user may contain ':' only in pass side — split from right @)
	if at := strings.LastIndex(raw, "@"); at > 0 {
		userinfo := raw[:at]
		hostport := raw[at+1:]
		host, port, err := splitHostPort(hostport)
		if err != nil {
			return Proxy{}, err
		}
		user, pass := splitUserPass(userinfo)
		p.Scheme = "http"
		p.Host = host
		p.Port = port
		p.User = user
		p.Pass = pass
		return p, nil
	}

	// host:port:user:pass  (4+ parts — user/pass may contain colons in pass only if we take last two carefully)
	// Common: host:port:user:pass
	parts := strings.Split(raw, ":")
	if len(parts) == 2 {
		// host:port
		host, port, err := splitHostPort(raw)
		if err != nil {
			return Proxy{}, err
		}
		p.Host = host
		p.Port = port
		return p, nil
	}
	if len(parts) >= 4 {
		// host:port:user:pass  OR  host:port:user:pass:with:colons
		// Try host = parts[0], port = parts[1], user = parts[2], pass = rest joined
		if port, err := strconv.Atoi(parts[1]); err == nil && port > 0 && port < 65536 {
			// if parts[0] looks like host (not pure number only issue)
			p.Host = parts[0]
			p.Port = port
			p.User = parts[2]
			p.Pass = strings.Join(parts[3:], ":")
			return p, nil
		}
	}
	if len(parts) == 3 {
		// could be host:port:user (no pass) or user:host:port
		if port, err := strconv.Atoi(parts[1]); err == nil && port > 0 {
			p.Host = parts[0]
			p.Port = port
			p.User = parts[2]
			return p, nil
		}
		if port, err := strconv.Atoi(parts[2]); err == nil && port > 0 {
			// user:host:port
			p.User = parts[0]
			p.Host = parts[1]
			p.Port = port
			return p, nil
		}
	}

	return Proxy{}, fmt.Errorf("unrecognized proxy format: %q", raw)
}

// ParseParts builds Proxy from separate Host / Login / Password fields
// as in vendor dashboards:
//
//	Host: 212.8.249.134:443
//	Login: user
//	Password: pass
func ParseParts(host, login, password, scheme string) (Proxy, error) {
	host = strings.TrimSpace(host)
	login = strings.TrimSpace(login)
	password = strings.TrimSpace(password)
	scheme = strings.ToLower(strings.TrimSpace(scheme))
	if scheme == "" {
		scheme = "http"
	}
	if host == "" {
		return Proxy{}, fmt.Errorf("host required")
	}
	// allow host already full user:pass@h:p
	if strings.Contains(host, "@") || strings.Count(host, ":") > 1 && login == "" {
		return Parse(host)
	}
	h, port, err := splitHostPort(host)
	if err != nil {
		return Proxy{}, err
	}
	return Proxy{
		Raw:    fmt.Sprintf("%s:%s@%s:%d", login, password, h, port),
		Scheme: scheme,
		Host:   h,
		Port:   port,
		User:   login,
		Pass:   password,
	}, nil
}

func parseURL(raw string) (Proxy, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return Proxy{}, err
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme == "socks" {
		scheme = "socks5"
	}
	if scheme == "" {
		scheme = "http"
	}
	host := u.Hostname()
	portStr := u.Port()
	if portStr == "" {
		switch scheme {
		case "https":
			portStr = "443"
		case "socks5", "socks4":
			portStr = "1080"
		default:
			portStr = "80"
		}
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return Proxy{}, fmt.Errorf("bad port: %w", err)
	}
	user, pass := "", ""
	if u.User != nil {
		user = u.User.Username()
		pass, _ = u.User.Password()
	}
	// DataImpulse: user may be path-encoded with ; — url.Parse keeps it in Username
	return Proxy{
		Raw:    raw,
		Scheme: scheme,
		Host:   host,
		Port:   port,
		User:   user,
		Pass:   pass,
	}, nil
}

func splitHostPort(hostport string) (string, int, error) {
	hostport = strings.TrimSpace(hostport)
	// [ipv6]:port
	if strings.HasPrefix(hostport, "[") {
		h, p, err := net.SplitHostPort(hostport)
		if err != nil {
			return "", 0, err
		}
		port, err := strconv.Atoi(p)
		return h, port, err
	}
	// host:port — last colon
	i := strings.LastIndex(hostport, ":")
	if i <= 0 {
		return "", 0, fmt.Errorf("need host:port, got %q", hostport)
	}
	host := hostport[:i]
	port, err := strconv.Atoi(hostport[i+1:])
	if err != nil || port <= 0 || port > 65535 {
		return "", 0, fmt.Errorf("bad port in %q", hostport)
	}
	return host, port, nil
}

// splitUserPass: first colon separates user/pass; user may contain no colon
// usually, but DataImpulse user has NO colon — pass is after first ':'.
// Format user:pass where user can contain ';' but not ':'.
// If multiple ':', first is separator (user:pass_with:colons rare → pass = rest).
func splitUserPass(userinfo string) (user, pass string) {
	i := strings.Index(userinfo, ":")
	if i < 0 {
		return userinfo, ""
	}
	return userinfo[:i], userinfo[i+1:]
}

// NormalizeInput cleans UI paste (Host/Login/Password blocks).
// Supports:
//
//	user:pass@host:port
//	and multi-line:
//	  Host
//	  212.8.249.134:443
//	  Login
//	  user
//	  Password
//	  pass
func NormalizeInput(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	// single line with @ — already full form
	if !strings.Contains(s, "\n") && !strings.Contains(s, "\r") {
		return strings.TrimSpace(s)
	}
	// multi-line vendor card
	lines := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	var host, login, pass string
	var bare []string
	mode := "" // host|login|pass
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// bare user:pass@host:port wins immediately
		if strings.Contains(line, "@") && strings.Count(line, ":") >= 2 {
			return line
		}
		low := strings.ToLower(line)
		// label-only lines
		if isLabelOnly(low, "host") {
			mode = "host"
			// value on same line?
			if v := stripLabel(line); v != "" && !isLabelOnly(strings.ToLower(v), "host") && v != line {
				host = v
				mode = ""
			}
			continue
		}
		if isLabelOnly(low, "login") || isLabelOnly(low, "логін") || isLabelOnly(low, "user") || isLabelOnly(low, "username") {
			mode = "login"
			if v := stripLabel(line); v != "" && v != line {
				login = v
				mode = ""
			}
			continue
		}
		if isLabelOnly(low, "pass") || isLabelOnly(low, "password") || isLabelOnly(low, "пароль") {
			mode = "pass"
			if v := stripLabel(line); v != "" && v != line {
				pass = v
				mode = ""
			}
			continue
		}
		// value line after label
		switch mode {
		case "host":
			host = line
			mode = ""
			continue
		case "login":
			login = line
			mode = ""
			continue
		case "pass":
			pass = line
			mode = ""
			continue
		}
		// "Host: value" form
		if strings.HasPrefix(low, "host") {
			host = stripLabel(line)
			continue
		}
		if strings.HasPrefix(low, "login") || strings.HasPrefix(low, "логін") || strings.HasPrefix(low, "user") {
			login = stripLabel(line)
			continue
		}
		if strings.HasPrefix(low, "pass") || strings.HasPrefix(low, "пароль") {
			pass = stripLabel(line)
			continue
		}
		bare = append(bare, line)
	}
	if host != "" {
		p, err := ParseParts(host, login, pass, "http")
		if err == nil {
			return p.URLWithAuth()
		}
	}
	// fallback: first bare line
	if len(bare) > 0 {
		return bare[0]
	}
	return s
}

func isLabelOnly(low, key string) bool {
	low = strings.TrimSpace(low)
	low = strings.TrimSuffix(low, ":")
	low = strings.TrimSpace(low)
	return low == key
}

func stripLabel(line string) string {
	// "Host: 1.2.3.4:443" or "Host 1.2.3.4:443"
	for i, r := range line {
		if r == ':' {
			rest := strings.TrimSpace(line[i+1:])
			// avoid treating host:port as label:value when line is just host:port
			// only strip if prefix before : is a known short label word
			prefix := strings.ToLower(strings.TrimSpace(line[:i]))
			if prefix == "host" || prefix == "login" || prefix == "user" || prefix == "username" ||
				prefix == "pass" || prefix == "password" || prefix == "логін" || prefix == "пароль" {
				return rest
			}
			return ""
		}
		if i > 0 && r == ' ' {
			prefix := strings.ToLower(strings.TrimSpace(line[:i]))
			if prefix == "host" || prefix == "login" || prefix == "user" || prefix == "password" || prefix == "pass" {
				return strings.TrimSpace(line[i+1:])
			}
		}
	}
	return ""
}
