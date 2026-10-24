# Samsung UA50KU7000 (Tizen 2.4): setup, custom app and findings

A complete record of the work on a 2016 Samsung Smart TV: checking firmware updates, enabling
development, removing preinstalled apps, and building and installing **Pardeh (پرده)**, a custom
video app. It also covers what the 2016 platform can and can't do, measured on the real TV.

Work dates: 23 October 2026. Development machine: MacBook Pro (Apple Silicon, `Mac15,6`), macOS 27.

---

## 1. The TV

Found on the local network through Bonjour (`_samsungmsf._tcp`) and Samsung's local REST API at
`http://<tv-ip>:8001/api/v2/`:

| | |
|---|---|
| Model | UA50KU7000 (`16_JAZZL_UHD_BASIC`), 50" 4K UHD, 2016 |
| OS | Tizen, platform 2.4.0 (`sdb capability`), CPU armv7 |
| Firmware | `T-JZL6UABC-1260.1` · Sub-micom `T-JZMDEUS-1007` · e-Manual `JZISDBK-1.1.5` |
| Region | `IR` |
| Network | Wi-Fi, e.g. `172.19.85.144` (Mac: `172.19.85.16`) |
| Open ports | 8001 (REST + WebSocket remote), 8002 (WSS), 7676, 8080 (DIAL), 9197 (DLNA); 26101 (`sdb`) once Developer Mode is on |

Useful read-only calls:

```bash
curl http://<tv-ip>:8001/api/v2/                                 # model, firmware, developerMode, DUID…
curl http://<tv-ip>:8001/api/v2/applications/<appId>             # is an app installed/running
```

## 2. Firmware update

- Installed: **1260.1**.
- Newest file on Samsung's support site (UA50KU7000K, "Upgrade File (USB type)"): **`T-JZL6UABC.zip`
  1250.2**, 13 Dec 2021, 1.1 GB.
- The installed version is **newer** than any downloadable file, so a USB update would be a
  downgrade. Samsung no longer updates this model, and the TV is on its final firmware.
- Tizen and the web engine can't be upgraded separately. Firmware must be signed by Samsung and
  is verified at boot. No public root exploit is known for firmware 1260.1, and trying one risks
  bricking the TV.

## 3. Removing preinstalled apps

With Developer Mode on (section 4), store apps can be uninstalled from the computer:

```bash
sdb -s <tv-ip>:26101 shell 0 vd_appuninstall <appId>
```

24 apps were removed: Cinema Ticket, Tiwall, Snappfood, Tehran Traffic, Kiosk, 90, Pishbini,
HamSam, Telewebion, Varzesh 3, Sports Video, Akharin Khabar, Aio, Ekran, Backgammon, Monopoly,
Ludo, BoardBall, Hazerjavab, Pantomime, Spot the Difference, MP4, Zigor, Nahj al-Balagha. Their
ids are in `tools/remove-store-apps.sh`. The built-in Web Browser, e-Manual and Privacy Choices
remain, since they can't be removed. Some removed apps may no longer be in the store.

The installed-app list can be read over the TV's WebSocket API (`ed.installedApp.get` on the
`samsung.remote.control` channel).

## 4. Development setup

### 4.1 Developer Mode on the TV

1. Open **Apps** and enter **1 2 3 4 5**. The 2016 Smart Remote has no number keys, so use the
   on-screen number pad (**123** button).
2. Switch **Developer Mode → On** and set **Host PC IP** to the computer's address.
3. **Restart fully**: hold the power button until the Samsung logo appears. A short press is
   only standby.
4. Check with `curl http://<tv-ip>:8001/api/v2/`, which should show `"developerMode": "1"` and the
   host IP, and port 26101 should be open.

Number keys sent over the WebSocket remote API didn't open the dialog reliably. Typing the IP
worked with `TypeOfRemote: "SendInputString"` (base64 text) on the same channel.

### 4.2 Tizen Studio on Apple Silicon

Tizen's macOS tools (`sdb`, the bundled JDK 1.8) are **x86_64 only**, so Rosetta 2 is required:

