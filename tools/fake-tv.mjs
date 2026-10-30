// A pretend Samsung TV for testing the installers (hub /install, the Android app) without a TV:
// the REST API on :8001 and the developer port (sdb) on :26101 of the given address.
//   node tools/fake-tv.mjs <ip-to-listen-on> [developer-ip]
// It answers getduid with FAKEDUID1234 and vd_appinstall with "install completed", and records
// every command in fake-tv.log and every copied file in fake-tv-files/ (in the current folder).
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';

const [IP, DEV_IP = IP] = process.argv.slice(2);
if (!IP) { console.log('usage: node tools/fake-tv.mjs <ip-to-listen-on> [developer-ip]'); process.exit(1); }
const C = {};
for (const n of ['CNXN', 'OPEN', 'OKAY', 'CLSE', 'WRTE']) C[n] = Buffer.from(n).readUInt32LE(0);
const rec = (o) => fs.appendFileSync('fake-tv.log', JSON.stringify(o) + '\n');
fs.mkdirSync('fake-tv-files', { recursive: true });

function pkt(cmd, a0, a1, data = Buffer.alloc(0)) {
    const h = Buffer.alloc(24);
    let s = 0;
    for (const b of data) s = (s + b) >>> 0;
    h.writeUInt32LE(cmd, 0); h.writeUInt32LE(a0, 4); h.writeUInt32LE(a1, 8); h.writeUInt32LE(data.length, 12);
    h.writeUInt32LE(s, 16); h.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20);
    return Buffer.concat([h, data]);
}

http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/api/v2/applications/')) return res.end(JSON.stringify({ running: false }));
    res.end(JSON.stringify({ device: { name: '[TV] Fake', modelName: 'UA00FAKE', developerMode: '1', developerIP: DEV_IP } }));
}).listen(8001, IP);

net.createServer((sock) => {
    let buf = Buffer.alloc(0), nextId = 1000;
    const streams = new Map();   // TV-side id -> { host, service, sync, path, file }
    const send = (b) => sock.write(b);
    const reply = (st, text) => { send(pkt(C.WRTE, st.dev, st.host, Buffer.from(text))); send(pkt(C.CLSE, st.dev, st.host)); };
    sock.on('error', () => {});
    sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 24) {
            const len = buf.readUInt32LE(12);
            if (buf.length < 24 + len) break;
            const cmd = buf.readUInt32LE(0), a0 = buf.readUInt32LE(4), a1 = buf.readUInt32LE(8), data = buf.subarray(24, 24 + len);
            buf = buf.subarray(24 + len);
            if (cmd === C.CNXN) { send(pkt(C.CNXN, 0x01000000, 4096, Buffer.from('device::ro.product.model=fake\0'))); continue; }
            if (cmd === C.OPEN) {
                const st = { host: a0, dev: nextId++, service: data.toString().replace(/\0/g, ''), sync: Buffer.alloc(0) };
                streams.set(st.dev, st);
                send(pkt(C.OKAY, st.dev, st.host));
                rec({ open: st.service });
                if (st.service === 'shell:0 getduid') reply(st, 'FAKEDUID1234\n');
                else if (st.service.startsWith('shell:0 vd_appinstall')) reply(st, 'spend time for wascmd is [1200]ms\napp_id[TvPlayr001] install completed\n');
                else if (st.service.startsWith('shell:')) reply(st, 'ok\n');
                continue;
            }
            const st = streams.get(a1);
            if (!st) continue;
            if (cmd === C.WRTE) {
                send(pkt(C.OKAY, st.dev, st.host));
                st.sync = Buffer.concat([st.sync, data]);
                for (;;) {   // complete sync requests: SEND path,mode / DATA chunk / DONE mtime / QUIT
                    const s = st.sync;
                    if (s.length < 8) break;
                    const id = s.subarray(0, 4).toString(), n = s.readUInt32LE(4);
                    if ((id === 'SEND' || id === 'DATA') && s.length < 8 + n) break;
                    if (id === 'SEND') { st.path = s.subarray(8, 8 + n).toString(); st.file = []; st.sync = s.subarray(8 + n); }
                    else if (id === 'DATA') { st.file.push(Buffer.from(s.subarray(8, 8 + n))); st.sync = s.subarray(8 + n); }
                    else if (id === 'DONE') {
                        const file = Buffer.concat(st.file), name = st.path.split(',')[0];
                        fs.writeFileSync('fake-tv-files/' + name.replace(/\//g, '_'), file);
                        rec({ pushed: st.path, bytes: file.length });
                        st.sync = s.subarray(8);
                        send(pkt(C.WRTE, st.dev, st.host, Buffer.from('OKAY\0\0\0\0')));
                    } else if (id === 'QUIT') { st.sync = s.subarray(8); send(pkt(C.CLSE, st.dev, st.host)); }
                    else { rec({ badSync: id }); st.sync = Buffer.alloc(0); }
                }
            } else if (cmd === C.CLSE) streams.delete(a1);
        }
    });
}).listen(26101, IP, () => console.log(`fake TV on ${IP} (developer IP ${DEV_IP})`));
