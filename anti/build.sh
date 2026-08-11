#!/usr/bin/env bash
# Build ANTI for Linux + Windows into anti/bin/ (also macOS if BUILD_MAC=1).
#   ./build.sh            → bin/anti (linux/amd64) + bin/anti.exe (windows/amd64)
#   BUILD_MAC=1 ./build.sh → also bin/anti-darwin
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p bin
FLAGS="-trimpath -ldflags \"-s -w\""

echo "==> linux/amd64  → bin/anti"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o bin/anti ./cmd/anti

echo "==> windows/amd64 → bin/anti.exe"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o bin/anti.exe ./cmd/anti

if [ "${BUILD_MAC:-0}" = "1" ]; then
  echo "==> darwin/amd64 → bin/anti-darwin"
  CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o bin/anti-darwin ./cmd/anti
fi

echo "==> done"
ls -la bin
