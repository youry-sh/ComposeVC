// Package proxybridge runs a local HTTP proxy without auth for Chrome.
// Upstream may be HTTP(S) with Proxy-Authorization or SOCKS5 with user/pass.
// Chromium rejects socks5://user:pass@host (ERR_NO_SUPPORTED_PROXIES).
//
// IMPORTANT: when Chrome is launched DETACHED, the bridge must outlive the
// anti.exe parent process. Use StartDetached (spawns anti bridge-run) rather
// than in-process Start alone for launch/detach flows — otherwise Chrome
// keeps --proxy-server=http://127.0.0.1:PORT pointing at a dead listener →
// ERR_PROXY_CONNECTION_FAILED while curl -x still works.
package proxybridge

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	xproxy "golang.org/x/net/proxy"

	"anti/internal/procattr"
	"anti/internal/proxyfmt"
)

// Bridge is a local HTTP proxy on 127.0.0.1 that forwards to authenticated upstream.
type Bridge struct {
	Upstream proxyfmt.Proxy
	listener net.Listener
	server   *http.Server
	LocalURL string // http://127.0.0.1:port  — safe for --proxy-server=
	mu       sync.Mutex
	closed   bool
}

// Start listens on 127.0.0.1:0.
// Supports upstream schemes: http, https, socks5, socks4 (socks4 treated as socks5 dial if needed).
func Start(up proxyfmt.Proxy) (*Bridge, error) {
	if up.Host == "" || up.Port == 0 {
		return nil, fmt.Errorf("invalid upstream")
	}
	scheme := strings.ToLower(up.Scheme)
	if scheme == "" {
		scheme = "http"
	}
	if scheme == "socks" {
		scheme = "socks5"
		up.Scheme = "socks5"
	}
	switch scheme {
	case "http", "https", "socks5", "socks4":
	default:
		return nil, fmt.Errorf("unsupported upstream scheme %q", scheme)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	b := &Bridge{
		Upstream: up,
		listener: ln,
		LocalURL: fmt.Sprintf("http://%s", ln.Addr().String()),
	}
	b.server = &http.Server{
		Handler:           b,
		ReadHeaderTimeout: 30 * time.Second,
	}
	go func() {
		_ = b.server.Serve(ln)
	}()
	return b, nil
}

// Close stops the local proxy.
func (b *Bridge) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil
	}
	b.closed = true
	if b.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = b.server.Shutdown(ctx)
	}
	if b.listener != nil {
		_ = b.listener.Close()
	}
	return nil
}

// Detached is a child process running anti bridge-run, outliving the launcher.
type Detached struct {
	LocalURL string // http://127.0.0.1:port
	Proc     *os.Process
	Pid      int
	MetaPath string // optional state file for close/relaunch
	Upstream proxyfmt.Proxy
}

// Close kills the detached bridge process (best-effort).
func (d *Detached) Close() error {
	if d == nil {
		return nil
	}
	var err error
	if d.Proc != nil {
		err = d.Proc.Kill()
		d.Proc = nil
	} else if d.Pid > 0 {
		if p, e := os.FindProcess(d.Pid); e == nil && p != nil {
			err = p.Kill()
		}
	}
	if d.MetaPath != "" {
		_ = os.Remove(d.MetaPath)
	}
	return err
}

// WriteMeta saves bridge pid/url so Electron closeProfile can kill it after anti.exe exits.
func (d *Detached) WriteMeta(path string) error {
	if d == nil || path == "" {
		return nil
	}
	d.MetaPath = path
	body := fmt.Sprintf("{\"pid\":%d,\"local_url\":%q,\"ts\":%d}\n", d.Pid, d.LocalURL, time.Now().Unix())
	return os.WriteFile(path, []byte(body), 0o600)
}

// KillMetaProcess reads meta file and kills the bridge pid (for closeProfile).
func KillMetaProcess(metaPath string) {
	if metaPath == "" {
		return
	}
	b, err := os.ReadFile(metaPath)
	if err != nil {
		return
	}
	_ = os.Remove(metaPath)
	// minimal parse: "pid":12345
	s := string(b)
	i := strings.Index(s, `"pid"`)
	if i < 0 {
		return
	}
	rest := s[i+5:]
	// skip to digits
	j := strings.IndexAny(rest, "0123456789")
	if j < 0 {
		return
	}
	rest = rest[j:]
	k := 0
	for k < len(rest) && rest[k] >= '0' && rest[k] <= '9' {
		k++
	}
	pid, err := strconv.Atoi(rest[:k])
	if err != nil || pid <= 0 {
		return
	}
	if p, e := os.FindProcess(pid); e == nil && p != nil {
		_ = p.Kill()
	}
}

