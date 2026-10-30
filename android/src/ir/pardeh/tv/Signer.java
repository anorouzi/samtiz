package ir.pardeh.tv;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Packaging and signing Pardeh for a Samsung TV, and certificate requests for Samsung — a port of
 * hub/signing.mjs, whose output matches Tizen Studio's byte for byte.
 *
 * A .wgt is a zip with two W3C widget signatures: author-signature.xml covers the app's files,
 * signature1.xml (the distributor) covers those plus the author signature.
 */
public final class Signer {
    private Signer() { }

    public static final class AppFile {
        public final String name;
        public final byte[] data;
        public AppFile(String name, byte[] data) { this.name = name; this.data = data; }
    }

    /** A signing key: PKCS#8 private key (PEM) and the certificate chain [leaf, Samsung CA] (PEM). */
    public static final class Key {
        public final String privateKey;
        public final List<String> chain;
        public Key(String privateKey, List<String> chain) { this.privateKey = privateKey; this.chain = chain; }
    }

    private static final String DSIG = "http://www.w3.org/2000/09/xmldsig#";

    // SHA-512 of the canonical <Object Id="prop"> each signature ends with; it only depends on
    // the signature's role, so it's the same in every package.
    private static String propDigest(String id) {
        return "AuthorSignature".equals(id)
            ? "aXbSAVgmAz0GsBUeZ1UmNDRrxkWhDUVGb45dZcNRq429wX3X+x6kaXT3NdNDTSNVTU+ypkysPMGvQY10fG1EWQ=="
            : "/r5npk2VVA46QFJnejgONBEh4BWtjrtu9x/IFeLksjWyGmB/cMWKSJWQl7aU3YRQRZ3AesG8gF7qGyvKX9Snig==";
    }

