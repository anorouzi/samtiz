#!/usr/bin/env bash
# Builds, signs and installs Pardeh on the TV, then launches it.
#
#   TV_IP=172.19.85.144 tools/deploy.sh
#
# Environment (all optional):
#   TV_IP           TV address on the local network
#   HUB             TV Hub URL, used to close the running app before installing
#   PROFILE         Tizen signing profile created with the Samsung certificate (see docs/REPORT.md)
#   DEVICE_PROFILE  device-profile.xml from Certificate Manager ("permit to install")
#   TIZEN_STUDIO    Tizen Studio install folder
set -euo pipefail

TV_IP="${TV_IP:-172.19.85.144}"
HUB="${HUB:-http://localhost:8090}"
PROFILE="${PROFILE:-TVPlayer}"
DEVICE_PROFILE="${DEVICE_PROFILE:-$HOME/SamsungCertificate/TVPlayer/device-profile.xml}"
TIZEN="${TIZEN_STUDIO:-$HOME/tizen-studio}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDB="$TIZEN/tools/sdb"
CLI="$TIZEN/tools/ide/bin/tizen"
DEV="$TV_IP:26101"
PKG="TvPlayr001"
APP_ID="$PKG.TVPlayer"
OUT="$ROOT/build"

echo "› Packaging and signing with profile '$PROFILE'"
mkdir -p "$OUT"
rm -f "$OUT"/*.wgt
"$CLI" package -t wgt -s "$PROFILE" -o "$OUT" -- "$ROOT/app" | grep -E "Location|rror" || true
WGT="$(ls "$OUT"/*.wgt | head -1)"

echo "› Connecting to the TV ($DEV)"
"$SDB" connect "$DEV" | tail -1

# Installing over a running app can fail with error 118 and leave it frozen until the TV is
# fully restarted, so close it first (the hub's virtual remote presses Back until it exits).
running() { curl -s -m 5 "http://$TV_IP:8001/api/v2/applications/$APP_ID" | grep -qE '"running": *true'; }
if running; then
    echo "› Closing the running app"
    for _ in 1 2 3 4 5 6; do
        curl -s -X POST -H 'Content-Type: application/json' -d '{"code":10009}' "$HUB/api/key" >/dev/null || true
        sleep 0.4
    done
    sleep 3
    if running; then
        echo "✗ Pardeh is still running. Close it on the TV (Back twice) and run this again." >&2
        exit 1
    fi
fi

if [ -f "$DEVICE_PROFILE" ]; then
    "$SDB" -s "$DEV" push "$DEVICE_PROFILE" /home/developer/device-profile.xml >/dev/null
fi

echo "› Installing"
"$SDB" -s "$DEV" push "$WGT" /opt/usr/apps/tmp/pardeh.wgt >/dev/null
RESULT="$("$SDB" -s "$DEV" shell 0 vd_appinstall "$PKG" /opt/usr/apps/tmp/pardeh.wgt | grep -E "install (completed|failed)" || true)"
echo "  $RESULT"
if echo "$RESULT" | grep -q failed; then
    echo "✗ Install failed. See 'Troubleshooting' in docs/REPORT.md (error 118)." >&2
    exit 1
fi

echo "› Launching"
"$SDB" -s "$DEV" shell 0 was_execute "$APP_ID" | grep -E "launch" || true
