// Sends remote-control keys to a Samsung Smart TV over its local WebSocket API (port 8001).
// Usage: TV_IP=172.19.85.144 node tools/tv-remote.mjs KEY_HOME KEY_DOWN KEY_ENTER
// The first connection shows an "Allow" prompt on the TV. If it's denied later, re-allow the
// device under Settings → General → External Device Manager → Device Connection Manager.
const TV = process.env.TV_IP || "172.19.85.144";
const DELAY = Number(process.env.KEY_DELAY_MS || 700);
const name = Buffer.from("Mac Remote").toString("base64");
const keys = process.argv.slice(2);

const ws = new WebSocket(`ws://${TV}:8001/api/v2/channels/samsung.remote.control?name=${name}`);
const timer = setTimeout(() => { console.log("timeout: no response (check the TV screen for an Allow prompt)"); process.exit(1); }, 30000);

ws.onmessage = async (msg) => {
  const data = JSON.parse(msg.data);
  console.log("TV says:", data.event);
  if (data.event === "ms.channel.connect") {
    for (const key of keys) {
      ws.send(JSON.stringify({ method: "ms.remote.control", params: { Cmd: "Click", DataOfCmd: key, Option: "false", TypeOfRemote: "SendRemoteKey" } }));
      console.log("sent", key);
      await new Promise((r) => setTimeout(r, DELAY));
    }
    clearTimeout(timer);
    setTimeout(() => { ws.close(); process.exit(0); }, 500);
  } else if (data.event === "ms.channel.unauthorized") {
    console.log("TV denied the connection");
    process.exit(1);
  }
};
ws.onerror = (e) => { console.log("error:", e.message ?? e); process.exit(1); };
