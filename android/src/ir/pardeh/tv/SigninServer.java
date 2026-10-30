package ir.pardeh.tv;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Receives the Samsung account sign-in: Samsung sends the browser back to
 * http://localhost:4794/signin/callback with the token in the address or a posted form (possibly
 * wrapped as JSON in "code"), the same way Tizen Studio's Certificate Manager receives it.
 */
public class SigninServer extends Thread {
    public interface Listener {
        void onSignedIn(String accessToken, String userId, String email);
        void onFailed(String why);
    }

    private final Listener listener;
    private ServerSocket server;

    public SigninServer(Listener listener) {
        this.listener = listener;
        setDaemon(true);
    }

    public void startListening() throws IOException {
        server = new ServerSocket(SamsungCert.SIGNIN_PORT, 4, InetAddress.getByName("127.0.0.1"));
        start();
    }

    public void shutdown() {
        try { if (server != null) server.close(); } catch (IOException ignored) { }
    }

    @Override
    public void run() {
        while (!server.isClosed()) {
            try (Socket s = server.accept()) {
                s.setSoTimeout(15000);
                handle(s);
            } catch (IOException ignored) { }
        }
    }

    private void handle(Socket s) throws IOException {
        InputStream in = s.getInputStream();
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int prev3 = 0;
        for (int b; (b = in.read()) >= 0; ) {   // up to the blank line after the headers
            head.write(b);
            prev3 = (prev3 << 8 | b) & 0xffffffff;
            if (prev3 == 0x0d0a0d0a) break;
        }
        String headers = head.toString("UTF-8");
        String[] first = headers.split("\r\n", 2)[0].split(" ");
        String target = first.length > 1 ? first[1] : "/";
        Matcher len = Pattern.compile("(?i)content-length:\\s*(\\d+)").matcher(headers);
        byte[] body = new byte[len.find() ? Integer.parseInt(len.group(1)) : 0];
        for (int off = 0; off < body.length; ) {
            int r = in.read(body, off, body.length - off);
            if (r < 0) break;
            off += r;
        }
        Map<String, String> fields = new HashMap<>();
        if (target.contains("?")) parseForm(target.substring(target.indexOf('?') + 1), fields);
        String text = new String(body, StandardCharsets.UTF_8).trim();
        if (text.startsWith("{")) parseJson(text, fields); else parseForm(text, fields);
        if (fields.containsKey("code") && fields.get("code").trim().startsWith("{")) parseJson(fields.get("code"), fields);

        String token = fields.get("access_token");
        String user = fields.containsKey("userId") ? fields.get("userId") : fields.get("user_id");
        String email = fields.containsKey("inputEmailID") ? fields.get("inputEmailID") : fields.get("email");
        boolean ok = token != null && user != null && target.startsWith("/signin");
        if (target.startsWith("/signin")) {
            if (ok) listener.onSignedIn(token, user, email);
            else listener.onFailed("Samsung didn't send the sign-in details (fields: " + fields.keySet() + ")");
        }
        String page = "<!doctype html><html dir=\"rtl\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"></head>"
            + "<body style=\"font-family:sans-serif;background:#0f1115;color:#e8eaf0;padding:30px\"><h2>"
            + (ok ? "ورود انجام شد ✓ در حال ساختن گواهی..." : "ورود کامل نشد") + "</h2></body></html>";
        byte[] out = page.getBytes(StandardCharsets.UTF_8);
        OutputStream o = s.getOutputStream();
        o.write(("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + out.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        o.write(out);
        o.flush();
    }

    static void parseForm(String s, Map<String, String> into) {
        for (String pair : s.split("&")) {
            int eq = pair.indexOf('=');
            if (eq <= 0) continue;
            try {
                into.put(URLDecoder.decode(pair.substring(0, eq), "UTF-8"), URLDecoder.decode(pair.substring(eq + 1), "UTF-8"));
            } catch (IllegalArgumentException | IOException ignored) { }
        }
    }

    /** Flat "key": "value" pairs, which is all the sign-in sends. */
    static void parseJson(String s, Map<String, String> into) {
        Matcher m = Pattern.compile("\"([^\"]+)\"\\s*:\\s*(?:\"((?:[^\"\\\\]|\\\\.)*)\"|([0-9.eE+-]+|true|false))").matcher(s);
        while (m.find()) into.put(m.group(1), m.group(2) != null ? m.group(2).replace("\\\"", "\"").replace("\\/", "/") : m.group(3));
    }
}
