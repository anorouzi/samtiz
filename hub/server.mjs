// TV Hub — lets phones/computers on the local network send video links to TV Player.
// Run: node ~/TVHub/server.mjs   (then open http://<this-mac-ip>:8090 on your phone)
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { handleInstall } from './installer.mjs';

const PORT = Number(process.env.HUB_PORT) || 8090;   // Pardeh looks for 8090; another port is for testing
const DIR = path.dirname(fileURLToPath(import.meta.url));
const YTDLP = path.join(DIR, 'bin', 'yt-dlp');
const LOG = path.join(DIR, 'tv.log');

const tvClients = new Set();   // open SSE connections from TVs
const recent = [];             // last links sent, newest first

// Prefer the Wi-Fi interface (en0) so a VPN tunnel address is never shown.
function lanAddress() {
    const ifaces = os.networkInterfaces();
    const lists = [ifaces.en0 || [], ...Object.values(ifaces)];
    for (const list of lists) {
        const a = list.find((x) => x.family === 'IPv4' && !x.internal);
        if (a) return a.address;
    }
    return 'localhost';
}

function isDirect(url) {
    return /aparat\.com\/v\//.test(url) || /\.(mp4|m3u8|mkv|webm|mov|ts)(\?|$)/i.test(url);
}

// For pages from other sites, ask yt-dlp for a playable stream URL.
function resolve(url) {
    return new Promise((done) => {
        if (isDirect(url) || !fs.existsSync(YTDLP)) return done({ url, title: '' });
        execFile(YTDLP, ['-g', '-f', 'best[height<=1080][vcodec!=none][acodec!=none]/best', '--get-title', '--no-playlist', url],
            { timeout: 45000 }, (err, stdout) => {
                const lines = (stdout || '').trim().split('\n').filter(Boolean);
                if (err || lines.length < 2) return done({ url, title: '', note: 'could not resolve, sending as-is' });
                done({ title: lines[0], url: lines[lines.length - 1] });
            });
    });
}

function broadcast(msg) {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of tvClients) res.write(data);
    return tvClients.size;
}

function readBody(req) {
    return new Promise((done) => {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
        req.on('end', () => { try { done(JSON.parse(body || '{}')); } catch { done({}); } });
    });
}

// The 2016 TV can't verify modern HTTPS certificates (e.g. Let's Encrypt), so the hub
// fetches those streams itself and hands them to the TV over plain HTTP.
// HLS playlists are rewritten so every segment also goes through the hub.
async function proxy(req, res, target) {
    const self = `http://${req.headers.host}/proxy?u=`;
    const viaHub = (u, seg) => self + encodeURIComponent(u) + (seg ? '&seg=1' : '');
    const isSegment = new URL(req.url, 'http://x').searchParams.get('seg') === '1';
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (req.headers.range) headers.Range = req.headers.range;
    const ctrl = new AbortController();
    req.on('close', () => ctrl.abort());
    const up = await fetch(target, { headers, redirect: 'follow', signal: ctrl.signal });
    const type = up.headers.get('content-type') || '';
    if (/mpegurl/i.test(type) || /\.m3u8$/i.test(new URL(up.url).pathname)) {
        const text = await up.text();
        let lastTag = '';
        const out = text.split('\n').map((line) => {
            const t = line.trim();
            if (!t) return line;
            if (/^EXT/i.test(t)) return '#' + t;   // some servers drop the leading '#'
            if (t.startsWith('#')) {
                lastTag = t.split(':')[0];
                return line.replace(/URI="([^"]+)"/g, (m, u) => `URI="${viaHub(new URL(u, up.url).href)}"`);
            }
            // A URI after #EXTINF is a media segment; after #EXT-X-STREAM-INF it's another playlist.
            return viaHub(new URL(t, up.url).href, lastTag === '#EXTINF');
        }).join('\n');
        res.writeHead(up.status, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
        return res.end(out);
    }
    const out = { 'Access-Control-Allow-Origin': '*' };
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = up.headers.get(k);
        if (v && !(k === 'content-length' && up.headers.get('content-encoding'))) out[k] = v;
    }
    if (isSegment && !/video|mp2t|octet/i.test(type)) out['content-type'] = 'video/mp2t';
    res.writeHead(up.status, out);
    if (!up.body) return res.end();
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}

