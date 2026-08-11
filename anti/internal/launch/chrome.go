package launch

import (
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"anti/internal/fp"
		"anti/internal/procattr"
		"anti/internal/proxybridge"
		"anti/internal/proxyfmt"
		"anti/internal/proxyping")
// shouldLoadCaptchaHelper ALWAYS loads captcha-helper unless ANTI_NO_CAPTCHA.
// The extension installs MAIN-world hooks (__ANTI_TS_INJECT__, callback capture).
// Solving is extension-native: captcha_pass clicks the real widget and harvests
// the in-browser token (no paid providers — CapSolver/2captcha were removed).
// Gating on anti/config/captcha.json enabled/key was a bug: agent captcha_pass ran
// without hooks → React never unlocked, form field empty, false "token ready".
func shouldLoadCaptchaHelper(projectRoot string) bool {
	if os.Getenv("ANTI_NO_CAPTCHA") != "" {
		return false
	}
	_ = projectRoot
	return true
}

var extMu sync.Mutex

// activeBridges: in-process (rare) + detached child bridges that outlive anti.exe.
var (
	bridgeMu       sync.Mutex
	activeBridge   *proxybridge.Bridge
	activeDetached *proxybridge.Detached
)

// chromeBinaryName returns the engine executable name for this platform:
// chrome.exe on Windows, chrome on Linux/macOS (system Chromium also accepted).
func chromeBinaryName() string {
	if runtime.GOOS == "windows" {
		return "chrome.exe"
	}
	return "chrome"
}

func ResolveChrome(projectRoot string) (string, error) {
	bin := chromeBinaryName()
	candidates := []string{}
	if env := os.Getenv("ANTI_CHROME"); env != "" {
		candidates = append(candidates, env)
	}
	marker := filepath.Join(projectRoot, "engine", "CHROME_DIR.txt")
	if b, err := os.ReadFile(marker); err == nil {
		dir := strings.TrimSpace(string(b))
		dir = strings.TrimPrefix(dir, "\ufeff")
		if dir != "" {
			candidates = append(candidates, filepath.Join(dir, bin), dir)
		}
	}
	candidates = append(candidates,
		filepath.Join(projectRoot, "engine", "chromium", bin),
		filepath.Join(projectRoot, "engine", bin),
	)
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			c = filepath.Join(c, bin)
		}
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			abs, _ := filepath.Abs(c)
			return abs, nil
		}
	}
	// Non-Windows: fall back to a system Chromium/Chrome on PATH.
	// The C++ fingerprint engine is Windows-only; on Linux the JS
	// fp-inject extension still spoofs navigator/plugins/etc.
	//
	// IMPORTANT: prefer UNBRANDED Chromium (chromium, chromium-browser).
	// Branded Google Chrome >=137 silently ignores --load-extension (and the
	// --disable-features=DisableLoadExtensionCommandLineSwitch workaround was
	// removed in 142), so the fp-inject/captcha-helper extensions never load
	// there. OSS Chromium builds still honor --load-extension in headless.
	if runtime.GOOS != "windows" {
		for _, name := range []string{
			"chromium", "chromium-browser", "chrome",
		} {
			if p, err := exec.LookPath(name); err == nil && p != "" {
				abs, _ := filepath.Abs(p)
				return abs, nil
			}
		}
		// Branded fallback (extensions likely won't load — last resort).
		for _, name := range []string{
			"google-chrome-stable", "google-chrome", "brave-browser",
		} {
			if p, err := exec.LookPath(name); err == nil && p != "" {
				abs, _ := filepath.Abs(p)
				return abs, nil
			}
		}
		// engine dirs as-is: someone may have dropped an executable with a
		// different name (e.g. engine/chromium/chromium, engine/ungoogled-chromium).
		for _, dir := range []string{
			filepath.Join(projectRoot, "engine", "chromium"),
			filepath.Join(projectRoot, "engine"),
		} {
			if st, err := os.Stat(dir); err != nil || !st.IsDir() {
				continue
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for _, e := range entries {
				if e.IsDir() {
					continue
				}
				full := filepath.Join(dir, e.Name())
				if st2, err := os.Stat(full); err == nil && st2.Mode()&0o111 != 0 {
					abs, _ := filepath.Abs(full)
					return abs, nil
				}
			}
		}
	}
	return "", fmt.Errorf("chrome binary not found; set ANTI_CHROME, put an engine under engine/chromium/, or install chromium/google-chrome on PATH")
}

