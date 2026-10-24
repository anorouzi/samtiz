// A small client for a Samsung TV's developer port (sdb, Tizen's version of adb, port 26101).
// It covers what installing an app needs: the TV's id, copying a file, and the few shell commands
// the TV allows (getduid, vd_appinstall, vd_appuninstall, was_execute). No npm packages.
// The TV only answers the computer whose IP was entered in its Developer Mode settings.
import net from 'node:net';

const CMD = {};
for (const name of ['CNXN', 'OPEN', 'OKAY', 'CLSE', 'WRTE']) CMD[name] = Buffer.from(name).readUInt32LE(0);

function packet(cmd, arg0, arg1, data = Buffer.alloc(0)) {
    const head = Buffer.alloc(24);
    let sum = 0;
    for (const b of data) sum = (sum + b) >>> 0;   // sdb's "checksum" is a plain byte sum
    head.writeUInt32LE(cmd, 0);
    head.writeUInt32LE(arg0, 4);
    head.writeUInt32LE(arg1, 8);
    head.writeUInt32LE(data.length, 12);
    head.writeUInt32LE(sum, 16);
    head.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20);
    return Buffer.concat([head, data]);
}

// Sync-protocol frame: 4-byte id + little-endian length (or value) + payload.
function syncFrame(id, value, payload = Buffer.alloc(0)) {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32LE(value, 4);
    return Buffer.concat([head, payload]);
}

export class Sdb {
    constructor(socket) {
        this.socket = socket;
        this.buf = Buffer.alloc(0);
        this.streams = new Map();   // local id -> stream state
        this.nextId = 1;
        this.maxData = 4096;
        this.banner = '';
        this.closed = false;
    }

    static connect(host, port = 26101, timeoutMs = 6000) {
        return new Promise((resolve, reject) => {
            const socket = net.connect(port, host);
            const sdb = new Sdb(socket);
            const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, timeoutMs);
            sdb.onConnect = () => { clearTimeout(timer); resolve(sdb); };
            socket.on('connect', () => socket.write(packet(CMD.CNXN, 0x01000000, 4096, Buffer.from('host::\0'))));
            socket.on('data', (d) => sdb._read(d));
            socket.on('error', (e) => { clearTimeout(timer); sdb._fail(e); reject(e); });
            socket.on('close', () => {
                clearTimeout(timer);
                sdb._fail(new Error('connection closed'));
                reject(new Error('the TV closed the connection (is this computer\'s IP set in its Developer Mode?)'));
            });
        });
    }

    close() {
        this.closed = true;
        this.socket.destroy();
    }

    _fail(err) {
        this.closed = true;
        for (const s of this.streams.values()) s.onClose(err);
        this.streams.clear();
    }

    _read(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        while (this.buf.length >= 24) {
            const len = this.buf.readUInt32LE(12);
            if (this.buf.length < 24 + len) return;
            const cmd = this.buf.readUInt32LE(0), arg0 = this.buf.readUInt32LE(4), arg1 = this.buf.readUInt32LE(8);
            const data = this.buf.subarray(24, 24 + len);
            this.buf = this.buf.subarray(24 + len);
            this._packet(cmd, arg0, arg1, Buffer.from(data));
        }
    }

    _packet(cmd, arg0, arg1, data) {
        if (cmd === CMD.CNXN) {
            this.maxData = Math.min(arg1 || 4096, 256 * 1024);
            this.banner = data.toString('utf8').replace(/\0/g, '');
            return this.onConnect && this.onConnect();
        }
        const s = this.streams.get(arg1);
        if (!s) return;
        if (cmd === CMD.OKAY) {
            if (s.remote === null) { s.remote = arg0; s.onOpen(); } else s.onAck();
        } else if (cmd === CMD.WRTE) {
            this.socket.write(packet(CMD.OKAY, s.local, s.remote));
            s.onData(data);
        } else if (cmd === CMD.CLSE) {
            this.streams.delete(s.local);
            s.onClose();
        }
    }

    // Opens a service ("shell:…", "sync:") and resolves with its stream once the TV accepts it.
    _open(service) {
        if (this.closed) return Promise.reject(new Error('not connected'));
        return new Promise((resolve, reject) => {
            const s = {
                local: this.nextId++, remote: null, chunks: [], acks: [], ended: null,
                onOpen: () => resolve(s),
                onAck: () => { const a = s.acks.shift(); if (a) a(); },
                onData: (d) => { s.chunks.push(d); if (s.onChunk) s.onChunk(); },
                onClose: (err) => { s.ended = err || true; if (s.remote === null) reject(err || new Error(`the TV refused "${service}"`)); if (s.onEnd) s.onEnd(); }
            };
            this.streams.set(s.local, s);
            this.socket.write(packet(CMD.OPEN, s.local, 0, Buffer.from(service + '\0')));
        });
    }

    // Writes to a stream in pieces the TV accepts, waiting for its OK after each one.
    async _write(s, data) {
        for (let i = 0; i < data.length; i += this.maxData) {
            if (s.ended) throw new Error('the TV closed the stream');
            await new Promise((ack) => {
                s.acks.push(ack);
                this.socket.write(packet(CMD.WRTE, s.local, s.remote, data.subarray(i, i + this.maxData)));
            });
        }
    }

    // Runs a shell command and resolves with everything it printed.
    async shell(command, timeoutMs = 120000) {
        const s = await this._open('shell:' + command);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`"${command}" took too long`)), timeoutMs);
            s.onEnd = () => { clearTimeout(timer); resolve(Buffer.concat(s.chunks).toString('utf8')); };
            if (s.ended) s.onEnd();
        });
    }

    // Copies data to a file on the TV (sync protocol: SEND, DATA…, DONE; the TV answers OKAY/FAIL).
    async push(remotePath, data, mode = 0o100644) {
        const s = await this._open('sync:');
        const frames = [syncFrame('SEND', 0, Buffer.from(`${remotePath},${mode}`))];
        frames[0].writeUInt32LE(frames[0].length - 8, 4);
        for (let i = 0; i < data.length; i += 64 * 1024) {
            const part = data.subarray(i, i + 64 * 1024);
            frames.push(syncFrame('DATA', part.length, part));
        }
        frames.push(syncFrame('DONE', Math.floor(Date.now() / 1000)));
        const reply = new Promise((resolve) => {
            s.onChunk = () => { if (Buffer.concat(s.chunks).length >= 8) resolve(Buffer.concat(s.chunks)); };
            s.onEnd = () => resolve(Buffer.concat(s.chunks));
        });
        await this._write(s, Buffer.concat(frames));
        const r = await reply;
        await this._write(s, syncFrame('QUIT', 0)).catch(() => {});
        const status = r.subarray(0, 4).toString('ascii');
        if (status !== 'OKAY') throw new Error(`copying to the TV failed: ${r.subarray(8).toString('utf8') || status || 'no answer'}`);
    }
}