```bash
softwareupdate --install-rosetta --agree-to-license
curl -LO https://download.tizen.org/sdk/Installer/tizen-studio_6.1/web-cli_Tizen_Studio_6.1_macos-64.bin
chmod +x web-cli_Tizen_Studio_6.1_macos-64.bin
./web-cli_Tizen_Studio_6.1_macos-64.bin --accept-license ~/tizen-studio
~/tizen-studio/tools/sdb version              # Smart Development Bridge 4.2.25
```

The command-line edition was chosen over the IDE to save disk space. Homebrew didn't support
macOS 27 at the time and wasn't needed.

Extra packages for Samsung certificates:

```bash
~/tizen-studio/package-manager/package-manager-cli.bin install --accept-license cert-add-on Certificate-Manager
```

**Gotcha:** the first attempt ran a forced update that failed halfway ("Cannot install updates")
and **deleted `~/tizen-studio/jdk`**. Restore it with
`cp -R ~/.package-manager/jdk ~/tizen-studio/jdk` and run the install again. The downloads from
download.tizen.org were slow (several minutes for a few hundred MB).

Installed versions: Tizen Studio CLI 6.1, sdb 4.2.25, Certificate-Manager 3.1.3, Samsung
Certificate Extension (`cert-add-on`) 2.0.75.

### 4.3 Connecting

```bash
SDB=~/tizen-studio/tools/sdb
$SDB connect <tv-ip>:26101
$SDB devices                    # → <tv-ip>:26101  device  UA50KU7000
$SDB -s <tv-ip>:26101 shell 0 getduid
```

The TV only allows a few `shell 0 <cmd>` commands: `getduid`, `vd_appinstall`,
`vd_appuninstall`, `was_execute`. There's no command to stop an app.

### 4.4 Samsung certificate and "permit to install"

- A package signed with a plain Tizen certificate is rejected (`install failed`).
- The certificate must come from Samsung's server (Certificate Manager → **Samsung → TV**, with
  a Samsung account login) and its distributor certificate must contain the TV's **DUID**
  (`URN:tizen:deviceid=<DUID>`).
- Even with the right certificate the install failed with **error 118** until the
  `device-profile.xml` created by Certificate Manager was copied to the TV:

```bash
$SDB -s <tv-ip>:26101 push ~/SamsungCertificate/TVPlayer/device-profile.xml /home/developer/device-profile.xml
```

Details are in `certificates/README.md`. The certificate files aren't in this repository.

**Other people's TVs.** A `.wgt` can't be installed from USB: Samsung only allows USB installs of
`.tmg` packages from its seller-only USB Demo Packaging Tool, and that service has been shut down.
The hub's `/install` page does the whole process over Wi-Fi instead, without Tizen Studio (section 6).
It reads the TV's DUID, gets a Samsung certificate for it after a Samsung account sign-in, signs
the app and installs it. It reproduces Certificate Manager's requests: the sign-in redirect to
`localhost:4794/signin/callback`, and `svdca.samsungqbe.com/apis/v3/authors` and `/distributors`
with `platform=VD`. The `/distributors` answer is the `device-profile.xml` itself; its
`<Certificate>` is the distributor certificate.

### 4.5 Build, install, run

```bash
tools/deploy.sh                      # package + sign + (close app) + install + launch
```

which runs, in essence:

```bash
tizen package -t wgt -s TVPlayer -o build -- app
sdb -s <tv-ip>:26101 push build/Pardeh.wgt /opt/usr/apps/tmp/pardeh.wgt
sdb -s <tv-ip>:26101 shell 0 vd_appinstall TvPlayr001 /opt/usr/apps/tmp/pardeh.wgt
sdb -s <tv-ip>:26101 shell 0 was_execute TvPlayr001.TVPlayer
```

The package id is `TvPlayr001` and the app id is `TvPlayr001.TVPlayer`. The display name
(`Pardeh`) is separate and can change freely.

To pin the app to the Home bar: **Apps → Pardeh → hold OK → Add to Home**. Apps can't do this
programmatically.

## 5. The app: Pardeh (پرده)

`app/` is a Tizen web app (`config.xml`, `index.html`, `css/style.css`, `js/main.js`, the MIT
`js/lib/qrcode.js` by Kazuhiko Arase, and `icon.png` generated by `tools/make-icon.py`).

**Written in ES5** (no `let`/`const`, arrow functions or template strings), because the 2016 web
engine doesn't support ES6. Persian UI, 1920×1080, remote-only navigation.

