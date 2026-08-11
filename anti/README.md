# ANTI — Chromium fingerprint browser (cross-platform) <!-- test comment edit -->

Go CLI + Electron integration that launches an isolated Chromium profile with a
seed-derived fingerprint persona, driven by the C++ patched fingerprint-chromium
engine (`--fingerprint-*` switches) + JS fp-inject reinforcement.

## Install the engine (Linux)

The patched C++ engine ships for Linux too (same 148.0.7778.215 release family
as the Windows build). Install it once:

```bash
cd anti
./fetch-engine-linux.sh        # downloads + verifies sha256 + installs engine/chromium/
FORCE=1 ./fetch-engine-linux.sh # reinstall
```

macOS: download `…_macos.dmg` from the same release
(https://github.com/adryfish/fingerprint-chromium/releases) and place the app
binary under `engine/chromium/chrome`.

## Build (Linux, produces both binaries)

```bash
cd anti
./build.sh            # → bin/anti (linux/amd64) + bin/anti.exe (windows/amd64)
BUILD_MAC=1 ./build.sh # also bin/anti-darwin
```

Requires Go ≥ 1.26. No cgo needed (`CGO_ENABLED=0`).

## Engine resolution (launch order)

1. `ANTI_CHROME` env var (explicit)
2. `engine/CHROME_DIR.txt` (path to engine dir)
3. `engine/chromium/<bin>` / `engine/<bin>`  (Windows: `chrome.exe`, else `chrome`)
4. **System browser fallback** (Linux/macOS, when no engine installed):
   - `chromium`, `chromium-browser`, `chrome` (unbranded — extensions work)
   - `google-chrome-stable`, `google-chrome`, `brave-browser` (branded, last resort)
   - any executable dropped in `engine/` or `engine/chromium/`

> Fallback notes: branded Google Chrome ≥137 silently ignores `--load-extension`
> (workaround removed in 142), so fallback prefers unbranded Chromium. Stock
> Chromium also ignores the `--fingerprint-*` C++ switches, so the fallback only
> gets JS-level spoofing from `fp-inject`. Install the engine for full C++ spoofing.

## Fingerprint coverage — verified end-to-end (Linux engine)

Profile `-platform linux -tz Europe/Moscow -lang ru-RU`, headless, CDP eval:

| signal             | value                          | how                                        |
|--------------------|--------------------------------|--------------------------------------------|
| UA                 | `Chrome/148.0.0.0` (no HeadlessChrome) | C++ patch 010 (headless)          |
| cores              | persona (16)                   | `--fingerprint-hardware-concurrency` (C++) |
| deviceMemory       | 8                              | engine patch 005 (native)                  |
| screen/DPR         | 1920x1080 @ 1.25               | C++: `--ozone-override-screen-size=<physWxphysH>` + `--force-device-scale-factor` (Linux headless; the Unix build ignores `--fingerprint-screen-*`, so the launcher converts CSS*dpr → physical) |
| navigator.language | ru-RU                          | `--lang` + fp-inject                       |
| Intl timezone      | Europe/Moscow                  | `TZ=<profile tz>` env (launcher)           |
| webdriver          | false                          | hardening flags + fp-inject                |
| WebGL/GPU          | SwiftShader/ANGLE              | engine GPU patch (headless)                |
| extensions         | fp-inject + captcha-helper     | `--load-extension` (ungoogled build)       |

## CLI

```bash
bin/anti create <name> -platform linux -tz <IANA> -lang <code> [-proxy …]
bin/anti list | show <name> | args <name> | engine | patches
bin/anti launch <name> [-headless|-visible] [-debug-port N]
bin/anti bridge-run -proxy <url> -ready-file <path>   # detached auth proxy
```

Env overrides: `ANTI_ROOT`, `ANTI_CHROME`, `ANTI_HEADLESS`, `ANTI_CDP`,
`ANTI_DEBUG_PORT`, `ANTI_NO_INJECT`, `ANTI_NO_CAPTCHA`, `ANTI_PROXY_PING`.

## Platform notes

- **Windows**: engine `engine/chromium/chrome.exe` (fingerprint-chromium
  148.0.7778.215 x64). Detached children use
  `DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP`.
- **Linux/macOS**: engine `engine/chromium/chrome`; detached children use
  `setsid` (see `internal/procattr`). Electron tracks live Chrome via PowerShell
  on Windows and `/proc/<pid>/cmdline` scan on Linux/macOS
  (`electron/tools/antiSession.cjs`).
