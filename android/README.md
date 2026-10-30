# Pardeh TV (Android app)

An Android app that puts Pardeh on a Samsung TV and controls the TV, all from the phone. No
computer is needed.

- **Finds the TV** on the Wi-Fi by itself, remembers it, and finds it again if its address changes.
- **Says whether the TV is ready.** It checks that Developer Mode is on and that its Host PC IP is
  this phone, and explains what to change if not.
- **Help in Persian**, step by step: Apps → `1 2 3 4 5` → Developer mode **On** → Host PC IP = the
  phone's address (shown in big digits) → full restart.
- **Setup from the phone, one button:** you open the TV's Apps screen from Home (with the
  card's own Home, arrows and OK) and press «تنظیم خودکار». The app presses `1 2 3 4 5`, moves to
  the first Host PC IP box, types the phone's IP with number keys (Left moves to the next box on
  this TV, and the boxes are filled in one pass from the first, since going back through a box
  empties it), selects OK, and holds power for 5.5 s for a full restart. It then waits until the
  TV reports this phone as its `developerIP`. If Developer Mode was off, it stops once and asks you
  to pick **On** before it goes on. The TV never sends `ms.remote.imeStart` and its IP boxes ignore
  `SendInputString`, so keys are the only way.
- **Installs Pardeh** with the parts you choose: Aparat, Gapfilm, live TV (Telewebion), links,
  sending from the phone, USB. The first time on each TV it asks you to sign in with a Samsung
  account (free), which makes the certificate the TV requires.
- **Play a link on the TV:** paste a link (Aparat, a Gapfilm page, a direct mp4/m3u8) and press play.
  Or use **Share → Pardeh TV** in any app (Aparat, the browser, Telegram…). Pardeh opens on the TV
  and plays it. The link goes through Pardeh's own app channel on the TV
  (`ws://<tv>:8001/api/v2/channels/ir.pardeh.links`): Pardeh joins it as "Pardeh TV" and the phone
  sends it a `play` event. If Pardeh isn't open, the app starts it (`ed.apps.launch`) and sends the
  link as soon as Pardeh joins. No hub is needed. (The TV's launcher drops the link it's given for
  apps like Pardeh, so `DEEP_LINK` can't be used.)
- **Remote control:** arrows, OK, Back, Home, volume, channels, numbers, colour keys, playback.
  It uses the TV's own remote API, so the TV asks "Allow?" once. It can also open Pardeh on the TV.

## Install the app on a phone

Copy `dist/Pardeh-TV.apk` to the phone and open it. Android asks to allow installing apps from
that source the first time. Android 8 or newer.

## Build

```bash
tools/build-android.sh             # → android/build/Pardeh-TV.apk
tools/build-android.sh --install   # build, install on the phone connected over USB, and open it
```

It uses only the Android SDK's command-line tools (build-tools, platform, Java 17), not Gradle or
Android Studio. The app carries a copy of `app/` (Pardeh), so rebuild after changing Pardeh. The
signing key is created once in `~/.android/pardeh-tv.jks` and isn't in the repository. Updates must
be signed with the same key, or Android refuses them.

On Xiaomi phones, a USB install needs Developer options → **Install via USB**, and each install
has to be confirmed on the phone.

## How it works

| File | What it does |
|---|---|
| `assets/ui/` | The screens (HTML/JS, Persian): TV, Install, Remote, Help |
| `src/…/MainActivity.java` | Hosts the screens and gives them what a web page can't do itself: the TV's developer port, the Samsung sign-in window, signing |
| `src/…/Installer.java` | Finds TVs (REST API on port 8001 across the /24), reads the TV's id, installs (same steps as `hub/installer.mjs`) |
| `src/…/Sdb.java` | The TV's developer protocol (port 26101): `getduid`, file copy, `vd_appinstall`, `was_execute` |
| `src/…/Signer.java` | Signs the app like Tizen Studio (checked byte for byte), zips the `.wgt`, builds certificate requests |
| `src/…/SamsungCert.java` | Samsung's certificate service, as Tizen Studio's Certificate Manager uses it |
| `src/…/SigninServer.java` | Receives the Samsung sign-in on `localhost:4794` |

The remote uses the TV's WebSocket API directly from the page:
`ws://<tv>:8001/api/v2/channels/samsung.remote.control`.

**One Host PC IP at a time.** The TV accepts installs only from the device in its Developer Mode
settings, so to install from the phone that has to be the phone. The remote works either way.

## Tests (on a computer)

The Java core has no Android code in it, so it runs on a computer:

```bash
W=/tmp/pardeh-test; mkdir -p $W/tv $W/classes
(cd $W/tv && node <repo>/tools/fake-tv.mjs <this-computer-ip> &)     # a simulated TV
javac -d $W/classes android/src/ir/pardeh/tv/{Sdb,Signer,SamsungCert,Installer,SigninServer}.java android/test/CoreTest.java
java -cp $W/classes CoreTest build/Pardeh.wgt app $W <this-computer-ip>
```

`CoreTest` checks the signatures against a Tizen Studio build, a certificate request with
openssl, a full install on the simulated TV, and the sign-in receiver.
