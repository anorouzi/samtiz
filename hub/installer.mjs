// "Install Pardeh on a TV" (/install): finds Samsung TVs on the network, gets a Samsung certificate
// for the chosen TV after a Samsung account sign-in, signs the app in ../app and installs it over
// Wi-Fi through the TV's developer port. Nothing but Node is needed, so it also runs on an Android
// phone (Termux). The sign-in must happen in a browser on the device running the hub, because
// Samsung sends the browser back to localhost.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sdb } from './sdb.mjs';
import { appFiles, signPackage, createSamsungCertificate, SIGNIN_URL, SIGNIN_PORT } from './signing.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(DIR, '..', 'app');
const CERT_DIR = path.join(DIR, 'certs');   // one certificate per TV, with private keys: never commit
const PKG = 'TvPlayr001';
const APP_ID = 'TvPlayr001.TVPlayer';

const job = { tv: null, busy: false, log: [], done: false };

function log(msg) {
    job.log.push({ t: Date.now(), msg });
    if (job.log.length > 100) job.log.shift();
    console.log('[install]', msg);
}

// The app is packaged from the project folder, so the hub has to run from there (samtiz/hub).
const appFound = () => fs.existsSync(path.join(APP_DIR, 'config.xml'));
const certFile = (duid) => path.join(CERT_DIR, duid.replace(/[^A-Za-z0-9_-]/g, '') + '.json');
const hasCert = (duid) => !!duid && fs.existsSync(certFile(duid));

// This device's addresses on the local network: one of them goes into the TV's Developer Mode.
function lanAddresses() {
    const ifaces = os.networkInterfaces(), out = [];
    for (const name of ['en0', 'wlan0', ...Object.keys(ifaces)]) {
        for (const a of ifaces[name] || []) {
            if (a.family === 'IPv4' && !a.internal && !out.includes(a.address)) out.push(a.address);
        }
    }
    return out;
}

async function tvInfo(ip, timeout = 1500) {
    const res = await fetch(`http://${ip}:8001/api/v2/`, { signal: AbortSignal.timeout(timeout) });
    const d = (await res.json()).device || {};
    return { ip, name: d.name, model: d.modelName, developerMode: d.developerMode === '1', developerIP: d.developerIP };
}

// Looks for Samsung TVs (their REST API on port 8001) on this device's /24 networks.
async function scan() {
    const ips = [];
    for (const a of lanAddresses()) {
        const prefix = a.split('.').slice(0, 3).join('.');
        for (let i = 1; i < 255; i++) if (`${prefix}.${i}` !== a) ips.push(`${prefix}.${i}`);
    }
    const found = [];
    for (let i = 0; i < ips.length; i += 64) {
        const batch = await Promise.all(ips.slice(i, i + 64).map((ip) => tvInfo(ip).catch(() => null)));
        found.push(...batch.filter((t) => t && t.model));
    }
    return found;
}

async function connect(ip) {
    const info = await tvInfo(ip, 4000).catch(() => ({ ip }));
    const sdb = await Sdb.connect(ip).catch((e) => {
        throw new Error(e.message === 'timeout' || /ECONNREFUSED|closed/.test(e.message)
            ? 'تلویزیون اجازهٔ اتصال نداد — Developer Mode را روشن کنید، IP این دستگاه را در آن وارد کنید و تلویزیون را کامل خاموش و روشن کنید'
            : e.message);
    });
    try {
        const duid = (await sdb.shell('0 getduid')).trim();
        if (!/^[A-Za-z0-9]{6,}$/.test(duid)) throw new Error(`شناسهٔ تلویزیون خوانده نشد (${duid.slice(0, 60)})`);
        job.tv = { ...info, duid };
        log(`وصل شد: ${info.name || ip} (${info.model || 'مدل نامعلوم'})`);
    } finally { sdb.close(); }
}

// ---------- Samsung account sign-in (Samsung sends the browser back to localhost:4794) ----------
let signinServer = null;

