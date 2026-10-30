# samtiz: Pardeh (پرده) for 2016 Samsung Tizen TVs

A custom video app for a 2016 Samsung Smart TV (UA50KU7000, Tizen 2.4), plus everything needed
to build, sign and install it.

- **Aparat:** search, categories, adaptive playback that starts in about 2–3 s on the TV.
- **Gapfilm tab:** the site's own categories, search, free titles without an account, series as
  episode lists. Logging in happens on the TV: phone number, then the SMS code.
- **Remote-first UI** in Persian: a seek bar with preview and acceleration, number-key jumps, a
  help screen on Info, and every color and media key mapped.
- **USB:** play files from the stick, and save videos to it through the TV's download manager,
  with pause, resume and delete.
- **Links** from anywhere, including from your phone through the optional **TV Hub** (QR code).
- **Android app (Pardeh TV):** finds the TV on the Wi-Fi, walks you through Developer Mode in
  Persian, installs Pardeh with the parts you choose, and works as a remote. Install
  [android/dist/Pardeh-TV.apk](android/dist/Pardeh-TV.apk); see [android/README.md](android/README.md).
- **Install on other TVs from a computer:** the hub's `/install` page does the same from a
  computer or Termux. See [hub/README.md](hub/README.md).

The full story is in **[docs/REPORT.md](docs/REPORT.md)**: TV discovery, firmware, Developer
Mode, Tizen Studio on Apple Silicon, Samsung certificates and error 118, the removed apps, and the
platform limits found along the way (old certificate store, 32 MiB file-writing limit, download
manager quirks), with test results.

## Quick start

1. Turn on **Developer Mode** on the TV with your computer's IP (Apps → 1 2 3 4 5), then do a
   full restart.
2. Install **Rosetta 2** (Apple Silicon) and the **Tizen Studio 6.1 CLI**, plus the
   `cert-add-on` and `Certificate-Manager` packages.
3. Create a **Samsung TV certificate** profile named `TVPlayer`. See
   [certificates/README.md](certificates/README.md).
4. Deploy:

   ```bash
   TV_IP=<tv-ip> tools/deploy.sh
   ```

5. Optional: run the hub with `node hub/server.mjs`. See [hub/README.md](hub/README.md).

## Layout

| Folder | Contents |
|---|---|
| `app/` | The Tizen web app (ES5, since the 2016 engine has no ES6) |
| `hub/` | Optional Node helper: phone sending, HTTPS relay, live recording, diagnostics, `/install` |
| `android/` | The Pardeh TV Android app (installer + remote); `dist/` has the APK |
| `tools/` | Deploy script, WebSocket remote, store-app remover, icon generator, yt-dlp fetcher |
| `certificates/` | How to create the Samsung certificate (the keys are never committed) |
| `docs/` | Complete report, and [the full Claude Code chat session](docs/chat-session.md) that built all of this (secrets redacted) |

Third-party code: `app/js/lib/qrcode.js`, the QR code generator by Kazuhiko Arase (MIT, header
kept).
