#!/usr/bin/env bash
# Download + install the Linux fingerprint-chromium engine (C++ patched build)
# into anti/engine/chromium/. Same 148.0.7778.215 release family as the Windows
# engine shipped with the app.
#
#   ./fetch-engine-linux.sh            # download (if missing) + install
#   FORCE=1 ./fetch-engine-linux.sh    # re-download + reinstall
set -euo pipefail
cd "$(dirname "$0")"

VER="148.0.7778.215"
BASE="https://github.com/adryfish/fingerprint-chromium/releases/download/${VER}"
FILE="ungoogled-chromium-${VER}-1-x86_64_linux.tar.xz"
URL="${BASE}/${FILE}"
SHA256="70d239830332e5820aa34dfcb284161cac0429eee25da642830afe04bda717f4"
DEST="engine/chromium"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> fingerprint-chromium Linux engine ${VER}"
echo "    url:  ${URL}"
echo "    dest: ${DEST}"

if [ -x "${DEST}/chrome" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "    engine already installed: ${DEST}/chrome ($("${DEST}/chrome" --version 2>/dev/null | head -1))"
  echo "    re-run with FORCE=1 to reinstall."
  exit 0
fi

if [ ! -f "/tmp/${FILE}" ]; then
  echo "==> downloading ${FILE} (~141 MB)…"
  curl -fL --retry 3 -o "/tmp/${FILE}" "${URL}"
else
  echo "==> using cached /tmp/${FILE}"
fi

echo "==> verifying sha256…"
echo "${SHA256}  /tmp/${FILE}" | sha256sum -c -

echo "==> installing into ${DEST}/…"
mkdir -p engine
rm -rf "${DEST}"
tar -xJf "/tmp/${FILE}" -C engine/
mv "engine/ungoogled-chromium-${VER}-1-x86_64_linux" "${DEST}"
chmod +x "${DEST}/chrome" "${DEST}/chrome-wrapper" "${DEST}/chromedriver" 2>/dev/null || true

echo "==> done"
"${DEST}/chrome" --version
echo
echo "Next: ../anti/bin/anti engine   (should print ${DEST}/chrome)"
echo "      ../anti/bin/anti create <name> -platform linux … && ../anti/bin/anti launch <name>"