type Options struct {
	ProjectRoot string
	UserDataDir string
	FP          fp.Config
	URL         string
	Detach      bool
	DebugPort   int
	// Headless runs Chrome with --headless=new (no visible window).
	// Env ANTI_HEADLESS=0|false|off forces visible even when Headless is true.
	// Env ANTI_HEADLESS=1|true|on forces headless when Headless is false.
	Headless bool
	// SkipProxyPing skips pre-launch https://i.pn check
	SkipProxyPing bool
	// RequireProxyPing if true and proxy set, fail launch when ping fails
	RequireProxyPing bool
}

func resolveHeadless(opt Options) bool {
	env := strings.TrimSpace(strings.ToLower(os.Getenv("ANTI_HEADLESS")))
	switch env {
	case "0", "false", "off", "no", "visible", "show":
		return false
	case "1", "true", "on", "yes", "headless":
		return true
	}
	return opt.Headless
}

func WriteFPInjectConfig(projectRoot string, cfg fp.Config) error {
	ext := filepath.Join(projectRoot, "extensions", "fp-inject")
	if st, err := os.Stat(ext); err != nil || !st.IsDir() {
		return fmt.Errorf("fp-inject missing: %s", ext)
	}
	lang := cfg.Lang
	if lang == "" {
		lang = "en-US"
	}
	acceptLang := cfg.AcceptLang
	if acceptLang == "" {
		acceptLang = lang
	}
	speech := cfg.SpeechExpect
	if speech == "" {
		speech = lang
	}
	plat := cfg.Platform
	if plat == "" {
		plat = "windows"
	}
	// Coherent hardware pack for JS inject (covers engine leaks like host deviceMemory=32)
	cores := cfg.HardwareConcurrency
	if cores <= 0 {
		cores = fp.DerivedHardwareConcurrency(cfg.Seed)
	}
	mem := cfg.DeviceMemoryGB
	if mem <= 0 {
		// Chrome buckets: 4 or 8 only (never host 16/32)
		if cores <= 6 {
			mem = 4
		} else {
			mem = 8
		}
	}
	if mem > 8 {
		mem = 8
	}
	if mem < 4 {
		mem = 4
	}
	sw, sh := cfg.ScreenWidth, cfg.ScreenHeight
	scale := cfg.DeviceScale
	if sw <= 0 || sh <= 0 {
		// seed screen from persona
		p := fp.DerivePersona(cfg.Seed, plat)
		if sw <= 0 {
			sw = p.ScreenWidth
		}
		if sh <= 0 {
			sh = p.ScreenHeight
		}
		if scale <= 0 {
			scale = p.DeviceScale
		}
	}
	if scale <= 0 {
		scale = 1
	}
	// availDelta for screen.availHeight (Windows taskbar CSS px)
	availDelta := 40
	if scale >= 1.4 {
		availDelta = 48
	}
	// audioNoise OFF by default (CreepJS lieProps). Set ANTI_AUDIO_NOISE=1 to enable.
	audioNoise := "false"
	if os.Getenv("ANTI_AUDIO_NOISE") == "1" {
		audioNoise = "true"
	}
	body := fmt.Sprintf(
		"// auto-generated by anti launcher — do not edit\n"+
			"window.__ANTI_FP__ = {\n"+
			"  seed: %d,\n"+
			"  lang: %q,\n"+
			"  acceptLang: %q,\n"+
			"  speechExpect: %q,\n"+
			"  platform: %q,\n"+
			"  hardwareConcurrency: %d,\n"+
			"  deviceMemory: %d,\n"+
			"  screenWidth: %d,\n"+
			"  screenHeight: %d,\n"+
			"  deviceScaleFactor: %g,\n"+
			"  availDelta: %d,\n"+
			"  audioNoise: %s\n"+
			"};\n",
			cfg.Seed, lang, acceptLang, speech, plat, cores, mem, sw, sh, scale, availDelta, audioNoise)
	return os.WriteFile(filepath.Join(ext, "config.js"), []byte(body), 0o644)
}

