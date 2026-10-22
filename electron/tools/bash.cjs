const { execFile } = require("child_process");
const path = require("path");
const backgroundTasks = require("../backgroundTasks.cjs");

const MAX_OUTPUT_CHARS = 20000;
const DEFAULT_TIMEOUT_MS = 300_000;

/** Live shell children — killed on Stop so hung processes cannot outlive the turn. */
const liveChildren = new Set();

/** True when running inside the app on Windows. */
const IS_WIN = process.platform === "win32";

/**
 * Windows-only dangerous-command blacklist (app runs PowerShell on Windows).
 * Blocks destructive / privilege / disk / system-wipe patterns BEFORE PowerShell spawn.
 * Safe project work is allowed: npm, git, node, builds, tests, and file/folder deletes
 * (Remove-Item, del, rmdir, GCI|Remove-Item) inside the project — only system/drive-root
 * wipes stay blocked.
 *
 * Matching is case-insensitive on a normalized command string (smart quotes stripped,
 * multi-space collapsed). Patterns intentionally allow optional path prefixes
 * (C:\Windows\System32\cmd.exe /c …) and PowerShell aliases.
 */
const BLOCKED_PATTERNS = [
  // ── Disk / volume wipe ──────────────────────────────────────────────
  // Only block real disk FORMAT as a command (format C: / format /FS:NTFS).
  // NEVER match: -Pattern "format|…", ?format=json, Format-Table, Select-String … format …
  // Require command-position: start of command or after ; | &
  {
    id: "format",
    // Command-position only. Drive letter: "C:" / "C:\" — no \b after ":" (fails at EOL).
    re: /(?:^|[;&|\n]\s*)format(?:\.exe)?\s+(?:\/(?:fs|v|q|x|c|y|u|a|t|p)\b|[a-z]:(?:\s|\\|\/|"|'|$))/i,
    why: "format wipes drives",
  },
  { id: "diskpart", re: /\bdiskpart(?:\.exe)?\b/i, why: "diskpart can erase partitions" },
  { id: "diskpart-script", re: /\b(?:clean\s+all|delete\s+(?:partition|volume|disk))\b/i, why: "disk wipe script" },
  { id: "cipher-wipe", re: /\bcipher(?:\.exe)?\b[\s\S]*\/w/i, why: "cipher /w securely wipes free space" },
  { id: "manage-bde", re: /\bmanage-bde(?:\.exe)?\b/i, why: "BitLocker manage-bde can lock/wipe volumes" },
  { id: "vssadmin-delete", re: /\bvssadmin(?:\.exe)?\b[\s\S]*\bdelete\b/i, why: "deletes shadow copies (ransom recovery kill)" },
  { id: "wbadmin-delete", re: /\bwbadmin(?:\.exe)?\b[\s\S]*\bdelete\b/i, why: "deletes Windows backups" },
  { id: "bcdedit-destructive", re: /\bbcdedit(?:\.exe)?\b[\s\S]*\b(?:delete|import|export|set)\b/i, why: "bcdedit can brick boot" },
  { id: "bootrec", re: /\bbootrec(?:\.exe)?\b/i, why: "bootrec rewrites boot records" },
  { id: "bootsect", re: /\bbootsect(?:\.exe)?\b/i, why: "bootsect rewrites boot sector" },
  { id: "raw-disk-write", re: /\\\\\.\\(?:PhysicalDrive|Harddisk)\d+/i, why: "raw physical disk access" },
  { id: "dd-if-of", re: /\bdd(?:\.exe)?\b[\s\S]*\b(?:if|of)=/i, why: "dd can overwrite disks" },

  // ── Mass recursive delete (system roots / user profile / wide wipe) ─
  { id: "rmdir-system-drive", re: /\b(?:rmdir|rd)(?:\.exe)?\b[\s\S]*\/s\b[\s\S]*(?:[c-z]:\\(?:windows|users|program\s*files|programdata|perflogs)?(?:\\|\s|"|'|$)|%[a-z_]*systemroot%|%windir%|%userprofile%|%homedrive%|%homepath%|%programfiles%|%programdata%)/i, why: "recursive rmdir on system/user roots" },
  { id: "del-system-drive", re: /\bdel(?:\.exe)?\b[\s\S]*\/s\b[\s\S]*(?:[c-z]:\\(?:windows|users|program\s*files|programdata)?|%[a-z_]*systemroot%|%windir%|%userprofile%|%programfiles%)/i, why: "recursive del on system/user roots" },
  { id: "remove-item-force-recurse-root", re: /\b(?:remove-item|ri|rm|rmdir|del)\b[\s\S]*-(?:recurse|r)\b[\s\S]*-(?:force|f)\b[\s\S]*(?:[c-z]:\\?\s*(?:;|$|"|'|})|[c-z]:\\(?:windows|users|program\s*files|programdata)|\$env:(?:systemroot|windir|userprofile|homedrive|programfiles|programdata)|%userprofile%|%systemroot%|%windir%)/i, why: "Remove-Item -Recurse -Force on system/user roots" },
	  // Require real path like C:\ or C:\something — not accidental "b:" inside host:port (gb:8359)
  { id: "takeown-system", re: /\btakeown(?:\.exe)?\b[\s\S]*(?:\/[rf]\b|%[a-z_]*systemroot%|%windir%|[c-z]:\\windows)/i, why: "takeown on system trees" },
  { id: "icacls-reset-system", re: /\bicacls(?:\.exe)?\b[\s\S]*(?:\/reset|\/grant\s+[^\\]*:\(F\))[\s\S]*(?:[c-z]:\\windows|%systemroot%|%windir%|%userprofile%)/i, why: "icacls reset/full grant on system paths" },

  // ── System file / OS destruction ────────────────────────────────────
  { id: "sfc-purge", re: /\bsfc(?:\.exe)?\b[\s\S]*\/(?:purgecache|revertpendingactions)/i, why: "sfc destructive switches" },
  { id: "dism-cleanup-resetbase", re: /\bdism(?:\.exe)?\b[\s\S]*(?:\/cleanup-image|\/startcomponentcleanup)[\s\S]*\/resetbase/i, why: "DISM /ResetBase can break servicing" },
  { id: "delete-system32", re: /(?:del|rmdir|rd|remove-item|ri|rm|erase)\b[\s\S]*(?:system32|syswow64|winsxs|boot\\bcd)/i, why: "delete targeting System32/WinSxS/BCD" },
  { id: "delete-windows-dir", re: /(?:del|rmdir|rd|remove-item|ri|rm)\b[\s\S]*[c-z]:\\windows(?:\\|\s|"|'|$)/i, why: "delete targeting C:\\Windows" },

  // ── Shutdown / reboot / logoff (agent must not reboot host mid-work) ─
  { id: "shutdown", re: /\bshutdown(?:\.exe)?\b/i, why: "shutdown/reboot host" },
  { id: "restart-computer", re: /\brestart-computer\b/i, why: "Restart-Computer" },
  { id: "stop-computer", re: /\bstop-computer\b/i, why: "Stop-Computer" },
  { id: "logoff", re: /\blogoff(?:\.exe)?\b/i, why: "logoff session" },
  { id: "psshutdown", re: /\bpsshutdown(?:\.exe)?\b/i, why: "Sysinternals psshutdown" },

  // ── Process kill of critical system / self ──────────────────────────
  { id: "taskkill-csrss", re: /\btaskkill(?:\.exe)?\b[\s\S]*\b(?:csrss|wininit|winlogon|lsass|services|smss|System)\b/i, why: "taskkill critical system process" },
  { id: "stop-process-critical", re: /\b(?:stop-process|kill|spps)\b[\s\S]*\b(?:csrss|wininit|winlogon|lsass|services|smss)\b/i, why: "Stop-Process critical system process" },
  { id: "taskkill-tree-all", re: /\btaskkill(?:\.exe)?\b[\s\S]*\/f\b[\s\S]*\/im\b[\s\S]*\*/i, why: "taskkill /F /IM * mass kill" },

  // ── Firewall / network stack tear-down ──────────────────────────────
  { id: "netsh-firewall-reset", re: /\bnetsh(?:\.exe)?\b[\s\S]*(?:advfirewall|firewall|winsock|int\s+ip)[\s\S]*(?:reset|delete\s+all)/i, why: "netsh firewall/winsock reset" },
  { id: "netsh-interface-delete", re: /\bnetsh(?:\.exe)?\b[\s\S]*interface[\s\S]*delete/i, why: "netsh interface delete" },
  { id: "disable-netadapter", re: /\bdisable-netadapter\b/i, why: "Disable-NetAdapter kills network" },
  // ── Registry destroy ────────────────────────────────────────────────
  { id: "reg-delete-hk", re: /\breg(?:\.exe)?\b\s+delete\b[\s\S]*\b(?:HKLM|HKCU|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKCR|HKU)\\/i, why: "reg delete hive/key" },
  { id: "remove-item-registry", re: /\b(?:remove-item|ri|rd)\b[\s\S]*HK(?:LM|CU|CR|U):\\/i, why: "Remove-Item registry provider" },
  { id: "reg-import-nuke", re: /\breg(?:\.exe)?\b\s+(?:import|restore|load)\b/i, why: "reg import/restore/load can overwrite hives" },
  { id: "regedit-silent", re: /\bregedit(?:\.exe)?\b[\s\S]*\/s\b/i, why: "silent regedit import" },

  // ── Service / scheduled task sabotage ───────────────────────────────
  { id: "sc-delete", re: /(?:^|[;&|\n]\s*)sc(?:\.exe)?\s+delete\b/i, why: "sc delete service" },
  {
    id: "sc-stop-critical",
    re: /(?:^|[;&|\n]\s*)sc(?:\.exe)?\s+stop\s+(?:windefend|wuauserv|bits|eventlog|rpcss|lanmanserver|lanmanworkstation|mpssvc)\b/i,
    why: "sc stop critical service",
  },
  {
    id: "stop-service-critical",
    re: /(?:^|[;&|\n]\s*)(?:stop-service|spsv)\b(?:\s+-\w+\b)*\s+(?:-name\s+)?['"]?(?:windefend|wuauserv|bits|eventlog|mpssvc|defender|wdnisvc|sense)\b/i,
    why: "Stop-Service critical",
  },
  { id: "remove-service", re: /(?:^|[;&|\n]\s*)remove-service\b/i, why: "Remove-Service" },
  { id: "schtasks-delete-all", re: /\bschtasks(?:\.exe)?\b[\s\S]*\/delete\b[\s\S]*\/tn\b[\s\S]*\*/i, why: "schtasks /Delete /TN *" },
  { id: "unregister-scheduledtask", re: /\bunregister-scheduledtask\b/i, why: "Unregister-ScheduledTask" },

  // ── User / local security destroy ───────────────────────────────────
  { id: "net-user-delete", re: /(?:^|[;&|\n]\s*)net(?:\.exe)?\s+user\b[\s\S]{0,120}\/delete\b/i, why: "net user /delete" },
  {
    id: "net-localgroup-admins",
    re: /(?:^|[;&|\n]\s*)net(?:\.exe)?\s+localgroup\s+administrators\b[\s\S]{0,80}\/(?:add|delete)\b/i,
    why: "net localgroup Administrators mutate",
  },
  { id: "remove-localuser", re: /\bremove-localuser\b/i, why: "Remove-LocalUser" },
  { id: "remove-localgroupmember-admins", re: /\bremove-localgroupmember\b[\s\S]{0,80}administrators/i, why: "Remove-LocalGroupMember Administrators" },
  { id: "disable-localuser", re: /\bdisable-localuser\b/i, why: "Disable-LocalUser" },
  { id: "net-accounts-lockout", re: /(?:^|[;&|\n]\s*)net(?:\.exe)?\s+accounts\b[\s\S]{0,80}\/lockoutthreshold:0/i, why: "disable account lockout" },

  // ── Defender / security disable ─────────────────────────────────────
  {
    id: "set-mppreference-disable",
    re: /\bset-mppreference\b[\s\S]{0,200}-(?:disablerealtimemonitoring|disableioavprotection|disablebehavior|exclusionpath)\s+\$?true\b/i,
    why: "Set-MpPreference disables Defender",
  },
  { id: "mpcmdrun-remove", re: /\bmpcmdrun(?:\.exe)?\b[\s\S]{0,120}-removedefinitions\b/i, why: "MpCmdRun remove definitions" },
  {
    id: "defender-service-kill",
    re: /(?:^|[;&|\n]\s*)(?:sc(?:\.exe)?|net(?:\.exe)?)\s+(?:stop|config)\s+(?:windefend|wdnisvc|sense)\b/i,
    why: "stop/config Windows Defender service",
  },

  // ── Ransomware-style shadow + recovery kill ─────────────────────────
  { id: "wmic-shadowcopy-delete", re: /\bwmic(?:\.exe)?\b[\s\S]*shadowcopy[\s\S]*delete/i, why: "wmic shadowcopy delete" },
  { id: "get-wmiobject-shadow-delete", re: /\b(?:get-wmiobject|gwmi|get-ciminstance)\b[\s\S]*win32_shadowcopy[\s\S]*\.(?:delete|remove)/i, why: "WMI shadowcopy delete" },
  { id: "reagentc-disable", re: /\breagentc(?:\.exe)?\b[\s\S]*\/disable/i, why: "reagentc /disable recovery" },
  { id: "recoverydrive", re: /\brecoverydrive(?:\.exe)?\b/i, why: "RecoveryDrive can wipe recovery" },

  // ── Firmware / boot security ────────────────────────────────────────
  { id: "mountvol-d", re: /\bmountvol(?:\.exe)?\b[\s\S]*\/d\b/i, why: "mountvol /d unmounts volumes" },
  { id: "mountvol-remove", re: /\bmountvol(?:\.exe)?\b[\s\S]*\/r\b/i, why: "mountvol /r removes volume mount points" },
  { id: "efibootmgr", re: /\befibootmgr\b/i, why: "efibootmgr changes firmware boot" },

  // ── Remote code from untrusted download (living-off-the-land) ───────
  { id: "iex-downloadstring", re: /\b(?:iex|invoke-expression)\b[\s\S]*(?:downloadstring|downloadfile|iwr|invoke-webrequest|wget|curl)\b/i, why: "IEX + download (remote code exec)" },
  { id: "downloadstring-iex", re: /\.(?:downloadstring|downloadfile)\s*\([\s\S]*\)[\s\S]*(?:iex|invoke-expression)/i, why: "DownloadString | IEX" },
  { id: "bitsadmin-transfer-exec", re: /\bbitsadmin(?:\.exe)?\b[\s\S]*\/transfer\b[\s\S]*&&/i, why: "bitsadmin transfer then execute" },
  { id: "certutil-decode-exec", re: /\bcertutil(?:\.exe)?\b[\s\S]*-decode\b/i, why: "certutil -decode often drops malware" },
  { id: "mshta-remote", re: /\bmshta(?:\.exe)?\b[\s\S]*https?:\/\//i, why: "mshta remote script" },
  { id: "rundll32-javascript", re: /\brundll32(?:\.exe)?\b[\s\S]*(?:javascript:|vbscript:)/i, why: "rundll32 script moniker" },
  { id: "regsvr32-s-u-i", re: /\bregsvr32(?:\.exe)?\b[\s\S]*\/[siu]+\b[\s\S]*https?:\/\//i, why: "regsvr32 remote scrobj" },
  { id: "wmic-process-call-create", re: /\bwmic(?:\.exe)?\b[\s\S]*process[\s\S]*call\s+create/i, why: "wmic process call create" },
  { id: "powershell-enc", re: /\b(?:powershell|pwsh)(?:\.exe)?\b[\s\S]*-(?:enc|encodedcommand)\b/i, why: "encoded PowerShell (obfuscation)" },
  { id: "powershell-nop-hidden-enc", re: /\b-(?:nop|noprofile)\b[\s\S]*-(?:w|windowstyle)\s*(?:h|hidden)\b[\s\S]*-(?:enc|e|encodedcommand)\b/i, why: "hidden encoded PowerShell" },
  { id: "frombase64-iex", re: /\bfrombase64string\b[\s\S]*(?:iex|invoke-expression)/i, why: "Base64 decode → IEX" },

  // ── Credential dump / SAM ───────────────────────────────────────────
  { id: "reg-save-sam", re: /\breg(?:\.exe)?\b\s+save\b[\s\S]*\b(?:sam|security|system)\b/i, why: "reg save SAM/SECURITY/SYSTEM" },
  { id: "ntdsutil", re: /\bntdsutil(?:\.exe)?\b/i, why: "ntdsutil AD database" },
  { id: "procdump-lsass", re: /\bprocdump(?:\.exe)?\b[\s\S]*lsass/i, why: "procdump lsass" },
  { id: "comsvcs-minidump", re: /\brundll32(?:\.exe)?\b[\s\S]*comsvcs\.dll[\s\S]*minidump/i, why: "comsvcs MiniDump (lsass dump)" },
  { id: "mimikatz", re: /\bmimikatz\b/i, why: "mimikatz" },
  { id: "sekurlsa", re: /\bsekurlsa::/i, why: "mimikatz sekurlsa" },

  // ── Persistence / autorun inject ────────────────────────────────────
  { id: "reg-run-key", re: /\breg(?:\.exe)?\b\s+add\b[\s\S]*\\(?:currentversion\\run|currentversion\\runonce)\b/i, why: "reg add Run/RunOnce persistence" },
  { id: "new-item-run-key", re: /\bnew-itemproperty\b[\s\S]*\\(?:currentversion\\run)/i, why: "New-ItemProperty Run key" },
  { id: "schtasks-create-onlogon", re: /\bschtasks(?:\.exe)?\b[\s\S]*\/create\b[\s\S]*\/sc\s+onlogon/i, why: "schtasks ONLOGON persistence" },
  { id: "new-service", re: /\bnew-service\b/i, why: "New-Service persistence" },
  { id: "sc-create", re: /\bsc(?:\.exe)?\b\s+create\b/i, why: "sc create service" },

  // ── Hosts / DNS hijack ──────────────────────────────────────────────
  // Only block writes to hosts (reads/diagnostics allowed).
  { id: "hosts-file-write", re: /(?:add-content|set-content|out-file|\becho\b|>>|[^-=]>\s*)[\s\S]*\\drivers\\etc\\hosts\b/i, why: "write Windows hosts file" },
  { id: "hosts-set-content", re: /\\drivers\\etc\\hosts\b[\s\S]*(?:set-content|add-content|out-file|clear-content|\|)/i, why: "pipe/write Windows hosts file" },

  // ── Mass wipe of drive roots only (project file/folder deletes are ALLOWED) ──
  // Agents must be able to: Remove-Item, del, rmdir, GCI|Remove-Item inside a project.
  // Still block recursive wipe of entire drive roots (C:\, D:\, …) via cmd.
  { id: "cmd-rd-s-q-root", re: /\bcmd(?:\.exe)?\b[\s\S]*\/c\b[\s\S]*(?:rd|rmdir)\b[\s\S]*\/s\b[\s\S]*\/q\b[\s\S]*[c-z]:\\?(?:\s|"|'|$)/i, why: "cmd /c rd /s /q C:\\ (drive root wipe)" },
  // del /s /q *.* only when clearly aimed at a drive root (C:\*.* or C:\…)
  { id: "cmd-del-s-q-drive-root", re: /\b(?:del|erase)(?:\.exe)?\b[\s\S]*\/[sfq]+\b[\s\S]*[c-z]:\\(?:\*\.\*|\s*$)/i, why: "del /s /q on drive root" },
  // for %x in (C:\*) do rd — classic mass wipe; allow for loops on relative paths
  { id: "for-rd-loop-drive", re: /\bfor\s+%[a-z]\s+in\s*\(\s*[c-z]:\\/i, why: "for-loop over drive root (mass delete)" },

  // ── Appx / feature remove (OS cripple) ──────────────────────────────
  { id: "remove-windowsfeature", re: /\b(?:remove-windowsfeature|uninstall-windowsfeature)\b/i, why: "Uninstall-WindowsFeature" },
  { id: "disable-windowsoptionalfeature", re: /\bdisable-windowsoptionalfeature\b[\s\S]*-online\b/i, why: "Disable-WindowsOptionalFeature -Online" },
  { id: "remove-appxprovisionedpackage", re: /\bremove-appxprovisionedpackage\b/i, why: "Remove-AppxProvisionedPackage" },

  // ── Clear event logs (anti-forensics) ────────────────────────────────
  { id: "wevtutil-cl", re: /\bwevtutil(?:\.exe)?\b\s+cl\b/i, why: "wevtutil cl (clear event log)" },
  { id: "clear-eventlog", re: /\bclear-eventlog\b/i, why: "Clear-EventLog" },
  { id: "remove-eventlog", re: /\bremove-eventlog\b/i, why: "Remove-EventLog" },

  // ── Hyper-V / virtual disk destroy ──────────────────────────────────
  { id: "remove-vm", re: /\bremove-vm\b/i, why: "Remove-VM" },
  { id: "remove-vhd", re: /\bremove-vhd\b/i, why: "Remove-VHD" },
  { id: "dismount-vhd-delete", re: /\bdismount-vhd\b[\s\S]*-delete/i, why: "Dismount-VHD -Delete" },
];

/**
 * Linux-only dangerous-command blacklist (app runs plain bash on Linux).
 * Mirrors the Windows intent: block catastrophic host-destroying / disk-wiping
 * commands BEFORE the bash process is spawned, while ALL normal Linux bash work
 * stays allowed: ls, cat, grep, sed, curl, npm, git, node, python, builds,
 * tests, and ordinary rm/mkdir/touch inside the project tree.
 */
const LINUX_BLOCKED_PATTERNS = [
  // ── Root filesystem wipe (rm -rf / or /* ) ──────────────────────────
  {
    id: "rm-root-fs",
    re: /\brm\b[\s\S]*-(?:rf|fr|r|f|R)\b[\s\S]*(?:--no-preserve-root|\/\*|(?:\s|\/)+\/\s*(?:$|;|\||&|>)|^\s*\/\s*$)/i,
    why: "rm -rf on root filesystem",
  },
  {
    id: "rm-home-root",
    re: /\brm\b[\s\S]*-(?:rf|fr|r|f|R)\b[\s\S]*(\$HOME|\$home|\/home\/[^\/\s]+\/?(?=$|;|\||&|>|\s)|~\/?)(?:\s|$|;|\||&|>)/i,
    why: "rm -rf on home directory",
  },
  {
    id: "rm-dot-recursive",
    re: /\brm\b[\s\S]*-(?:rf|fr|R|r)\b[\s\S]*(?:\s|\.\.?|$)[\s\S]*[.][.]?\/?\s*$|^\s*rm\s+-(?:rf|fr)\s+(?:\.\s*$|\.\/\s*$|\/\s*$)/i,
    why: "rm -rf . or ./ (recursive self-wipe)",
  },

  // ── Disk format / raw block device write ────────────────────────────
  {
    id: "mkfs-device",
    re: /\bmkfs(?:\.\w+)?\b[\s\S]*\/dev\/(?:sd|nvme|vd|hd|mmcblk|xvd|loop)[a-z0-9]+/i,
    why: "mkfs formats a disk/partition",
  },
  {
    id: "dd-block-device",
    re: /\bdd\b[\s\S]*\bof=\/dev\/(?:sd|nvme|vd|hd|mmcblk|xvd|loop|zero)[a-z0-9]*/i,
    why: "dd writing raw to a block device",
  },
  {
    id: "wipefs-device",
    re: /\bwipefs\b[\s\S]*\/dev\/(?:sd|nvme|vd|hd|mmcblk|xvd)[a-z0-9]*/i,
    why: "wipefs erases filesystem signatures",
  },
  {
    id: "fdisk-write",
    re: /\b(?:fdisk|sfdisk|parted)\b[\s\S]*\/dev\/(?:sd|nvme|vd|hd|mmcblk|xvd)[a-z0-9]*(?:\s|$|;|\||&)[\s\S]*\b(?:w|write|mkpart|rm)\b/i,
    why: "fdisk/sfdisk/parted destructive write",
  },

  // ── Host shutdown / reboot ──────────────────────────────────────────
  { id: "shutdown", re: /(?:^|[;&|\n]\s*)(?:shutdown|halt|poweroff)\b/i, why: "shutdown/reboot host" },
  { id: "reboot", re: /(?:^|[;&|\n]\s*)reboot\b/i, why: "reboot host" },
  { id: "init-power", re: /(?:^|[;&|\n]\s*)init\s+[06]\b/i, why: "init 0/6 powers off/reboots host" },
  {
    id: "systemctl-power",
    re: /\bsystemctl\b[\s\S]*(?:poweroff|reboot|halt|suspend|hibernate|emergency)\b/i,
    why: "systemctl power-state change",
  },
  { id: "efibootmgr", re: /\befibootmgr\b/i, why: "efibootmgr changes firmware boot" },
];

function normalizeCommandForCheck(command) {
  return String(command || "")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u00A0/g, " ")
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns { blocked:true, id, why, matched } or { blocked:false }.
 * Exported for unit tests via module.exports.checkCommandBlacklist.
 */
function checkCommandBlacklist(command) {
  const normalized = normalizeCommandForCheck(command);
  if (!normalized) return { blocked: false };

  for (const rule of BLOCKED_PATTERNS) {
    if (!rule || !rule.re || !rule.why) continue; // skip placeholders
    if (rule.re.test(normalized)) {
      return {
        blocked: true,
        id: rule.id,
        why: rule.why,
        matched: rule.re.toString(),
      };
    }
  }
  return { blocked: false };
}

/**
 * Linux analog of checkCommandBlacklist — only used on non-Windows platforms.
 * Exported for unit tests via module.exports.checkLinuxCommandBlacklist.
 */
function checkLinuxCommandBlacklist(command) {
  const normalized = normalizeCommandForCheck(command);
  if (!normalized) return { blocked: false };

  for (const rule of LINUX_BLOCKED_PATTERNS) {
    if (!rule || !rule.re || !rule.why) continue; // skip placeholders
    if (rule.re.test(normalized)) {
      return {
        blocked: true,
        id: rule.id,
        why: rule.why,
        matched: rule.re.toString(),
      };
    }
  }
  return { blocked: false };
}

function buildBlacklistError(hit, command) {
  const preview = String(command || "").replace(/\s+/g, " ").slice(0, 160);
  return new Error(
    `BLOCKED by bash blacklist (${hit.id}): ${hit.why}. ` +
      `Command was NOT executed. Preview: "${preview}${String(command || "").length > 160 ? "…" : ""}". ` +
      `Use safer project-scoped tools (read_file/edit_file/grep) or a narrower non-destructive command. ` +
      `Mass wipe, disk format, and host reboot are never allowed.`
  );
}

function truncate(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... (truncated, ${text.length} chars total)`;
}

function resolveTimeoutMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.floor(n);
}

function killChildTree(child) {
  if (!child || child.killed) return false;
  const pid = child.pid;
  try {
    if (process.platform === "win32" && pid) {
      const { spawnSync } = require("child_process");
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      child.kill("SIGTERM");
      try {
        child.kill("SIGKILL");
      } catch {
        /* */
      }
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* */
    }
  }
  return true;
}

function disposeAll() {
  let n = 0;
  for (const child of [...liveChildren]) {
    if (killChildTree(child)) n += 1;
    liveChildren.delete(child);
  }
  return { killed: n };
}

module.exports = {
  name: "bash",
  description:
    "Execute a shell command in the given working directory and return stdout/stderr. " +
    "On Linux (Kali, Ubuntu, etc.) this runs PLAIN bash (/bin/bash -c) and behaves EXACTLY like a normal " +
    "Linux terminal: use ls, cat, grep, sed, awk, curl, wget, npm, git, node, python3, apt, systemctl, and " +
    "standard pipes/redirects exactly as you would in any Linux shell. " +
    "On Windows it runs PowerShell. " +
    "A dangerous-command blacklist runs BEFORE spawn on both platforms (disk format/wipe, root-filesystem " +
    "recursive delete, registry destroy, host reboot/shutdown, and similar OS-destructive ops are blocked " +
    "with an error — the command never runs). " +
    "Safe project work is allowed: npm, git, node, builds, tests, diagnostics, and normal file operations. " +
    "Use for real shell work only — do NOT use bash to read project source/config " +
    "(no cat, Get-Content, ReadAllLines, type, sed -n, or line-range dumps) — use read_file and grep instead. " +
    "Set timeout_ms yourself for long jobs (builds, installs, long tests); default 300000 (300s) when omitted. No hard ceiling.",
  isReadOnly: false,
  disposeAll,
  checkCommandBlacklist,
  checkLinuxCommandBlacklist,
  BLOCKED_PATTERNS,
  LINUX_BLOCKED_PATTERNS,
  resolveTimeoutMs,
  DEFAULT_TIMEOUT_MS,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      cwd: { type: "string", description: "Working directory for the command" },
      timeout_ms: {
        type: "number",
        description:
          "Timeout in milliseconds. Agent should set this for long-running commands. Default 300000 (300s) when omitted. No hard max cap.",
      },
      background: {
        type: "boolean",
        description:
          "If true, launch the command as a detached background process and return immediately without waiting for it to finish. Use for long-running servers/daemons (npm run dev, a local server, etc.) that should keep running while the agent continues. The process keeps running after this turn and after the app closes; it is shown as a per-chat badge in the composer with a stop button.",
      },
    },
    required: ["command"],
  },
  async execute(input, context) {
    const command = String(input.command || "");
    const cwd = input.cwd || context?.rootPath || process.cwd();
    const timeout = resolveTimeoutMs(input.timeout_ms);
    const signal = context?.signal;

    if (signal?.aborted) {
      throw Object.assign(new Error("Stopped by user"), { name: "AbortError" });
    }

    // Hard block destructive commands before any shell process is spawned.
    // Windows → PowerShell blacklist; Linux/macOS → plain-bash blacklist.
    const blacklistHit = IS_WIN
      ? checkCommandBlacklist(command)
      : checkLinuxCommandBlacklist(command);
    if (blacklistHit.blocked) {
      throw buildBlacklistError(blacklistHit, command);
    }

    const execOpts = { cwd, timeout, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" };

    return new Promise((resolve, reject) => {
      let child;

      const onDone = (error, stdout, stderr) => {
        liveChildren.delete(child);
        if (signal) {
          try {
            signal.removeEventListener("abort", onAbort);
          } catch {
            /* */
          }
        }
        if (error && (error.killed || signal?.aborted)) {
          reject(
            Object.assign(
              new Error(signal?.aborted ? "Stopped by user" : `Command timed out after ${timeout}ms`),
              { name: signal?.aborted ? "AbortError" : "TimeoutError" }
            )
          );
          return;
        }

        resolve({
          command,
          cwd,
          exitCode: error ? error.code ?? 1 : 0,
          stdout: truncate(stdout || ""),
          stderr: truncate(stderr || ""),
        });
      };

      if (IS_WIN) {
        // PowerShell writes console output in the system codepage (e.g. cp866 on
        // Russian Windows), not UTF-8. Force UTF-8 so Cyrillic etc. is not mojibake.
        const encodedCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
        child = execFile(
          "powershell.exe",
          ["-NoLogo", "-NonInteractive", "-Command", encodedCommand],
          execOpts,
          onDone
        );
      } else {
        // Plain Linux bash — behaves exactly like a normal terminal.
        child = execFile("/bin/bash", ["-c", command], execOpts, onDone);
      }
      liveChildren.add(child);

      const onAbort = () => {
        killChildTree(child);
        liveChildren.delete(child);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  },
};
