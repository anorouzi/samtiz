package ir.pardeh.tv;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.content.res.AssetManager;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * "Pardeh TV": finds the Samsung TV on the Wi-Fi, helps set up Developer Mode, installs Pardeh
 * (with the parts chosen) and works as a remote. The screens are a web page (assets/ui); this
 * class gives that page what a web page can't do itself: TCP to the TV's developer port, the
 * Samsung sign-in and certificate, and signing the app (see Installer, Sdb, Signer, SamsungCert).
 */
public class MainActivity extends Activity {
    private WebView web;
    private final ExecutorService work = Executors.newCachedThreadPool();
    private SigninServer signin;
    private Dialog signinDialog;
    private volatile String shared;   // a link shared to the app, until the page takes it
    private volatile boolean pageReady;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        web.addJavascriptInterface(new Bridge(), "Native");
        web.setWebViewClient(new WebViewClient());
        setContentView(web);
        takeShare(getIntent());
        web.loadUrl("file:///android_asset/ui/index.html");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        takeShare(intent);
        if (pageReady && shared != null) web.evaluateJavascript("window.onShared && window.onShared()", null);
    }

    /** The link in a "Share → Pardeh TV" (the first http(s) address in the shared text). */
    private void takeShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("https?://\\S+").matcher(text == null ? "" : text);
        if (m.find()) shared = m.group();
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.onBack && window.onBack()", value -> {
            if (!"true".equals(value)) MainActivity.super.onBackPressed();
        });
    }

    /** Answers a call from the page: window.Native_done(id, error, result). */
    private void done(String id, String error, Object result) {
        String js = "window.Native_done(" + JSONObject.quote(id) + "," + (error == null ? "null" : JSONObject.quote(error)) + ","
            + (result == null ? "null" : result instanceof String ? JSONObject.quote((String) result) : result.toString()) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    private void progress(String message) {
        web.post(() -> web.evaluateJavascript("window.Native_progress(" + JSONObject.quote(message) + ")", null));
    }

    private interface Job { Object run() throws Exception; }

    private void background(String id, Job job) {
        work.execute(() -> {
            try { done(id, null, job.run()); } catch (Exception e) { done(id, e.getMessage() == null ? e.toString() : e.getMessage(), null); }
        });
    }

    private static JSONObject tvJson(Installer.Tv tv) throws Exception {
        return new JSONObject().put("ip", tv.ip).put("name", tv.name).put("model", tv.model)
            .put("developerMode", tv.developerMode).put("developerIP", tv.developerIP == null ? "" : tv.developerIP);
    }

    // ---------- certificates, kept per TV in the app's private files ----------
    private File certDir(String duid) { return new File(getFilesDir(), "certs/" + duid.replaceAll("[^A-Za-z0-9]", "")); }

    private static String readText(File f) throws IOException { return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8); }

    private static List<String> pems(String text) {
        List<String> out = new ArrayList<>();
        for (String part : text.split("(?<=-----END CERTIFICATE-----)")) if (part.contains("BEGIN CERTIFICATE")) out.add(part.trim() + "\n");
        return out;
    }

    private void saveCert(SamsungCert.Cert c) throws IOException {
        File d = certDir(c.duid);
        d.mkdirs();
        Files.write(new File(d, "author.key").toPath(), c.author.privateKey.getBytes(StandardCharsets.UTF_8));
        Files.write(new File(d, "author.pem").toPath(), String.join("", c.author.chain).getBytes(StandardCharsets.UTF_8));
        Files.write(new File(d, "distributor.key").toPath(), c.distributor.privateKey.getBytes(StandardCharsets.UTF_8));
        Files.write(new File(d, "distributor.pem").toPath(), String.join("", c.distributor.chain).getBytes(StandardCharsets.UTF_8));
        if (c.deviceProfile != null) Files.write(new File(d, "device-profile.xml").toPath(), c.deviceProfile.getBytes(StandardCharsets.UTF_8));
    }

    private SamsungCert.Cert loadCert(String duid) throws IOException {
        File d = certDir(duid);
        if (!new File(d, "distributor.pem").exists()) return null;
        SamsungCert.Cert c = new SamsungCert.Cert();
        c.duid = duid;
        c.author = new Signer.Key(readText(new File(d, "author.key")), pems(readText(new File(d, "author.pem"))));
        c.distributor = new Signer.Key(readText(new File(d, "distributor.key")), pems(readText(new File(d, "distributor.pem"))));
        File profile = new File(d, "device-profile.xml");
        c.deviceProfile = profile.exists() ? readText(profile) : null;
        return c;
    }

    // ---------- the Pardeh app files and Samsung's CA certificates, bundled in assets ----------
    private byte[] asset(String path) throws IOException {
        try (InputStream in = getAssets().open(path)) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
            return b.toByteArray();
        }
    }

    private void appFiles(AssetManager am, String dir, String rel, List<Signer.AppFile> out) throws IOException {
        String[] names = am.list(dir);
        if (names == null) return;
        for (String n : names) {
            String path = dir + "/" + n, r = rel.isEmpty() ? n : rel + "/" + n;
            String[] children = am.list(path);
            if (children != null && children.length > 0) appFiles(am, path, r, out);
            else out.add(new Signer.AppFile(r, asset(path)));
        }
    }

    // ---------- Samsung account sign-in in a full-screen browser window ----------
    private void startSignin(String id, String duid) {
        if (signin != null) signin.shutdown();
        signin = new SigninServer(new SigninServer.Listener() {
            @Override public void onSignedIn(String token, String user, String email) {
                runOnUiThread(() -> { if (signinDialog != null) signinDialog.dismiss(); });
                progress("ورود انجام شد؛ در حال گرفتن گواهی سامسونگ برای این تلویزیون...");
                background(id, () -> {
                    SamsungCert.Cert c = SamsungCert.create(token, user, email, duid,
                        new String(asset("samsung-ca/author-ca.cer"), StandardCharsets.UTF_8),
                        new String(asset("samsung-ca/distributor-public-ca.cer"), StandardCharsets.UTF_8));
                    saveCert(c);
                    signin.shutdown();
                    return true;
                });
            }
            @Override public void onFailed(String why) { done(id, why, null); }
        });
        try { signin.startListening(); } catch (IOException e) { done(id, "پورت ورود (4794) در دسترس نیست: " + e.getMessage(), null); return; }
        runOnUiThread(() -> {
            WebView w = new WebView(this);
            w.getSettings().setJavaScriptEnabled(true);
            w.getSettings().setDomStorageEnabled(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
            w.setWebViewClient(new WebViewClient());
            signinDialog = new Dialog(this, android.R.style.Theme_Material_NoActionBar);
            signinDialog.setContentView(w);
            signinDialog.setOnCancelListener(d -> { signin.shutdown(); done(id, "ورود لغو شد", null); });
            signinDialog.show();
            w.loadUrl(SamsungCert.SIGNIN_URL);
        });
    }

    /** What the page can call (window.Native). Long jobs answer later through Native_done. */
    private class Bridge {
        @JavascriptInterface public String addresses() { return new JSONArray(Installer.lanAddresses()).toString(); }

        @JavascriptInterface public String version() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
        }

        @JavascriptInterface public void scan(String id) {
            background(id, () -> {
                JSONArray list = new JSONArray();
                for (Installer.Tv tv : Installer.scan()) list.put(tvJson(tv));
                return list;
            });
        }

        @JavascriptInterface public void tvInfo(String id, String ip) {
            background(id, () -> {
                Installer.Tv tv = Installer.tvInfo(ip, 3000);
                return tv == null ? null : tvJson(tv);
            });
        }

        @JavascriptInterface public void connect(String id, String ip) {
            background(id, () -> {
                String duid = Installer.readDuid(ip);
                return new JSONObject().put("duid", duid).put("hasCert", loadCert(duid) != null);
            });
        }

        @JavascriptInterface public void signIn(String id, String duid) { startSignin(id, duid); }

        @JavascriptInterface public void forgetCert(String duid) {
            File d = certDir(duid);
            File[] files = d.listFiles();
            if (files != null) for (File f : files) f.delete();
            d.delete();
        }

        @JavascriptInterface public void install(String id, String ip, String duid, String modulesJson) {
            background(id, () -> {
                SamsungCert.Cert cert = loadCert(duid);
                if (cert == null) throw new IOException("اول با حساب سامسونگ وارد شوید تا گواهی این تلویزیون ساخته شود");
                JSONArray m = new JSONArray(modulesJson);
                List<String> modules = new ArrayList<>();
                for (int i = 0; i < m.length(); i++) modules.add(m.getString(i));
                List<Signer.AppFile> files = new ArrayList<>();
                appFiles(getAssets(), "pardeh", "", files);
                Installer.install(ip, files, modules, cert, MainActivity.this::progress);
                return true;
            });
        }

        @JavascriptInterface public void launch(String id, String ip) {
            background(id, () -> { Installer.launch(ip); return true; });
        }

        @JavascriptInterface public void openWifiSettings() {
            startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS));
        }

        @JavascriptInterface public String modules() { return new JSONArray(Arrays.asList(Installer.MODULES)).toString(); }

        /** The link shared to the app, once (null if none). */
        @JavascriptInterface public String takeShared() {
            pageReady = true;
            String s = shared;
            shared = null;
            return s;
        }

        @JavascriptInterface public String clipboard() {
            android.content.ClipboardManager cm = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip() || cm.getPrimaryClip().getItemCount() == 0) return "";
            CharSequence t = cm.getPrimaryClip().getItemAt(0).coerceToText(MainActivity.this);
            return t == null ? "" : t.toString();
        }
    }

    @Override
    protected void onDestroy() {
        if (signin != null) signin.shutdown();
        work.shutdownNow();
        super.onDestroy();
    }
}