func AttachFPInject(projectRoot string, cfg *fp.Config) {
	if cfg == nil || os.Getenv("ANTI_NO_INJECT") != "" {
		return
	}
	ext := filepath.Join(projectRoot, "extensions", "fp-inject")
	if st, err := os.Stat(ext); err != nil || !st.IsDir() {
		fmt.Fprintf(os.Stderr, "  warn: fp-inject missing at %s\n", ext)
		return
	}
	if err := WriteFPInjectConfig(projectRoot, *cfg); err != nil {
		fmt.Fprintf(os.Stderr, "  warn: write fp-inject config: %v\n", err)
	}
	abs, err := filepath.Abs(ext)
	if err != nil {
		abs = ext
	}
	// Optional captcha helper (Turnstile / reCAPTCHA / hCaptcha → local anti-ui API)
	extList := abs
	if os.Getenv("ANTI_NO_CAPTCHA") == "" {
		capExt := filepath.Join(projectRoot, "extensions", "captcha-helper")
		if st, err := os.Stat(capExt); err == nil && st.IsDir() {
			// Load captcha helper when solver is enabled (or always if no config yet — helper no-ops)
			if shouldLoadCaptchaHelper(projectRoot) {
				if capAbs, err2 := filepath.Abs(capExt); err2 == nil {
					extList = abs + "," + capAbs
					fmt.Fprintf(os.Stderr, "  captcha-helper: loaded\n")
				}
			}
		}
	}
	var cleaned []string
	for _, a := range cfg.ExtraArgs {
		if strings.HasPrefix(a, "--load-extension=") || strings.HasPrefix(a, "--disable-extensions-except=") {
			continue
		}
		cleaned = append(cleaned, a)
	}
	cfg.ExtraArgs = append(cleaned,
		"--disable-extensions-except="+extList,
		"--load-extension="+extList,
	)
}

func PrepareConfig(projectRoot string, cfg *fp.Config) {
	if cfg == nil {
		return
	}
	if os.Getenv("ANTI_NO_SPEECH") == "" && os.Getenv("ANTI_NO_INJECT") == "" {
		cfg.LoadSpeechExtension = true
	}
	if os.Getenv("ANTI_NO_HARDEN") == "" {
		cfg.HeadlessHardening = true
	}
	fp.ApplyPersona(cfg)
	extMu.Lock()
	AttachFPInject(projectRoot, cfg)
	extMu.Unlock()
}

