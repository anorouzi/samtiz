// Pardeh TV (Android): screens for finding the TV, setting it up, installing Pardeh and the remote.
// window.Native is the Java side (MainActivity.Bridge); long jobs answer through Native_done.
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- talking to the Java side ----------
const pending = {};
let seq = 0;
function call(method, ...args) {
    return new Promise((ok, fail) => {
        const id = 'c' + (++seq);
        pending[id] = { ok, fail };
        Native[method](id, ...args);
    });
}
window.Native_done = (id, error, result) => {
    const p = pending[id];
    delete pending[id];
    if (p) { if (error) p.fail(new Error(error)); else p.ok(result); }
};
window.Native_progress = (msg) => log(msg);

function toast(text) {
    $('toast').textContent = text;
    $('toast').classList.remove('hidden');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => $('toast').classList.add('hidden'), 3500);
}

function log(msg) {
    $('log').textContent += ($('log').textContent ? '\n' : '') + '• ' + msg;
}

// ---------- state: the chosen TV is remembered ----------
const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* no storage */ } }
};
let tv = store.get('tv', null);          // { ip, name, model, developerMode, developerIP, duid }
let found = [];
const myIps = () => JSON.parse(Native.addresses());

function ready(t) {
    return t && t.developerMode && myIps().indexOf(t.developerIP) !== -1;
}

// ---------- pages ----------
function go(page) {
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('hidden', p.id !== 'page-' + page));
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.go === page));
    if (page === 'install') showInstall();
    if (page === 'remote') remoteConnect();
    if (page === 'link') renderRecent();
    window.scrollTo(0, 0);
}
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
window.onBack = () => {
    const shown = document.querySelector('.page:not(.hidden)');
    if (shown && shown.id !== 'page-tv') { go('tv'); return true; }
    return false;
};

// ---------- TV page ----------
function renderTv() {
    const ip = myIps()[0] || '؟';
    $('myip').textContent = ip;
    $('help-ip').textContent = ip;
    const badge = $('tvbadge');
    if (!tv) {
        badge.textContent = 'تلویزیونی انتخاب نشده';
        badge.className = 'badge';
        $('readiness').innerHTML = 'اول تلویزیون را انتخاب کنید.';
        return;
    }
    $('tvcard').innerHTML = `<b><bdi>${esc(tv.name || 'تلویزیون سامسونگ')}</bdi></b> · <bdi>${esc(tv.model || '')}</bdi><br>
        <span class="muted">آدرس: <span class="ip">${esc(tv.ip)}</span>${tv.offline ? ' — <span class="warn">الان پیدا نمی‌شود (خاموش است؟)</span>' : ''}</span>`;
    const ok = ready(tv);
    badge.textContent = (tv.name || 'تلویزیون') + (ok ? ' · آماده ✓' : ' · آماده نیست');
    badge.className = 'badge ' + (ok ? 'ready' : 'notready');
    let why;
    if (tv.offline) why = '<span class="warn">تلویزیون روشن نیست یا به این وای‌فای وصل نیست.</span>';
    else if (!tv.developerMode) why = '<span class="bad">Developer mode تلویزیون خاموش است.</span> طبق راهنما آن را روشن کنید و IP این گوشی را بنویسید.';
    else if (!ok) why = `<span class="warn">Developer mode روشن است ولی IP آن <span class="ip">${esc(tv.developerIP)}</span> است؛ باید <span class="ip">${esc(myIps()[0])}</span> باشد.</span> طبق راهنما IP را عوض کنید و تلویزیون را کامل خاموش و روشن کنید.`;
    else why = '<span class="ok">آماده ✓</span> — می‌توانید پرده را نصب کنید و تلویزیون را با گوشی کنترل کنید.';
    $('readiness').innerHTML = why + (ok ? '<button data-go="install">رفتن به نصب</button>' : '<button class="second" data-go="help">راهنمای قدم‌به‌قدم</button>');
    $('setup').classList.toggle('hidden', ok || !!tv.offline);
    $('readiness').querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
}

