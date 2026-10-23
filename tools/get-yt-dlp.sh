#!/usr/bin/env bash
# Downloads the standalone yt-dlp build the TV Hub uses to resolve links from other video sites.
# (Homebrew didn't support this macOS version at the time, so the official binary is used.)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/hub/bin"
case "$(uname -s)" in
    Darwin) ASSET=yt-dlp_macos ;;
    Linux)  ASSET=yt-dlp_linux ;;
    *)      ASSET=yt-dlp ;;
esac
curl -L --fail -o "$ROOT/hub/bin/yt-dlp" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$ASSET"
chmod +x "$ROOT/hub/bin/yt-dlp"
"$ROOT/hub/bin/yt-dlp" --version