// applyProxy rewrites cfg.Proxy for Chrome.
// Chromium rejects socks5://user:pass@host and http://user:pass@host
// → ERR_NO_SUPPORTED_PROXIES. Any auth proxy goes through local bridge
// (127.0.0.1:port HTTP, no credentials) which dials upstream with auth.
//
// For Detached launches we MUST use StartDetached so the bridge process
// outlives anti.exe — otherwise Chrome hits a dead 127.0.0.1 and shows
// ERR_PROXY_CONNECTION_FAILED while curl -x still works.
func applyProxy(projectRoot string, cfg *fp.Config, skipPing, requirePing, preferDetached bool) (*proxyping.Result, error) {
	if cfg == nil || strings.TrimSpace(cfg.Proxy) == "" {
		return nil, nil
	}
	raw := proxyfmt.NormalizeInput(cfg.Proxy)
	p, err := proxyfmt.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("proxy parse: %w", err)
	}
	// default scheme
	if p.Scheme == "" {
		p.Scheme = "http"
	}

	var pingRes *proxyping.Result
	if !skipPing && os.Getenv("ANTI_NO_PROXY_PING") == "" {
		r := proxyping.PingProxy(p, proxyping.DefaultCheckURL, 15*time.Second)
		pingRes = &r
		fmt.Fprintf(os.Stderr, "  proxy ping: ok=%v %dms status=%d %s\n", r.OK, r.LatencyMS, r.StatusCode, r.Error)
		if r.BodyPreview != "" {
			fmt.Fprintf(os.Stderr, "  proxy body: %s\n", r.BodyPreview)
		}
		if !r.OK && (requirePing || os.Getenv("ANTI_REQUIRE_PROXY_PING") != "") {
			return pingRes, fmt.Errorf("proxy dead: %s", r.Error)
		}
	}

	// Always bridge when credentials present (http AND socks5).
	// Chrome cannot embed user:pass in --proxy-server.
	if p.HasAuth() {
		// Prefer detached child so Chrome survives after anti launch CLI exits.
		if preferDetached || os.Getenv("ANTI_BRIDGE_INLINE") == "" {
			det, err := proxybridge.StartDetached(projectRoot, p)
			if err != nil {
				// Fallback to in-process (only useful for non-detach / debug)
				fmt.Fprintf(os.Stderr, "  proxy bridge detached failed (%v) — trying in-process\n", err)
				br, err2 := proxybridge.Start(p)
				if err2 != nil {
					return pingRes, fmt.Errorf("proxy bridge: detached: %v; inline: %w", err, err2)
				}
				cfg.Proxy = br.LocalURL
				fmt.Fprintf(os.Stderr, "  proxy bridge (inline): %s → upstream %s (%s)\n", br.LocalURL, p.Display(), p.Scheme)
				bridgeMu.Lock()
				if activeBridge != nil {
					_ = activeBridge.Close()
				}
				if activeDetached != nil {
					_ = activeDetached.Close()
					activeDetached = nil
				}
				activeBridge = br
				bridgeMu.Unlock()
				return pingRes, nil
			}
			cfg.Proxy = det.LocalURL
			fmt.Fprintf(os.Stderr, "  proxy bridge (detached): %s → upstream %s (%s) pid=%d\n", det.LocalURL, p.Display(), p.Scheme, det.Pid)
			// Machine-readable for Electron antiSession (stdout survives spawnSync)
			fmt.Printf("bridge_pid: %d\n", det.Pid)
			fmt.Printf("bridge_url: %s\n", det.LocalURL)
			bridgeMu.Lock()
			if activeDetached != nil {
				// Don't Kill previous here if same launch path — Kill old only
				_ = activeDetached.Close()
			}
			if activeBridge != nil {
				_ = activeBridge.Close()
				activeBridge = nil
			}
			activeDetached = det
			bridgeMu.Unlock()
			return pingRes, nil
		}
		br, err := proxybridge.Start(p)
		if err != nil {
			return pingRes, fmt.Errorf("proxy bridge: %w", err)
		}
		cfg.Proxy = br.LocalURL // http://127.0.0.1:xxxxx — NO credentials
		fmt.Fprintf(os.Stderr, "  proxy bridge: %s → upstream %s (%s)\n", br.LocalURL, p.Display(), p.Scheme)
		bridgeMu.Lock()
		if activeBridge != nil {
			_ = activeBridge.Close()
		}
		activeBridge = br
		bridgeMu.Unlock()
		return pingRes, nil
	}

	// no auth: socks5://host:port or http://host:port (Chrome-safe)
	if p.Scheme == "socks5" || p.Scheme == "socks4" {
		cfg.Proxy = fmt.Sprintf("%s://%s:%d", p.Scheme, p.Host, p.Port)
		return pingRes, nil
	}
	cfg.Proxy = p.ChromeProxyServer()
	return pingRes, nil
}