// Streams a live HLS playlist as one continuous MPEG-TS file, so the TV's download manager can
// record it straight to USB (the TV's own file writer can't handle big files). Ends when the TV
// disconnects, the playlist ends, or after maxSec.
async function record(req, res, target, maxSec) {
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let open = true;
    req.on('close', () => { open = false; });
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-cache' });
    const seen = new Set();
    const until = Date.now() + maxSec * 1000;
    while (open && Date.now() < until) {
        let text, base;
        try {
            const r = await fetch(target, { headers, redirect: 'follow' });
            text = await r.text(); base = r.url;
        } catch { await sleep(2000); continue; }
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        // A master playlist: switch to the best variant up to 720p.
        if (lines.some((l) => l.includes('EXT-X-STREAM-INF'))) {
            let pick = null, best = 0;
            lines.forEach((l, i) => {
                const m = l.match(/RESOLUTION=\d+x(\d+)/);
                const h = m ? +m[1] : 0;
                if (m && h <= 720 && h >= best && lines[i + 1] && !lines[i + 1].startsWith('#')) { best = h; pick = lines[i + 1]; }
            });
            if (!pick) { res.end(); return; }
            target = new URL(pick, base).href;
            continue;
        }
        let dur = 4, ended = false;
        const segs = [];
        for (const l of lines) {
            const tag = l.replace(/^#?/, '#');
            if (tag.startsWith('#EXT-X-TARGETDURATION:')) dur = parseFloat(tag.split(':')[1]) || dur;
            else if (tag.startsWith('#EXT-X-ENDLIST')) ended = true;
            else if (!l.startsWith('#') && !/^EXT/i.test(l)) segs.push(new URL(l, base).href);
        }
        for (const s of segs) {
            if (!open || seen.has(s)) continue;
            seen.add(s);
            try {
                const buf = Buffer.from(await (await fetch(s, { headers })).arrayBuffer());
                if (!res.write(buf)) await new Promise((r) => res.once('drain', r));
            } catch { /* skip a missing segment, keep recording */ }
        }
        if (seen.size > 2000) { const keep = [...seen].slice(-500); seen.clear(); keep.forEach((x) => seen.add(x)); }
        if (ended) break;
        await sleep(Math.max(1000, dur * 500));
    }
    res.end();
}

function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST' });
        return res.end();
    }

    if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return fs.createReadStream(path.join(DIR, 'phone.html')).pipe(res);
    }

    // Installing Pardeh on a TV over Wi-Fi (see installer.mjs).
    if (pathname === '/install' || pathname.startsWith('/install/')) {
        try { return await handleInstall(req, res, pathname); } catch (e) {
            if (!res.headersSent) { res.writeHead(500); res.end(String(e.message)); }
            return;
        }
    }

    // TVs keep this open and receive "play" commands.
    if (pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
        res.write('retry: 3000\n\n');
        tvClients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clearInterval(ping); tvClients.delete(res); });
        return;
    }

    if (pathname === '/api/send' && req.method === 'POST') {
        const { url } = await readBody(req);
        if (!url || !/^https?:\/\//.test(url.trim())) return json(res, 400, { ok: false, error: 'invalid link' });
        const item = await resolve(url.trim());
        item.source = url.trim();
        recent.unshift({ ...item, time: Date.now() });
        recent.length = Math.min(recent.length, 20);
        const tvs = broadcast({ type: 'play', url: item.url, title: item.title });
        return json(res, 200, { ok: true, tvs, title: item.title, note: item.note });
    }

    if (pathname === '/proxy') {
        const target = new URL(req.url, 'http://x').searchParams.get('u');
        if (!target || !/^https?:\/\//.test(target)) { res.writeHead(400); return res.end('bad url'); }
        const t0 = Date.now();
        res.on('finish', () => {
            if (process.env.HUB_DEBUG) console.log(`${new Date().toISOString()} proxy ${res.statusCode} ${Date.now() - t0}ms ${req.headers.range || ''} ${target.slice(-60)}`);
        });
        try { await proxy(req, res, target); } catch (e) {
            if (!res.headersSent) { res.writeHead(502); res.end(String(e.message)); } else res.destroy();
        }
        return;
    }

    // Presses a remote button inside TV Player (key codes as in the app, e.g. 416 = Record).
    if (pathname === '/api/key' && req.method === 'POST') {
        const { code } = await readBody(req);
        return json(res, 200, { ok: true, tvs: broadcast({ type: 'key', code: Number(code) }) });
    }

    if (pathname === '/record') {
        const q = new URL(req.url, 'http://x').searchParams;
        const target = q.get('u');
        if (!target || !/^https?:\/\//.test(target)) { res.writeHead(400); return res.end('bad url'); }
        try { await record(req, res, target, Math.min(+q.get('max') || 6 * 3600, 12 * 3600)); } catch { res.destroy(); }
        return;
    }

    if (pathname === '/api/status') {
        return json(res, 200, { tvs: tvClients.size, recent, address: `http://${lanAddress()}:${PORT}` });
    }

    // TV Player reports diagnostics here so they can be read on the Mac.
    if (pathname === '/api/log' && req.method === 'POST') {
        const body = await readBody(req);
        fs.appendFileSync(LOG, `${new Date().toISOString()} ${JSON.stringify(body)}\n`);
        return json(res, 200, { ok: true });
    }

    res.writeHead(404); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`TV Hub running — open http://${lanAddress()}:${PORT} on your phone`);
});