// antiBinaryName returns the anti CLI executable name for this platform.
func antiBinaryName() string {
	if runtime.GOOS == "windows" {
		return "anti.exe"
	}
	return "anti"
}

// resolveAntiExe finds the anti binary next to the running binary or under projectRoot.
func resolveAntiExe(projectRoot string) (string, error) {
	if self, err := os.Executable(); err == nil {
		abs, _ := filepath.Abs(self)
		if st, err := os.Stat(abs); err == nil && !st.IsDir() {
			return abs, nil
		}
	}
	bin := antiBinaryName()
	cands := []string{
		filepath.Join(projectRoot, "bin", bin),
		filepath.Join(projectRoot, bin),
	}
	for _, c := range cands {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			abs, _ := filepath.Abs(c)
			return abs, nil
		}
	}
	return "", fmt.Errorf("%s not found for bridge-run (projectRoot=%s)", bin, projectRoot)
}

// StartDetached spawns `anti bridge-run -proxy …` as a detached OS process so
// Chrome can keep using 127.0.0.1 after the parent anti launch CLI exits.
// Child prints "bridge: http://127.0.0.1:PORT" on stdout; we parse it.
func StartDetached(projectRoot string, up proxyfmt.Proxy) (*Detached, error) {
	if up.Host == "" || up.Port == 0 {
		return nil, fmt.Errorf("invalid upstream")
	}
	exe, err := resolveAntiExe(projectRoot)
	if err != nil {
		return nil, err
	}
	proxyURL := up.URLWithAuth()
	if proxyURL == "" {
		return nil, fmt.Errorf("empty proxy URL")
	}

	// Write ready URL to a temp file — more reliable than stdout with DETACHED_PROCESS on Windows.
	readyFile := filepath.Join(os.TempDir(), fmt.Sprintf("anti-bridge-%d-%d.url", os.Getpid(), time.Now().UnixNano()))
	_ = os.Remove(readyFile)

	cmd := exec.Command(exe, "bridge-run", "-proxy", proxyURL, "-ready-file", readyFile)
	cmd.Dir = filepath.Dir(exe)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.SysProcAttr = procattr.Detached()
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start bridge-run: %w", err)
	}

	// Poll ready file for local URL
	localURL := ""
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		// Child died?
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			_ = os.Remove(readyFile)
			return nil, fmt.Errorf("bridge-run exited before ready (exe=%s)", exe)
		}
		b, err := os.ReadFile(readyFile)
		if err == nil {
			line := strings.TrimSpace(string(b))
			if strings.HasPrefix(line, "http://") || strings.HasPrefix(line, "https://") {
				localURL = line
				break
			}
			if strings.HasPrefix(line, "bridge:") {
				localURL = strings.TrimSpace(strings.TrimPrefix(line, "bridge:"))
				if localURL != "" {
					break
				}
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	if localURL == "" {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		_ = os.Remove(readyFile)
		return nil, fmt.Errorf("bridge-run did not write ready file in time (exe=%s file=%s)", exe, readyFile)
	}
	hostPort := strings.TrimPrefix(localURL, "http://")
	hostPort = strings.TrimPrefix(hostPort, "https://")
	if err := waitTCP(hostPort, 3*time.Second); err != nil {
		_ = cmd.Process.Kill()
		_ = os.Remove(readyFile)
		return nil, fmt.Errorf("bridge not listening on %s: %w", hostPort, err)
	}
	pid := 0
	if cmd.Process != nil {
		pid = cmd.Process.Pid
	}
	// Keep ready file so tools can discover bridge; cleaned on Close
	return &Detached{LocalURL: localURL, Proc: cmd.Process, Pid: pid, Upstream: up}, nil
}

func waitTCP(addr string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", addr, 300*time.Millisecond)
		if err == nil {
			_ = c.Close()
			return nil
		}
		last = err
		time.Sleep(80 * time.Millisecond)
	}
	if last == nil {
		last = fmt.Errorf("timeout")
	}
	return last
}

