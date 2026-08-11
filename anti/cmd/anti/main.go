package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"anti/internal/fp"
	"anti/internal/launch"
	"anti/internal/profile"
	"anti/internal/proxybridge"
	"anti/internal/proxyfmt"
)

const banner = `
  ╔══════════════════════════════════════════════╗
  ║  ANTI — Chromium fingerprint browser        ║
  ║  engine: fingerprint-chromium (C++ patches)  ║
  ╚══════════════════════════════════════════════╝
`

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(0)
	}

	root := findProjectRoot()
	store := profile.NewStore(filepath.Join(root, "profiles"))

	switch os.Args[1] {
	case "help", "-h", "--help":
		usage()
	case "create":
		cmdCreate(store, os.Args[2:])
	case "list":
		cmdList(store)
	case "show":
		cmdShow(store, os.Args[2:])
	case "delete":
		cmdDelete(store, os.Args[2:])
case "launch", "open", "run":
			cmdLaunch(root, store, os.Args[2:])
		case "args":
			cmdArgs(root, store, os.Args[2:])
		case "bridge-run", "bridge_run", "proxy-bridge":
			// Detached local auth proxy for Chrome — must outlive launch CLI.
			cmdBridgeRun(os.Args[2:])
		case "engine":
			cmdEngine(root)
		case "patches":
			cmdPatches(root)
		case "persona":
			cmdPersona(os.Args[2:])
		default:
			fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
			usage()
			os.Exit(1)
		}
	}
func usage() {
	fmt.Print(banner)
	fmt.Print(`  Usage:
    anti create  <name> [flags]     create profile (seed→persona pack)
    anti list                       list profiles
    anti show    <name>             show profile JSON + chrome args
    anti delete  <name> [--wipe]    delete profile metadata (+ data)
anti launch  <name> [url] [-headless|-visible] [-debug-port N]
		    anti args    <name>             print chrome args (dry-run)
		    anti bridge-run -proxy URL      local auth proxy (detached; used by launch)
		    anti persona <seed>             print seed-derived persona (no save)
			    anti engine                     resolve chrome binary path		    anti patches                    list local C++ patch files
	  launch flags:
	    -headless             --headless=new (no window); also ANTI_HEADLESS=1
	    -visible              force visible window; also ANTI_HEADLESS=0
	    -debug-port N         remote-debugging-port
	  create flags:    -seed int             0=random; drives cores/screen/tz/lang
    -platform windows|linux|macos
    -platform-version string
    -brand Chrome|Edge|Opera|Vivaldi
    -cores int            0=seed formula ((seed%13)+4)*2  [NOT forced 8]
    -width int -height int  0=seed screen table
-tz string            empty=proxy EXIT IP tz (if -proxy) else seed locale
	    -lang string          empty=proxy EXIT lang (if -proxy) else seed
	    -proxy string         http://… | socks5://… | host:port:user:pass
	                          → timezone/lang taken from EXIT IP (not America/* seed)    -no-speech-ext        disable speech-locale extension
    -no-harden            disable headless-hardening flags
    -notes string

  Engine docs:
    patches/  — C++ diffs + draft 019-speech
    docs/     — FIXPLAN, ARCHITECTURE, FLAGS
    extensions/speech-locale — runtime speech filter until C++ rebuild
`)
}

