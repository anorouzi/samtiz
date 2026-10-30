#!/usr/bin/env bash
# Builds the "Pardeh TV" Android app (android/) into android/build/Pardeh-TV.apk with the Android
# SDK's command-line tools only (no Gradle, no Android Studio). The app carries a copy of app/
# (Pardeh itself) to install on TVs, and hub/samsung-ca/.
#
#   tools/build-android.sh            # build
#   tools/build-android.sh --install  # build and install on the phone connected over USB (adb)
#
# Environment (optional): ANDROID_HOME (default ~/Library/Android/sdk), VERSION_NAME, VERSION_CODE.
# The signing key is made once in ~/.android/pardeh-tv.jks (password in pardeh-tv.pass next to
# it) and kept out of the repository; later builds must use the same key to update the app.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
JAR="$SDK/platforms/$(ls "$SDK/platforms" | sort -V | tail -1)/android.jar"
OUT="$ROOT/android/build"
VERSION_NAME="${VERSION_NAME:-1.0}"
VERSION_CODE="${VERSION_CODE:-1}"
KS="$HOME/.android/pardeh-tv.jks"
PASS_FILE="$HOME/.android/pardeh-tv.pass"

echo "› Build tools $(basename "$BT"), $(basename "$(dirname "$JAR")")"
rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/assets/pardeh" "$OUT/assets/samsung-ca"

echo "› Assets: the screens, Pardeh (app/) and Samsung's CA certificates"
cp -R "$ROOT/android/assets/ui" "$OUT/assets/ui"
(cd "$ROOT/app" && find . -type f ! -name '.*' ! -name 'author-signature.xml' ! -name 'signature*.xml' | while read -r f; do
    mkdir -p "$OUT/assets/pardeh/$(dirname "$f")"
    cp "$f" "$OUT/assets/pardeh/$f"
done)
cp "$ROOT"/hub/samsung-ca/*.cer "$OUT/assets/samsung-ca/"

echo "› Compiling Java"
# Java 8 API from the JDK (lambdas need it) and Android's classes from android.jar; d8 converts.
javac -nowarn --release 8 -cp "$JAR" -d "$OUT/classes" "$ROOT"/android/src/ir/pardeh/tv/*.java
"$BT/d8" --lib "$JAR" --min-api 26 --output "$OUT" $(find "$OUT/classes" -name '*.class')

echo "› Packaging"
"$BT/aapt2" compile --dir "$ROOT/android/res" -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/unsigned.apk" -I "$JAR" --manifest "$ROOT/android/AndroidManifest.xml" -R "$OUT/res.zip" -A "$OUT/assets" \
    --min-sdk-version 26 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME"
(cd "$OUT" && zip -q unsigned.apk classes.dex)
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

if [ ! -f "$KS" ]; then
    echo "› Creating the signing key $KS"
    mkdir -p "$(dirname "$KS")"
    head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$PASS_FILE"
    chmod 600 "$PASS_FILE"
    keytool -genkeypair -keystore "$KS" -storepass "$(cat "$PASS_FILE")" -keypass "$(cat "$PASS_FILE")" -alias pardeh \
        -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Pardeh TV" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass "file:$PASS_FILE" --ks-key-alias pardeh --out "$OUT/Pardeh-TV.apk" "$OUT/aligned.apk"
rm -f "$OUT/unsigned.apk" "$OUT/aligned.apk" "$OUT/res.zip"
echo "✓ $OUT/Pardeh-TV.apk ($(du -h "$OUT/Pardeh-TV.apk" | cut -f1))"

if [ "${1:-}" = "--install" ]; then
    ADB="$SDK/platform-tools/adb"
    echo "› Installing on the phone"
    "$ADB" install -r "$OUT/Pardeh-TV.apk"
    "$ADB" shell am start -n ir.pardeh.tv/.MainActivity >/dev/null
fi