### Features

- **Aparat:** search, 9 category chips (ورزشی، کارتون، فیلم…) that load when you stop on them,
  infinite scrolling grid with posters, playback.
  - API: `https://www.aparat.com/api/fa/v1/video/video/search/text/<q>` and
    `.../show/videohash/<uid>`, which returns `file_link_all` (MP4 180p–1080p) and `hls_link`.
- **Site tabs:** آپارات · گپ فیلم in the top bar. Each has its own categories, search and player.
  A series opens as a list of its episodes, and Back returns to the list it came from. Gapfilm has a
  «ورود با موبایل» chip: you type the phone number with the remote, then the SMS code. Only sites
  that work on the TV without the hub get a tab; the other sites checked are in section 10.
- **Player:** the TV's native AVPlay (hardware decoding).
  - Defaults to Aparat's adaptive HLS ("خودکار"), which starts about 4× faster than a 720p MP4.
    A fixed quality chosen with ▲ is remembered.
  - Resumes where you left off (`localStorage`), auto-plays the next item, and has three display
    modes (fit / stretch / auto).
- **Seek bar:** current time and length, a knob, and a preview bubble. Repeated ◀ ▶ presses add up
  and seek once. Holding speeds up from 10 s to 30 s to 60 s steps. 1–9 jump to 10–90% and 0 goes
  back to the start.
- **Links:** an Aparat page link or any direct `.mp4` / `.m3u8`. Links can also arrive from the
  phone through the hub.
- **USB:** lists videos on the stick (root and one folder deep) and plays them. Hold OK or press
  Tools for options (play / resume / delete with confirmation). Partly downloaded and suspicious
  files are labelled.
- **Save to USB:** ● (Record) or the ▼ menu.
  - MP4 videos go through the TV's **download manager** (`tizen.download`), with pause / resume.
  - Live streams are recorded via the hub.
  - A badge shows progress, and ● again stops.
- **Help:** the Info button shows every remote button, on any screen.
- **Speed:**
  - Rendering is batched to one per frame, and scrolling uses GPU transforms with no shadows or
    blur.
  - Posters load only for rows near the focus.
  - Playback info for the focused video is fetched ahead of time, so OK starts it faster.

### Remote buttons

| Button | Browsing | Watching |
|---|---|---|
| Arrows / OK | Move / select | OK = pause; ◀ ▶ seek (adds up, accelerates); ▲ quality; ▼ menu |
| 0–9 | 1–9 category, 0 search | 1–9 → 10–90 %, 0 → start |
| CH ▲▼ | Page up / down | Previous / next video or channel |
| ⏮ ⏭ | | Previous / next video |
| ⏪ ⏩ | | ±1 minute |
| ▶ ⏸ ■ | | Play / pause / stop |
| ● Record | Stop a running download or recording | Save to USB / stop |
| Tools | USB item options | Menu |
| Info | Help | Help |
| A 🔴 / B 🟢 / C 🟡 / D 🔵 | Live TV / search / USB / open link | (same; leaves the player) |
| Search | Aparat search | Aparat search |
| Back | Up a level; twice at the top exits | Back to the list |

Key codes are read from the TV at startup with `tizen.tvinputdevice.getKey()`. The TV reported
support for numbers, Volume, ChannelUp/Down, the four colors, Menu, Tools, Info, Exit, Search,
Guide, the media keys, and MediaTrackPrevious/Next.

### Privileges (`config.xml`)