    private static String wrap(String s, int width) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i += width) {
            if (i > 0) b.append('\n');
            b.append(s, i, Math.min(s.length(), i + width));
        }
        return b.toString();
    }

    private static String b64(byte[] data) { return Base64.getEncoder().encodeToString(data); }

    /** Like JavaScript's encodeURIComponent, which Tizen Studio uses for the file names. */
    static String encodeUri(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8").replace("+", "%20").replace("%21", "!").replace("%27", "'")
                .replace("%28", "(").replace("%29", ")").replace("%7E", "~");
        } catch (IOException e) { throw new IllegalStateException(e); }
    }

    private static String propObject(String id) {
        String role = "AuthorSignature".equals(id) ? "author" : "distributor";
        return "<Object Id=\"prop\"><SignatureProperties xmlns:dsp=\"http://www.w3.org/2009/xmldsig-properties\">"
            + "<SignatureProperty Id=\"profile\" Target=\"#" + id + "\"><dsp:Profile URI=\"http://www.w3.org/ns/widgets-digsig#profile\"></dsp:Profile></SignatureProperty>"
            + "<SignatureProperty Id=\"role\" Target=\"#" + id + "\"><dsp:Role URI=\"http://www.w3.org/ns/widgets-digsig#role-" + role + "\"></dsp:Role></SignatureProperty>"
            + "<SignatureProperty Id=\"identifier\" Target=\"#" + id + "\"><dsp:Identifier></dsp:Identifier></SignatureProperty>"
            + "</SignatureProperties></Object>";
    }

    private static String reference(String uri, String digest, boolean transform) {
        return "<Reference URI=\"" + uri + "\">\n"
            + (transform ? "<Transforms>\n<Transform Algorithm=\"http://www.w3.org/2006/12/xml-c14n11\"></Transform>\n</Transforms>\n" : "")
            + "<DigestMethod Algorithm=\"http://www.w3.org/2001/04/xmlenc#sha512\"></DigestMethod>\n"
            + "<DigestValue>" + wrap(digest, 76) + "</DigestValue>\n</Reference>\n";
    }

    public static String signedInfo(String id, List<AppFile> files) throws GeneralSecurityException {
        StringBuilder refs = new StringBuilder();
        for (AppFile f : files) refs.append(reference(encodeUri(f.name), b64(MessageDigest.getInstance("SHA-512").digest(f.data)), false));
        refs.append(reference("#prop", propDigest(id), true));
        return "<SignedInfo>\n"
            + "<CanonicalizationMethod Algorithm=\"http://www.w3.org/2001/10/xml-exc-c14n#\"></CanonicalizationMethod>\n"
            + "<SignatureMethod Algorithm=\"http://www.w3.org/2001/04/xmldsig-more#rsa-sha512\"></SignatureMethod>\n"
            + refs + "</SignedInfo>";
    }

    /** Exclusive canonical form of the <SignedInfo> above: the namespace it inherits moves onto it. */
    public static String canonical(String info) {
        return info.replaceFirst("<SignedInfo>", "<SignedInfo xmlns=\"" + DSIG + "\">");
    }

    static String pemBody(String pem) { return pem.replaceAll("-----[^-]+-----|\\s", ""); }

    public static PrivateKey privateKey(String pem) throws GeneralSecurityException {
        return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(pemBody(pem))));
    }

    public static byte[] signature(String id, List<AppFile> files, Key key) throws GeneralSecurityException {
        String info = signedInfo(id, files);
        Signature rsa = Signature.getInstance("SHA512withRSA");
        rsa.initSign(privateKey(key.privateKey));
        rsa.update(canonical(info).getBytes(StandardCharsets.UTF_8));
        StringBuilder certs = new StringBuilder();
        for (String c : key.chain) certs.append("<X509Certificate>\n").append(wrap(pemBody(c), 76)).append("\n</X509Certificate>\n");
        String xml = "<Signature xmlns=\"" + DSIG + "\" Id=\"" + id + "\">\n" + info + "\n<SignatureValue>\n" + wrap(b64(rsa.sign()), 76)
            + "\n</SignatureValue>\n<KeyInfo>\n<X509Data>\n" + certs + "</X509Data>\n</KeyInfo>\n" + propObject(id) + "\n</Signature>\n";
        return xml.getBytes(StandardCharsets.UTF_8);
    }

    private static final Comparator<AppFile> BY_NAME = new Comparator<AppFile>() {
        @Override public int compare(AppFile a, AppFile b) { return a.name.compareTo(b.name); }
    };

    /** Signs the app's files (any order) and returns the .wgt. */
    public static byte[] signPackage(List<AppFile> appFiles, Key author, Key distributor) throws GeneralSecurityException, IOException {
        List<AppFile> files = new ArrayList<>(appFiles);
        files.sort(BY_NAME);
        List<AppFile> withAuthor = new ArrayList<>(files);
        withAuthor.add(new AppFile("author-signature.xml", signature("AuthorSignature", files, author)));
        withAuthor.sort(BY_NAME);
        List<AppFile> all = new ArrayList<>(withAuthor);
        all.add(new AppFile("signature1.xml", signature("DistributorSignature", withAuthor, distributor)));
        return zip(all);
    }

    public static byte[] zip(List<AppFile> files) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream z = new ZipOutputStream(bytes)) {
            for (AppFile f : files) {
                z.putNextEntry(new ZipEntry(f.name));
                z.write(f.data);
                z.closeEntry();
            }
        }
        return bytes.toByteArray();
    }

    // ---------- certificate requests (PKCS#10), built by hand in DER ----------
    private static byte[] der(int tag, byte[]... parts) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (byte[] p : parts) body.write(p, 0, p.length);
        int n = body.size();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(tag);
        if (n < 128) out.write(n);
        else {
            byte[] len = java.math.BigInteger.valueOf(n).toByteArray();
            int start = len[0] == 0 ? 1 : 0;
            out.write(0x80 | (len.length - start));
            out.write(len, start, len.length - start);
        }
        byte[] b = body.toByteArray();
        out.write(b, 0, b.length);
        return out.toByteArray();
    }

    private static byte[] seq(byte[]... p) { return der(0x30, p); }
    private static byte[] set(byte[]... p) { return der(0x31, p); }

    private static byte[] oid(String dotted) {
        String[] parts = dotted.split("\\.");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(40 * Integer.parseInt(parts[0]) + Integer.parseInt(parts[1]));
        for (int i = 2; i < parts.length; i++) {
            long v = Long.parseLong(parts[i]);
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            List<Integer> bytes = new ArrayList<>();
            bytes.add((int) (v & 127));
            for (v >>>= 7; v > 0; v >>>= 7) bytes.add(0, (int) ((v & 127) | 128));
            for (int x : bytes) b.write(x);
            byte[] bb = b.toByteArray();
            out.write(bb, 0, bb.length);
        }
        return der(0x06, out.toByteArray());
    }

    /** A certificate request; deviceIds (TV DUIDs) make it a distributor request. Returns PEM. */
    public static String certificateRequest(String cn, String email, KeyPair keys, List<String> deviceIds) throws GeneralSecurityException {
        List<byte[]> rdn = new ArrayList<>();
        rdn.add(set(seq(oid("2.5.4.3"), der(0x0c, cn.getBytes(StandardCharsets.UTF_8)))));
        if (email != null && !email.isEmpty()) rdn.add(set(seq(oid("1.2.840.113549.1.9.1"), der(0x16, email.getBytes(StandardCharsets.US_ASCII)))));
        byte[] attributes = der(0xa0);
        if (deviceIds != null) {
            List<byte[]> uris = new ArrayList<>();
            uris.add(der(0x86, "URN:tizen:packageid=".getBytes(StandardCharsets.US_ASCII)));
            for (String d : deviceIds) uris.add(der(0x86, ("URN:tizen:deviceid=" + d).getBytes(StandardCharsets.US_ASCII)));
            byte[] altNames = seq(oid("2.5.29.17"), der(0x04, seq(uris.toArray(new byte[0][]))));
            attributes = der(0xa0, seq(oid("1.2.840.113549.1.9.14"), set(seq(altNames))));
        }
        byte[] info = seq(der(0x02, new byte[] { 0 }), seq(rdn.toArray(new byte[0][])), keys.getPublic().getEncoded(), attributes);
        Signature rsa = Signature.getInstance("SHA512withRSA");
        rsa.initSign(keys.getPrivate());
        rsa.update(info);
        byte[] sig = rsa.sign();
        byte[] bits = new byte[sig.length + 1];
        System.arraycopy(sig, 0, bits, 1, sig.length);
        byte[] csr = seq(info, seq(oid("1.2.840.113549.1.1.13"), der(0x05)), der(0x03, bits));
        return "-----BEGIN CERTIFICATE REQUEST-----\n" + wrap(b64(csr), 64) + "\n-----END CERTIFICATE REQUEST-----\n";
    }

    public static KeyPair newKeys() throws GeneralSecurityException {
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048);
        return g.generateKeyPair();
    }

    public static String privateKeyPem(KeyPair keys) {
        return "-----BEGIN PRIVATE KEY-----\n" + wrap(b64(keys.getPrivate().getEncoded()), 64) + "\n-----END PRIVATE KEY-----\n";
    }
}
