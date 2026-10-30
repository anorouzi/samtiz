// Plays a link in Pardeh on the TV, the way the phone app does it (no hub needed):
//   TV_IP=10.128.10.144 node tools/tv-link.mjs https://www.aparat.com/v/xxxx
// Joins Pardeh's app channel on the TV (ir.pardeh.links, port 8001). If Pardeh is there, the link
// goes straight to it; if not, Pardeh is started through the remote API (which needs the TV's
// "Allow" for this remote once) and the link is sent as soon as Pardeh joins the channel.
const TV = process.env.TV_IP || '10.128.10.144';
const link = process.argv[2];
if (!link) { console.log('usage: node tools/tv-link.mjs <url>'); process.exit(1); }
const b64 = (s) => Buffer.from(s).toString('base64');
const PARDEH = b64('Pardeh TV');
const say = (...a) => console.log(...a);

const ch = new WebSocket(`ws://${TV}:8001/api/v2/channels/ir.pardeh.links?name=${b64('Pardeh Link Sender')}`);
const play = (to) => { ch.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'play', to, data: link } })); say('sent to Pardeh ✓'); setTimeout(() => process.exit(0), 500); };
setTimeout(() => { say('Pardeh did not join the channel in time'); process.exit(1); }, 30000);

ch.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.event === 'ms.channel.connect') {
        const tv = (d.data.clients || []).find((c) => c.attributes && c.attributes.name === PARDEH);
        if (tv) return play(tv.id);
        say('Pardeh is not open; starting it...');
        const rc = new WebSocket(`ws://${TV}:8001/api/v2/channels/samsung.remote.control?name=${b64('Mac Remote')}`);
        rc.onmessage = (r) => {
            if (JSON.parse(r.data).event === 'ms.channel.connect') {
                rc.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId: 'TvPlayr001.TVPlayer', action_type: 'NATIVE_LAUNCH' } } }));
            }
        };
    } else if (d.event === 'ms.channel.clientConnect' && d.data.attributes && d.data.attributes.name === PARDEH) {
        say('Pardeh joined');
        setTimeout(() => play(d.data.id), 300);
    }
};
ch.onerror = (e) => { say('error:', e.message ?? e); process.exit(1); };
