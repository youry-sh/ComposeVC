//go:build !windows

package procattr

import "syscall"

// Detached runs the child in a new session (setsid) so it outlives the
// parent CLI process — same contract as DETACHED_PROCESS on Windows.
func Detached() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

// NoConsole is a no-op on unix — there is no console window concept.
func NoConsole() *syscall.SysProcAttr { return nil }