func findProjectRoot() string {
	// 1) ANTI_ROOT
	if r := os.Getenv("ANTI_ROOT"); r != "" {
		return r
	}
	// 2) beside executable: .../bin/anti.exe -> parent
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		// bin/ -> project root
		if filepath.Base(dir) == "bin" {
			cand := filepath.Dir(dir)
			if looksLikeRoot(cand) {
				return cand
			}
		}
		if looksLikeRoot(dir) {
			return dir
		}
	}
	// 3) cwd
	cwd, _ := os.Getwd()
	// walk up
	dir := cwd
	for i := 0; i < 6; i++ {
		if looksLikeRoot(dir) {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return cwd
}

func looksLikeRoot(dir string) bool {
	// engine/chromium/chrome.exe or patches/ present
	if st, err := os.Stat(filepath.Join(dir, "engine", "chromium", "chrome.exe")); err == nil && !st.IsDir() {
		return true
	}
	if st, err := os.Stat(filepath.Join(dir, "patches")); err == nil && st.IsDir() {
		return true
	}
	return false
}

func cmdCreate(store *profile.Store, args []string) {
	// Allow: create <name> [flags]  OR  create [flags] <name>
	// flag.FlagSet stops at first non-flag, so pull name out first if present.
	name := ""
	flagArgs := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		if name == "" && !strings.HasPrefix(a, "-") {
			name = a
			continue
		}
		// keep flag and its value together
		flagArgs = append(flagArgs, a)
		if strings.HasPrefix(a, "-") && !strings.Contains(a, "=") && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
			// boolean flags have no value; known value-taking flags only
			switch strings.TrimLeft(a, "-") {
case "notes", "seed", "platform", "platform-version", "brand", "brand-version",
					"cores", "width", "height", "tz", "lang", "accept-lang", "proxy", "noise", "disable-spoofing":				i++
				if i < len(args) {
					flagArgs = append(flagArgs, args[i])
				}
			}
		}
	}

	fs := flag.NewFlagSet("create", flag.ExitOnError)
	seed := fs.Int64("seed", 0, "fingerprint seed (0=random)")
	platform := fs.String("platform", "windows", "windows|linux|macos")
	platformVer := fs.String("platform-version", "", "OS version (empty=persona default)")
	brand := fs.String("brand", "Chrome", "browser brand")
	brandVer := fs.String("brand-version", "", "brand version")
	cores := fs.Int("cores", 0, "hardwareConcurrency (0=seed formula)")
	width := fs.Int("width", 0, "screen width (0=seed table)")
	height := fs.Int("height", 0, "screen height (0=seed table)")
	tz := fs.String("tz", "", "timezone (empty=seed locale)")
	lang := fs.String("lang", "", "lang (empty=seed locale)")
	accept := fs.String("accept-lang", "", "accept-lang (empty=seed)")
proxy := fs.String("proxy", "", "proxy-server")
		notes := fs.String("notes", "", "notes")
		noise := fs.String("noise", "balanced", "fingerprint noise: full|balanced|native (see --disable-spoofing)")
		disableSpoof := fs.String("disable-spoofing", "", "raw engine tokens e.g. canvas,audio (overrides -noise)")
		noSpeech := fs.Bool("no-speech-ext", false, "disable speech-locale extension")
		noHarden := fs.Bool("no-harden", false, "disable headless hardening args")
		_ = fs.Parse(flagArgs)
		if name == "" {
			rest := fs.Args()
			if len(rest) < 1 {
				fmt.Fprintln(os.Stderr, "create: name required")
				os.Exit(1)
			}
			name = rest[0]
		}

		cfg := fp.DefaultConfig()
		cfg.Seed = *seed
		cfg.Platform = *platform
		cfg.PlatformVersion = *platformVer
		cfg.Brand = *brand
		cfg.BrandVersion = *brandVer
		cfg.HardwareConcurrency = *cores
		cfg.ScreenWidth = *width
		cfg.ScreenHeight = *height
		cfg.Timezone = *tz
		cfg.Lang = *lang
		cfg.AcceptLang = *accept
		cfg.Proxy = *proxy
		cfg.NoiseMode = *noise
		if *disableSpoof != "" {
			cfg.DisableSpoofing = *disableSpoof
		}
		if *noSpeech {
			cfg.LoadSpeechExtension = false
		}
		if *noHarden {
			cfg.HeadlessHardening = false
		}

		p, err := store.Create(name, cfg)
		if err != nil {
			fatal(err)
		}
		if *notes != "" {
			p.Notes = *notes
			_ = store.Save(p)
		}

		fmt.Printf("  created profile %q\n", p.Name)
		fmt.Printf("  seed:     %d\n", p.FP.Seed)
		fmt.Printf("  cores:    %d  (deviceMemory expect %d GB — engine may still report 8)\n",
			p.FP.HardwareConcurrency, p.FP.DeviceMemoryGB)
		fmt.Printf("  screen:   %dx%d @ %g\n", p.FP.ScreenWidth, p.FP.ScreenHeight, p.FP.DeviceScale)
		fmt.Printf("  locale:   %s | %s | speech=%s\n", p.FP.Lang, p.FP.Timezone, p.FP.SpeechExpect)
		fmt.Printf("  fonts:    %s\n", p.FP.FontTier)
		fmt.Printf("  noise:    %s  disable-spoofing=%q\n", p.FP.NoiseMode, p.FP.DisableSpoofing)
		fmt.Printf("  gpu hint: %s\n", p.FP.GPUHint)
