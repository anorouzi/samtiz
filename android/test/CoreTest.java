import ir.pardeh.tv.Installer;
import ir.pardeh.tv.SamsungCert;
import ir.pardeh.tv.Signer;
import ir.pardeh.tv.SigninServer;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyPair;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Tests the installer's core on a computer (no Android needed):
 *   java CoreTest <tizen-studio-built.wgt> <app dir> <work dir> [fake TV ip]
 * 1. signatures match what Tizen Studio produced for the same files;
 * 2. a certificate request verifies with openssl;
 * 3. (with a fake TV ip) a full install against hub's simulated TV;
 * 4. the sign-in receiver parses Samsung's callback.
 */
public class CoreTest {
    static int failures = 0;

    static void check(String what, boolean ok) {
        System.out.println((ok ? "  ok   " : "  FAIL ") + what);
        if (!ok) failures++;
    }

    static List<Signer.AppFile> unzip(byte[] zip) throws IOException {
        List<Signer.AppFile> out = new ArrayList<>();
        try (ZipInputStream z = new ZipInputStream(new java.io.ByteArrayInputStream(zip))) {
            for (ZipEntry e; (e = z.getNextEntry()) != null; ) {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                for (int n; (n = z.read(buf)) > 0; ) b.write(buf, 0, n);
                out.add(new Signer.AppFile(e.getName(), b.toByteArray()));
            }
        }
        return out;
    }

    static String text(List<Signer.AppFile> files, String name) {
        for (Signer.AppFile f : files) if (f.name.equals(name)) return new String(f.data, StandardCharsets.UTF_8);
        return null;
    }

    static List<Signer.AppFile> appFiles(File dir, String prefix) throws IOException {
        List<Signer.AppFile> out = new ArrayList<>();
        File[] list = dir.listFiles();
        if (list == null) return out;
        for (File f : list) {
            if (f.getName().startsWith(".") || f.getName().matches("author-signature\\.xml|signature\\d*\\.xml")) continue;
            if (f.isDirectory()) out.addAll(appFiles(f, prefix + f.getName() + "/"));
            else out.add(new Signer.AppFile(prefix + f.getName(), Files.readAllBytes(f.toPath())));
        }
        return out;
    }

    public static void main(String[] args) throws Exception {
        File work = new File(args[2]);
        work.mkdirs();

        System.out.println("1. signatures vs Tizen Studio");
        List<Signer.AppFile> built = unzip(Files.readAllBytes(new File(args[0]).toPath()));
        List<Signer.AppFile> plain = new ArrayList<>();
        for (Signer.AppFile f : built) if (!f.name.matches("author-signature\\.xml|signature\\d*\\.xml")) plain.add(f);
        plain.sort((a, b) -> a.name.compareTo(b.name));
        Pattern info = Pattern.compile("<SignedInfo>[\\s\\S]*?</SignedInfo>");
        Matcher a = info.matcher(text(built, "author-signature.xml"));
        check("author SignedInfo identical", a.find() && a.group().equals(Signer.signedInfo("AuthorSignature", plain)));
        List<Signer.AppFile> withAuthor = new ArrayList<>(plain);
        for (Signer.AppFile f : built) if (f.name.equals("author-signature.xml")) withAuthor.add(f);
        withAuthor.sort((x, y) -> x.name.compareTo(y.name));
        Matcher d = info.matcher(text(built, "signature1.xml"));
        check("distributor SignedInfo identical", d.find() && d.group().equals(Signer.signedInfo("DistributorSignature", withAuthor)));

        System.out.println("2. certificate request");
        KeyPair keys = Signer.newKeys();
        String csr = Signer.certificateRequest("TizenSDK", "someone@example.com", keys, Collections.singletonList("ABCDEFGHIJ123"));
        File csrFile = new File(work, "dist.csr");
        Files.write(csrFile.toPath(), csr.getBytes(StandardCharsets.UTF_8));
        Process p = new ProcessBuilder("openssl", "req", "-in", csrFile.getPath(), "-noout", "-verify", "-text").redirectErrorStream(true).start();
        String out = new String(readAll(p.getInputStream()), StandardCharsets.UTF_8);
        p.waitFor();
        check("openssl verifies the request", out.contains("verify OK"));
        check("request lists the TV id", out.contains("URN:tizen:deviceid=ABCDEFGHIJ123"));

        if (args.length > 3) {
            System.out.println("3. install on the simulated TV at " + args[3]);
            Installer.Tv tv = Installer.tvInfo(args[3], 3000);
            check("TV found: " + (tv == null ? null : tv.model), tv != null);
            String duid = Installer.readDuid(args[3]);
            check("DUID read: " + duid, duid.equals("FAKEDUID1234"));
            // A self-signed key stands in for Samsung's certificate.
            File keyPem = new File(work, "key.pem"), crt = new File(work, "self.crt");
            Files.write(keyPem.toPath(), Signer.privateKeyPem(keys).getBytes(StandardCharsets.UTF_8));
            new ProcessBuilder("openssl", "req", "-x509", "-key", keyPem.getPath(), "-subj", "/CN=Test", "-days", "2", "-out", crt.getPath()).start().waitFor();
            Signer.Key key = new Signer.Key(Signer.privateKeyPem(keys), Collections.singletonList(new String(Files.readAllBytes(crt.toPath()), StandardCharsets.UTF_8)));
            SamsungCert.Cert cert = new SamsungCert.Cert();
            cert.duid = duid; cert.author = key; cert.distributor = key; cert.deviceProfile = "<Profile><TestDevice>FAKEDUID1234</TestDevice></Profile>";
            List<String> log = new ArrayList<>();
            Installer.install(args[3], appFiles(new File(args[1]), ""), Arrays.asList("gapfilm", "usb"), cert, log::add);
            for (String l : log) System.out.println("       " + l);
            check("install reported success", log.get(log.size() - 1).contains("نصب شد"));
        }

        System.out.println("4. sign-in receiver");
        final String[] got = new String[3];
        final CountDownLatch done = new CountDownLatch(1);
        SigninServer server = new SigninServer(new SigninServer.Listener() {
            public void onSignedIn(String t, String u, String e) { got[0] = t; got[1] = u; got[2] = e; done.countDown(); }
            public void onFailed(String why) { got[0] = "FAILED " + why; done.countDown(); }
        });
        server.startListening();
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + SamsungCert.SIGNIN_PORT + "/signin/callback").openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        try (OutputStream o = c.getOutputStream()) {
            o.write(("code=" + java.net.URLEncoder.encode("{\"access_token\":\"tok123\",\"userId\":\"u42\",\"inputEmailID\":\"a@b.c\"}", "UTF-8")).getBytes(StandardCharsets.UTF_8));
        }
        int status = c.getResponseCode();
        done.await(5, TimeUnit.SECONDS);
        server.shutdown();
        check("callback answered " + status, status == 200);
        check("token, user and email parsed", "tok123".equals(got[0]) && "u42".equals(got[1]) && "a@b.c".equals(got[2]));

        System.out.println(failures == 0 ? "ALL OK" : failures + " FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }

    static byte[] readAll(java.io.InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
        return b.toByteArray();
    }
}