// RunForeground starts an in-process bridge and blocks until killed.
// Used by `anti bridge-run`. Writes ready URL to readyFile and stdout.
func RunForeground(up proxyfmt.Proxy, readyFile string) error {
	br, err := Start(up)
	if err != nil {
		return err
	}
	defer br.Close()
	line := br.LocalURL + "\n"
	fmt.Printf("bridge: %s\n", br.LocalURL)
	if readyFile != "" {
		_ = os.WriteFile(readyFile, []byte(strings.TrimSpace(br.LocalURL)), 0o600)
		defer os.Remove(readyFile)
	}
	_, _ = os.Stdout.WriteString(line)
	// Block forever (until process kill)
	select {}
}

// ParseProxyFlag is a thin helper for CLI.
func ParseProxyFlag(raw string) (proxyfmt.Proxy, error) {
	raw = proxyfmt.NormalizeInput(raw)
	return proxyfmt.Parse(raw)
}

// silence unused import if any
var (
	_ = strconv.Itoa
	_ = bufio.NewReader
)

func (b *Bridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		b.handleConnect(w, r)
		return
	}
	b.handleHTTP(w, r)
}

func (b *Bridge) scheme() string {
	s := strings.ToLower(b.Upstream.Scheme)
	if s == "" {
		return "http"
	}
	if s == "socks" {
		return "socks5"
	}
	return s
}

func (b *Bridge) upstreamAddr() string {
	return net.JoinHostPort(b.Upstream.Host, fmt.Sprintf("%d", b.Upstream.Port))
}

func (b *Bridge) proxyAuthHeader() string {
	if !b.Upstream.HasAuth() {
		return ""
	}
	token := base64.StdEncoding.EncodeToString([]byte(b.Upstream.User + ":" + b.Upstream.Pass))
	return "Basic " + token
}

// dialTarget returns a TCP connection to target (host:port) via upstream.
func (b *Bridge) dialTarget(ctx context.Context, target string) (net.Conn, error) {
	switch b.scheme() {
	case "socks5", "socks4":
		var auth *xproxy.Auth
		if b.Upstream.HasAuth() {
			auth = &xproxy.Auth{User: b.Upstream.User, Password: b.Upstream.Pass}
		}
		d, err := xproxy.SOCKS5("tcp", b.upstreamAddr(), auth, xproxy.Direct)
		if err != nil {
			return nil, fmt.Errorf("socks5 dialer: %w", err)
		}
		if cd, ok := d.(interface {
			DialContext(context.Context, string, string) (net.Conn, error)
		}); ok {
			return cd.DialContext(ctx, "tcp", target)
		}
		type res struct {
			c   net.Conn
			err error
		}
		ch := make(chan res, 1)
		go func() {
			c, err := d.Dial("tcp", target)
			ch <- res{c, err}
		}()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case r := <-ch:
			return r.c, r.err
		}
	default:
		var lastErr error
		for attempt := 0; attempt < 3; attempt++ {
			upConn, err := b.dialHTTPConnect(ctx, target)
			if err == nil {
				return upConn, nil
			}
			lastErr = err
			if strings.Contains(err.Error(), "status 407") {
				break
			}
			if attempt < 2 {
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-time.After(250 * time.Millisecond):
				}
			}
		}
		return nil, lastErr
	}
}

func (b *Bridge) dialHTTPConnect(ctx context.Context, target string) (net.Conn, error) {
	d := net.Dialer{Timeout: 20 * time.Second, KeepAlive: 30 * time.Second}
	upConn, err := d.DialContext(ctx, "tcp", b.upstreamAddr())
	if err != nil {
		return nil, fmt.Errorf("upstream dial: %w", err)
	}
	if tc, ok := upConn.(*net.TCPConn); ok {
		_ = tc.SetKeepAlive(true)
		_ = tc.SetKeepAlivePeriod(30 * time.Second)
	}
	reqLine := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n", target, target)
	if auth := b.proxyAuthHeader(); auth != "" {
		reqLine += "Proxy-Authorization: " + auth + "\r\n"
	}
	reqLine += "Connection: Keep-Alive\r\nProxy-Connection: Keep-Alive\r\n\r\n"
	if _, err := io.WriteString(upConn, reqLine); err != nil {
		_ = upConn.Close()
		return nil, fmt.Errorf("upstream CONNECT write: %w", err)
	}
	br := bufio.NewReader(upConn)
	status, err := br.ReadString('\n')
	if err != nil {
		_ = upConn.Close()
		return nil, fmt.Errorf("upstream CONNECT read: %w", err)
	}
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			_ = upConn.Close()
			return nil, fmt.Errorf("upstream CONNECT headers: %w", err)
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	if !strings.Contains(status, "200") {
		_ = upConn.Close()
		fields := strings.Fields(status)
		code := "unknown"
		if len(fields) > 1 {
			code = fields[1]
		}
		return nil, fmt.Errorf("upstream CONNECT failed status %s: %s", code, strings.TrimSpace(status))
	}
	if br.Buffered() > 0 {
		return &bufConn{Conn: upConn, r: br}, nil
	}
	return upConn, nil

}

type bufConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufConn) Read(p []byte) (int, error) {
	return c.r.Read(p)
}

func (c *bufConn) CloseWrite() error {
	if tc, ok := c.Conn.(*net.TCPConn); ok {
		return tc.CloseWrite()
	}
	return c.Conn.Close()
}

func (c *bufConn) CloseRead() error {
	if tc, ok := c.Conn.(*net.TCPConn); ok {
		return tc.CloseRead()
	}
	return nil
}

func (b *Bridge) handleConnect(w http.ResponseWriter, r *http.Request) {
	// Dial timeout only — tunnel itself must stay open for long TLS sessions
	// (Apple/iCloud keep CONNECT alive and are sensitive to early close/EOF).
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	target := r.Host
	if target == "" {
		target = r.URL.Host
	}
	upConn, err := b.dialTarget(ctx, target)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		upConn.Close()
		http.Error(w, "hijack not supported", http.StatusInternalServerError)
		return
	}
	clientConn, bufrw, err := hj.Hijack()
	if err != nil {
		upConn.Close()
		return
	}
	// Flush any pending buffered client data into the tunnel.
	if bufrw != nil && bufrw.Reader != nil && bufrw.Reader.Buffered() > 0 {
		pending := make([]byte, bufrw.Reader.Buffered())
		_, _ = bufrw.Read(pending)
		_, _ = upConn.Write(pending)
	}
	if err := setTCPKeepAlive(clientConn); err == nil {
		_ = setTCPKeepAlive(upConn)
	}
	_, _ = io.WriteString(clientConn, "HTTP/1.1 200 Connection Established\r\n\r\n")
	var wg sync.WaitGroup
	wg.Add(2)
	go proxyCopy(&wg, upConn, clientConn)
	go proxyCopy(&wg, clientConn, upConn)
	wg.Wait()
	_ = clientConn.Close()
	_ = upConn.Close()
}

func (b *Bridge) handleHTTP(w http.ResponseWriter, r *http.Request) {
	// For plain HTTP requests via proxy, dial target host:80 through upstream
	target := r.URL.Host
	if target == "" {
		target = r.Host
	}
	if !strings.Contains(target, ":") {
		target = target + ":80"
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	upConn, err := b.dialTarget(ctx, target)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer upConn.Close()

	// rewrite request to origin-form for origin server
	outReq := r.Clone(ctx)
	outReq.RequestURI = ""
	outReq.URL = &url.URL{
		Scheme:   "http",
		Host:     r.Host,
		Path:     r.URL.Path,
		RawQuery: r.URL.RawQuery,
	}
	if outReq.URL.Path == "" {
		outReq.URL.Path = "/"
	}
	if err := outReq.Write(upConn); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	resp, err := http.ReadResponse(bufio.NewReader(upConn), outReq)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func proxyCopy(wg *sync.WaitGroup, dst, src net.Conn) {
	defer wg.Done()
	_, _ = io.Copy(dst, src)
	closeWrite(dst)
	closeRead(src)
}

func setTCPKeepAlive(c net.Conn) error {
	switch t := c.(type) {
	case *net.TCPConn:
		if err := t.SetKeepAlive(true); err != nil {
			return err
		}
		return t.SetKeepAlivePeriod(30 * time.Second)
	case *bufConn:
		if tc, ok := t.Conn.(*net.TCPConn); ok {
			if err := tc.SetKeepAlive(true); err != nil {
				return err
			}
			return tc.SetKeepAlivePeriod(30 * time.Second)
		}
	}
	return nil
}

func closeWrite(c net.Conn) {
	if cw, ok := c.(interface{ CloseWrite() error }); ok {
		_ = cw.CloseWrite()
		return
	}
	_ = c.Close()
}

func closeRead(c net.Conn) {
	if cr, ok := c.(interface{ CloseRead() error }); ok {
		_ = cr.CloseRead()
	}
}