fmt.Printf("  platform: %s %s\n", p.FP.Platform, p.FP.PlatformVersion)
		fmt.Printf("  data:     %s\n", store.AbsDataDir(p))
		fmt.Printf("  launch:   anti launch %s\n", p.Name)
	}
func cmdPersona(args []string) {
	if len(args) < 1 {
		fatal(fmt.Errorf("persona: seed required (int)"))
	}
	seed, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil || seed == 0 {
		fatal(fmt.Errorf("persona: invalid seed %q", args[0]))
	}
	platform := "windows"
	if len(args) > 1 {
		platform = args[1]
	}
	p := fp.DerivePersona(seed, platform)
	b, _ := json.MarshalIndent(p, "", "  ")
	fmt.Println(string(b))
}

func cmdList(store *profile.Store) {
	list, err := store.List()
	if err != nil {
		fatal(err)
	}
	if len(list) == 0 {
		fmt.Println("  (no profiles — anti create <name>)")
		return
	}
	fmt.Printf("  %-20s %-12s %-10s %s\n", "NAME", "SEED", "PLATFORM", "PROXY")
	for _, p := range list {
		fmt.Printf("  %-20s %-12d %-10s %s\n", p.Name, p.FP.Seed, p.FP.Platform, p.FP.Proxy)
	}
}

func cmdShow(store *profile.Store, args []string) {
	if len(args) < 1 {
		fatal(fmt.Errorf("show: name required"))
	}
	p, err := store.Get(args[0])
	if err != nil {
		fatal(err)
	}
	b, _ := json.MarshalIndent(p, "", "  ")
	fmt.Println(string(b))
	fmt.Println("--- chrome args ---")
	_ = launch.PrintArgs(launch.Options{
		ProjectRoot: findProjectRoot(),
		UserDataDir: store.AbsDataDir(p),
		FP:          p.FP,
	})
}

func cmdDelete(store *profile.Store, args []string) {
	wipe := false
	name := ""
	for _, a := range args {
		if a == "--wipe" {
			wipe = true
			continue
		}
		if !strings.HasPrefix(a, "-") {
			name = a
		}
	}
	if name == "" {
		fatal(fmt.Errorf("delete: name required"))
	}
	if err := store.Delete(name, wipe); err != nil {
		fatal(err)
	}
	fmt.Printf("  deleted %q (wipe=%v)\n", name, wipe)
}

func cmdLaunch(root string, store *profile.Store, args []string) {
	name := ""
	url := ""
	flagArgs := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") {
			flagArgs = append(flagArgs, a)
			if (a == "-debug-port" || a == "--debug-port") && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
				flagArgs = append(flagArgs, args[i])
			}
			continue
		}
		if name == "" {
			name = a
			continue
		}
		if url == "" {
			url = a
		}
	}
	fs := flag.NewFlagSet("launch", flag.ContinueOnError)
	debugPort := fs.Int("debug-port", 0, "remote-debugging-port (0=off; or ANTI_DEBUG_PORT / ANTI_CDP=1)")
	headlessFlag := fs.Bool("headless", false, "run chrome with --headless=new (no window)")
	visibleFlag := fs.Bool("visible", false, "force visible window (overrides -headless)")
	_ = fs.Parse(flagArgs)
	if name == "" {
		rest := fs.Args()
		if len(rest) < 1 {
			fatal(fmt.Errorf("launch: name required"))
		}
		name = rest[0]
		if len(rest) > 1 && url == "" {
			url = rest[1]
		}
	}
	port := *debugPort
	if port <= 0 {
		if v := strings.TrimSpace(os.Getenv("ANTI_DEBUG_PORT")); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				port = n
			}
		}
	}
	if port <= 0 && (os.Getenv("ANTI_CDP") == "1" || strings.EqualFold(os.Getenv("ANTI_CDP"), "true")) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fatal(fmt.Errorf("allocate debug port: %w", err))
		}
		port = ln.Addr().(*net.TCPAddr).Port
		_ = ln.Close()
	}
	p, err := store.Get(name)
	if err != nil {
		fatal(err)
	}
	if profile.RefreshProxyLocaleOnLaunch(p) {
		_ = store.Save(p)
		fmt.Fprintf(os.Stderr, "  locale refreshed from proxy exit: %s | %s\n", p.FP.Timezone, p.FP.Lang)
	}
	if err := p.FP.Validate(); err != nil {
		fatal(err)
	}
	skipPing := true
	if os.Getenv("ANTI_PROXY_PING") == "1" || os.Getenv("ANTI_REQUIRE_PROXY_PING") != "" {
		skipPing = false
	}
	wantHeadless := *headlessFlag
	if *visibleFlag {
		wantHeadless = false
	}
	if !*headlessFlag && !*visibleFlag {
		env := strings.TrimSpace(strings.ToLower(os.Getenv("ANTI_HEADLESS")))
		switch env {
		case "0", "false", "off", "no", "visible", "show":
			wantHeadless = false
		case "1", "true", "on", "yes", "headless":
			wantHeadless = true
		default:
			if port > 0 || os.Getenv("ANTI_CDP") == "1" || strings.EqualFold(os.Getenv("ANTI_CDP"), "true") {
				wantHeadless = true
			}
		}
	}
	err = launch.Run(launch.Options{
		ProjectRoot:   root,
		UserDataDir:   store.AbsDataDir(p),
		FP:            p.FP,
		URL:           url,
		Detach:        true,
		DebugPort:     port,
		Headless:      wantHeadless,
		SkipProxyPing: skipPing,
	})
	if err != nil {
		fatal(err)
	}
	fmt.Printf("  launched %q tz=%s lang=%s headless=%v\n", p.Name, p.FP.Timezone, p.FP.Lang, wantHeadless)
	if port > 0 {
		fmt.Printf("debug_port: %d\n", port)
		fmt.Printf("cdp: http://127.0.0.1:%d\n", port)
	}
}