`internet`, `tv.inputdevice`, `filesystem.read`, `filesystem.write`, `download`, and
`network.public` (to read the TV's IP for hub discovery). The `developer.samsung.com/privilege/avplay`
privilege was removed during the error-118 hunt; AVPlay works without it on this TV.

### Stored settings (`localStorage`)

`hub` (last hub URL), `prefQ` (`"auto"` or a height), `displayMode`, `positions` (resume points,
the 150 most recent), `partials` (paused downloads: download-manager id, Aparat uid, quality),
`viaHubHosts` (sites that need the hub relay), `site` (last site tab), `accounts` (site logins:
token and phone number), `deviceId` (random id sent with the Gapfilm login).

## 6. TV Hub (optional)

`hub/server.mjs` is Node with no packages. See `hub/README.md`. It adds phone sending (QR code),
the modern-HTTPS relay, live recording, and diagnostics. Its `/install` page installs Pardeh on
other Samsung TVs over Wi-Fi (`installer.mjs`, `sdb.mjs`, `signing.mjs`). The signing output was
checked byte for byte against a Tizen Studio build, and the whole flow was run against a simulated
TV. It hasn't yet been tried on a second real TV. The app finds it automatically by
scanning the subnet for port 8090. It can run on the Mac, or on an Android phone with Termux,
which suits the case where the TV uses the phone's hotspot.

## 7. What this 2016 TV can and can't do (findings)

1. **Old certificate store.** The TV doesn't trust Let's Encrypt (ISRG/"YR1"/"YE2" chains), so
   `telewebion.net` and `sepehrtv.ir` fail (`PLAYER_ERROR_CONNECTION_FAILED`, XHR network
   error). Aparat, Gapfilm and Google-hosted sites work. The store is in signed firmware and can't
   be changed, so the hub relays these sites over HTTP.
   **The issuer alone doesn't decide it.** Certum's `Certum DV TLS G2 R39 CA` leads to the 2018
   root `Certum Trusted Root CA`, which the TV doesn't have. Servers that also send that root
   cross-signed by the old `Certum Trusted Network CA` work (aparat.com, gapfilm.ir,
   asset.tamashakhoneh.ir). Servers that send the self-signed 2018 root don't: `tmk.ir`,
   `api.tmk.ir` and `api.tamashakhoneh.ir` fail with an immediate XHR network error. Check with
   `openssl s_client -connect <host>:443 -servername <host> -showcerts`: the last `i:` line must be
   `Certum Trusted Network CA`.
2. **App file writing breaks at 32 MiB.** The Tizen `FileStream` API (`writeBase64`) **freezes
   the app's JavaScript** once a file reaches about 32 MB. Downloads from the first version were
   cut off at exactly **33,554,432 bytes**, and the frozen app then blocked relaunching ("wait some
   time and try again") until a full TV restart. Slicing the writes and reopening the file didn't
   help; appending to a 32 MB file froze immediately.
   **Fix:** big files go through `tizen.download`, which writes natively. `FileStream` is only used
   for small files.
3. **Download manager quirks.**
   - It rejects virtual paths (`removable_sda1/Videos` → "Invalid destination") and needs the real
     path (`/opt/storage/usb/sda1/Videos`).
   - It writes to `<name>.<random code>` and leaves that name after completion, so the app renames
     finished files and repairs leftovers when it lists USB.
   - Download ids are forgotten when the app is reinstalled, so a paused download then restarts
     from zero.
4. **Installing over a running app** can fail with **error 118** and leave a zombie process
   (REST shows `"running": true, "visible": false`, and `was_execute` says
   `launch failed[404]`). Only a full TV restart clears it. Always close the app first;
   `tools/deploy.sh` does this through the hub.
5. **HLS starts faster than MP4.** On this network, a 720p MP4 took about 10 s to start, while
   Aparat's adaptive HLS took about 2.2–3.6 s.
6. **`setBufferingParam`** is accepted for on-demand video but not used for live streams.
7. **Live Telewebion through the hub fails** with `PLAYER_ERROR_INVALID_OPERATION`. AVPlay
   reloads the media playlist every second but fetches only the first segment. The suspected
   cause is the huge `EXT-X-MEDIA-SEQUENCE` (≈1.79×10¹⁵), which the 2016 player probably can't
   handle. An idea to try is having the hub rewrite it (e.g. `seq % 1e9`). This is postponed to a
   separate Telewebion app. The stream itself is fine: `https://ncdn.telewebion.net/<channel>/live/playlist.m3u8`,
   channel list from `https://gateway.telewebion.net/kandoo/channel/getChannelsList/`, no login.
8. **WebSocket remote API authorisation.** The first connection was accepted without a prompt.
   Later connections from the same name were sometimes `ms.channel.unauthorized` until re-allowed
   under *External Device Manager → Device Connection Manager*. During development the hub's
   `/api/key` (keys injected inside the app) was more reliable.
9. **Emoji** may not render in the TV's fonts, so the UI uses plain symbols (▶ ● ■ ↓ ✓ ×).
10. **No launch-with-URL from outside.** `POST /api/v2/applications/<id>` on port 8001 didn't
    respond, and launching through `ed.apps.launch` needs the WebSocket authorisation.

## 8. Test results (on the TV)

| Test | Result |
|---|---|
| Category change by moving across chips | ✅ loads after 0.7 s pause; no stale highlight |
| Start, Aparat 720p MP4 | ⚠️ ~10.1 s |
| Start, Aparat adaptive HLS | ✅ 2.2–3.6 s |
| Start, file from USB | ✅ 0.9 s |
| 45 s continuous playback | ✅ no stalls |
| Seek +30 s / back to start (HLS) | ✅ no stall |
| Old in-app downloader, 75 MB | ❌ froze; earlier files cut at 32 MiB |
| Download manager, 75 MB | ✅ complete in 70 s (~1 MB/s), renamed correctly |
| Download manager, 153 MB | ✅ complete |
| Stop → resume (same session) | ✅ continues at full speed |
| Delete from USB with confirmation | ✅ |
| Live recording via hub `/record` (tested from the Mac) | ✅ valid MPEG-TS |
| Live Telewebion playback via hub | ❌ INVALID_OPERATION (see 7.7) |
| Gapfilm tab, rows load (direct, no hub) | ✅ 9 rows from the home page |
| Gapfilm series → episode list → episode 1 (Reacher, direct) | ✅ started in 6.6 s |
| Tamashakhoneh API, direct | ❌ XHR network error (certificate chain, 7.1) |
| Tamashakhoneh / Movieland through the hub (test build, not kept) | ✅ lists; Movieland film started in 8.9 s |
| Gapfilm login and paid titles | not tested yet (needs the account holder's phone) |

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `install failed[118]` | Push `device-profile.xml` again. If the app is running or frozen, close it or fully restart the TV. As a last resort `vd_appuninstall TvPlayr001` and then install (this clears the app's settings) |
| TV says "wait some time and try again" / `launch failed[404]` | Frozen app process: hold the power button about 5 s for a full restart |
| `sdb: serial number wrong` after a TV restart | `sdb disconnect <ip>:26101 && sdb connect <ip>:26101` |
| Developer Mode setting doesn't stick | Enter the IP, OK, then a **full** restart, not standby |
| Package manager deleted the JDK | `cp -R ~/.package-manager/jdk ~/tizen-studio/jdk` |
| Site plays on a computer but not on the TV | Probably a Let's Encrypt site: run the hub (Pardeh retries through it and remembers the site) |
| WebSocket remote "unauthorized" | Re-allow the device under External Device Manager → Device Connection Manager |

## 10. Video sites checked

Checked from the Mac (whose traffic leaves through a VPN in Germany) and then on the TV. "On the
TV alone" means without the hub. Pardeh only gets a tab for sites that work on the TV alone.

| Site | In Pardeh | On the TV alone | Account | Video | Notes |
|---|---|---|---|---|---|
| **Aparat** (aparat.com) | tab | ✅ | none | MP4 + HLS | Certum, cross-signed chain |
| **Gapfilm** (gapfilm.ir) | tab | ✅ | free titles: none; others: subscriber login | HLS (360p–4K, H.264) + MP4 per quality, no DRM | All hosts Certum with the cross-signed chain. Paid streams answer `402 محتوا رایگان نیست` without a subscription |
| **Tamashakhoneh** (tmk.ir, Asiatech) | — (worked through the hub in a test build) | ❌ | needed to play | HLS (`m3u8_path`), no DRM, may carry VAST ads | API servers send the self-signed 2018 Certum root (7.1); posters (`asset.tamashakhoneh.ir`) load directly. HTTP redirects to HTTPS. `tv.tmk.ir` wasn't reachable |
| **Movieland** (movieland.af, Hindukush Bridge, Afghanistan) | — (worked through the hub in a test build) | ❌ | none | HLS 240p–1080p, no DRM | Let's Encrypt everywhere, HTTP redirects to HTTPS, and the video server answers 403 without `Referer: https://movieland.af/` (tried six player user agents) |
| **Filmland** (Netbox) | — | — | Netbox device | — | Exclusive to Netbox Android boxes ("only usable on Netbox devices"); `filmland.ir` is a parked domain for sale; `filmland.net-box.ir` is a staff panel |
| Telewebion / Sepehr | Live tab, via hub | ❌ | none | HLS | Let's Encrypt; see 7.7 |
| PersianMoviesBox | — | — | — | — | Cloudflare bot check, appears to host unlicensed copies; the old domain is now a gambling site |

**APIs** (all JSON; Gapfilm pages count from 0). Tamashakhoneh and Movieland are kept for later;
through the hub they'd also need it to pass POST bodies and `x-…` headers, and to add Movieland's
`Referer`:

- **Gapfilm** `https://core.gapfilm.ir/api/`, header `SourceChannel: GF_WEBSITE`:
  - Rows: `v3.3/GetFirstPageByPlatform?PlatformId=1&PlatformType=1&PageType=1&ParentType=2&…`, then
    `v3.3/GetFirstPageByPlatformPaging?EntityType=1&EntityId=<row>&PageIndex=<0…>`. Pardeh uses rows
    with no template, `SectionTemplateId` 1 (collection), 10 or 11; banners, actors (14) and
    "continue watching" (15) are skipped.
  - Search: `v1.0/search?Title=`. Title: `v4/Content/GetContent?Id=` (`SeasonList`).
  - Episodes and links: `v4/Content/GetContentAttachments?Id=&seasonId=&generateLink=true`.
    `Files` type 7 = HLS, 9 = MP4s.
  - Images: `https://cdn.gapfilm.ir/image/400/panel/<id>/landscape.jpg`.
  - Login: `v3.2/Account/Login {Method:1, PhoneNo}`, then `v3.2/Account/Confirm {Type:3, Code, PhoneNo}`
    returns `Data.Token`, sent as `Authorization: bearer …`.
- **Tamashakhoneh** `https://api.tmk.ir/v4/`, header `x-platform: 0`:
  - Lists: `categories`, `movies/categories/<id>?page=`, `search?text=`.
  - Series: `https://api.tamashakhoneh.ir/v5/series/<id>` (seasons) and `…/series/seasons/<id>` (episodes).
  - Playing: `POST watch/<id>` with `x-auth-token` gives `data.m3u8_path`.
  - Login: `POST auth/otp {mobile}` sends the SMS, then `POST auth/otp/code {mobile, code}`. The
    token comes back in the `x-auth-token` response header. Accounts with a password answer 409;
    they use `POST auth/login {mobile, password}`.
- **Movieland** GraphQL at `https://api.movieland.af/graphql` (no login):
  - Lists: `movies` / `series`, with `pageSize` at most 21 and genres as `genreSlugs`.
  - Search: `search(term:)`.
  - Streams: `movieById` / `episode` give `online_url`; `seriesDetails(slug).seasonsWithEpisodes`
    lists the episodes.

## 11. Open items / ideas

- **Telewebion** as its own app: fix the media-sequence issue (7.7) and run the hub on the phone
  for a direct Iranian route. The Mac's route went through a VPN and was slow, about 3 Mbps.
- **Test the Gapfilm login** with a real account (phone + SMS code on the TV), and a paid title
  with a subscription.
- **Test the `/install` page on a real TV:** first this TV, which needs a new certificate made by
  the page, then a friend's. Watch whether the device profile from `/distributors` is accepted as is.
- **Tamashakhoneh on the TV alone:** look for a Tamashakhoneh server that sends the cross-signed
  Certum chain (like `asset.tamashakhoneh.ir` does), e.g. the one its Android TV app uses. If one
  exists, the tab can come back without the hub.
- **Movieland** can't work on this TV without the hub (Let's Encrypt and the Referer check).
- **Hub on Android (Termux)**, so the TV doesn't depend on the Mac.

## 12. Repository layout

```
app/          Pardeh Tizen web app (config.xml, index.html, css/, js/, icon.png)
hub/          Optional TV Hub (Node) + phone page + /install page (installer.mjs, sdb.mjs, signing.mjs, samsung-ca/)
tools/        deploy.sh, tv-remote.mjs, remove-store-apps.sh, make-icon.py, get-yt-dlp.sh, export-chat.py
certificates/ How to create the Samsung certificate (files themselves are git-ignored)
docs/         This report + chat-session.md (the whole Claude Code session, secrets redacted)
```
