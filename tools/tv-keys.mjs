// Presses keys / types text on a Samsung TV over its remote API (WebSocket, port 8001) and prints
// everything the TV reports back (e.g. ms.remote.imeStart when its on-screen keyboard opens).
//   TV_IP=10.128.10.144 node tools/tv-keys.mjs KEY_HOME wait:2000 KEY_1 text:10.128.10.16 hold:KEY_POWER:5500 listen:5000
// Steps: KEY_* = click, wait:<ms>, text:<string> (types into the open keyboard, then ends input),
// hold:<KEY>:<ms> (press and hold), listen:<ms> (just wait and print events).
// The first connection shows an "Allow" prompt on the TV.
const TV = process.env.TV_IP || '10.128.10.144';
const GAP = Number(process.env.KEY_DELAY_MS || 600);
const name = Buffer.from(process.env.REMOTE_NAME || 'Mac Remote').toString('base64');
const steps = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const ws = new WebSocket(`ws://${TV}:8001/api/v2/channels/samsung.remote.control?name=${name}`);
const timer = setTimeout(() => { say('timeout: no answer (Allow prompt on the TV?)'); process.exit(1); }, 40000);
const remote = (params) => ws.send(JSON.stringify({ method: 'ms.remote.control', params }));

ws.onmessage = async (msg) => {
    const data = JSON.parse(msg.data);
    if (data.event !== 'ms.channel.connect') { say('TV:', JSON.stringify(data).slice(0, 300)); }
    if (data.event === 'ms.channel.unauthorized') { say('the TV refused this remote'); process.exit(1); }
    if (data.event !== 'ms.channel.connect') return;
    clearTimeout(timer);
    say('connected');
    for (const s of steps) {
        if (s.startsWith('wait:') || s.startsWith('listen:')) { await sleep(+s.split(':')[1]); continue; }
        if (s.startsWith('text:')) {
            const text = s.slice(5);
            remote({ Cmd: Buffer.from(text).toString('base64'), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' });
            say('typed', text);
            await sleep(700);
            remote({ TypeOfRemote: 'SendInputEnd' });
            await sleep(GAP);
            continue;
        }
        if (s.startsWith('launch:')) {   // launch:<appId>[:<link>] — the TV answers ed.apps.launch with 200 or 404
            const [, appId, ...rest] = s.split(':');
            const link = rest.join(':');
            ws.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host',
                data: { appId, action_type: link ? 'DEEP_LINK' : 'NATIVE_LAUNCH', ...(link ? { metaTag: link } : {}) } } }));
            say('launch', appId, link);
            await sleep(GAP * 3);
            continue;
        }
        if (s.startsWith('tap:')) {   // tap:<KEY> — a separate press and release, like a finger on the remote
            const key = s.slice(4);
            remote({ Cmd: 'Press', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' });
            await sleep(120);
            remote({ Cmd: 'Release', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' });
            say('tapped', key);
            await sleep(GAP);
            continue;
        }
        if (s.startsWith('hold:')) {
            const [, key, ms] = s.split(':');
            remote({ Cmd: 'Press', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' });
            say('holding', key);
            await sleep(+ms || 3000);
            remote({ Cmd: 'Release', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' });
            continue;
        }
        remote({ Cmd: 'Click', DataOfCmd: s, Option: 'false', TypeOfRemote: 'SendRemoteKey' });
        say('pressed', s);
        await sleep(GAP);
    }
    setTimeout(() => { ws.close(); process.exit(0); }, 800);
};
ws.onerror = (e) => { say('error:', e.message ?? e); process.exit(1); };