func cmdArgs(root string, store *profile.Store, args []string) {
	if len(args) < 1 {
		fatal(fmt.Errorf("args: name required"))
	}
	p, err := store.Get(args[0])
	if err != nil {
		fatal(err)
	}
	_ = launch.PrintArgs(launch.Options{
		ProjectRoot: root,
		UserDataDir: store.AbsDataDir(p),
		FP:          p.FP,
	})
}
// cmdBridgeRun runs a local HTTP auth-proxy forever (for Chrome --proxy-server).
// Flags: -proxy URL  -ready-file path
// Prints "bridge: http://127.0.0.1:PORT" and writes ready-file so parent can detach.
func cmdBridgeRun(args []string) {
	fs := flag.NewFlagSet("bridge-run", flag.ContinueOnError)
	proxy := fs.String("proxy", "", "upstream proxy URL with auth (http://user:pass@host:port)")
	readyFile := fs.String("ready-file", "", "write local bridge URL here when listening")
	_ = fs.Parse(args)
	raw := strings.TrimSpace(*proxy)
	if raw == "" {
		// also accept positional
		if fs.NArg() > 0 {
			raw = fs.Arg(0)
		}
	}
	if raw == "" {
		fatal(fmt.Errorf("bridge-run: -proxy required"))
	}
	p, err := proxyfmt.Parse(proxyfmt.NormalizeInput(raw))
	if err != nil {
		fatal(fmt.Errorf("bridge-run parse: %w", err))
	}
	if !p.HasAuth() {
		// still ok — bridge works without auth too, but usually not needed
		fmt.Fprintf(os.Stderr, "  warn: bridge-run without auth (pass-through to %s)\n", p.Display())
	}
	if err := proxybridge.RunForeground(p, *readyFile); err != nil {
		fatal(err)
	}
}

func cmdEngine(root string) {
	path, err := launch.ResolveChrome(root)
	if err != nil {
		fatal(err)
	}
	fmt.Println(path)
	// also print version-ish parent dir
	fmt.Printf("  project: %s\n", root)
}

func cmdPatches(root string) {
	dir := filepath.Join(root, "patches")
	entries, err := os.ReadDir(dir)
	if err != nil {
		fatal(err)
	}
	fmt.Printf("  patches in %s\n", dir)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, _ := e.Info()
		sz := int64(0)
		if info != nil {
			sz = info.Size()
		}
		fmt.Printf("  %6d  %s\n", sz, e.Name())
	}
	fmt.Println("  source: adryfish/fingerprint-chromium tag 144.0.7559.132")
	fmt.Println("  binary: 148.0.7778.215 x64 (fingerprint-enabled)")
	fmt.Println("          windows: engine/chromium/chrome.exe | linux: engine/chromium/chrome")
	fmt.Println("          linux engine: ./fetch-engine-linux.sh")
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "  error: %v\n", err)
	os.Exit(1)
}

// silence unused import if build tags change
var _ = strconv.Itoa
