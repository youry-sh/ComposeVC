package captcha

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"anti/internal/procattr"
)

var (
	procMu   sync.Mutex
	localCmd *exec.Cmd
)

// SolverDir returns tools/turnstile-solver under project root.
func SolverDir(projectRoot string) string {
	return filepath.Join(projectRoot, "tools", "turnstile-solver")
}

// EnsureLocalRunning starts the Python Boterdrop solver if not already healthy.
// No-op if already up. Best-effort — errors returned so UI can show them.
// Windows: no console window (pythonw + CREATE_NO_WINDOW). Logs go to file only.
func EnsureLocalRunning(projectRoot, baseURL string) error {
	procMu.Lock()
	defer procMu.Unlock()

	if _, err := LocalHealth(nil, baseURL); err == nil {
		fmt.Fprintf(os.Stderr, "  local turnstile-solver: already online at %s\n", baseURL)
		return nil
	}

	dir := SolverDir(projectRoot)
	startPy := filepath.Join(dir, "src", "start_server.py")
	if st, err := os.Stat(startPy); err != nil || st.IsDir() {
		return fmt.Errorf("local solver missing at %s — copy tools/turnstile-solver", dir)
	}

	py, err := ensureSolverPython(dir)
	if err != nil {
		return err
	}
	// Prefer pythonw.exe on Windows — GUI subsystem, never opens a console.
	py = preferNoConsolePython(py)
	host, port := localHostPort(baseURL)

	logPath := filepath.Join(dir, "anti-local-solver.log")
	logF, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("local solver log open: %w", err)
	}
	// header
	_, _ = fmt.Fprintf(logF, "\n---- start %s host=%s port=%s py=%s ----\n",
		time.Now().Format(time.RFC3339), host, port, py)

	cmd := exec.Command(py, startPy, "--host", host, "--port", port)
	cmd.Dir = dir
	cmd.Stdout = logF
	cmd.Stderr = logF
	cmd.Stdin = nil
	hideConsole(cmd)

	if err := cmd.Start(); err != nil {
		_ = logF.Close()
		return fmt.Errorf("start local turnstile solver: %w", err)
	}
	localCmd = cmd
	// Reap async; keep logF open for process lifetime via Wait after.
	go func(c *exec.Cmd, f *os.File) {
		_ = c.Wait()
		_ = f.Close()
	}(cmd, logF)

	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := LocalHealth(nil, baseURL); err == nil {
			fmt.Fprintf(os.Stderr, "  local turnstile-solver: ready at %s (pid %d, no console)\n", baseURL, cmd.Process.Pid)
			fmt.Fprintf(os.Stderr, "  local turnstile-solver: log %s\n", logPath)
			return nil
		}
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			return fmt.Errorf("local turnstile-solver exited early — see %s", logPath)
		}
		time.Sleep(800 * time.Millisecond)
	}
	return fmt.Errorf("local turnstile-solver started but not healthy within 90s — see %s", logPath)
}

// preferNoConsolePython swaps python.exe -> pythonw.exe when available (Windows).
func preferNoConsolePython(py string) string {
	if runtime.GOOS != "windows" {
		return py
	}
	base := filepath.Base(py)
	switch base {
	case "python.exe", "python":
		cand := filepath.Join(filepath.Dir(py), "pythonw.exe")
		if fileExists(cand) {
			return cand
		}
	case "python3.exe", "python3":
		cand := filepath.Join(filepath.Dir(py), "pythonw.exe")
		if fileExists(cand) {
			return cand
		}
	}
	// PATH lookup for pythonw
	if w, err := exec.LookPath("pythonw"); err == nil && w != "" {
		// only if same install tree roughly — still better than console flash
		return w
	}
	return py
}

func hideConsole(cmd *exec.Cmd) {
	cmd.SysProcAttr = procattr.NoConsole()
}

func ensureSolverPython(dir string) (string, error) {
	venvPy := filepath.Join(dir, "venv", "bin", "python")
	if runtime.GOOS == "windows" {
		venvPy = filepath.Join(dir, "venv", "Scripts", "python.exe")
	}
	if fileExists(venvPy) {
		return venvPy, nil
	}

	basePy, err := exec.LookPath("python")
	if err != nil {
		basePy, err = exec.LookPath("python3")
	}
	if err != nil && runtime.GOOS == "windows" {
		for _, cand := range []string{
			filepath.Join(os.Getenv("LocalAppData"), "Programs", "Python", "Python312", "python.exe"),
			filepath.Join(os.Getenv("LocalAppData"), "Programs", "Python", "Python311", "python.exe"),
			filepath.Join(os.Getenv("LocalAppData"), "Programs", "Python", "Python310", "python.exe"),
			`C:\Python312\python.exe`,
			`C:\Python311\python.exe`,
			`C:\Python310\python.exe`,
		} {
			if fileExists(cand) {
				basePy = cand
				err = nil
				break
			}
		}
	}
	if err != nil || basePy == "" {
		return "", fmt.Errorf("python not found in PATH — install Python 3.x (tick Add to PATH) or run tools/turnstile-solver setup (start-with-anti.bat on Windows, start-server.sh on Linux)")
	}
	fmt.Fprintf(os.Stderr, "  local turnstile-solver: creating venv (first run, may take several minutes)...\n")
	if err := runSolverSetup(dir, basePy, "-m", "venv", "venv"); err != nil {
		return "", err
	}
	if !fileExists(venvPy) {
		return "", fmt.Errorf("venv python was not created at %s", venvPy)
	}
	if err := runSolverSetup(dir, venvPy, "-m", "pip", "install", "-U", "pip"); err != nil {
		return "", err
	}
	if err := runSolverSetup(dir, venvPy, "-m", "pip", "install", "-r", "requirements.txt"); err != nil {
		return "", err
	}
	if err := runSolverSetup(dir, venvPy, "-m", "camoufox", "fetch"); err != nil {
		return "", err
	}
	return venvPy, nil
}

func runSolverSetup(dir, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	// Setup can also flash a console — hide it; output to anti-setup.log
	logPath := filepath.Join(dir, "anti-setup.log")
	if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
		defer f.Close()
		cmd.Stdout = f
		cmd.Stderr = f
		_, _ = fmt.Fprintf(f, "\n---- setup %s %v ----\n", name, args)
	} else {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}
	cmd.Stdin = nil
	hideConsole(cmd)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("local turnstile solver setup failed: %s %v: %w (see %s)", name, args, err, logPath)
	}
	return nil
}

func localHostPort(baseURL string) (string, string) {
	u, err := url.Parse(baseURL)
	if err != nil || u.Host == "" {
		return "127.0.0.1", "8000"
	}
	host := u.Hostname()
	if host == "" || host == "localhost" {
		host = "127.0.0.1"
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "8000"
		}
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsUnspecified() {
		host = "127.0.0.1"
	}
	return host, port
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// StopLocal kills process started by EnsureLocalRunning (if any).
func StopLocal() {
	procMu.Lock()
	defer procMu.Unlock()
	if localCmd != nil && localCmd.Process != nil {
		_ = localCmd.Process.Kill()
		localCmd = nil
	}
}