function pick(t) {
    const same = tv && tv.ip === t.ip;
    tv = Object.assign({}, same ? tv : {}, t, { offline: false });
    store.set('tv', tv);
    renderTv();
    renderList();
}

function renderList() {
    $('tvlist').innerHTML = found.map((t, i) => `<div class="tv${tv && tv.ip === t.ip ? ' sel' : ''}" data-i="${i}">
        <b><bdi>${esc(t.name)}</bdi></b> · <bdi>${esc(t.model)}</bdi> · <span class="ip">${esc(t.ip)}</span><br>
        <span class="${ready(t) ? 'ok' : 'warn'}">${ready(t) ? 'آماده ✓' : !t.developerMode ? 'Developer mode خاموش' : 'IP در Developer mode درست نیست'}</span></div>`).join('');
    $('tvlist').querySelectorAll('.tv').forEach((el) => el.addEventListener('click', () => pick(found[+el.dataset.i])));
}

async function scan() {
    $('scan').disabled = true;
    $('tvcard').innerHTML = tv ? $('tvcard').innerHTML : 'در حال جستجو در وای‌فای (تا ۲۰ ثانیه)...';
    try {
        found = await call('scan');
        if (!found.length) {
            if (!tv) $('tvcard').innerHTML = '<span class="warn">تلویزیونی پیدا نشد.</span> تلویزیون روشن است و به همین وای‌فای وصل است؟';
        } else if (!tv) {
            pick(found[0]);   // the first TV found becomes "my TV"
        } else {
            // The remembered TV may have a new address: find it again by name and model.
            const again = found.find((t) => t.ip === tv.ip) || found.find((t) => t.name === tv.name && t.model === tv.model);
            if (again) pick(again);
        }
        renderList();
    } catch (e) {
        toast(e.message);
    }
    $('scan').disabled = false;
}

// On start: check the remembered TV; if it's gone (new address?), search the Wi-Fi.
async function checkTv() {
    renderTv();
    if (!tv) return scan();
    const now = await call('tvInfo', tv.ip).catch(() => null);
    if (now) { pick(now); return; }
    tv.offline = true;
    renderTv();
    scan();
}

$('scan').addEventListener('click', scan);
$('wifi').addEventListener('click', () => Native.openWifiSettings());

// ---------- install page ----------
async function showInstall() {
    $('inst-tv').innerHTML = !tv ? '<span class="warn">اول در صفحهٔ «تلویزیون» تلویزیون را انتخاب کنید.</span>'
        : ready(tv) ? `<span class="ok">✓ <bdi>${esc(tv.name)}</bdi> آماده است</span>`
        : '<span class="warn">تلویزیون هنوز آماده نیست — صفحهٔ «تلویزیون» و راهنما را ببینید.</span>';
    $('signin').disabled = $('install').disabled = !ready(tv);
    $('cert').textContent = '';
    if (!ready(tv)) return;
    try {
        const r = await call('connect', tv.ip);
        tv.duid = r.duid;
        store.set('tv', tv);
        $('cert').innerHTML = r.hasCert ? '<span class="ok">گواهی این تلویزیون آماده است ✓</span>' : '<span class="warn">هنوز گواهی ندارد — وارد حساب سامسونگ شوید.</span>';
        $('signin').textContent = r.hasCert ? 'ساختن گواهی تازه (ورود دوباره)' : 'ورود به حساب سامسونگ';
        $('install').disabled = !r.hasCert;
    } catch (e) {
        $('cert').innerHTML = `<span class="bad">اتصال به تلویزیون ممکن نشد: ${esc(e.message)}</span><br>IP در Developer mode را بررسی کنید و تلویزیون را کامل خاموش و روشن کنید.`;
        $('signin').disabled = $('install').disabled = true;
    }
}

$('signin').addEventListener('click', async () => {
    $('signin').disabled = true;
    log('صفحهٔ ورود سامسونگ باز می‌شود...');
    try {
        await call('signIn', tv.duid);
        log('گواهی سامسونگ برای این تلویزیون ساخته شد ✓');
    } catch (e) {
        log('ساخت گواهی ممکن نشد: ' + e.message);
    }
    showInstall();
});

