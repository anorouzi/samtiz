package ir.pardeh.tv;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/**
 * A small client for a Samsung TV's developer port (sdb, Tizen's version of adb, port 26101):
 * the TV's id, copying a file, and the few shell commands the TV allows (getduid, vd_appinstall,
 * was_execute). Same protocol as hub/sdb.mjs. The TV only answers the device whose IP was entered
 * in its Developer Mode settings. One stream at a time, which is all installing needs.
 */
public class Sdb implements AutoCloseable {
    private static final int CNXN = cmd("CNXN"), OPEN = cmd("OPEN"), OKAY = cmd("OKAY"), CLSE = cmd("CLSE"), WRTE = cmd("WRTE");

    private final Socket socket;
    private final InputStream in;
    private final OutputStream out;
    private int maxData = 4096;
    private int nextId = 1;
    public String banner = "";

    private static int cmd(String s) {
        return ByteBuffer.wrap(s.getBytes(StandardCharsets.US_ASCII)).order(ByteOrder.LITTLE_ENDIAN).getInt();
    }

    public Sdb(String host) throws IOException {
        socket = new Socket();
        socket.connect(new InetSocketAddress(host, 26101), 6000);
        socket.setSoTimeout(120000);
        in = socket.getInputStream();
        out = socket.getOutputStream();
        send(CNXN, 0x01000000, 4096, "host::\0".getBytes(StandardCharsets.US_ASCII));
        Packet p = read();
        if (p.cmd != CNXN) throw new IOException("the TV didn't answer the connection");
        maxData = Math.min(p.arg1 == 0 ? 4096 : p.arg1, 256 * 1024);
        banner = new String(p.data, StandardCharsets.UTF_8).replace("\0", "");
    }

    @Override
    public void close() {
        try { socket.close(); } catch (IOException ignored) { }
    }

    private static class Packet {
        int cmd, arg0, arg1;
        byte[] data;
    }

    private void send(int cmd, int arg0, int arg1, byte[] data) throws IOException {
        ByteBuffer h = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN);
        int sum = 0;
        for (byte b : data) sum += b & 0xff;   // sdb's "checksum" is a plain byte sum
        h.putInt(cmd).putInt(arg0).putInt(arg1).putInt(data.length).putInt(sum).putInt(~cmd);
        out.write(h.array());
        out.write(data);
        out.flush();
    }

    private Packet read() throws IOException {
        byte[] head = readFully(24);
        ByteBuffer h = ByteBuffer.wrap(head).order(ByteOrder.LITTLE_ENDIAN);
        Packet p = new Packet();
        p.cmd = h.getInt();
        p.arg0 = h.getInt();
        p.arg1 = h.getInt();
        p.data = readFully(h.getInt());
        return p;
    }

    private byte[] readFully(int n) throws IOException {
        byte[] b = new byte[n];
        for (int off = 0; off < n; ) {
            int r = in.read(b, off, n - off);
            if (r < 0) throw new IOException("the TV closed the connection");
            off += r;
        }
        return b;
    }

    /** Reads the next packet for stream `local`; packets left over from earlier streams are skipped. */
    private Packet readFor(int local) throws IOException {
        while (true) {
            Packet p = read();
            if (p.arg1 == local) return p;
        }
    }

    /** Opens a service ("shell:…", "sync:"); returns {local id, remote id}. */
    private int[] open(String service) throws IOException {
        int local = nextId++;
        send(OPEN, local, 0, (service + "\0").getBytes(StandardCharsets.UTF_8));
        Packet p = readFor(local);
        if (p.cmd == CLSE) throw new IOException("the TV refused \"" + service + "\"");
        if (p.cmd != OKAY) throw new IOException("unexpected answer to \"" + service + "\"");
        return new int[] { local, p.arg0 };
    }

    /** Runs a shell command and returns everything it printed. */
    public String shell(String command) throws IOException {
        int[] s = open("shell:" + command);
        ByteArrayOutputStream text = new ByteArrayOutputStream();
        while (true) {
            Packet p = readFor(s[0]);
            if (p.cmd == WRTE) {
                text.write(p.data);
                send(OKAY, s[0], s[1], new byte[0]);
            } else if (p.cmd == CLSE) {
                return text.toString("UTF-8");
            }
        }
    }

    /** Writes data in pieces the TV accepts, waiting for its OKAY after each one; anything the TV
     *  writes back meanwhile is kept in `replies`. */
    private void write(int[] s, byte[] data, ByteArrayOutputStream replies) throws IOException {
        for (int i = 0; i < data.length; i += maxData) {
            int n = Math.min(maxData, data.length - i);
            byte[] part = new byte[n];
            System.arraycopy(data, i, part, 0, n);
            send(WRTE, s[0], s[1], part);
            while (true) {
                Packet p = readFor(s[0]);
                if (p.cmd == OKAY) break;
                if (p.cmd == CLSE) throw new IOException("the TV closed the stream");
                if (p.cmd == WRTE) { replies.write(p.data); send(OKAY, s[0], s[1], new byte[0]); }
            }
        }
    }

    private static byte[] frame(String id, int value, byte[] payload) {
        ByteBuffer b = ByteBuffer.allocate(8 + payload.length).order(ByteOrder.LITTLE_ENDIAN);
        b.put(id.getBytes(StandardCharsets.US_ASCII)).putInt(value).put(payload);
        return b.array();
    }

    /** Copies data to a file on the TV (sync protocol: SEND, DATA…, DONE; the TV answers OKAY or FAIL). */
    public void push(String remotePath, byte[] data) throws IOException {
        int[] s = open("sync:");
        ByteArrayOutputStream req = new ByteArrayOutputStream();
        byte[] target = (remotePath + "," + 0100644).getBytes(StandardCharsets.UTF_8);
        req.write(frame("SEND", target.length, target));
        for (int i = 0; i < data.length; i += 64 * 1024) {
            int n = Math.min(64 * 1024, data.length - i);
            byte[] part = new byte[n];
            System.arraycopy(data, i, part, 0, n);
            req.write(frame("DATA", n, part));
        }
        req.write(frame("DONE", (int) (System.currentTimeMillis() / 1000), new byte[0]));
        ByteArrayOutputStream reply = new ByteArrayOutputStream();
        write(s, req.toByteArray(), reply);
        while (reply.size() < 8) {
            Packet p = readFor(s[0]);
            if (p.cmd == WRTE) { reply.write(p.data); send(OKAY, s[0], s[1], new byte[0]); }
            else if (p.cmd == CLSE) break;
        }
        // Say goodbye and close our end without waiting; late packets for this stream are skipped.
        send(WRTE, s[0], s[1], frame("QUIT", 0, new byte[0]));
        send(CLSE, s[0], s[1], new byte[0]);
        byte[] r = reply.toByteArray();
        String status = r.length >= 4 ? new String(r, 0, 4, StandardCharsets.US_ASCII) : "";
        if (!"OKAY".equals(status)) {
            String msg = r.length > 8 ? new String(r, 8, r.length - 8, StandardCharsets.UTF_8) : status;
            throw new IOException("copying to the TV failed: " + (msg.isEmpty() ? "no answer" : msg));
        }
    }
}
