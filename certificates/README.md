# Certificates (not in git)

2016 Samsung TVs (Tizen 2.4) only install apps signed with a **Samsung** certificate that
contains the TV's DUID. A plain Tizen certificate is rejected. Certificate files contain private
keys, so this folder's contents are ignored by git. Keep your own backup.

## Create one

1. Install Tizen Studio's `Certificate-Manager` and `cert-add-on` packages (see `docs/REPORT.md`).
2. Connect the TV first (`sdb connect <tv-ip>:26101`) so its DUID is filled in automatically.
   You can also read the DUID with `sdb shell 0 getduid`.
3. Open `~/tizen-studio/tools/certificate-manager/Certificate-manager.app` and click **+**, then
   choose **Samsung → TV** and name the profile (this project uses `TVPlayer`).
4. **Author certificate:** create new, set a name and password, then sign in with a Samsung account.
5. **Distributor certificate:** keep **Public** and check that the DUID is listed. Finish.

Certificate Manager writes `author.p12`, `distributor.p12` and `device-profile.xml` (by default
under `~/SamsungCertificate/<profile>/`). It also registers the signing profile in
`~/tizen-studio-data/profile/profiles.xml`, which `tizen package -s <profile>` uses.

## "Permit to install"

Copy `device-profile.xml` to the TV, or installs fail with **error 118**:

```bash
sdb -s <tv-ip>:26101 push device-profile.xml /home/developer/device-profile.xml
```

`tools/deploy.sh` does this automatically when it finds the file.

The certificates expire after one year. Renew them in Certificate Manager the same way.
