/* Pardeh (پرده) — Aparat, Gapfilm, live TV, links and USB videos for Samsung Tizen TVs.
 * Written in ES5 because the 2016 (Tizen 2.4) web engine has no ES6 support. */
(function () {
    'use strict';

    var API = 'https://www.aparat.com/api/fa/v1/video/video/';
    var HUB_PORT = 8090;                     // optional TV Hub on a computer/phone (~/TVHub/server.mjs)
    var HUB = null;                          // found at startup by findHub()
    var DISPLAY_MODES = [
        { id: 'PLAYER_DISPLAY_MODE_LETTER_BOX', label: 'کامل با حاشیه (اصلی)' },
        { id: 'PLAYER_DISPLAY_MODE_FULL_SCREEN', label: 'تمام صفحه (کشیده)' },
        { id: 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO', label: 'خودکار' }
    ];
    // Parts switched on in js/settings.js (written by the installers); all of them if it lists none.
    var MODULES = window.PARDEH_MODULES && window.PARDEH_MODULES.length ? window.PARDEH_MODULES : ['aparat', 'gapfilm', 'live', 'link', 'phone', 'usb'];
    var APARAT_CHIPS = ['ورزشی', 'کارتون', 'فیلم', 'سریال', 'مستند', 'موسیقی', 'آشپزی', 'طنز', 'خبر'];
    var TOP = ['search', 'btn-live', 'btn-link', 'btn-phone', 'btn-usb'];   // the site tabs go in front at startup
    var GAP = 'https://core.gapfilm.ir/api/';
    var GAP_IMG = 'https://cdn.gapfilm.ir/image/400/panel/';
    var TW_CHANNELS = 'https://gateway.telewebion.net/kandoo/channel/getChannelsList/';
    var TW_LIVE = 'https://ncdn.telewebion.net/';
    var VIDEO_EXT = /\.(mp4|mkv|avi|mov|m4v|ts|webm|wmv|flv|3gp)$/i;
    // The download manager writes to "<name>.<random code>" and doesn't always rename the file back.
    var TEMP_NAME = /^(.+\.(mp4|mkv|ts|webm|mov|m4v))\.[A-Za-z0-9_-]{16,}$/i;
    var OLD_LIMIT = 33554432;                 // files cut off by the old in-app downloader are exactly 32 MiB
    var COLS = 4;
    var PART_SIZE = 16 * 1024 * 1024;           // recordings are split into files of this size
    var SEEK_DELAY = 650;                    // ms to wait for more ◀ ▶ presses before seeking once
    var BAR_W = 1440;                        // seek bar width in px (matches #osd-bar in the CSS)

    var KEY = {
        LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009,
        PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, STOP: 413, FF: 417, RW: 412, RECORD: 416,
        RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
        CH_UP: 427, CH_DOWN: 428, INFO: 457, SEARCH: 10225, TOOLS: 10135, PREV: 10232, NEXT: 10233,
        IME_DONE: 65376, IME_CANCEL: 65385
    };
    // Remote buttons the app takes over; their codes are re-read from the TV at startup.
    var REMOTE_KEYS = {
        PLAYPAUSE: 'MediaPlayPause', PLAY: 'MediaPlay', PAUSE: 'MediaPause', STOP: 'MediaStop',
        FF: 'MediaFastForward', RW: 'MediaRewind', RECORD: 'MediaRecord',
        RED: 'ColorF0Red', GREEN: 'ColorF1Green', YELLOW: 'ColorF2Yellow', BLUE: 'ColorF3Blue',
        CH_UP: 'ChannelUp', CH_DOWN: 'ChannelDown', INFO: 'Info', SEARCH: 'Search', TOOLS: 'Tools',
        PREV: 'MediaTrackPrevious', NEXT: 'MediaTrackNext'
    };

    var $ = function (id) { return document.getElementById(id); };
    var noop = function () {};
    var raf = window.requestAnimationFrame || window.webkitRequestAnimationFrame || function (f) { return setTimeout(f, 16); };

    var store = {
        get: function (k, def) {
            try { var v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch (e) { return def; }
        },
        set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* no storage */ } }
    };

    function has(module) { return MODULES.indexOf(module) !== -1; }

    function show(id) { $(id).classList.remove('hidden'); }
    function hide(id) { $(id).classList.add('hidden'); }

    function setTransform(el, t) { el.style.webkitTransform = t; el.style.transform = t; }

    // ---------- state ----------
    var screen = 'browse';          // browse | link | phone | login | player
    var zone = 'top';               // top | chips | grid
    var topIndex = 0, chipIndex = 0, gridIndex = 0;
    var videos = [], more = null;                    // the list on screen; more() loads its next page
    var site = null, chips = [], activeChip = -1;    // current site tab, its category chips, the chip shown
    var listSeq = 0, listToken = 0, listParent = null;   // current list, and the list a series was opened from
    var accounts = store.get('accounts', {});        // site logins: site id -> { token, phone }
    var login = null;                                // the open login dialog
    var player = {
        qualities: [], qIndex: 0, title: '', id: null, live: false, listIndex: -1,
        paused: false, duration: 0, pos: 0, token: 0, osdTimer: null,
        seekAcc: 0, seekBase: 0, seekPresses: 0, seekTimer: null,
        t0: 0, started: false, stallAt: 0, lastSeekAt: 0
    };
    var menu = null;                                 // open pop-up menu (player or USB item)
    var helpOpen = false;
    var displayMode = store.get('displayMode', 0) % DISPLAY_MODES.length;
    var positions = store.get('positions', {});      // resume points: id -> seconds
    var partials = store.get('partials', {});        // unfinished downloads: USB path -> { uid, url, label, title, total }
    var showCache = {};                              // Aparat playback info: uid -> { t, data }
    var usb = { storages: [], writable: null };
    var job = null;                                  // the running USB download or recording
    var renameFailed = {};                           // temp-named files that couldn't be renamed
    var toastTimer = null, renderQueued = false, focusedEl = null, prefetchTimer = null, chipTimer = null, backAt = 0;
    var enterDown = false, enterDownTimer = null, enterHold = null;

    // ---------- helpers ----------
    // JSON over XHR. opts: { method, body (sent as JSON), headers }. ok(data, xhr); fail(message, status).
    // Error replies that carry the site's own message ({ message } / { Message }) show that message.
    function ajax(url, opts, ok, fail) {
        var xhr = new XMLHttpRequest(), headers = opts.headers || {};
        xhr.open(opts.method || 'GET', url, true);
        xhr.timeout = 20000;
        if (opts.body !== undefined) { xhr.setRequestHeader('Content-Type', 'application/json'); }
        Object.keys(headers).forEach(function (k) { xhr.setRequestHeader(k, headers[k]); });
        xhr.onload = function () {
            var data = null, good = xhr.status >= 200 && xhr.status < 300;
            try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
            if (good && data !== null) { return ok(data, xhr); }
            fail((data && (data.message || data.Message)) || (good ? 'خطا در خواندن پاسخ' : 'خطای سرور: ' + xhr.status), xhr.status);
        };
        xhr.onerror = function () { fail('اتصال به اینترنت برقرار نشد', 0); };
        xhr.ontimeout = function () { fail('زمان اتصال تمام شد', 0); };
        xhr.send(opts.body !== undefined ? JSON.stringify(opts.body) : null);
    }

    function getJSON(url, ok, fail) { ajax(url, {}, ok, fail); }

    // Sends diagnostics to the TV Hub (written to ~/TVHub/tv.log).
    function hubLog(event, data) {
        if (!HUB) { return; }
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', HUB + '/api/log', true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(JSON.stringify({ event: event, data: data }));
        } catch (e) { /* hub not running */ }
    }

    function fmtTime(sec) {
        sec = Math.max(0, Math.floor(sec));
        var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        var mm = (h && m < 10 ? '0' : '') + m, ss = (s < 10 ? '0' : '') + s;
        return (h ? h + ':' : '') + mm + ':' + ss;
    }

    function esc(t) {
        return String(t || '').replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    function mb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }

    function setStatus(text) { $('status').textContent = text || ''; }

    function toast(text) {
        hubLog('toast', text);
        $('toast').textContent = text;
        show('toast');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { hide('toast'); }, 3500);
    }

    // Empties the grid for a new list; replies still on their way for the old one are ignored.
    function resetGrid() {
        videos = []; gridIndex = 0; more = null;
        listToken = ++listSeq; listParent = null;
        if (focusedEl && focusedEl.className.indexOf('card') !== -1) { focusedEl = null; }
        $('grid').innerHTML = '<div id="grid-inner"></div>';
    }

    function cardHtml(idx, thumb, title, meta) {
        return '<div class="card" id="card-' + idx + '">' + thumb +
            '<div class="title" dir="auto">' + esc(title) + '</div>' +
            '<div class="meta" id="meta-' + idx + '">' + meta + '</div></div>';
    }

    // The chip of the category currently shown gets its own mark, separate from the focus.
    function markActiveChip() {
        for (var i = 0; i < chips.length; i++) {
            var c = $('chip-' + i);
            if (!c) { continue; }
            if (i === activeChip) { c.classList.add('active'); } else { c.classList.remove('active'); }
        }
    }

    // ---------- lists (any site) ----------
    // Items: { title, poster, badge, meta } plus what the site needs to open them.
    function addItems(items) {
        var html = '';
        items.forEach(function (v) {
            var idx = videos.length;
            videos.push(v);
            html += cardHtml(idx, '<div class="thumb" id="thumb-' + idx + '">' +
                (v.badge ? '<span class="dur">' + esc(v.badge) + '</span>' : '') + '</div>', v.title, esc(v.meta) || '&nbsp;');
        });
        if ($('grid-inner')) { $('grid-inner').insertAdjacentHTML('beforeend', html); }
    }

    // Shows a paged list: fetch(page, ok(items, hasMore), fail) is called for page 1, 2, …
    // opts: { unit, parent } — parent is the list a series was opened from (Back returns to it).
    function showList(label, fetch, opts) {
        opts = opts || {};
        markActiveChip();
        resetGrid();
        listParent = opts.parent || null;
        var token = listToken, page = 1, busy = false;
        setStatus('در حال بارگذاری «' + label + '» ...');
        var next = function () {
            if (busy) { return; }
            busy = true;
            fetch(page, function (items, hasMore) {
                busy = false;
                if (token !== listToken) { return; }   // the user moved on to another list
                hubLog('list', { site: site.id, label: label, page: page, items: items.length });
                page++;
                more = hasMore ? next : null;
                addItems(items);
                setStatus(videos.length ? '«' + label + '» · ' + videos.length + ' ' + (opts.unit || 'مورد') +
                    (listParent ? ' · Back: برگشت' : '') : 'نتیجه‌ای پیدا نشد');
                render();
            }, function (err) {
                busy = false;
                hubLog('list.fail', { site: site.id, label: label, page: page, err: err });
                if (token === listToken) { setStatus(err); }
            });
        };
        next();
    }

    // A series list remembers the list it was opened from, so Back can bring it back as it was.
    function saveList() {
        return { videos: videos, more: more, token: listToken, gridIndex: gridIndex, chip: activeChip,
            html: $('grid-inner') ? $('grid-inner').innerHTML.replace(/ focused/g, '') : '', status: $('status').textContent };
    }

    function backToParent() {
        var p = listParent;
        resetGrid();
        videos = p.videos; more = p.more; listToken = p.token; gridIndex = p.gridIndex; activeChip = p.chip;
        $('grid-inner').innerHTML = p.html;
        markActiveChip();
        setStatus(p.status);
        zone = 'grid';
        render();
    }

    // ---------- Aparat ----------
    function searchAparat(query) {
        hubLog('search', query);
        var url = API + 'search/text/' + encodeURIComponent(query);
        showList(query, function (page, ok, fail) {
            getJSON(url, function (data) {
                var row = data.data && data.data[0] && data.data[0].attributes, items = [];
                url = row && row.link && row.link.next ? row.link.next : null;
                (data.included || []).forEach(function (i) {
                    if (i.type !== 'Video') { return; }
                    var v = i.attributes;
                    items.push({ uid: v.uid, title: v.title, poster: v.small_poster || v.medium_poster || '',
                        badge: fmtTime(+v.duration || 0), meta: (v.sender_name || v.username || '') + ' · ' + (v.visit_cnt || 0) + ' بازدید',
                        added: -(+v.sdate_timediff || 0), pop: +v.visit_cnt_int || 0, length: +v.duration || 0 });
                });
                ok(items, !!url);
            }, fail);
        }, { unit: 'ویدیو' });
    }

    // Playback info is cached for a few minutes (the links carry expiring tokens).
    function getShow(uid, ok, fail) {
        var c = showCache[uid];
        if (c && Date.now() - c.t < 10 * 60 * 1000) { return ok(c.data); }
        getJSON(API + 'show/videohash/' + uid, function (d) { showCache[uid] = { t: Date.now(), data: d }; ok(d); }, fail);
    }

    // Default is the adaptive stream: on this TV it starts in ~3 s versus ~10 s for a 720p MP4,
    // and it follows the Wi-Fi speed. A fixed quality chosen with ▲ is remembered instead.
    function pickQuality(list) {
        var pref = store.get('prefQ', 'auto'), best = -1, bestP = 0, low = -1;
        if (pref === 'auto') {
            for (var a = 0; a < list.length; a++) { if (list[a].stream) { return a; } }
            pref = 720;
        }
        list.forEach(function (q, i) {
            var p = parseInt(q.label, 10);
            if (!p) { return; }
            if (p <= pref && p > bestP) { best = i; bestP = p; }
            if (low < 0 || p < parseInt(list[low].label, 10)) { low = i; }
        });
        return best >= 0 ? best : Math.max(low, 0);
    }

    function playAparat(uid, title) {
        showPlayer(title);
        var token = player.token;
        getShow(uid, function (data) {
            if (token !== player.token) { return; }   // the user already moved on
            var a = data.data.attributes, list = [];
            (a.file_link_all || []).forEach(function (q) {
                if (q.urls && q.urls[0]) { list.push({ label: q.profile, url: q.urls[0] }); }
            });
            if (a.hls_link) { list.push({ label: 'خودکار', url: a.hls_link, stream: true }); }
            if (!list.length) { return playerError('لینک پخش پیدا نشد'); }
            startPlayback(a.title || title, list, pickQuality(list), { id: 'a:' + uid });
        }, function (err) { if (token === player.token) { playerError(err); } });
    }

    function openLink(url, title) {
        url = url.trim();
        player.listIndex = -1;
        var m = url.match(/aparat\.com\/v\/([A-Za-z0-9]+)/);
        if (m) { return playAparat(m[1], title || ''); }
        if (!/^https?:\/\//.test(url)) { url = 'http://' + url; }
        var name = title || url.split('/').pop().split('?')[0] || url;
        showPlayer(name);
        startPlayback(name, [{ label: 'لینک', url: url, stream: /\.m3u8/i.test(url) }], 0, { id: 'u:' + url });
    }

    // Plays item i of the current list; CH ▲/▼ in the player walk through the same list.
    // A series opens the list of its episodes instead.
    function playItem(i) {
        var v = videos[i];
        if (!v) { return; }
        gridIndex = i;
        if (v.series) {
            if (screen === 'player') { closePlayer(); }
            return siteById(v.site).open(v);
        }
        player.listIndex = i;
        if (v.live) { return playLive(v); }
        if (v.local) { return playLocal(v); }
        if (v.site) { return siteById(v.site).open(v); }
        playAparat(v.uid, v.title);
    }

    // Reads an HLS master playlist, so ▲ can switch between its quality variants.
    function loadVariants(master, done) {
        var auto = { label: 'خودکار', url: master, stream: true };
        var xhr = new XMLHttpRequest();
        xhr.open('GET', master, true);
        xhr.timeout = 15000;
        xhr.onload = function () {
            var list = [auto], lines = (xhr.responseText || '').split('\n');
            for (var i = 0; i < lines.length - 1; i++) {
                var m = lines[i].match(/^#EXT-X-STREAM-INF:.*RESOLUTION=\d+x(\d+)/), next = lines[i + 1].trim();
                if (m && next && next.charAt(0) !== '#') {
                    // Telewebion names its 50 fps variants …108050p….
                    list.push({ label: m[1] + 'p' + (/108050p/.test(next) ? ' 50fps' : ''), url: resolveUrl(master, next), stream: true });
                }
            }
            done(list);
        };
        xhr.onerror = xhr.ontimeout = function () { done([auto]); };
        xhr.send();
    }

    // ---------- Live TV (Telewebion) ----------
    // Telewebion uses certificates this TV can't verify, so it only works through a TV Hub.
    function hubProxy(url) { return HUB + '/proxy?u=' + encodeURIComponent(url); }

    // Sites known to fail directly on this TV go straight through the hub (learned over time).
    var viaHubHosts = ['telewebion.net', 'sepehrtv.ir'].concat(store.get('viaHubHosts', []));

    function hostOf(url) { var m = url.match(/^https?:\/\/([^\/:?#]+)/); return m ? m[1] : ''; }

    function needsHub(url) {
        var h = hostOf(url);
        return /^https:\/\//.test(url) && viaHubHosts.some(function (d) { return h === d || h.slice(-d.length - 1) === '.' + d; });
    }

    function rememberViaHub(url) {
        var h = hostOf(url);
        if (!h || needsHub(url)) { return; }
        viaHubHosts.push(h);
        store.set('viaHubHosts', store.get('viaHubHosts', []).concat([h]));
    }

    function showLive() {
        activeChip = -1; markActiveChip();
        resetGrid();
        if (!HUB) { return setStatus('پخش زنده به «TV Hub» نیاز دارد (روی مک یا گوشی اندروید) — هاب پیدا نشد'); }
        setStatus('در حال دریافت شبکه‌ها ...');
        var token = listToken;
        getJSON(hubProxy(TW_CHANNELS), function (data) {
            if (token !== listToken) { return; }
            var list = (data.body && data.body.queryChannel) || [], html = '';
            list.forEach(function (c) {
                var idx = videos.length;
                videos.push({ live: true, descriptor: c.descriptor, title: c.name });
                html += cardHtml(idx, '<div class="thumb text">' + esc(c.name) + '</div>', c.name,
                    esc(c.type && c.type.name) + ' · ' + esc(c.descriptor));
            });
            $('grid-inner').innerHTML = html;
            setStatus(list.length + ' شبکهٔ زنده · هنگام پخش با CH ▲▼ شبکه را عوض کنید');
            if (list.length) { zone = 'grid'; }
            render();
        }, setStatus);
    }

    function playLive(v) {
        showPlayer(v.title);
        var token = player.token;
        loadVariants(hubProxy(TW_LIVE + v.descriptor + '/live/playlist.m3u8'), function (list) {
            if (token === player.token) { startPlayback(v.title, list, 0, { id: null, live: true }); }
        });
    }

    // ---------- sites ----------
    // Each site tab has its own categories (chips: fixed, or loaded from the site), search and way
    // of opening an item. Sites that need an account get a login chip (phone number + SMS code).
    // Only sites that work on the TV by itself belong here: Tamashakhoneh and Movieland were left
    // out because this TV can't reach them without the hub (docs/REPORT.md, section 10).
    // Tools are action chips after the categories (e.g. Gapfilm's genres).
    var ALL_SITES = [
        { id: 'aparat', name: 'آپارات', search: searchAparat,
            chips: APARAT_CHIPS.map(function (c) { return { label: c, open: function () { searchAparat(c); } }; }) },
        { id: 'gapfilm', name: 'گپ فیلم', loadChips: gapChips, search: gapSearch, open: gapOpen,
            tools: [{ label: 'ژانرها', action: gapGenres }],
            login: { request: gapLoginRequest, confirm: gapLoginConfirm } }
    ];
    var SITES = ALL_SITES.filter(function (s) { return has(s.id); });
    if (!SITES.length) { SITES = [ALL_SITES[0]]; }

    function siteById(id) {
        for (var i = 0; i < SITES.length; i++) { if (SITES[i].id === id) { return SITES[i]; } }
        return SITES[0];
    }

    // As many categories as fit on one line (nine at most, for the number keys), then the site's
    // tools and the account chip.
    function renderChips() {
        var s = site, acc = accounts[s.id], row = $('chips'), n = Math.min((s.chips || []).length, 9), last;
        var extra = (s.tools || []).slice();
        if (s.login) {
            extra.push(acc ? { label: 'حساب ' + acc.phone, action: function () { accountMenu(s); } }
                : { label: 'ورود با موبایل', action: function () { openLogin(s); } });
        }
        do {
            chips = (s.chips || []).slice(0, n).concat(extra);
            row.innerHTML = chips.map(function (c, i) {
                return '<div class="chip' + (c.action ? ' account' : '') + '" id="chip-' + i + '">' +
                    (c.action ? '' : '<span class="num">' + (i + 1) + '</span>') + esc(c.label) + '</div>';
            }).join('');
            last = $('chip-' + (chips.length - 1));
        } while (last && last.getBoundingClientRect().left < row.getBoundingClientRect().left && --n > 0);   // laid out right-to-left
        if (focusedEl && focusedEl.className.indexOf('chip') !== -1) { focusedEl = null; }
        markActiveChip();
    }

    function switchSite(i) {
        var s = site = SITES[i];
        store.set('site', s.id);
        hubLog('site', s.id);
        SITES.forEach(function (x, j) {
            if (j === i) { $('site-' + j).classList.add('active'); } else { $('site-' + j).classList.remove('active'); }
        });
        $('search').placeholder = 'جستجو در ' + s.name + '...';
        $('search').value = '';
        activeChip = -1; chipIndex = 0;
        resetGrid();
        renderChips();
        if (s.chips) { return openFirstChip(); }
        setStatus('در حال بارگذاری ' + s.name + ' ...');
        s.loadChips(function (list) {
            s.chips = list;
            hubLog('site.chips', { site: s.id, chips: list.map(function (c) { return c.label; }) });
            if (site !== s) { return; }
            renderChips();
            openFirstChip();
        }, function (err) {
            hubLog('site.fail', { site: s.id, err: err });
            if (site === s) { setStatus(err + ' — برای تلاش دوباره، تب ' + s.name + ' را دوباره بزنید'); }
        });
    }

    function openFirstChip() {
        if (chips.length && !chips[0].action) { openChip(0); } else { setStatus(''); }
    }

    // Category chips load their list; the account chip only acts on OK.
    function openChip(i) {
        var c = chips[i];
        if (!c) { return; }
        clearTimeout(chipTimer);
        chipIndex = i;
        if (c.action) { return c.action(); }
        activeChip = i;
        c.open();
    }

    function search(query) {
        activeChip = -1;
        site.search(query);
    }

    // ---------- Gapfilm (gapfilm.ir) ----------
    // Free titles play without an account; the rest need a logged-in subscriber. Plain HLS and MP4
    // on Certum certificates, which this TV trusts, so no hub is needed.
    function gapCall(path, body, ok, fail, extraHeaders) {
        var acc = accounts.gapfilm, h = extraHeaders || {};
        h.SourceChannel = 'GF_WEBSITE';
        if (acc) { h.Authorization = 'bearer ' + acc.token; h.SourceChannelUser = 'GF_WEBSITE'; }
        ajax(GAP + path, { method: body ? 'POST' : 'GET', body: body || undefined, headers: h }, ok, function (err, status) {
            if (status === 401 && acc) { loginExpired('gapfilm'); }
            fail(err, status);
        });
    }

    function gapItem(c) {
        var id = c.ContentId || c.ContentID, genre = '';
        (c.Properties || []).forEach(function (p) { if (p.Name === 'ژانر') { genre = p.Value; } });
        return { site: 'gapfilm', id: id, title: c.Title, poster: GAP_IMG + id + '/landscape.jpg', meta: genre || c.EnglishTitle || '',
            added: c.CreateDate || c.UpdateDate || 0, pop: c.LikeCount || 0 };
    }

    function gapItems(list) {
        return (list || []).filter(function (c) { return c.ContentId || c.ContentID; }).map(gapItem);
    }

    // The rows of Gapfilm's home page become the categories: plain rows (no template, 10, 11) and
    // collections (1). Banners, actors (14), "continue watching" (15) and the like are skipped.
    var GAP_ROWS = [null, undefined, 1, 10, 11];

    function gapChips(ok, fail) {
        gapCall('v3.3/GetFirstPageByPlatform?PlatformId=1&PlatformType=1&PageType=1&ParentType=2&ContentRows=1&PageSize=20&PageIndex=1', null, function (d) {
            var list = [];
            ((d.Result && d.Result.Sections) || []).forEach(function (s) {
                if (GAP_ROWS.indexOf(s.SectionTemplateId) === -1 || s.Total < 2 || !s.Title) { return; }
                list.push({ label: s.Title, open: function () { gapSection(s.SectionId, s.Title); } });
            });
            ok(list);
        }, fail);
    }

    // Gapfilm counts pages from 0.
    function gapSection(id, title) {
        showList(title, function (page, ok, fail) {
            gapCall('v3.3/GetFirstPageByPlatformPaging?EntityType=1&PageSize=24&EntityId=' + id + '&PageIndex=' + (page - 1), null, function (d) {
                var r = d.Result || {};
                ok(gapItems(r.Contents), page < (r.TotalPage || 0));
            }, fail);
        });
    }

    function gapSearch(query) {
        showList(query, function (page, ok, fail) {
            gapCall('v1.0/search?PageSize=24&Title=' + encodeURIComponent(query) + '&PageIndex=' + (page - 1), null, function (d) {
                ok(gapItems(d.Contents), page < (d.TotalPage || 0));
            }, fail);
        });
    }

    // Genres are Gapfilm categories under "فیلم" (6) and "سریال" (7); first pick one of the two.
    var gapCategories = null;

    function gapGenres() {
        var pick = function (parent, name) {
            var list = gapCategories.filter(function (c) { return c.ParentID === parent; });
            openMenu(list.map(function (c) {
                return { label: c.Title.trim(), action: function () { gapGenre(c.CategoryID, name + ' · ' + c.Title.trim()); } };
            }).concat([{ label: 'بستن', action: noop }]), 0, 'ژانرهای ' + name);
        };
        var choose = function () {
            openMenu([
                { label: 'فیلم', action: function () { pick(6, 'فیلم'); } },
                { label: 'سریال', action: function () { pick(7, 'سریال'); } },
                { label: 'بستن', action: noop }
            ], 0, 'ژانرها');
        };
        if (gapCategories) { return choose(); }
        gapCall('v1.0/GetCategoryList', { request: { requestId: -1 } }, function (d) {
            gapCategories = (d.Result && d.Result.GetCategoryList) || [];
            choose();
        }, toast);
    }

    function gapGenre(id, title) {
        activeChip = -1;
        showList(title, function (page, ok, fail) {
            gapCall('v1.0/GetContentList', { request: { RequestType: 2, RequestId: id, PageIndex: page - 1, PageSize: 24 } }, function (d) {
                var r = d.Result || {};
                ok(gapItems(r.GetContentList), page < (r.TotalPages || 0));
            }, fail);
        });
        zone = 'grid';
    }

    // Cast and crew of a title (where Gapfilm lists them); picking one shows their other titles.
    function gapCast(v) {
        toast('در حال دریافت بازیگران «' + v.title + '» ...');
        gapCall('v1.1/Person/GetPersonByContentId?contentId=' + v.id, null, function (d) {
            var ROLE = { 5: 'بازیگر', 6: 'کارگردان', 1: 'نویسنده' }, people = [], byId = {};
            (d.Result || []).forEach(function (p) {
                if (p.ParentId) { return; }   // dubbing voices hang under the actor they dub
                var role = ROLE[p.PersonRoleId] || p.PersonRoleName || '';
                if (byId[p.Id]) { byId[p.Id].roles.push(role); return; }
                byId[p.Id] = { id: p.Id, name: p.PersianName || p.EnglishName, roles: [role] };
                people.push(byId[p.Id]);
            });
            if (!people.length) { return toast('گپ فیلم بازیگران «' + v.title + '» را ثبت نکرده است'); }
            openMenu(people.slice(0, 12).map(function (p) {
                return { label: p.name + ' — ' + p.roles.join('، '), action: function () { gapPerson(p); } };
            }).concat([{ label: 'بستن', action: noop }]), 0, 'بازیگران و عوامل «' + v.title + '»');
        }, toast);
    }

    function gapPerson(p) {
        showList(p.name, function (page, ok, fail) {
            gapCall('v1/GetPerson?OrderBy=createdate&Order=desc&PageSize=24&Id=' + p.id + '&PageIndex=' + (page - 1), null, function (d) {
                var r = d.Result || {};
                ok(gapItems((r.Contents || []).map(function (c) {
                    return { ContentId: c.Id, Title: c.Title, CreateDate: c.CreateDate, LikeCount: c.LikeCount };
                })), page < (r.TotalPages || 0));
            }, fail);
        }, { unit: 'عنوان', parent: saveList() });
        zone = 'grid';
    }

    // A film plays straight away; a series opens as a list of its episodes (one page per season).
    function gapOpen(v) {
        if (v.att) { return gapPlay(v); }
        toast('در حال باز کردن «' + v.title + '» ...');
        gapCall('v4/Content/GetContent?Id=' + v.id, null, function (d) {
            var seasons = (d.Result && d.Result.SeasonList) || [];
            if (!seasons.length) { return toast('ویدیویی برای «' + v.title + '» پیدا نشد'); }
            var film = seasons.length === 1 && seasons[0].NumberOfEpisodes <= 1;
            var fetch = function (page, ok, fail) {
                var s = seasons[page - 1];
                gapCall('v4/Content/GetContentAttachments?generateLink=true&Id=' + v.id + '&seasonId=' + s.SeasonId, null, function (r) {
                    var items = [];
                    ((r.Result && r.Result.Attachments) || []).forEach(function (a) {
                        items.push({ site: 'gapfilm', id: v.id, att: a, poster: a.Thumbnail || v.poster,
                            title: film ? v.title : (seasons.length > 1 ? s.SeasonTitle + ' · ' : '') + a.Title,
                            badge: a.DurationSeconds ? fmtTime(a.DurationSeconds) : '', meta: a.IsFree ? 'رایگان' : 'ویژهٔ مشترکین' });
                    });
                    ok(items, page < seasons.length);
                }, fail);
            };
            if (film) {
                return fetch(1, function (items) { if (items.length) { gapPlay(items[0]); } else { toast('لینک پخش پیدا نشد'); } }, toast);
            }
            if (screen === 'player') { closePlayer(); }
            showList(v.title, fetch, { unit: 'قسمت', parent: saveList() });
            zone = 'grid';
        }, toast);
    }

    function gapPlay(v) {
        var a = v.att, list = [], hls = null;
        if (!a.IsFree && !accounts.gapfilm) {
            toast('این ویدیو ویژهٔ مشترکین گپ فیلم است — اول وارد حساب شوید');
            return openLogin(siteById('gapfilm'), function () { gapRelink(v); });
        }
        a.Files.forEach(function (f) {
            if (f.Type === 7 && !hls) { hls = f.Path; }   // adaptive stream
            else if (f.Type === 9 && f.Width) { list.push({ label: Math.round(f.Width * 9 / 16) + 'p', url: f.Path }); }   // MP4s
        });
        if (hls) { list.push({ label: 'خودکار', url: hls, stream: true }); }
        if (!list.length) { return toast('لینک پخش پیدا نشد'); }
        showPlayer(v.title);
        var token = player.token;
        var start = function () {
            if (token === player.token) { startPlayback(v.title, list, pickQuality(list), { id: 'g:' + v.id + ':' + a.SeasonId + ':' + a.EpisodeNo }); }
        };
        if (a.IsFree || !hls) { return start(); }
        // Without a subscription the stream answers 402.
        var xhr = new XMLHttpRequest();
        xhr.open('GET', hls, true);
        xhr.timeout = 15000;
        xhr.onload = function () {
            if (token !== player.token) { return; }
            if (xhr.status === 402) { return playerError('این ویدیو اشتراک گپ فیلم لازم دارد'); }
            start();
        };
        xhr.onerror = xhr.ontimeout = start;
        xhr.send();
    }

    // Links made before logging in are a guest's; fetch them again for the account.
    function gapRelink(v) {
        gapCall('v4/Content/GetContentAttachments?generateLink=true&Id=' + v.id + '&seasonId=' + v.att.SeasonId, null, function (d) {
            var a = null;
            ((d.Result && d.Result.Attachments) || []).forEach(function (x) { if (x.EpisodeNo === v.att.EpisodeNo) { a = x; } });
            if (!a) { return toast('لینک پخش پیدا نشد'); }
            v.att = a;
            gapPlay(v);
        }, toast);
    }

    function gapDevice() {
        var id = store.get('deviceId', null);
        if (!id) { id = 'tv-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); store.set('deviceId', id); }
        return { OS: 'Tizen', OsVersion: '2.4', DeviceModel: 'Samsung TV', AndroidId: id, AdvertiseId: id };
    }

    function gapLoginRequest(phone, ok, fail) {
        gapCall('v3.2/Account/Login', { Method: 1, PhoneNo: phone }, function (d) {
            if (d.Code === 1) { ok(); } else { fail(d.Message || 'ارسال کد ممکن نشد'); }
        }, fail, gapDevice());
    }

    function gapLoginConfirm(phone, code, ok, fail) {
        gapCall('v3.2/Account/Confirm', { Type: 3, Code: code, PhoneNo: phone }, function (d) {
            if (d.Code === 1 && d.Data && d.Data.Token) { ok({ token: d.Data.Token, phone: phone }); } else { fail(d.Message || 'کد درست نیست'); }
        }, fail, gapDevice());
    }

    // ---------- site login: phone number, then the SMS code, typed with the remote ----------
    // then() runs after a successful login (e.g. plays the video that needed it).
    function openLogin(s, then) {
        if (screen === 'player') { closePlayer(); }
        login = { site: s, then: then || null, phone: '', step: 'phone', busy: false };
        screen = 'login';
        $('login-title').textContent = 'ورود به ' + s.name;
        show('login-dialog');
        loginStep('phone');
    }

    var LOGIN_HINTS = {
        phone: 'شمارهٔ موبایلِ حسابتان را وارد کنید (مثل 09121234567) و OK بزنید؛ یک کد پیامکی برایتان فرستاده می‌شود.',
        code: 'کدی را که به {phone} پیامک شد وارد کنید و OK بزنید.'
    };

    function loginStep(step, note) {
        var input = $('login-input');
        login.step = step;
        login.busy = false;
        input.value = '';
        $('login-hint').textContent = (note ? note + ' — ' : '') + LOGIN_HINTS[step].replace('{phone}', login.phone);
        input.focus();
    }

    function latinDigits(t) {
        return t.replace(/[۰-۹٠-٩]/g, function (c) {
            var n = c.charCodeAt(0);
            return String(n - (n >= 0x6f0 ? 0x6f0 : 0x660));
        });
    }

    function submitLogin() {
        var l = login, s = l.site, value = latinDigits($('login-input').value).trim();
        if (!value || l.busy) { return; }
        $('login-input').blur();
        l.busy = true;
        $('login-hint').textContent = 'لطفاً صبر کنید...';
        if (l.step === 'phone') {
            var phone = value.replace(/[^\d]/g, '').replace(/^(98|0098)(?=9\d{9}$)/, '').replace(/^(?=9\d{9}$)/, '0');
            if (!/^09\d{9}$/.test(phone)) { return loginStep('phone', 'شماره درست نیست'); }
            l.phone = phone;
            return s.login.request(phone, function () { if (login === l) { loginStep('code'); } },
                function (err) { if (login === l) { loginStep('phone', err); } });
        }
        s.login.confirm(l.phone, value, function (acc) {
            if (login !== l) { return; }
            accounts[s.id] = acc;
            store.set('accounts', accounts);
            closeLogin();
            if (site === s) { renderChips(); render(); }
            toast('وارد حساب ' + s.name + ' شدید');
            if (l.then) { l.then(); }
        }, function (err) { if (login === l) { loginStep('code', err || 'کد درست نیست'); } });
    }

    function closeLogin() {
        $('login-input').blur();
        hide('login-dialog');
        login = null;
        screen = 'browse';
        render();
    }

    function accountMenu(s) {
        openMenu([
            { label: 'خروج از حساب', action: function () { forgetLogin(s.id); toast('از حساب ' + s.name + ' خارج شدید'); } },
            { label: 'بستن', action: noop }
        ], 1, s.name + ' · ' + accounts[s.id].phone);
    }

    function forgetLogin(id) {
        delete accounts[id];
        store.set('accounts', accounts);
        if (site && site.id === id) { renderChips(); render(); }
    }

    function loginExpired(id) {
        forgetLogin(id);
        toast('ورود به ' + siteById(id).name + ' منقضی شد — دوباره وارد شوید');
    }

    // ---------- USB ----------
    function findUsb(done) {
        try {
            tizen.filesystem.listStorages(function (list) {
                usb.storages = list.filter(function (s) { return s.type === 'EXTERNAL' && s.state === 'MOUNTED'; });
                done();
            }, function (e) { hubLog('usb.listStorages.error', e.message); usb.storages = []; done(); });
        } catch (e) { usb.storages = []; done(); }
    }

    // Probe once whether this TV lets apps write to the USB stick.
    function testUsbWrite() {
        if (!usb.storages.length) { return; }
        tizen.filesystem.resolve(usb.storages[0].label, function (dir) {
            try {
                // Unique name, so a leftover file from an interrupted test can't make this fail.
                var f = dir.createFile('.pardeh-test-' + Date.now() + '.txt');
                f.openStream('w', function (s) {
                    s.write('ok'); s.close();
                    dir.deleteFile(f.fullPath, noop, noop);
                    usb.writable = true;
                }, function () { usb.writable = false; });
            } catch (e) { usb.writable = false; }
        }, function () { usb.writable = false; }, 'rw');
    }

    // Unfinished downloads are remembered by file name: { id, uid, url, label, title, total, bytes }.
    // Entries keyed by full path come from the old in-app downloader and can only be restarted.
    function usbMeta(v) {
        if (job && job.kind === 'download' && job.name === v.title) { return 'در حال دانلود... ' + jobProgress(job); }
        if (v.partial) {
            var t = v.partial.total, b = v.partial.bytes || v.size || 0;
            return 'ناقص ' + (t ? Math.floor(b * 100 / t) + '% · ' : '') + mb(b) + ' · OK برای ادامه';
        }
        if (v.legacy) { return 'ناقص · ' + mb(v.size) + ' · OK برای دانلود دوباره'; }
        if (v.size === OLD_LIMIT) { return 'احتمالاً ناقص (۳۲ مگ) · نگه‌داشتن OK برای حذف'; }
        if (!v.size) { return 'فایل خالی · نگه‌داشتن OK برای حذف'; }
        return mb(v.size) + (positions['f:' + v.path] ? ' · ادامه از ' + fmtTime(positions['f:' + v.path]) : '');
    }

    function showUsb() {
        activeChip = -1; markActiveChip();
        resetGrid();
        setStatus('در حال خواندن USB ...');
        findUsb(function () {
            if (!usb.storages.length) { return setStatus('فلش USB پیدا نشد — فلش را به تلویزیون وصل کنید'); }
            var found = [], pending = 0;
            var finish = function () {
                if (--pending > 0) { return; }
                found.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
                var html = '', names = {};
                var add = function (v, ext) {
                    var idx = videos.length;
                    videos.push(v);
                    html += cardHtml(idx, '<div class="thumb text' + (v.partial || v.legacy ? ' partial' : '') + '">' + esc(ext) + '</div>', v.title, usbMeta(v));
                };
                var orphans = [];
                found.forEach(function (f) {
                    var t = f.name.match(TEMP_NAME), title = t ? t[1] : f.name;
                    // A finished download still carrying its temporary name: rename it, then list again.
                    if (t && !partials[title] && !(job && job.name === title) && !renameFailed[f.fullPath]) { return orphans.push({ f: f, title: title }); }
                    names[title] = true;
                    add({ local: true, file: f, uri: f.toURI(), path: f.fullPath, title: title, size: f.fileSize,
                        partial: partials[title] || null, legacy: !!partials[f.fullPath] },
                        (title.match(/\.(\w+)$/) || ['', ''])[1].toUpperCase());
                });
                if (orphans.length) {
                    var left = orphans.length;
                    orphans.forEach(function (o) {
                        renameFile(o.f, o.title, function (ok) {
                            if (!ok) { renameFailed[o.f.fullPath] = true; }   // try each file only once
                            if (--left === 0) { showUsb(); }
                        });
                    });
                    return;
                }
                // Paused downloads whose file the download manager hasn't created yet.
                Object.keys(partials).forEach(function (n) {
                    if (n.indexOf('/') === -1 && !names[n]) { add({ local: true, virtual: true, title: n, size: partials[n].bytes || 0, partial: partials[n] }, 'MP4'); }
                });
                $('grid-inner').innerHTML = html;
                hubLog('usb.list', videos.map(function (v) { return (v.partial ? '[partial] ' : v.legacy ? '[old-partial] ' : '') + v.title + ' ' + mb(v.size); }));
                setStatus(videos.length ? 'USB: ' + videos.length + ' ویدیو · OK پخش · نگه‌داشتن OK یا Tools: گزینه‌ها (حذف)' : 'ویدیویی روی USB نیست');
                if (videos.length) { zone = 'grid'; }
                render();
            };
            // Look in the root and one folder deep (e.g. /Videos).
            var scan = function (dir, depth) {
                pending++;
                dir.listFiles(function (files) {
                    if (depth > 0) { hubLog('usb.dir', { dir: dir.name, files: files.map(function (f) { return f.name + ' ' + f.fileSize; }) }); }
                    files.forEach(function (f) {
                        if (f.name.charAt(0) === '.') { return; }
                        if (f.isDirectory && depth < 2) { scan(f, depth + 1); }
                        else if (f.isFile && (VIDEO_EXT.test(f.name) || TEMP_NAME.test(f.name))) { found.push(f); }
                    });
                    finish();
                }, finish);
            };
            usb.storages.forEach(function (s) {
                pending++;
                tizen.filesystem.resolve(s.label, function (dir) { scan(dir, 0); finish(); }, finish, 'r');
            });
        });
    }

    function playLocal(v) {
        showPlayer(v.title);
        startPlayback(v.title, [{ label: 'USB', url: v.uri, alt: v.path, local: true }], 0, { id: 'f:' + v.path });
    }

    // Options for an item: Tools, or holding OK (for USB files also OK on an unfinished download).
    function openItemMenu(i) {
        var v = videos[i];
        if (!v || v.live) { return; }
        if (!v.local) { return openSiteItemMenu(i); }
        var items = [];
        if (v.partial) { items.push({ label: '↓ ادامهٔ دانلود', action: function () { resumeDownload(v); } }); }
        if (v.legacy) { items.push({ label: '↓ دانلود دوباره از اول', action: function () { restartDownload(v); } }); }
        if (!v.virtual) { items.push({ label: '▶ پخش', action: function () { playItem(i); } }); }
        items.push({ label: v.virtual ? '× لغو دانلود' : '× حذف از USB', action: function () { confirmDelete(v); } });
        items.push({ label: 'بستن', action: noop });
        openMenu(items, 0);
    }

    function openSiteItemMenu(i) {
        var v = videos[i], items = [{ label: v.series ? 'باز کردن' : 'پخش', action: function () { playItem(i); } }];
        if (v.site === 'gapfilm') { items.push({ label: 'بازیگران و عوامل', action: function () { gapCast(v); } }); }
        items.push({ label: 'مرتب‌سازی فهرست...', action: openSortMenu });
        items.push({ label: 'بستن', action: noop });
        openMenu(items, 0, v.title);
    }

    // Sorts what's loaded of the current list (the sites can't sort on their side); later pages
    // are added at the end as before.
    var SORTS = [
        { key: 'added', label: 'جدیدترین', compare: function (a, b) { return (b.added || 0) - (a.added || 0); } },
        { key: 'pop', label: 'پربازدیدترین / محبوب‌ترین', compare: function (a, b) { return (b.pop || 0) - (a.pop || 0); } },
        { key: 'length', label: 'کوتاه‌ترین', compare: function (a, b) { return (a.length || 0) - (b.length || 0); } },
        { key: 'title', label: 'الفبایی', compare: function (a, b) { return String(a.title).localeCompare(String(b.title)); } }
    ];

    function openSortMenu() {
        var usable = SORTS.filter(function (s) {
            return s.key === 'title' || videos.some(function (v) { return v[s.key]; });
        });
        openMenu(usable.map(function (s) { return { label: s.label, action: function () { sortList(s); } }; })
            .concat([{ label: 'بستن', action: noop }]), 0, 'مرتب‌سازی ' + videos.length + ' مورد');
    }

    function sortList(s) {
        var items = videos.slice().sort(s.compare), status = $('status').textContent.replace(/ · مرتب: .*$/, '');
        if (focusedEl && focusedEl.className.indexOf('card') !== -1) { focusedEl = null; }
        $('grid').innerHTML = '<div id="grid-inner"></div>';
        videos = []; gridIndex = 0;
        items.forEach(function (v) { v.thumbDone = false; });
        addItems(items);
        setStatus(status + ' · مرتب: ' + s.label);
        zone = 'grid';
        render();
    }

    function confirmDelete(v) {
        openMenu([
            { label: 'بله، حذف شود', action: function () { deleteUsbFile(v); } },
            { label: 'خیر', action: noop }
        ], 1, 'حذف «' + v.title + '»؟');
    }

    function forgetPartial(v) {
        var m = partials[v.title];
        if (m && m.id !== undefined) { try { tizen.download.cancel(m.id); } catch (e) { /* already gone */ } }
        delete partials[v.title];
        if (v.path) { delete partials[v.path]; }
        store.set('partials', partials);
    }

    function deleteUsbFile(v) {
        if (job && job.name === v.title) { return toast('این فایل در حال ذخیره است — اول با ● آن را متوقف کنید'); }
        forgetPartial(v);
        var done = function () {
            if (positions['f:' + v.path]) { delete positions['f:' + v.path]; store.set('positions', positions); }
            toast('حذف شد: ' + v.title);
            showUsb();
        };
        if (!v.file) { return done(); }
        try {
            v.file.parent.deleteFile(v.path, done, function (e) {
                hubLog('usb.delete.fail', e.message);
                if (v.partial) { return done(); }   // cancelling the download already removed it
                toast('حذف ممکن نشد');
            });
        } catch (e) { toast('حذف ممکن نشد'); hubLog('usb.delete.fail', e.message); }
    }

    // ---------- saving to USB: downloads (MP4) and recordings (HLS / live) ----------
    function safeName(t) {
        return (t || 'video').replace(/[\\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 80) || 'video';
    }

    // Resolves (creating if needed) <usb>/Videos: ok(dir).
    function videosDir(ok) {
        if (!usb.storages.length) { return toast('فلش USB پیدا نشد'); }
        if (usb.writable === false) { return toast('این تلویزیون اجازهٔ نوشتن روی USB را به برنامه نمی‌دهد'); }
        tizen.filesystem.resolve(usb.storages[0].label, function (root) {
            var dir;
            try { dir = root.resolve('Videos'); } catch (e) { dir = root.createDirectory('Videos'); }
            ok(dir);
        }, function (e) { toast('دسترسی به USB ممکن نشد'); hubLog('usb.resolve.fail', e.message); }, 'rw');
    }

    // Appends raw bytes to a Tizen FileStream (it only accepts base64 for binary data), in small
    // slices; a slice length divisible by 3 keeps every base64 piece self-contained.
    function writeBytes(stream, buffer) {
        var bytes = new Uint8Array(buffer), STEP = 3 * 8192;
        for (var i = 0; i < bytes.length; i += STEP) {
            stream.writeBase64(btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + STEP))));
        }
        return bytes.length;
    }

    function getBytes(url, ok, fail) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.timeout = 30000;
        xhr.onload = function () {
            if (xhr.status === 200 || xhr.status === 206) { ok(xhr.response, xhr); } else { fail('خطای سرور ' + xhr.status, xhr.status); }
        };
        xhr.onerror = xhr.ontimeout = xhr.onabort = function () { fail('اتصال قطع شد'); };
        xhr.send();
        return xhr;
    }

    function jobProgress(j) {
        return j.kind === 'download' && j.total ? Math.floor(j.bytes * 100 / j.total) + '%' : mb(j.bytes);
    }

    function updateBadge() {
        var b = $('job-badge');
        if (!job) { return b.classList.add('hidden'); }
        b.textContent = job.moving ? '↓ انتقال به USB...' : (job.kind === 'download' ? '↓ دانلود ' : '● ضبط ') + jobProgress(job);
        b.classList.remove('hidden');
    }

    function newJob(kind, name) {
        job = { kind: kind, name: name, id: null, dir: null, file: null, stream: null, bytes: 0, total: 0,
            stopped: false, closed: false, busy: false, xhr: null, timer: null };
        updateBadge();
        hubLog('job.start', { kind: kind, name: name });
        return job;
    }

    function endJob(j, msg) {
        if (!j.closed) {
            j.closed = true;
            if (j.stream) { try { j.stream.close(); } catch (e) { /* ignore */ } }
        }
        if (job === j) { job = null; }
        updateBadge();
        toast(msg);
        hubLog('job.end', { kind: j.kind, name: j.name, bytes: j.bytes, total: j.total, msg: msg });
        if (screen === 'browse' && videos.length && videos[0].local) { showUsb(); }
    }

    function saveDownloadState(j) {
        var m = partials[j.name];
        if (m) { m.bytes = j.bytes; m.total = j.total; store.set('partials', partials); }
    }

    function stopJob() {
        var j = job;
        if (!j) { return; }
        j.stopped = true;
        clearTimeout(j.timer);
        if (j.kind === 'download') {
            try { tizen.download.pause(j.id); } catch (e) { hubLog('download.pause.fail', e.message); }
            saveDownloadState(j);
            return endJob(j, 'دانلود متوقف شد (' + jobProgress(j) + ') — در بخش USB (دکمهٔ C) ادامه دهید یا حذف کنید');
        }
        if (j.id !== null) {   // recording through the hub
            try { tizen.download.pause(j.id); } catch (e) { hubLog('record.pause.fail', e.message); }
            return finishRecording(j, 'ضبط ذخیره شد: ' + j.name);
        }
        if (j.xhr) { try { j.xhr.abort(); } catch (e) { /* ignore */ } }
        endJob(j, 'ضبط ذخیره شد: ' + j.name);
    }

    // Record button / ▼ menu: MP4s are downloaded, live streams are recorded.
    function startSave() {
        var q = player.qualities[player.qIndex];
        if (job) { return toast('یک ذخیره‌سازی در حال انجام است — برای توقف ● را دوباره بزنید'); }
        if (!q || q.local) { return toast('این ویدیو از قبل روی USB است'); }
        if (q.stream) {
            // Watching the adaptive stream of a video that also has MP4 files: download the MP4
            // (up to 720p); only true streams (live TV) are recorded.
            var mp4 = null;
            player.qualities.forEach(function (x) { if (!x.stream && parseInt(x.label, 10) <= 720) { mp4 = x; } });
            return mp4 ? downloadMp4(mp4) : recordHls(q);
        }
        downloadMp4(q);
    }

    // Downloads go through the TV's own download manager: it writes straight to the USB stick,
    // pauses and resumes natively, and keeps big files out of the app's memory (writing them from
    // the app froze the 2016 web engine at ~32 MB).
    function downloadsSupported() {
        try { return !!(tizen.download && tizen.DownloadRequest); } catch (e) { return false; }
    }

    function downloadMp4(q) {
        if (!downloadsSupported()) { return toast('دانلود روی این تلویزیون پشتیبانی نمی‌شود'); }
        var name = safeName(player.title) + ' - ' + q.label + '.mp4';
        if (partials[name]) { return resumeDownload({ title: name, partial: partials[name] }); }
        var uid = player.id && player.id.indexOf('a:') === 0 ? player.id.slice(2) : null;
        videosDir(function (dir) {
            var old = null;
            try { old = dir.resolve(name); } catch (e) { /* not there yet */ }
            if (old && partials[old.fullPath]) { return restartDownload({ title: name, file: old, path: old.fullPath }); }
            if (old) { return toast('این ویدیو قبلاً دانلود شده'); }
            startDownload(name, q.url, { uid: uid, url: q.url, label: q.label, title: player.title });
        });
    }

    // Renames a file within its folder (keeps going on failure, so the list still shows it).
    function renameFile(f, newName, done) {
        try {
            f.parent.moveTo(f.fullPath, f.parent.fullPath + '/' + newName, false, function () {
                hubLog('usb.renamed', newName); done(true);
            }, function (e) { hubLog('usb.rename.fail', e.message); done(false); });
        } catch (e) { hubLog('usb.rename.fail', e.message); done(false); }
    }

    // Gives a finished download its proper name if the download manager left the temporary one.
    function finishName(name, done) {
        videosDir(function (dir) {
            dir.listFiles(function (files) {
                var tmp = null;
                files.forEach(function (f) { var t = f.name.match(TEMP_NAME); if (t && t[1] === name) { tmp = f; } });
                if (!tmp) { return done(); }
                renameFile(tmp, name, function () { done(); });
            }, function () { done(); });
        });
    }

    function startDownload(name, url, meta) {
        videosDir(function (dir) {
            var j = newJob('download', name);
            // Which destinations the download manager accepts differs between firmwares: try the
            // USB folder in its different forms, then the TV's own Downloads folder (the file is
            // moved to the USB stick when it's finished).
            var dests = [dir.fullPath, usb.storages[0].label + '/Videos', usb.storages[0].label, 'downloads'];
            for (var i = 0; i < dests.length && j.id === null; i++) {
                try {
                    j.id = tizen.download.start(new tizen.DownloadRequest(url, dests[i], name, 'ALL'), downloadListener(j));
                    meta.dest = dests[i];
                } catch (e) { hubLog('download.dest.rejected', { dest: dests[i], err: e.message }); }
            }
            if (j.id === null) { return endJob(j, 'شروع دانلود ممکن نشد'); }
            hubLog('download.dest', meta.dest);
            meta.id = j.id; meta.bytes = 0; meta.total = 0; meta.usbDir = dir.fullPath;
            partials[name] = meta;
            store.set('partials', partials);
            toast('دانلود به USB شروع شد — برای توقف ● را دوباره بزنید');
        });
    }

    // Downloads that had to go to the TV's own storage are moved to the USB stick when finished.
    function moveToUsb(j, m) {
        j.moving = true;
        updateBadge();
        var fail = function (e) {
            hubLog('download.move.fail', e && e.message);
            endJob(j, 'انتقال به USB ممکن نشد — فایل در حافظهٔ تلویزیون مانده است');
        };
        tizen.filesystem.resolve('downloads', function (dl) {
            dl.moveTo(dl.fullPath + '/' + j.name, m.usbDir + '/' + j.name, true, function () {
                delete partials[j.name];
                store.set('partials', partials);
                endJob(j, 'دانلود تمام شد: ' + j.name);
            }, fail);
        }, fail, 'rw');
    }

    function downloadListener(j) {
        var logged = j.bytes;
        return {
            onprogress: function (id, received, total) {
                if (j.closed) { return; }
                j.bytes = received; j.total = total || j.total;
                updateBadge();
                if (received - logged >= 4 * 1048576) {
                    logged = received;
                    saveDownloadState(j);
                    hubLog('job.progress', { mb: Math.round(received / 1048576), totalMb: Math.round(j.total / 1048576) });
                }
            },
            onpaused: noop,
            oncanceled: noop,
            oncompleted: function (id, fullPath) {
                hubLog('download.completed', { name: j.name, path: fullPath });
                var m = partials[j.name];
                if (m && m.dest === 'downloads' && m.usbDir && !j.closed) { return moveToUsb(j, m); }
                delete partials[j.name];
                store.set('partials', partials);
                if (j.closed) { return; }
                j.moving = true;
                updateBadge();
                finishName(j.name, function () { j.moving = false; endJob(j, 'دانلود تمام شد: ' + j.name); });
            },
            onfailed: function (id, err) {
                saveDownloadState(j);
                hubLog('download.failed', { name: j.name, err: err ? err.name + ': ' + err.message : '' });
                if (!j.closed) { endJob(j, 'دانلود قطع شد — در بخش USB می‌توانید ادامه دهید'); }
            }
        };
    }

    // Continues a paused download; if the download manager no longer knows it (e.g. after the
    // TV was restarted), it starts again with a fresh link.
    function resumeDownload(v) {
        if (job) { return toast('یک ذخیره‌سازی در حال انجام است'); }
        var meta = v.partial, state = null;
        try { state = tizen.download.getState(meta.id); } catch (e) { /* unknown id */ }
        hubLog('download.resume', { name: v.title, id: meta.id, state: state });
        if (state === 'COMPLETED') {
            delete partials[v.title]; store.set('partials', partials);
            toast('این دانلود کامل است');
            return showUsb();
        }
        if (state === 'PAUSED' || state === 'DOWNLOADING' || state === 'QUEUED') {
            var j = newJob('download', v.title);
            j.id = meta.id; j.bytes = meta.bytes || 0; j.total = meta.total || 0;
            try {
                tizen.download.setListener(meta.id, downloadListener(j));
                if (state === 'PAUSED') { tizen.download.resume(meta.id); }
                toast('ادامهٔ دانلود از ' + mb(j.bytes));
                if (screen === 'browse') { showUsb(); }
                return;
            } catch (e) {
                hubLog('download.resume.fail', e.message);
                job = null; updateBadge();
            }
        }
        restartDownload(v);
    }

    function restartDownload(v) {
        if (job) { return toast('یک ذخیره‌سازی در حال انجام است'); }
        var meta = v.partial || partials[v.path] || {};
        var go = function (url) {
            if (!url) { return toast('لینک این دانلود در دسترس نیست'); }
            var start = function () {
                forgetPartial(v);
                startDownload(v.title, url, { uid: meta.uid, url: url, label: meta.label, title: meta.title });
                if (screen === 'browse') { showUsb(); }
            };
            if (!v.file) { return start(); }
            try { v.file.parent.deleteFile(v.path, start, start); } catch (e) { start(); }
        };
        if (!meta.uid) { return go(meta.url); }
        // Aparat links expire, so fetch a fresh one for the same quality.
        delete showCache[meta.uid];
        getShow(meta.uid, function (d) {
            var url = meta.url;
            (d.data.attributes.file_link_all || []).forEach(function (q) {
                if (q.profile === meta.label && q.urls && q.urls[0]) { url = q.urls[0]; }
            });
            go(url);
        }, function () { go(meta.url); });
    }

    // After the app starts, pick up downloads the download manager is still running.
    function reattachDownloads() {
        if (!downloadsSupported()) { return; }
        Object.keys(partials).forEach(function (name) {
            var m = partials[name], state = null;
            if (name.indexOf('/') !== -1 || m.id === undefined) { return; }
            try { state = tizen.download.getState(m.id); } catch (e) { return; }
            if (state === 'COMPLETED') { delete partials[name]; store.set('partials', partials); }
            else if ((state === 'DOWNLOADING' || state === 'QUEUED') && !job) {
                var j = newJob('download', name);
                j.id = m.id; j.bytes = m.bytes || 0; j.total = m.total || 0;
                try { tizen.download.setListener(m.id, downloadListener(j)); } catch (e) { job = null; updateBadge(); }
            }
        });
    }

    function resolveUrl(base, u) {
        if (/^https?:\/\//.test(u)) { return u; }
        if (u.charAt(0) === '/') { return base.match(/^https?:\/\/[^\/]+/)[0] + u; }
        return base.replace(/[?#].*$/, '').replace(/[^\/]*$/, '') + u;
    }

    // Saves an HLS stream's segments, in order, into .ts files on the USB stick. Files are split
    // every 16 MB (the TV's file writer locks up on larger files); the parts play back to back.
    // Live streams record until stopped; finished playlists stop by themselves at the end.
    function unproxy(u) {
        var i = u.indexOf('/proxy?u=');
        return i < 0 ? u : decodeURIComponent(u.slice(i + 9).split('&')[0]);
    }

    // With a TV Hub around, the hub joins the live segments into one continuous stream and the
    // TV's download manager saves it straight to USB — no file writing in the app at all.
    function recordHls(q) {
        if (!HUB || !downloadsSupported()) { return recordHlsLocal(q); }
        var src = unproxy(q.url);
        if (/^خودکار/.test(q.label)) {
            player.qualities.forEach(function (x) { if (x !== q && x.stream && parseInt(x.label, 10) <= 720) { src = unproxy(x.url); } });
        }
        var d = new Date();
        var name = safeName(player.title) + ' ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
            ' ' + pad(d.getHours()) + pad(d.getMinutes()) + '.ts';
        videosDir(function (dir) {
            var j = newJob('record', name);
            try {
                j.id = tizen.download.start(new tizen.DownloadRequest(HUB + '/record?u=' + encodeURIComponent(src), dir.fullPath, name, 'ALL'), {
                    onprogress: function (id, received) {
                        if (j.closed) { return; }
                        j.bytes = received;
                        updateBadge();
                    },
                    onpaused: noop,
                    oncanceled: noop,
                    oncompleted: function () { finishRecording(j, 'ضبط کامل شد: ' + name); },
                    onfailed: function (id, err) {
                        hubLog('record.failed', err ? err.name + ': ' + err.message : '');
                        finishRecording(j, 'ضبط قطع شد — تا این‌جا ذخیره شد: ' + name);
                    }
                });
            } catch (e) {
                hubLog('record.start.fail', e.message);
                return endJob(j, 'شروع ضبط ممکن نشد');
            }
            toast('ضبط روی USB شروع شد — برای توقف ● را دوباره بزنید');
        });
    }

    // Gives the recording its proper name (the download manager leaves a temporary one).
    function finishRecording(j, msg) {
        if (j.finishing) { return; }
        j.finishing = true;
        j.moving = true;
        updateBadge();
        setTimeout(function () {   // let the download manager flush the file first
            finishName(j.name, function () { j.moving = false; endJob(j, msg); });
        }, 1500);
    }

    // Fallback without a hub: writes the segments from the app, split into 16 MB parts.
    function recordHlsLocal(q) {
        // "Auto" points at the master playlist; record a fixed variant (up to 720p) instead.
        var media = q.url;
        if (/^خودکار/.test(q.label)) {
            player.qualities.forEach(function (x) { if (x !== q && x.stream && parseInt(x.label, 10) <= 720) { media = x.url; } });
        }
        var d = new Date();
        var base = safeName(player.title) + ' ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
            ' ' + pad(d.getHours()) + pad(d.getMinutes());
        var part = 0;
        videosDir(function (dir) {
            var j = newJob('record', base), seen = {}, queue = [], ended = false;
            j.dir = dir;

            // Starts the next part file, then calls done().
            var nextPart = function (done) {
                if (j.stream) { try { j.stream.close(); } catch (e) { /* ignore */ } j.stream = null; }
                part++;
                var f;
                try { f = dir.createFile(base + ' (' + pad(part) + ').ts'); } catch (e) { return endJob(j, 'ساخت فایل روی USB ممکن نشد'); }
                f.openStream('w', function (s) {
                    if (j.closed) { try { s.close(); } catch (e) { /* ignore */ } return; }
                    j.file = f; j.stream = s; j.partBytes = 0;
                    done();
                }, function () { endJob(j, 'ساخت فایل روی USB ممکن نشد'); });
            };

            var poll = function () {
                if (j.stopped) { return; }
                var xhr = new XMLHttpRequest();
                xhr.open('GET', media, true);
                xhr.timeout = 15000;
                xhr.onload = function () {
                    if (j.stopped) { return; }
                    var target = 4;
                    (xhr.responseText || '').split('\n').forEach(function (l) {
                        l = l.trim();
                        if (l.indexOf('#EXT-X-TARGETDURATION:') === 0) { target = parseFloat(l.split(':')[1]) || target; }
                        else if (l.indexOf('#EXT-X-ENDLIST') === 0) { ended = true; }
                        else if (l && l.charAt(0) !== '#') {
                            var u = resolveUrl(media, l);
                            if (!seen[u]) { seen[u] = true; queue.push(u); }
                        }
                    });
                    pump();
                    if (!ended) { j.timer = setTimeout(poll, Math.max(2000, target * 1000)); }
                };
                xhr.onerror = xhr.ontimeout = function () { if (!j.stopped) { j.timer = setTimeout(poll, 3000); } };
                xhr.send();
            };

            var pump = function () {
                if (j.busy || j.stopped) { return; }
                if (!queue.length) {
                    if (ended) { endJob(j, 'ضبط کامل شد: ' + base); }
                    return;
                }
                j.busy = true;
                j.xhr = getBytes(queue.shift(), function (buf) {
                    if (j.stopped) { j.busy = false; return; }
                    var n;
                    try { n = writeBytes(j.stream, buf); } catch (e) { j.busy = false; return endJob(j, 'نوشتن روی USB ممکن نشد'); }
                    j.bytes += n; j.partBytes += n;
                    updateBadge();
                    if (Math.floor(j.bytes / 4194304) !== Math.floor((j.bytes - n) / 4194304)) {
                        hubLog('job.progress', { mb: Math.round(j.bytes / 1048576), part: part });
                    }
                    if (j.partBytes < PART_SIZE) { j.busy = false; return pump(); }
                    nextPart(function () { j.busy = false; pump(); });
                }, function () { j.busy = false; pump(); });   // skip a missing segment, keep recording
            };

            toast('ضبط روی USB شروع شد — برای توقف ● را دوباره بزنید');
            nextPart(poll);
        });
    }

    function toggleSave() {
        if (job) { return stopJob(); }
        if (!has('usb')) { return; }
        if (screen !== 'player') { return toast('اول ویدیو را پخش کنید، بعد ● را بزنید'); }
        startSave();
    }

    // ---------- links sent straight to the TV ----------
    function handleAppControl() {
        if (!has('link')) { return; }
        try {
            var req = tizen.application.getCurrentApplication().getRequestedAppControl();
            if (!req) { return; }
            var found = null;
            (req.appControl.data || []).forEach(function (d) {
                d.value.forEach(function (v) {
                    var m = !found && String(v).match(/https?:\/\/[^\s"'\\]+/);
                    if (m) { found = m[0]; }
                });
            });
            if (found) { toast('لینک دریافت شد'); openLink(found); }
        } catch (e) { /* not on a TV */ }
    }

    // ---------- TV Hub (optional) ----------
    // The hub adds QR-code phone sending and live TV. Its last address is remembered;
    // if it moved, the local network is scanned.
    function findHub() {
        var saved = store.get('hub', null);
        var check = function (base, cb) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', base + '/api/status', true);
            xhr.timeout = 1500;
            xhr.onload = function () { cb(xhr.status === 200 && xhr.responseText.indexOf('"tvs"') !== -1); };
            xhr.onerror = xhr.ontimeout = function () { cb(false); };
            xhr.send();
        };
        var found = function (base) {
            HUB = base;
            store.set('hub', base);
            connectHub();
            var dlApi = false;
            try { dlApi = !!(tizen.download && tizen.download.start && window.tizen.DownloadRequest); } catch (e) { /* no tizen */ }
            hubLog('startup', { storages: usb.storages.map(function (s) { return s.label; }), usbWritable: usb.writable, downloadApi: dlApi });
        };
        var scan = function () {
            var ip = null;
            try { ip = webapis.network.getIp(); } catch (e) { /* no network API */ }
            if (!ip) { return; }
            var prefix = ip.split('.').slice(0, 3).join('.') + '.', next = 1, active = 0, done = false;
            var pump = function () {
                while (!done && active < 24 && next < 255) {
                    (function (base) {
                        active++;
                        check(base, function (ok) {
                            active--;
                            if (ok && !done) { done = true; return found(base); }
                            pump();
                        });
                    }('http://' + prefix + (next++) + ':' + HUB_PORT));
                }
            };
            pump();
        };
        if (saved) { check(saved, function (ok) { if (ok) { found(saved); } else { scan(); } }); } else { scan(); }
    }

    function connectHub() {
        if (!window.EventSource) { return; }
        var es = new EventSource(HUB + '/api/events');
        es.onopen = function () { $('hub-state').textContent = '● به هاب متصل است'; };
        es.onerror = function () { $('hub-state').textContent = '● هاب در دسترس نیست'; };
        es.onmessage = function (e) {
            var msg;
            try { msg = JSON.parse(e.data); } catch (err) { return; }
            if (msg.type === 'key' && msg.code) {
                return onKey({ keyCode: +msg.code, preventDefault: noop, fake: true });
            }
            if (msg.type === 'play' && msg.url && has('phone')) {
                if (screen === 'link') { closeLinkDialog(); }
                if (screen === 'phone') { closePhoneDialog(); }
                if (screen === 'login') { closeLogin(); }
                toast('لینک از گوشی دریافت شد');
                openLink(msg.url, msg.title);
            }
        };
    }

    function openPhoneDialog() {
        screen = 'phone';
        if (HUB) {
            var qr = qrcode(0, 'M');
            qr.addData(HUB);
            qr.make();
            $('qr').innerHTML = qr.createImgTag(10, 0);
            show('qr');
            $('hub-url').textContent = HUB;
        } else {
            hide('qr');
            $('hub-url').textContent = '';
            $('hub-state').textContent = 'هاب پیدا نشد (اختیاری است)';
        }
        show('phone-dialog');
    }

    function closePhoneDialog() {
        hide('phone-dialog');
        screen = 'browse';
        render();
    }

    // ---------- resume points ----------
    function savePosition() {
        if (!player.id || player.live || !player.duration || !player.pos) { return; }
        var sec = Math.floor(player.pos / 1000);
        delete positions[player.id];
        // Near the end counts as watched: start from the beginning next time.
        if (sec > 15 && sec < player.duration / 1000 - 20) { positions[player.id] = sec; }
        var ids = Object.keys(positions);
        if (ids.length > 150) { delete positions[ids[0]]; }
        store.set('positions', positions);
    }

    // ---------- player ----------
    function showPlayer(title) {
        if (screen === 'player') { savePosition(); closeMenu(false); }
        try { webapis.avplay.stop(); webapis.avplay.close(); } catch (e) { /* nothing open */ }
        player.token++;
        player.pos = 0; player.duration = 0; player.seekAcc = 0; player.paused = false;
        player.t0 = Date.now(); player.started = false; player.stallAt = 0;
        clearTimeout(player.seekTimer);
        screen = 'player';
        hide('browse'); show('player'); hide('pause-icon'); hide('osd-bubble');
        $('osd-title').textContent = title || '';
        $('osd-quality').textContent = '';
        $('osd-cur').textContent = '';
        $('osd-dur').textContent = '';
        setBar(0);
        showSpinner('در حال بارگذاری...');
        showOsd();
    }

    function showSpinner(text) {
        $('spinner-text').textContent = text;
        show('spinner');
        $('spinner').classList.remove('error');
    }

    function friendlyError(msg) {
        if (/CONNECTION_FAILED|NETWORK/i.test(msg)) { return 'اتصال به این ویدیو برقرار نشد — اینترنت یا لینک را بررسی کنید'; }
        if (/INVALID_OPERATION|INVALID_STATE/i.test(msg)) { return 'پخش این ویدیو شروع نشد — دوباره امتحان کنید'; }
        if (/UNSUPPORTED|NOT_SUPPORTED|FORMAT/i.test(msg)) { return 'فرمت این ویدیو روی این تلویزیون پشتیبانی نمی‌شود'; }
        return msg;
    }

    function playerError(msg) {
        hubLog('player.error', msg);
        $('spinner-text').textContent = msg + ' — Back برای بازگشت';
        show('spinner');
        $('spinner').classList.add('error');
    }

    function viaHubList(qualities) {
        return qualities.map(function (x) {
            return { label: x.label, url: /^https:\/\//.test(x.url) ? hubProxy(x.url) : x.url, stream: x.stream };
        });
    }

    // opts: { id, live, resumeMs, useAlt }. id (when given) is used to remember the position.
    function startPlayback(title, qualities, qIndex, opts) {
        opts = opts || {};
        if (HUB && needsHub(qualities[qIndex].url)) { qualities = viaHubList(qualities); }
        var q = qualities[qIndex], token = player.token, resumeMs = opts.resumeMs || 0, fromSaved = false;
        player.title = title; player.qualities = qualities; player.qIndex = qIndex; player.paused = false;
        if (opts.id !== undefined) { player.id = opts.id; }
        player.live = !!opts.live;
        if (!resumeMs && player.id && positions[player.id]) { resumeMs = positions[player.id] * 1000; fromSaved = true; }
        $('osd-title').textContent = title;
        $('osd-quality').textContent = q.label;
        hide('pause-icon');
        showSpinner('در حال بارگذاری...');
        try { webapis.avplay.stop(); webapis.avplay.close(); } catch (e) { /* nothing open yet */ }

        player.t0 = Date.now();
        var failed = function (msg) {
            if (token !== player.token) { return; }
            // Adaptive stream failed: fall back to a regular MP4 of the same video.
            var mp4 = -1;
            if (q.stream) { qualities.forEach(function (x, i) { if (!x.stream && parseInt(x.label, 10) <= 720) { mp4 = i; } }); }
            if (mp4 >= 0) {
                hubLog('play.hlsFallback', msg);
                return startPlayback(title, qualities, mp4, { resumeMs: player.pos || resumeMs });
            }
            // Local files: retry once with the plain path instead of the file:// URI.
            if (q.alt && !opts.useAlt) { return startPlayback(title, qualities, qIndex, { resumeMs: resumeMs, useAlt: true, live: player.live }); }
            // HTTPS sites with modern certificates: retry through the TV Hub if one is around.
            if (HUB && /^https:\/\//.test(q.url)) {
                hubLog('play.retryViaHub', q.url);
                rememberViaHub(q.url);
                return startPlayback(title, viaHubList(qualities), qIndex, { resumeMs: resumeMs, live: player.live });
            }
            if (player.live && !opts.retried) {
                hubLog('play.liveRetry', msg);
                return setTimeout(function () {
                    if (token === player.token) { startPlayback(title, qualities, qIndex, { live: true, retried: true }); }
                }, 1500);
            }
            hubLog('play.error', { msg: msg, url: opts.useAlt ? q.alt : q.url });
            playerError(friendlyError(msg));
        };
        try {
            webapis.avplay.open(opts.useAlt ? q.alt : q.url);
            webapis.avplay.setDisplayRect(0, 0, 1920, 1080);
            webapis.avplay.setDisplayMethod(DISPLAY_MODES[displayMode].id);
            // Start after a short buffer; keep a longer one after a stall so it doesn't stutter again.
            // Not for live streams: they reject these settings with PLAYER_ERROR_INVALID_OPERATION.
            if (!opts.live) try {
                webapis.avplay.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', 3);
                webapis.avplay.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', 8);
            } catch (e) { /* not supported on this firmware */ }
            webapis.avplay.setListener({
                onbufferingstart: function () {
                    if (player.started) { player.stallAt = Date.now(); }
                    showSpinner('در حال بافر...');
                },
                onbufferingcomplete: function () {
                    hide('spinner');
                    if (player.stallAt) {
                        hubLog('play.stall', { ms: Date.now() - player.stallAt, pos: Math.floor(player.pos / 1000), q: player.qualities[player.qIndex].label,
                            afterSeekMs: player.lastSeekAt ? player.stallAt - player.lastSeekAt : null });
                        player.stallAt = 0;
                    }
                },
                oncurrentplaytime: updateTime,
                onstreamcompleted: function () {
                    if (player.id) { delete positions[player.id]; store.set('positions', positions); }
                    var nextItem = player.listIndex >= 0 && !player.live && videos[player.listIndex + 1];
                    if (nextItem && !nextItem.series) { return playNeighbor(1); }
                    closePlayer();
                },
                onerror: function (e) { failed('خطای پخش: ' + e); }
            });
            webapis.avplay.prepareAsync(function () {
                if (token !== player.token) { return; }
                player.duration = webapis.avplay.getDuration();
                if (!player.duration) { player.live = true; }
                if (resumeMs && !player.live) {
                    webapis.avplay.seekTo(resumeMs);
                    player.pos = resumeMs;
                    if (fromSaved) { toast('ادامه از ' + fmtTime(resumeMs / 1000) + ' — دکمهٔ 0 برای شروع از اول'); }
                }
                webapis.avplay.play();
                player.started = true;
                hide('spinner');
                updateTime(player.pos);
                showOsd();
                hubLog('play.ok', { startMs: Date.now() - player.t0, q: q.label, dur: Math.floor(player.duration / 1000), live: player.live });
            }, function (e) { failed('پخش ممکن نشد: ' + e); });
        } catch (e) { failed('پخش ممکن نشد: ' + e.message); }
    }

    // Seek bar: progress fill and knob move with GPU transforms.
    function setBar(f) {
        f = Math.max(0, Math.min(1, f || 0));
        setTransform($('osd-progress'), 'scaleX(' + f + ')');
        setTransform($('osd-knob'), 'translate3d(' + Math.round(f * BAR_W) + 'px,0,0)');
    }

    function showBubble(f, text) {
        var b = $('osd-bubble');
        b.textContent = text;
        setTransform(b, 'translate3d(' + Math.round(Math.max(0, Math.min(1, f)) * BAR_W) + 'px,0,0)');
        b.classList.remove('hidden');
    }

    function updateTime(ms) {
        var lastSaved = Math.floor(player.pos / 10000);
        player.pos = ms;
        if (player.seekAcc) { return; }   // the seek preview is on screen
        var dur = player.duration;
        if (player.live) {
            $('osd-cur').textContent = '● زنده';
            $('osd-dur').textContent = '';
            setBar(1);
        } else {
            $('osd-cur').textContent = fmtTime(ms / 1000);
            $('osd-dur').textContent = fmtTime(dur / 1000);
            setBar(dur ? ms / dur : 0);
        }
        if (Math.floor(ms / 10000) !== lastSaved) { savePosition(); }   // every ~10 s
    }

    function showOsd() {
        $('osd').classList.remove('faded');
        clearTimeout(player.osdTimer);
        player.osdTimer = setTimeout(function () {
            if (!player.paused && !menu && !player.seekAcc) { $('osd').classList.add('faded'); }
        }, 4000);
    }

    function togglePause() {
        try {
            if (player.paused) { webapis.avplay.play(); } else { webapis.avplay.pause(); }
            player.paused = !player.paused;
        } catch (e) { /* not ready */ }
        if (player.paused) { show('pause-icon'); } else { hide('pause-icon'); }
        showOsd();
    }

    // Repeated ◀ ▶ presses add up and the player seeks once when they stop. Holding the
    // button speeds up: 10 s steps, then 30 s, then 60 s.
    function seekBy(dir, big) {
        if (player.live || !player.duration) { return showOsd(); }
        if (!player.seekAcc) { player.seekBase = player.pos; player.seekPresses = 0; }
        player.seekPresses++;
        var step = big ? 60 : player.seekPresses > 12 ? 60 : player.seekPresses > 4 ? 30 : 10;
        var dur = player.duration;
        var target = Math.max(0, Math.min(player.seekBase + (player.seekAcc + dir * step) * 1000, dur - 3000));
        player.seekAcc = Math.round((target - player.seekBase) / 1000) || dir * 0.001;   // stays "on" even when clamped to 0
        var delta = Math.round(player.seekAcc);
        $('osd-cur').textContent = fmtTime(target / 1000);
        setBar(target / dur);
        showBubble(target / dur, (delta >= 0 ? '+' : '−') + fmtTime(Math.abs(delta)));
        showOsd();
        clearTimeout(player.seekTimer);
        player.seekTimer = setTimeout(function () {
            player.seekAcc = 0;
            player.pos = target;
            player.lastSeekAt = Date.now();
            hide('osd-bubble');
            try { webapis.avplay.seekTo(Math.floor(target)); } catch (e) { /* not seekable */ }
            updateTime(target);
            showOsd();
        }, SEEK_DELAY);
    }

    // Number keys: 0 = start, 1–9 = 10%–90% of the video.
    function seekToPercent(d) {
        if (player.live || !player.duration) { return; }
        clearTimeout(player.seekTimer);
        player.seekAcc = 0;
        hide('osd-bubble');
        var target = Math.floor(player.duration * d / 10);
        player.lastSeekAt = Date.now();
        try { webapis.avplay.seekTo(target); } catch (e) { /* not seekable */ }
        updateTime(target);
        showOsd();
    }

    function playNeighbor(delta) {
        var i = player.listIndex + delta;
        if (player.listIndex < 0 || i < 0 || i >= videos.length) {
            return toast(delta > 0 ? 'مورد بعدی وجود ندارد' : 'مورد قبلی وجود ندارد');
        }
        if (more && i >= videos.length - COLS * 2) { more(); }
        toast((delta > 0 ? 'بعدی: ' : 'قبلی: ') + videos[i].title);
        playItem(i);
    }

    // ---------- pop-up menus (player ▲ quality / ▼ actions, USB item options) ----------
    function openMenu(items, index, title) {
        menu = { items: items, index: index || 0, title: title || '' };
        $('menu').className = screen === 'player' ? '' : 'center';
        renderMenu();
        if (screen === 'player') { showOsd(); }
    }

    function renderMenu() {
        var m = $('menu');
        m.innerHTML = (menu.title ? '<div class="m-title" dir="auto">' + esc(menu.title) + '</div>' : '') +
            menu.items.map(function (it, i) {
                return '<div class="m-item' + (i === menu.index ? ' sel' : '') + '">' + esc(it.label) + '</div>';
            }).join('');
        // Centered menus (browse screens) are centered vertically too, so long ones still fit.
        m.style.top = m.className === 'center' ? Math.max(20, Math.round((1080 - m.offsetHeight) / 2)) + 'px' : '';
    }

    function closeMenu(pick) {
        var m = menu;
        menu = null;
        hide('menu');
        if (pick && m) { m.items[m.index].action(); }
    }

    function onMenuKey(k) {
        if (k === KEY.UP && menu.index > 0) { menu.index--; }
        else if (k === KEY.DOWN && menu.index < menu.items.length - 1) { menu.index++; }
        else if (k === KEY.ENTER) { return closeMenu(true); }
        else if (k === KEY.BACK || k === KEY.TOOLS) { return closeMenu(false); }
        renderMenu();
    }

    function openQualityMenu() {
        if (player.qualities.length < 2) { return showOsd(); }
        openMenu(player.qualities.map(function (q, i) {
            return { label: (i === player.qIndex ? '✓ ' : '') + q.label, action: function () { switchQuality(i); } };
        }), player.qIndex, 'کیفیت');
    }

    function switchQuality(i) {
        if (i === player.qIndex) { return; }
        var p = parseInt(player.qualities[i].label, 10);
        if (!player.live) { store.set('prefQ', p || 'auto'); }   // start future videos at this quality
        startPlayback(player.title, player.qualities, i, { resumeMs: player.live ? 0 : player.pos, live: player.live });
    }

    function openActionsMenu() {
        var items = [], q = player.qualities[player.qIndex];
        if (job) {
            items.push({ label: '■ توقف ' + (job.kind === 'download' ? 'دانلود' : 'ضبط') + ' (' + jobProgress(job) + ')', action: stopJob });
        } else if (q && !q.local && has('usb')) {
            items.push({ label: q.stream && player.live ? '● ضبط در USB' : '↓ دانلود در USB', action: startSave });
        }
        items.push({ label: 'نمایش: ' + DISPLAY_MODES[displayMode].label, action: cycleDisplayMode });
        if (player.listIndex >= 0) { items.push({ label: 'ویدیوی بعدی', action: function () { playNeighbor(1); } }); }
        items.push({ label: 'راهنمای دکمه‌ها', action: toggleHelp });
        items.push({ label: 'بستن منو', action: noop });
        openMenu(items, 0);
    }

    function cycleDisplayMode() {
        displayMode = (displayMode + 1) % DISPLAY_MODES.length;
        store.set('displayMode', displayMode);
        try { webapis.avplay.setDisplayMethod(DISPLAY_MODES[displayMode].id); } catch (e) { /* not playing */ }
        toast('نمایش: ' + DISPLAY_MODES[displayMode].label);
    }

    function closePlayer() {
        savePosition();
        player.token++;
        clearTimeout(player.seekTimer);
        player.seekAcc = 0;
        try { webapis.avplay.stop(); webapis.avplay.close(); } catch (e) { /* ignore */ }
        closeMenu(false);
        screen = 'browse';
        hide('player'); show('browse');
        if (videos.length && videos[0].local) { showUsb(); }   // refresh resume points / sizes
        render();
    }

    function toggleHelp() {
        helpOpen = !helpOpen;
        if (helpOpen) { show('help'); } else { hide('help'); }
    }

    // ---------- focus / rendering ----------
    // Rendering is batched to one per frame, so holding an arrow key stays smooth.
    function render() {
        if (renderQueued) { return; }
        renderQueued = true;
        raf(doRender);
    }

    function doRender() {
        renderQueued = false;
        var el = null;
        if (screen !== 'player') {
            if (zone === 'top') { el = $(TOP[topIndex]); }
            else if (zone === 'chips') { el = $('chip-' + chipIndex); }
            else if (zone === 'grid') { el = $('card-' + gridIndex); }
        }
        if (focusedEl !== el) {
            if (focusedEl) { focusedEl.classList.remove('focused'); }
            if (el) { el.classList.add('focused'); }
            focusedEl = el;
        }
        var inner = $('grid-inner');
        if (!inner) { return; }
        // Scroll with a GPU transform instead of changing layout.
        var card = $('card-' + gridIndex);
        var y = (zone === 'grid' && card) ? Math.max(0, card.offsetTop - 20) : 0;
        setTransform(inner, 'translate3d(0,' + (-y) + 'px,0)');
        loadThumbs();
        schedulePrefetch();
    }

    // Posters are only loaded for rows near the focus.
    function loadThumbs() {
        var row = zone === 'grid' ? Math.floor(gridIndex / COLS) : 0;
        var to = Math.min(videos.length, (row + 3) * COLS);
        for (var i = Math.max(0, (row - 1) * COLS); i < to; i++) {
            var v = videos[i];
            if (v.poster && !v.thumbDone) {
                var th = $('thumb-' + i);
                if (th) { th.style.backgroundImage = "url('" + v.poster.replace(/'/g, '%27') + "')"; v.thumbDone = true; }
            }
        }
    }

    // Fetch playback info for the focused video ahead of time so OK starts it faster.
    function schedulePrefetch() {
        clearTimeout(prefetchTimer);
        var v = zone === 'grid' && videos[gridIndex];
        if (!v || !v.uid) { return; }
        prefetchTimer = setTimeout(function () { getShow(v.uid, noop, noop); }, 400);
    }

    function moveGrid(delta) {
        var n = gridIndex + delta;
        if (n < 0) {
            if (gridIndex < COLS) { zone = 'chips'; } else { gridIndex = gridIndex % COLS; }
            return render();
        }
        if (n >= videos.length) { n = videos.length - 1; }
        gridIndex = n;
        // Near the end: fetch the next page.
        if (more && gridIndex >= videos.length - COLS * 2) { more(); }
        render();
    }

    // Moving across the categories loads the one you stop on (the account chip waits for OK).
    function focusChip(i) {
        chipIndex = i;
        clearTimeout(chipTimer);
        chipTimer = setTimeout(function () {
            var c = chips[chipIndex];
            if (zone === 'chips' && screen === 'browse' && c && !c.action && chipIndex !== activeChip) { openChip(chipIndex); }
        }, 700);
    }

    function openSearch() {
        if (screen === 'player') { closePlayer(); }
        if (screen !== 'browse') { return; }
        zone = 'top'; topIndex = TOP.indexOf('search');
        render();
        $('search').focus();
    }

    function onTopEnter() {
        var id = TOP[topIndex];
        if (id.indexOf('site-') === 0) { switchSite(+id.slice(5)); zone = 'chips'; render(); }
        else if (id === 'search') { $('search').focus(); }
        else if (id === 'btn-live') { showLive(); }
        else if (id === 'btn-link') { openLinkDialog(); }
        else if (id === 'btn-phone') { openPhoneDialog(); }
        else if (id === 'btn-usb') { showUsb(); }
    }

    // OK plays (or opens) an item; holding OK opens its options (cast, sorting; delete for USB files).
    function onGridEnter(e) {
        var v = videos[gridIndex], idx = gridIndex;
        if (!v) { return; }
        if (v.live) { return playItem(idx); }
        if (v.partial) { return openItemMenu(idx); }
        if (e.fake) { return playItem(idx); }
        enterHold = setTimeout(function () { enterHold = null; openItemMenu(idx); }, 600);
    }

    function onBrowseKey(k, e) {
        // Number keys pick a category (1–9) or open search (0).
        if (k >= 48 && k <= 57) {
            if (k === 48) { return openSearch(); }
            var n = chips.filter(function (c) { return !c.action; }).length;
            if (n) { openChip(Math.min(k - 49, n - 1)); zone = 'chips'; }
            return render();
        }
        if (k === KEY.CH_UP || k === KEY.CH_DOWN) {
            if (zone === 'grid') { moveGrid(k === KEY.CH_UP ? -COLS * 2 : COLS * 2); }
            return;
        }
        if (k === KEY.TOOLS) { return zone === 'grid' && openItemMenu(gridIndex); }
        if (zone === 'top') {
            if (k === KEY.LEFT && topIndex > 0) { topIndex--; }
            else if (k === KEY.RIGHT && topIndex < TOP.length - 1) { topIndex++; }
            else if (k === KEY.DOWN) {
                zone = videos.length && (videos[0].local || videos[0].live) ? 'grid' : 'chips';
                if (zone === 'chips') { chipIndex = Math.max(0, activeChip); }
            }
            else if (k === KEY.ENTER) { return onTopEnter(); }
        } else if (zone === 'chips') {
            // Chips are laid out right-to-left.
            if (k === KEY.LEFT && chipIndex < chips.length - 1) { focusChip(chipIndex + 1); }
            else if (k === KEY.RIGHT && chipIndex > 0) { focusChip(chipIndex - 1); }
            else if (k === KEY.UP) { zone = 'top'; }
            else if (k === KEY.DOWN && videos.length) {
                if (chipIndex !== activeChip && chips[chipIndex] && !chips[chipIndex].action) { openChip(chipIndex); }
                zone = 'grid'; gridIndex = Math.min(gridIndex, Math.max(0, videos.length - 1));
            }
            else if (k === KEY.ENTER && chips[chipIndex]) {
                var act = chips[chipIndex].action;
                openChip(chipIndex);
                if (!act) { zone = 'grid'; gridIndex = 0; }
            }
        } else if (zone === 'grid') {
            if (k === KEY.LEFT) { if ((gridIndex % COLS) < COLS - 1 && gridIndex < videos.length - 1) { moveGrid(1); } return; }
            if (k === KEY.RIGHT) { if (gridIndex % COLS) { moveGrid(-1); } return; }
            if (k === KEY.UP) { return moveGrid(-COLS); }
            if (k === KEY.DOWN) { return moveGrid(COLS); }
            if (k === KEY.ENTER) { return onGridEnter(e); }
        }
        if (k === KEY.BACK) {
            if (zone === 'grid' && listParent) { return backToParent(); }   // from a series back to its list
            if (zone === 'grid') { zone = 'chips'; chipIndex = Math.max(0, activeChip); }
            else if (zone === 'chips') { zone = 'top'; }
            else if (Date.now() - backAt < 2000) {
                try { tizen.application.getCurrentApplication().exit(); } catch (err) { /* not on TV */ }
            } else { backAt = Date.now(); toast('برای خروج دوباره Back را بزنید'); }
        }
        render();
    }

    function onPlayerKey(k) {
        if (k >= 48 && k <= 57) { return seekToPercent(k - 48); }
        switch (k) {
            case KEY.ENTER: case KEY.PLAYPAUSE: togglePause(); break;
            case KEY.PLAY: if (player.paused) { togglePause(); } break;
            case KEY.PAUSE: if (!player.paused) { togglePause(); } break;
            case KEY.LEFT: seekBy(-1); break;
            case KEY.RIGHT: seekBy(1); break;
            case KEY.RW: seekBy(-1, true); break;
            case KEY.FF: seekBy(1, true); break;
            case KEY.CH_UP: case KEY.PREV: playNeighbor(-1); break;
            case KEY.CH_DOWN: case KEY.NEXT: playNeighbor(1); break;
            case KEY.UP: openQualityMenu(); break;
            case KEY.DOWN: case KEY.TOOLS: openActionsMenu(); break;
            case KEY.RECORD: toggleSave(); break;
            case KEY.STOP: if (job && job.kind === 'record') { stopJob(); } closePlayer(); break;
            case KEY.BACK: closePlayer(); break;
            default: showOsd();
        }
    }

    // ---------- link dialog ----------
    function openLinkDialog() {
        if (screen === 'player') { closePlayer(); }
        screen = 'link';
        show('link-dialog');
        $('link-input').value = '';
        $('link-input').focus();
    }

    function closeLinkDialog() {
        $('link-input').blur();
        hide('link-dialog');
        screen = 'browse';
        render();
    }

    // ---------- input ----------
    function onKey(e) {
        var k = e.keyCode, active = document.activeElement;

        // Held OK auto-repeats; only the first press counts (keyup or a pause ends the hold).
        if (k === KEY.ENTER && !e.fake) {
            var repeat = enterDown;
            enterDown = true;
            clearTimeout(enterDownTimer);
            enterDownTimer = setTimeout(function () { enterDown = false; }, 700);
            if (repeat) { return e.preventDefault(); }
        }

        // While a text field has focus, the on-screen keyboard owns the keys.
        if (active === $('search')) {
            if (k === KEY.ENTER || k === KEY.IME_DONE) {
                var q = $('search').value.trim();
                $('search').blur();
                if (q) { search(q); zone = 'grid'; gridIndex = 0; }
                render();
            } else if (k === KEY.IME_CANCEL || k === KEY.BACK) { $('search').blur(); render(); }
            return;
        }
        if (active === $('link-input')) {
            if (k === KEY.ENTER || k === KEY.IME_DONE) {
                var url = $('link-input').value;
                closeLinkDialog();
                if (url.trim()) { openLink(url); }
            } else if (k === KEY.IME_CANCEL || k === KEY.BACK) { closeLinkDialog(); }
            return;
        }
        if (active === $('login-input')) {
            if (k === KEY.ENTER || k === KEY.IME_DONE) { submitLogin(); }
            else if (k === KEY.IME_CANCEL || k === KEY.BACK) { closeLogin(); }
            return;
        }

        e.preventDefault();
        if (helpOpen) { return toggleHelp(); }   // any button closes the help
        if (k === KEY.INFO) { return toggleHelp(); }
        if (screen === 'link') { if (k === KEY.BACK) { closeLinkDialog(); } return; }
        if (screen === 'login') {
            if (k === KEY.BACK) { closeLogin(); } else if (k === KEY.ENTER && !login.busy) { $('login-input').focus(); }
            return;
        }
        if (screen === 'phone') { if (k === KEY.BACK || k === KEY.ENTER) { closePhoneDialog(); } return; }
        if (menu) { return onMenuKey(k); }

        // Buttons that work the same everywhere (a running download/recording continues).
        if (k === KEY.RED && has('live')) { if (screen === 'player') { closePlayer(); } topIndex = TOP.indexOf('btn-live'); showLive(); return render(); }
        if (k === KEY.GREEN || k === KEY.SEARCH) { return openSearch(); }
        if (k === KEY.YELLOW && has('usb')) { if (screen === 'player') { closePlayer(); } topIndex = TOP.indexOf('btn-usb'); showUsb(); return render(); }
        if (k === KEY.BLUE && has('link')) { return openLinkDialog(); }

        if (screen === 'player') { onPlayerKey(k); } else if (k === KEY.RECORD) { toggleSave(); } else { onBrowseKey(k, e); }
    }

    function onKeyUp(e) {
        if (e.keyCode !== KEY.ENTER) { return; }
        enterDown = false;
        clearTimeout(enterDownTimer);
        if (enterHold) {   // released before the hold time: a normal press
            clearTimeout(enterHold);
            enterHold = null;
            playItem(gridIndex);
        }
    }

    function registerKeys() {
        Object.keys(REMOTE_KEYS).forEach(function (id) {
            try {
                tizen.tvinputdevice.registerKey(REMOTE_KEYS[id]);
                KEY[id] = tizen.tvinputdevice.getKey(REMOTE_KEYS[id]).code;
            } catch (e) { /* this TV has no such key, or not on a TV */ }
        });
        for (var d = 0; d <= 9; d++) {
            try { tizen.tvinputdevice.registerKey(String(d)); } catch (e) { /* no number keys */ }
        }
    }

    function init() {
        registerKeys();
        Array.prototype.forEach.call(document.querySelectorAll('[data-module]'), function (el) {
            if (!has(el.getAttribute('data-module'))) { el.classList.add('hidden'); }
        });
        TOP = TOP.filter(function (id) { return !$(id).classList.contains('hidden'); });
        $('search').insertAdjacentHTML('beforebegin', SITES.map(function (s, i) {
            return '<div id="site-' + i + '" class="btn tab">' + s.name + '</div>';
        }).join(''));
        TOP = SITES.map(function (s, i) { return 'site-' + i; }).concat(TOP);
        document.addEventListener('keydown', onKey);
        document.addEventListener('keyup', onKeyUp);
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden || screen !== 'player') { return; }
            savePosition();
            if (!player.paused) { togglePause(); }
        });

        handleAppControl();
        window.addEventListener('appcontrol', handleAppControl);
        findUsb(function () {
            if (has('usb')) { testUsbWrite(); }
            findHub();
            if (has('usb')) { reattachDownloads(); }
        });

        switchSite(SITES.indexOf(siteById(store.get('site', 'aparat'))));
        zone = 'chips';
        render();
    }

    window.onload = init;
}());
