// Package procattr provides OS-specific syscall.SysProcAttr helpers for
// launching detached child processes (Chrome, bridge-run, local solver).
//
// Windows: DETACHED_PROCESS / CREATE_NEW_PROCESS_GROUP / CREATE_NO_WINDOW.
// Unix (Linux/macOS): Setsid (new session) — child outlives the parent CLI.
package procattr
