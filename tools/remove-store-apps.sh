#!/usr/bin/env bash
# Uninstalls Samsung Smart Hub store apps over the developer connection (Developer Mode must be on).
# These are the 24 preinstalled Iranian-store apps removed from the TV on 2026-10-23.
# Built-in apps (Web Browser, e-Manual, Privacy Choices) can't be removed this way.
#
#   TV_IP=172.19.85.144 tools/remove-store-apps.sh            # remove the whole list
#   TV_IP=172.19.85.144 tools/remove-store-apps.sh 3201512007136   # remove specific app ids
set -euo pipefail
TV_IP="${TV_IP:-172.19.85.144}"
SDB="${TIZEN_STUDIO:-$HOME/tizen-studio}/tools/sdb"
DEV="$TV_IP:26101"

APPS=(
    "3201512006801  Cinema Ticket (سینما تیکت)"
    "3201507004316  Tiwall (تیوال)"
    "3201811017241  Snappfood (اسنپ فود)"
    "111399002304   Tehran Traffic (ترافیک تهران)"
    "3201506003711  Kiosk (کيوسک)"
    "3201511006640  90 (نود)"
    "3201806016422  Pishbini (پیش بینی)"
    "3201612011388  HamSam (هم سام)"
    "3201512007136  Telewebion (تلوبیون)"
    "3201504001784  Varzesh 3 (ورزش 3)"
    "3201504001786  Sports Video (ویدئو ورزشی)"
    "3201712015493  Akharin Khabar (آخرین خبر)"
    "3201606009648  Aio (آیو)"
    "3201810017128  Ekran (اکران)"
    "3201607010168  Backgammon (تخته نرد)"
    "111477001266   Monopoly (مونوپولی)"
    "3201710014880  Ludo (منچ)"
    "3201612011378  BoardBall"
    "3201612011385  Hazerjavab (حاضرجواب)"
    "3201808016787  Pantomime (پانتومیم)"
    "3201505002401  Spot the Difference (اختلاف تصاویر)"
    "3201601007687  MP4"
    "3201604008893  Zigor (زیگور)"
    "3201507004312  Nahj al-Balagha (نهج البلاغه)"
)

"$SDB" connect "$DEV" | tail -1
if [ $# -gt 0 ]; then
    APPS=()
    for id in "$@"; do APPS+=("$id  (from command line)"); done
fi
for entry in "${APPS[@]}"; do
    id="${entry%% *}"
    printf '%-45s ' "${entry#* }"
    if "$SDB" -s "$DEV" shell 0 vd_appuninstall "$id" 2>&1 | grep -q "uninstall completed"; then echo removed; else echo "not removed"; fi
done
