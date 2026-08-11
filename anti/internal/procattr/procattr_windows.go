//go:build windows

package procattr

import "syscall"

// Detached returns SysProcAttr that detaches the child from this console/process
// (DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP) so it survives parent exit.
// Used for Chrome and anti bridge-run on Windows.
func Detached() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200}
}

// NoConsole returns SysProcAttr that hides the child console window
// (CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP). Used for python helpers.
func NoConsole() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000 | 0x00000200,
	}
}
