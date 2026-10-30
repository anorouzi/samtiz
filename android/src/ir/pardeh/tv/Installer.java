package ir.pardeh.tv;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Finding Samsung TVs on the Wi-Fi and installing Pardeh on one (same steps as hub/installer.mjs).
 * No Android classes here, so it also runs (and is tested) on a computer.
 */
public final class Installer {
    private Installer() { }

    public static final String PKG = "TvPlayr001";
    public static final String APP_ID = "TvPlayr001.TVPlayer";
    /** Parts of Pardeh that can be left out; the choice goes into js/settings.js in the package. */
    public static final String[] MODULES = { "aparat", "gapfilm", "live", "link", "phone", "usb" };

    public interface Log { void say(String message); }

    public static final class Tv {
        public String ip, name, model, developerIP, duid;
        public boolean developerMode;
    }

    /** This device's IPv4 addresses on the local network (Wi-Fi first). */
    public static List<String> lanAddresses() {
        List<String> out = new ArrayList<>();
        try {
            for (Enumeration<NetworkInterface> e = NetworkInterface.getNetworkInterfaces(); e != null && e.hasMoreElements(); ) {
                NetworkInterface ni = e.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                boolean wifi = ni.getName().startsWith("wlan") || ni.getName().equals("en0");
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress() || a.isLinkLocalAddress()) continue;
                    if (wifi) out.add(0, a.getHostAddress()); else out.add(a.getHostAddress());
                }
            }
        } catch (IOException ignored) { }
        return out;
    }

    static String httpGet(String url, int timeoutMs) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(timeoutMs);
        c.setReadTimeout(timeoutMs);
        try { return SamsungCert.read(c.getInputStream()); } finally { c.disconnect(); }
    }

    private static String field(String json, String name) {
        Matcher m = Pattern.compile("\"" + name + "\"\\s*:\\s*\"([^\"]*)\"").matcher(json);
        return m.find() ? m.group(1) : null;
    }

    /** The TV's own description (REST API on port 8001), or null if there's no Samsung TV there. */
    public static Tv tvInfo(String ip, int timeoutMs) {
        try {
            String json = httpGet("http://" + ip + ":8001/api/v2/", timeoutMs);
            String model = field(json, "modelName");
            if (model == null) return null;
            Tv tv = new Tv();
            tv.ip = ip;
            tv.model = model;
            tv.name = field(json, "name");
            tv.developerMode = "1".equals(field(json, "developerMode"));
            tv.developerIP = field(json, "developerIP");
            return tv;
        } catch (IOException e) {
            return null;
        }
    }

    /** Looks for Samsung TVs on this device's /24 networks. */
    public static List<Tv> scan() throws InterruptedException {
        List<String> ips = new ArrayList<>();
        for (String a : lanAddresses()) {
            String prefix = a.substring(0, a.lastIndexOf('.') + 1);
            for (int i = 1; i < 255; i++) if (!(prefix + i).equals(a)) ips.add(prefix + i);
        }
        ExecutorService pool = Executors.newFixedThreadPool(48);
        List<Future<Tv>> jobs = new ArrayList<>();
        for (final String ip : ips) jobs.add(pool.submit(() -> tvInfo(ip, 1500)));
        pool.shutdown();
        pool.awaitTermination(30, TimeUnit.SECONDS);
        List<Tv> found = new ArrayList<>();
        for (Future<Tv> f : jobs) {
            try { if (f.isDone() && f.get() != null) found.add(f.get()); } catch (Exception ignored) { }
        }
        return found;
    }

    /** Connects over sdb and reads the TV's DUID (the id its certificate is made for). */
    public static String readDuid(String ip) throws IOException {
        try (Sdb sdb = new Sdb(ip)) {
            String duid = sdb.shell("0 getduid").trim();
            if (!duid.matches("[A-Za-z0-9]{6,}")) throw new IOException("could not read the TV's id (" + duid + ")");
            return duid;
        }
    }

    public static boolean pardehRunning(String ip) {
        try {
            return httpGet("http://" + ip + ":8001/api/v2/applications/" + APP_ID, 4000).matches("(?s).*\"running\"\\s*:\\s*true.*");
        } catch (IOException e) {
            return false;
        }
    }

    /** js/settings.js with the chosen parts. */
    public static Signer.AppFile settings(List<String> modules) {
        StringBuilder list = new StringBuilder();
        for (String m : MODULES) {
            if (!modules.contains(m)) continue;
            list.append(list.length() > 0 ? ", " : "").append('\'').append(m).append('\'');
        }
        String js = "/* Written by the installer: the parts of Pardeh switched on. */\nvar PARDEH_MODULES = [" + list + "];\n";
        return new Signer.AppFile("js/settings.js", js.getBytes(StandardCharsets.UTF_8));
    }

    /** Signs Pardeh (appFiles, with the chosen parts) for this TV and installs it. */
    public static void install(String ip, List<Signer.AppFile> appFiles, List<String> modules, SamsungCert.Cert cert, Log log)
            throws IOException, GeneralSecurityException {
        List<Signer.AppFile> files = new ArrayList<>();
        for (Signer.AppFile f : appFiles) if (!f.name.equals("js/settings.js")) files.add(f);
        files.add(settings(modules));
        log.say("ساختن و امضای بستهٔ پرده...");
        byte[] wgt = Signer.signPackage(files, cert.author, cert.distributor);
        // Installing over a running app can leave the TV needing a full restart (error 118).
        if (pardehRunning(ip)) throw new IOException("پرده روی تلویزیون باز است — اول با دو بار Back آن را ببندید و دوباره نصب کنید");
        try (Sdb sdb = new Sdb(ip)) {
            if (cert.deviceProfile != null) {
                // The "permit to install" profile: 2016 TVs read it from /home/developer, newer ones from sdk_tools.
                for (String p : new String[] { "/home/developer/device-profile.xml", "/home/owner/share/tmp/sdk_tools/device-profile.xml" }) {
                    try { sdb.push(p, cert.deviceProfile.getBytes(StandardCharsets.UTF_8)); } catch (IOException ignored) { }
                }
            }
            log.say("فرستادن بسته به تلویزیون (" + wgt.length / 1024 + " KB)...");
            String target = null;
            for (String p : new String[] { "/opt/usr/apps/tmp/pardeh.wgt", "/home/owner/share/tmp/sdk_tools/pardeh.wgt" }) {
                try { sdb.push(p, wgt); target = p; break; } catch (IOException e) { log.say("نوشتن در " + p + " ممکن نشد: " + e.getMessage()); }
            }
            if (target == null) throw new IOException("فرستادن بسته به تلویزیون ممکن نشد");
            log.say("نصب روی تلویزیون (چند ثانیه)...");
            String out = sdb.shell("0 vd_appinstall " + PKG + " " + target);
            Matcher m = Pattern.compile("install (completed|failed)[^\\n]*").matcher(out);
            String result = m.find() ? m.group() : out.trim();
            if (!result.contains("completed")) {
                throw new IOException("نصب انجام نشد: " + result + (result.contains("118") ? " — تلویزیون را کامل خاموش و روشن کنید و دوباره امتحان کنید" : ""));
            }
            log.say("نصب شد ✓ — در حال باز کردن پرده روی تلویزیون");
            try { sdb.shell("0 was_execute " + APP_ID); } catch (IOException ignored) { }
        }
    }

    /** Opens Pardeh on the TV (needs this device to be the TV's Developer Mode IP). */
    public static void launch(String ip) throws IOException {
        try (Sdb sdb = new Sdb(ip)) { sdb.shell("0 was_execute " + APP_ID); }
    }
}