$('install').addEventListener('click', async () => {
    const modules = [...document.querySelectorAll('#modules input')].filter((c) => c.checked).map((c) => c.value);
    if (modules.indexOf('aparat') === -1 && modules.indexOf('gapfilm') === -1) return toast('دست‌کم یکی از آپارات یا گپ فیلم را انتخاب کنید');
    store.set('modules', modules);
    $('install').disabled = true;
    $('log').textContent = '';
    try {
        await call('install', tv.ip, tv.duid, JSON.stringify(modules));
        toast('پرده نصب شد ✓');
    } catch (e) {
        log('خطا: ' + e.message);
    }
    $('install').disabled = false;
});

(function restoreModules() {
    const m = store.get('modules', null);
    if (m) document.querySelectorAll('#modules input').forEach((c) => { c.checked = m.indexOf(c.value) !== -1; });
}());

// ---------- the TV's own remote API (WebSocket on port 8001): remote keys and opening Pardeh ----------
// The first time, the TV asks "Allow?" on screen; after that it remembers this phone.
let ws = null, wsReady = null;

function remoteState(text, cls) {
    $('remote-state').innerHTML = `<span class="${cls || ''}">${text}</span>`;
}

// Resolves with the open socket once the TV has accepted this phone.
function tvSocket() {
    if (!tv) return Promise.reject(new Error('اول در صفحهٔ «تلویزیون» تلویزیون را انتخاب کنید'));
    if (wsReady) return wsReady;
    wsReady = new Promise((ok, fail) => {
        remoteState('در حال اتصال به تلویزیون... (بار اول روی تلویزیون «Allow» را بزنید)', 'muted');
        const sock = new WebSocket(`ws://${tv.ip}:8001/api/v2/channels/samsung.remote.control?name=${btoa('Pardeh Phone')}`);
        const timer = setTimeout(() => { sock.close(); fail(new Error('تلویزیون جواب نداد — روی تلویزیون «Allow» را بزنید و دوباره امتحان کنید')); }, 30000);
        sock.onmessage = (m) => {
            let d = {};
            try { d = JSON.parse(m.data); } catch (e) { return; }
            if (d.event === 'ms.channel.connect') {
                clearTimeout(timer);
                ws = sock;
                remoteState('✓ وصل به ' + esc(tv.name || tv.ip), 'ok');
                ok(sock);
            } else if (d.event === 'ms.channel.unauthorized') {
                clearTimeout(timer);
                fail(new Error('تلویزیون اجازه نداد — در تلویزیون: تنظیمات ← عمومی ← External Device Manager ← Device Connection Manager، این گوشی را Allow کنید'));
            } else if (d.event === 'ed.apps.launch' && tvSocket.onLaunch) {
                tvSocket.onLaunch(d.data);
            }
        };
        sock.onclose = () => { clearTimeout(timer); ws = null; wsReady = null; fail(new Error('اتصال برقرار نشد — تلویزیون روشن است و به همین وای‌فای وصل است؟')); };
    });
    wsReady.catch((e) => { wsReady = null; remoteState(esc(e.message), 'bad'); });
    return wsReady;
}

function remoteConnect() {
    if (!tv) return remoteState('برای کنترل، اول تلویزیون را انتخاب کنید.', 'warn');
    tvSocket().catch(() => {});
}

function sendKey(key) {
    tvSocket().then((sock) => sock.send(JSON.stringify({
        method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' }
    }))).catch((e) => toast(e.message));
}

document.querySelectorAll('.key').forEach((b) => b.addEventListener('click', () => {
    if (navigator.vibrate) navigator.vibrate(12);
    sendKey(b.dataset.key);
}));

// Starts Pardeh on the TV (the TV answers ed.apps.launch with true, or false/404 if it isn't installed).
function launchPardeh() {
    return tvSocket().then((sock) => new Promise((ok, fail) => {
        const timer = setTimeout(() => { tvSocket.onLaunch = null; ok(); }, 6000);   // some TVs don't answer
        tvSocket.onLaunch = (answer) => {
            clearTimeout(timer);
            tvSocket.onLaunch = null;
            if (answer === false || answer === 404 || answer === '404') fail(new Error('پرده روی این تلویزیون نصب نیست — از صفحهٔ «نصب» نصبش کنید'));
            else ok();
        };
        sock.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId: 'TvPlayr001.TVPlayer', action_type: 'NATIVE_LAUNCH' } } }));
    }));
}

