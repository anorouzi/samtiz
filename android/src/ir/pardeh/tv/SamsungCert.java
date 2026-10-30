package ir.pardeh.tv;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.util.Arrays;
import java.util.Collections;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A Samsung certificate for one TV, as Tizen Studio's Certificate Manager makes it for
 * "Samsung → TV": with a Samsung account token, Samsung signs an author certificate and a
 * distributor certificate that lists the TV's id (DUID). The distributor answer is the device
 * profile ("permit to install") the TV also needs; the certificate is inside it.
 */
public final class SamsungCert {
    private SamsungCert() { }

    public static final int SIGNIN_PORT = 4794;
    public static final String SIGNIN_URL = "https://account.samsung.com/mobile/account/check.do?serviceID=v285zxnl3h&actionID=StartOAuth2"
        + "&accessToken=Y&redirect_uri=http://localhost:" + SIGNIN_PORT + "/signin/callback";
    private static final String CA = "https://svdca.samsungqbe.com/apis/v3/";

    /** What installing needs for one TV. */
    public static final class Cert {
        public String duid;
        public Signer.Key author, distributor;
        public String deviceProfile;   // may be null
    }

    private static String post(String kind, String token, String userId, String csr, String[][] extra) throws IOException {
        String boundary = "----pardeh" + Long.toHexString(System.nanoTime());
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        String[][] fields = { { "access_token", token }, { "user_id", userId }, { "platform", "VD" } };
        for (String[][] group : new String[][][] { fields, extra }) {
            for (String[] f : group) {
                body.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + f[0] + "\"\r\n\r\n" + f[1] + "\r\n").getBytes(StandardCharsets.UTF_8));
            }
        }
        String file = kind.substring(0, kind.length() - 1) + ".csr";
        body.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"csr\"; filename=\"" + file + "\"\r\n"
            + "Content-Type: application/octet-stream\r\n\r\n" + csr + "\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));

        HttpURLConnection c = (HttpURLConnection) new URL(CA + kind).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        try (OutputStream o = c.getOutputStream()) { o.write(body.toByteArray()); }
        int status = c.getResponseCode();
        String text = read(status < 400 ? c.getInputStream() : c.getErrorStream());
        if (status >= 400) throw new IOException("Samsung refused the " + file.replace(".csr", "") + " certificate (" + status + "): " + text);
        return text;
    }

    static String read(InputStream in) throws IOException {
        if (in == null) return "";
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
        in.close();
        return b.toString("UTF-8");
    }

    /** A certificate from Samsung's answer: a PEM block, or the <Certificate> of a device profile. */
    static String certificateFrom(String text) {
        Matcher pem = Pattern.compile("-----BEGIN CERTIFICATE-----[\\s\\S]+?-----END CERTIFICATE-----").matcher(text);
        if (pem.find()) return pem.group() + "\n";
        Matcher field = Pattern.compile("<Certificate>\\s*([A-Za-z0-9+/=\\s]+?)\\s*</Certificate>").matcher(text);
        if (!field.find()) return null;
        String body = field.group(1).replaceAll("\\s", "");
        StringBuilder b = new StringBuilder("-----BEGIN CERTIFICATE-----\n");
        for (int i = 0; i < body.length(); i += 64) b.append(body, i, Math.min(body.length(), i + 64)).append('\n');
        return b.append("-----END CERTIFICATE-----\n").toString();
    }

    /** caAuthor / caDistributor: Samsung's public CA certificates (PEM) that complete the chains. */
    public static Cert create(String accessToken, String userId, String email, String duid, String caAuthor, String caDistributor)
            throws IOException, GeneralSecurityException {
        KeyPair authorKeys = Signer.newKeys(), distKeys = Signer.newKeys();
        String authorText = post("authors", accessToken, userId, Signer.certificateRequest("Pardeh", null, authorKeys, null), new String[0][]);
        String profile = post("distributors", accessToken, userId,
            Signer.certificateRequest("TizenSDK", email, distKeys, Collections.singletonList(duid)),
            new String[][] { { "privilege_level", "Public" }, { "developer_type", "Individual" } });
        String authorCert = certificateFrom(authorText), distCert = certificateFrom(profile);
        if (authorCert == null || distCert == null) {
            String bad = authorCert == null ? authorText : profile;
            throw new IOException("Samsung's answer had no certificate in it: " + bad.substring(0, Math.min(200, bad.length())));
        }
        Cert c = new Cert();
        c.duid = duid;
        c.author = new Signer.Key(Signer.privateKeyPem(authorKeys), Arrays.asList(authorCert, caAuthor));
        c.distributor = new Signer.Key(Signer.privateKeyPem(distKeys), Arrays.asList(distCert, caDistributor));
        c.deviceProfile = profile.contains("<Profile") ? profile : null;
        return c;
    }
}
