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

The hub has no authentication. Anyone on the local network can use it, so only run it on a
trusted network.