// Sends a link to Pardeh through its app channel on the TV (ir.pardeh.links, port 8001); this TV
// doesn't pass links through its launcher. If Pardeh isn't open, it's started first and gets the
// link as soon as it joins the channel.
function playOnTv(url) {
    return new Promise((ok, fail) => {
        const PARDEH = btoa('Pardeh TV');
        const ch = new WebSocket(`ws://${tv.ip}:8001/api/v2/channels/ir.pardeh.links?name=${btoa('Pardeh Phone')}`);
        let finished = false;
        const finish = (err) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            setTimeout(() => ch.close(), 600);
            if (err) fail(err); else ok();
        };
        const timer = setTimeout(() => finish(new Error('پرده روی تلویزیون باز نشد — اگر نصب نیست، از صفحهٔ «نصب» نصبش کنید')), 30000);
        const send = (id) => {
            ch.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'play', to: id, data: url } }));
            finish();
        };
        ch.onmessage = (m) => {
            let d = {};
            try { d = JSON.parse(m.data); } catch (e) { return; }
            if (d.event === 'ms.channel.connect') {
                const pardeh = ((d.data && d.data.clients) || []).find((c) => c.attributes && c.attributes.name === PARDEH);
                if (pardeh) return send(pardeh.id);
                $('send-state').innerHTML = 'پرده روی تلویزیون باز می‌شود...';
                launchPardeh().catch(finish);
            } else if (d.event === 'ms.channel.clientConnect' && d.data && d.data.attributes && d.data.attributes.name === PARDEH) {
                setTimeout(() => send(d.data.id), 300);
            }
        };
        ch.onerror = () => finish(new Error('اتصال به تلویزیون برقرار نشد — تلویزیون روشن است و به همین وای‌فای وصل است؟'));
    });
}

// ---------- setting up Developer Mode from the phone ----------
// What works on a 2016 TV (found by trying on one): with the Apps screen open (opened from the
// Home bar), 1 2 3 4 5 opens the Developer mode window. Down goes to the first Host PC IP box;
// the boxes take number keys, Left moves to the next box and Right back (passing back through a
// box empties it, so the boxes are filled in one pass from the first). Down from the last box is
// OK. The new IP only takes effect after a full restart (a long press on power).
function setupState(html) { $('setup-state').innerHTML = html; }

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function press(keys, gap) {
    for (const k of keys) { sendKey(k); await pause(gap || 500); }
}

async function restartTv(sock) {
    const power = (cmd) => sock.send(JSON.stringify({ method: 'ms.remote.control', params: { Cmd: cmd, DataOfCmd: 'KEY_POWER', Option: 'false', TypeOfRemote: 'SendRemoteKey' } }));
    power('Press');
    await pause(5500);
    power('Release');
}

// Waits until the TV answers again with this phone as its Developer Mode IP.
async function waitForNewIp(minutes) {
    const until = Date.now() + minutes * 60000;
    while (Date.now() < until) {
        await pause(3000);
        const now = await call('tvInfo', tv.ip).catch(() => null);
        if (now && now.developerMode && myIps().indexOf(now.developerIP) !== -1) { pick(now); return true; }
    }
    return false;
}

let setupContinue = null;