function signinPage(title, text, ok) {
    return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>body{font-family:Tahoma,sans-serif;background:#0f1115;color:#e8eaf0;padding:32px;line-height:1.8}
h1{color:${ok ? '#3ecf8e' : '#ff4d6d'};font-size:26px}</style></head><body><h1>${title}</h1><p>${text}</p></body></html>`;
}

function readBody(req) {
    return new Promise((done) => {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => done(body));
    });
}

async function onSignin(req, res) {
    const send = (code, title, text, ok) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(signinPage(title, text, ok)); };
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/signin')) return send(404, 'پیدا نشد', '', false);
    // The token can arrive in the address or in a posted form, possibly wrapped as JSON in "code".
    const fields = Object.fromEntries(url.searchParams);
    const body = await readBody(req);
    if (body) Object.assign(fields, body.trim().startsWith('{') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)));
    if (fields.code && String(fields.code).trim().startsWith('{')) Object.assign(fields, JSON.parse(fields.code));
    const access = { accessToken: fields.access_token, userId: fields.userId || fields.user_id, email: fields.inputEmailID || fields.email };
    if (!access.accessToken || !access.userId) {
        log(`پاسخ ورود سامسونگ ناقص بود (فیلدها: ${Object.keys(fields).join(', ') || 'هیچ'})`);
        return send(400, 'ورود کامل نشد', 'سامسونگ اطلاعات ورود را نفرستاد. دوباره امتحان کنید.', false);
    }
    if (!job.tv) return send(409, 'تلویزیونی انتخاب نشده', 'به صفحهٔ نصب برگردید و اول به تلویزیون وصل شوید.', false);
    try {
        log('ورود به حساب سامسونگ انجام شد؛ در حال گرفتن گواهی برای این تلویزیون...');
        const cert = await createSamsungCertificate(access, job.tv.duid);
        fs.mkdirSync(CERT_DIR, { recursive: true });
        fs.writeFileSync(certFile(job.tv.duid), JSON.stringify(cert), { mode: 0o600 });
        log('گواهی سامسونگ برای این تلویزیون ساخته شد' + (cert.deviceProfile ? '' : ' (بدون device profile)'));
        send(200, 'گواهی آماده است', 'به صفحهٔ نصب برگردید و «نصب» را بزنید. این پنجره را می‌توانید ببندید.', true);
    } catch (e) {
        log('ساخت گواهی ممکن نشد: ' + e.message);
        send(502, 'ساخت گواهی ممکن نشد', e.message.replace(/</g, '&lt;'), false);
    }
}

function startSignin() {
    if (signinServer) return;
    signinServer = http.createServer((req, res) => onSignin(req, res).catch((e) => { res.writeHead(500); res.end(String(e.message)); }));
    signinServer.on('error', (e) => { log(`پورت ${SIGNIN_PORT} در دسترس نیست (${e.code}) — Tizen Studio یا برنامهٔ دیگری آن را گرفته است؟`); signinServer = null; });
    signinServer.listen(SIGNIN_PORT, '127.0.0.1');
}

// ---------- installing ----------
async function install() {
    const tv = job.tv;
    const cert = JSON.parse(fs.readFileSync(certFile(tv.duid), 'utf8'));
    log('ساختن و امضای بستهٔ پرده...');
    const wgt = signPackage(appFiles(APP_DIR), cert.author, cert.distributor);
    const running = await fetch(`http://${tv.ip}:8001/api/v2/applications/${APP_ID}`, { signal: AbortSignal.timeout(4000) })
        .then((r) => r.json()).then((a) => a.running === true).catch(() => false);
    // Installing over a running app can leave the TV needing a full restart (error 118).
    if (running) throw new Error('پرده روی تلویزیون باز است — اول با دو بار Back آن را ببندید، بعد دوباره «نصب» را بزنید');
    const sdb = await Sdb.connect(tv.ip);
    try {
        if (cert.deviceProfile) {
            // The "permit to install" profile: 2016 TVs read it from /home/developer, newer ones from sdk_tools.
            for (const p of ['/home/developer/device-profile.xml', '/home/owner/share/tmp/sdk_tools/device-profile.xml']) {
                await sdb.push(p, Buffer.from(cert.deviceProfile)).catch(() => {});
            }
        }
        log(`فرستادن بسته به تلویزیون (${Math.round(wgt.length / 1024)} KB)...`);
        let target = null;
        for (const p of ['/opt/usr/apps/tmp/pardeh.wgt', '/home/owner/share/tmp/sdk_tools/pardeh.wgt']) {
            try { await sdb.push(p, wgt); target = p; break; } catch (e) { log(`نوشتن در ${p} ممکن نشد: ${e.message}`); }
        }
        if (!target) throw new Error('فرستادن بسته به تلویزیون ممکن نشد');
        log('نصب روی تلویزیون (چند ثانیه)...');
        const out = await sdb.shell(`0 vd_appinstall ${PKG} ${target}`);
        const result = (out.match(/install (completed|failed)[^\n]*/) || [out.trim().split('\n').pop() || 'بی‌پاسخ'])[0];
        if (!/completed/.test(result)) throw new Error(`نصب انجام نشد: ${result}` + (/118/.test(result) ? ' — تلویزیون را کامل خاموش و روشن کنید و دوباره امتحان کنید' : ''));
        log('نصب شد ✓ — در حال باز کردن پرده روی تلویزیون');
        await sdb.shell(`0 was_execute ${APP_ID}`).catch(() => {});
    } finally { sdb.close(); }
}

async function run(task, label) {
    if (job.busy) throw new Error('یک کار دیگر در حال انجام است');
    job.busy = true;
    try { await task(); } catch (e) { log(`${label}: ${e.message}`); throw e; } finally { job.busy = false; }
}

function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(obj));
}

export async function handleInstall(req, res, pathname) {
    if (pathname === '/install' || pathname === '/install/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return fs.createReadStream(path.join(DIR, 'install.html')).pipe(res);
    }
    if (pathname === '/install/state') {
        return json(res, 200, { tv: job.tv, hasCert: hasCert(job.tv && job.tv.duid), busy: job.busy, log: job.log, addresses: lanAddresses(),
            signinUrl: SIGNIN_URL, appFound: appFound() });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    const body = await readBody(req);
    const args = body ? JSON.parse(body) : {};
    try {
        if (pathname === '/install/scan') return json(res, 200, { tvs: await scan() });
        if (pathname === '/install/connect') {
            await run(() => connect(String(args.ip || '').trim()), 'اتصال');
            return json(res, 200, { ok: true });
        }
        if (pathname === '/install/signin') {
            if (!job.tv) throw new Error('اول به تلویزیون وصل شوید');
            startSignin();
            return json(res, 200, { url: SIGNIN_URL });
        }
        if (pathname === '/install/run') {
            if (!job.tv || !hasCert(job.tv.duid)) throw new Error('اول به تلویزیون وصل شوید و گواهی بگیرید');
            if (!appFound()) throw new Error(`پوشهٔ app کنار هاب پیدا نشد (${APP_DIR}) — هاب را از داخل پوشهٔ پروژه اجرا کنید`);
            run(install, 'نصب').catch(() => {});   // progress shows up in the log
            return json(res, 202, { ok: true });
        }
        return json(res, 404, { error: 'not found' });
    } catch (e) {
        return json(res, 400, { error: e.message });
    }
}