func BuildCmd(opt Options) (*exec.Cmd, error) {
	chrome, err := ResolveChrome(opt.ProjectRoot)
	if err != nil {
		return nil, err
	}
	PrepareConfig(opt.ProjectRoot, &opt.FP)

	requirePing := opt.RequireProxyPing
	if os.Getenv("ANTI_REQUIRE_PROXY_PING") != "" {
		requirePing = true
	}
	preferDetached := opt.Detach || true
	if _, err := applyProxy(opt.ProjectRoot, &opt.FP, opt.SkipProxyPing, requirePing, preferDetached); err != nil {
		return nil, err
	}

	if err := opt.FP.Validate(); err != nil {
		return nil, err
	}
	if opt.UserDataDir == "" {
		return nil, fmt.Errorf("user data dir required")
	}
	if err := os.MkdirAll(opt.UserDataDir, 0o755); err != nil {
		return nil, err
	}
	bridgeMu.Lock()
	if activeDetached != nil && opt.UserDataDir != "" {
		meta := filepath.Join(opt.UserDataDir, "anti-proxy-bridge.json")
		if err := activeDetached.WriteMeta(meta); err == nil {
			fmt.Fprintf(os.Stderr, "  proxy bridge meta: %s\n", meta)
		}
	}
	bridgeMu.Unlock()
	args := opt.FP.Args(opt.UserDataDir)
	if resolveHeadless(opt) {
		args = append(args, "--headless=new", "--hide-scrollbars", "--mute-audio")
		// Linux/macOS headless: the fingerprint-chromium screen C++ switches
		// (--fingerprint-screen-width/height/device-scale-factor) are ignored on
		// Unix — the screen stays at ozone's 800x600 default. Force the persona
		// screen at C++ level instead: ozone-override-screen-size expects
		// PHYSICAL pixels, so convert CSS*dpr. Verified on the 148 engine:
		//   --ozone-override-screen-size=2400,1350 --force-device-scale-factor=1.25
		//   → screen.width=1920 height=1080 dpr=1.25 (exactly the persona pack).
		if runtime.GOOS != "windows" && opt.FP.ScreenWidth > 0 && opt.FP.ScreenHeight > 0 {
			scale := opt.FP.DeviceScale
			if scale <= 0 {
				scale = 1
			}
			physW := int(math.Round(float64(opt.FP.ScreenWidth) * scale))
			physH := int(math.Round(float64(opt.FP.ScreenHeight) * scale))
			if physW >= 800 && physH >= 600 {
				args = append(args, fmt.Sprintf("--ozone-override-screen-size=%d,%d", physW, physH))
				args = append(args, fmt.Sprintf("--force-device-scale-factor=%g", scale))
			}
		}
	}
	if opt.DebugPort > 0 {
		args = append(args, fmt.Sprintf("--remote-debugging-port=%d", opt.DebugPort))
		args = append(args, "--remote-allow-origins=*")
	}
	if opt.URL != "" {
		args = append(args, opt.URL)
	}
	cmd := exec.Command(chrome, args...)
	cmd.Dir = filepath.Dir(chrome)
	// Linux/macOS: Chrome ignores --timezone there, but honors the TZ env var
	// (ICU reads it). This keeps Intl.DateTimeFormat() in sync with the profile
	// timezone. Never override an explicit user TZ.
	if runtime.GOOS != "windows" && opt.FP.Timezone != "" && os.Getenv("TZ") == "" {
		cmd.Env = append(os.Environ(), "TZ="+opt.FP.Timezone)
	}
	return cmd, nil
}

func Run(opt Options) error {
	cmd, err := BuildCmd(opt)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "  chrome: %s\n", cmd.Path)
	fmt.Fprintf(os.Stderr, "  args:   %s\n", strings.Join(cmd.Args[1:], " "))
	if opt.Detach {
		cmd.Stdin = nil
		cmd.Stdout = nil
		cmd.Stderr = nil
		cmd.SysProcAttr = procattr.Detached()
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("start chrome: %w", err)
		}
		fmt.Fprintf(os.Stderr, "  pid:    %d (detached)\n", cmd.Process.Pid)
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		waitCrash := 400 * time.Millisecond
		if v := strings.TrimSpace(os.Getenv("ANTI_LAUNCH_WAIT_MS")); v != "" {
			if n, err := time.ParseDuration(v + "ms"); err == nil && n >= 100*time.Millisecond {
				waitCrash = n
			}
		}
		select {
		case err := <-done:
			if err != nil {
				return fmt.Errorf("chrome exited immediately: %w", err)
			}
			return fmt.Errorf("chrome exited immediately (code 0)")
		case <-time.After(waitCrash):
			return nil
		}
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func Start(opt Options) (*os.Process, error) {
	cmd, err := BuildCmd(opt)
	if err != nil {
		return nil, err
	}
	fmt.Fprintf(os.Stderr, "  chrome: %s\n", cmd.Path)
	fmt.Fprintf(os.Stderr, "  args:   %s\n", strings.Join(cmd.Args[1:], " "))
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.SysProcAttr = procattr.Detached()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd.Process, nil
}

func PrintArgs(opt Options) error {
	PrepareConfig(opt.ProjectRoot, &opt.FP)
	opt.SkipProxyPing = true
	if _, err := applyProxy(opt.ProjectRoot, &opt.FP, true, false, true); err != nil {
		return err
	}
	if err := opt.FP.Validate(); err != nil {
		return err
	}
	chrome, err := ResolveChrome(opt.ProjectRoot)
	if err != nil {
		chrome = "<chrome>"
	}
	args := opt.FP.Args(opt.UserDataDir)
	if resolveHeadless(opt) {
		args = append(args, "--headless=new", "--hide-scrollbars", "--mute-audio")
	}
	if opt.DebugPort > 0 {
		args = append(args, fmt.Sprintf("--remote-debugging-port=%d", opt.DebugPort))
	}
	if opt.URL != "" {
		args = append(args, opt.URL)
	}
	fmt.Printf("%s %s\n", chrome, strings.Join(args, " "))
	return nil
}