$('auto-setup').addEventListener('click', async () => {
    const ip = myIps()[0];
    const parts = (ip || '').split('.');
    if (parts.length !== 4) return setupState('<span class="bad">IP گوشی پیدا نشد — به وای‌فای وصل است؟</span>');
    $('auto-setup').disabled = true;
    try {
        const sock = await tvSocket();
        setupState('زدن ۱ ۲ ۳ ۴ ۵ ...');
        await press(['KEY_1', 'KEY_2', 'KEY_3', 'KEY_4', 'KEY_5']);
        await pause(2500);
        if (!tv.developerMode) {
            // A TV that never had Developer mode on: switching it on is left to you, once.
            setupState('در پنجرهٔ Developer mode گزینهٔ <b>On</b> را انتخاب کنید (با دکمه‌های پایین)، بعد «ادامه» را بزنید.');
            $('setup-continue').classList.remove('hidden');
            await new Promise((r) => { setupContinue = r; });
            $('setup-continue').classList.add('hidden');
        }
        setupState(`نوشتن IP گوشی (<span class="ip">${esc(ip)}</span>) ...`);
        await press(['KEY_DOWN', 'KEY_RIGHT', 'KEY_RIGHT', 'KEY_RIGHT', 'KEY_RIGHT']);
        for (let i = 0; i < 4; i++) {
            if (i) await press(['KEY_LEFT']);
            await press(parts[i].split('').map((d) => 'KEY_' + d));
        }
        setupState('ذخیره (OK) ...');
        await press(['KEY_DOWN', 'KEY_ENTER'], 900);
        await pause(1500);
        setupState('خاموش و روشن کردن کامل تلویزیون (حدود یک دقیقه)...');
        await restartTv(sock);
        if (await waitForNewIp(3)) setupState('<span class="ok">تمام شد ✓ تلویزیون حالا با این گوشی کار می‌کند.</span><button data-go="install">رفتن به نصب</button>');
        else setupState('<span class="warn">IP تازه هنوز فعال نشده.</span> اگر تلویزیون خاموش ماند با ریموت روشنش کنید؛ اگر روشن است، کار را دوباره امتحان کنید (اول صفحهٔ Apps را از Home باز کنید).');
        $('setup-state').querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
    } catch (e) {
        setupState(`<span class="bad">${esc(e.message)}</span>`);
    }
    $('auto-setup').disabled = false;
});

$('setup-continue').addEventListener('click', () => { if (setupContinue) { setupContinue(); setupContinue = null; } });

// ---------- link page ----------
function linkIn(text) {
    const m = String(text || '').match(/https?:\/\/\S+/);
    return m ? m[0] : null;
}

function renderRecent() {
    const recent = store.get('recent', []);
    $('recent').innerHTML = recent.length ? recent.map((u, i) => `<div class="recent">${esc(u)}<button class="second" data-i="${i}">▶ دوباره پخش</button></div>`).join('')
        : 'هنوز چیزی ارسال نشده';
    $('recent').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => sendLink(recent[+b.dataset.i])));
}

async function sendLink(url) {
    url = linkIn(url) || (url && url.trim());
    if (!url) return toast('لینکی وارد نشده');
    if (!/^https?:\/\//.test(url)) url = 'https://' + url;
    $('send').disabled = true;
    $('send-state').innerHTML = 'در حال فرستادن به تلویزیون...';
    try {
        await playOnTv(url);
        $('send-state').innerHTML = '<span class="ok">✓ روی تلویزیون باز شد</span>';
        store.set('recent', [url].concat(store.get('recent', []).filter((u) => u !== url)).slice(0, 10));
        renderRecent();
    } catch (e) {
        $('send-state').innerHTML = `<span class="bad">${esc(e.message)}</span>`;
    }
    $('send').disabled = false;
}

$('send').addEventListener('click', () => sendLink($('url').value));
$('paste').addEventListener('click', () => {
    const text = Native.clipboard();
    $('url').value = linkIn(text) || text;
    if (!$('url').value) toast('کلیپ‌بورد خالی است — اول لینک را کپی کنید');
});

// "Share → Pardeh TV" from another app: send it straight away.
window.onShared = () => {
    const url = Native.takeShared();
    if (!url) return;
    go('link');
    $('url').value = url;
    sendLink(url);
};
renderRecent();

$('open-pardeh').addEventListener('click', async () => {
    try { await launchPardeh(); toast('پرده روی تلویزیون باز شد'); }
    catch (e) { toast(e.message); }
});

// ---------- start ----------
$('version').textContent = 'نسخهٔ ' + Native.version();
checkTv().then(() => window.onShared());
