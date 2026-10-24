# TV Hub

An optional helper that runs on a computer or phone on the same network as the TV. Pardeh works
without it. With it, you also get:

- **Send to TV:** a phone page (open the QR code from Pardeh's «گوشی» button) where you paste a
  link and it plays on the TV.
- **Modern-HTTPS relay:** the 2016 TV can't verify certificates such as Let's Encrypt. The hub
  fetches those streams and passes them to the TV over plain HTTP (`/proxy`). Pardeh learns which
  sites need it.
- **Live recording:** `/record` joins a live HLS stream into one continuous `.ts` stream that the
  TV's download manager saves to USB.
- **Diagnostics:** Pardeh posts events to `/api/log` (written to `tv.log`). `/api/key` presses
  remote buttons inside the app, which the automated tests use.
- **Install Pardeh on another TV:** `/install` installs the app on any Samsung Tizen TV on the
  same Wi-Fi. See below.

Pardeh finds the hub by itself: it remembers the last address and otherwise scans the local
subnet for port 8090.

## Run

Requires Node.js 18 or newer, with no npm packages.

```bash
node server.mjs          # or: npm start
```

It prints the address to open on a phone, e.g. `http://172.19.85.16:8090`. Set `HUB_DEBUG=1` to
log every relayed request.

Optional: `../tools/get-yt-dlp.sh` downloads yt-dlp into `bin/`. The hub then turns page links
from many video sites into playable stream URLs.

### On an Android phone (for when the TV uses the phone's hotspot)

Install [Termux](https://termux.dev), then:

```bash
pkg install nodejs git
git clone https://github.com/anorouzi/samtiz.git
cd samtiz/hub && node server.mjs
```

## Install Pardeh on another TV

A TV can't install an app from a USB stick, and it only accepts an app signed with a Samsung
certificate made for that particular TV (its DUID). The hub does it over Wi-Fi from a computer or
an Android phone (Termux), with nothing but Node:

1. Run the hub **from the project folder** (it packages `../app`): `cd samtiz/hub && node server.mjs`.
2. Open `http://localhost:8090/install` **on the same device** (the Samsung sign-in sends the
   browser back to `localhost`).
3. On the TV: Apps → `1 2 3 4 5` → Developer mode **On**, Host PC IP = the address the page shows
   → OK → restart the TV fully (hold the power button).
4. On the page: find the TV, connect, sign in with a Samsung account (free), install. The app
   opens on the TV when it's done.

How it works:

- `sdb.mjs` speaks the TV's developer protocol (port 26101): it reads the DUID (`getduid`), copies
  files, and runs `vd_appinstall` / `was_execute`.
- `signing.mjs` does what Tizen Studio's Certificate Manager does: it builds certificate requests
  for an author and a distributor certificate (with the TV's DUID), and Samsung signs them
  (`svdca.samsungqbe.com`) for the signed-in account. The distributor answer is the device profile
  ("permit to install") that is copied to the TV too.
- It then signs `../app` exactly like Tizen Studio (`author-signature.xml`, `signature1.xml`; the
  output was checked byte for byte against a Tizen Studio build) and zips it into a `.wgt`.
- Certificates are kept per TV in `certs/<DUID>.json` (git-ignored, they hold private keys), so a
  TV only needs the sign-in once. `samsung-ca/` has Samsung's two public CA certificates that go
  into the signatures.
- The sign-in uses port 4794. Close Tizen Studio's Certificate Manager first if it's open.

## Endpoints

| Path | Method | Purpose |
|---|---|---|
| `/` | GET | Phone "send to TV" page |
| `/api/send` | POST `{url}` | Plays a link on every connected TV |
| `/api/events` | GET (SSE) | TVs listen here for links and key presses |
| `/api/key` | POST `{code}` | Presses a remote key inside Pardeh (e.g. `416` = Record, `10009` = Back) |
| `/api/status` | GET | Connected TVs, recent links, hub address |
| `/api/log` | POST | Diagnostics from the TV → `tv.log` |
| `/proxy?u=<url>` | GET | Relays a URL. HLS playlists are rewritten so segments also go through the hub |
| `/record?u=<m3u8>&max=<sec>` | GET | Continuous MPEG-TS stream of a live playlist (≤720p variant), for recording |
| `/install` | GET | "Install Pardeh on a TV" page |
| `/install/state` | GET | Connected TV, whether it has a certificate, progress log, this device's addresses |
| `/install/scan`, `/install/connect {ip}`, `/install/signin`, `/install/run` | POST | The installer's steps |

The hub has no authentication. Anyone on the local network can use it, so only run it on a
trusted network.
