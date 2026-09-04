# Plixteam

A free Teleparty replacement for Netflix: synced playback **plus** built-in voice and video
chat, so you can drop the WhatsApp call and the mute/unmute dance.

Two pieces:

- `extension/` — Chrome MV3 extension. Syncs play/pause/seek across everyone in a room and
  overlays a draggable video-call panel on the Netflix player.
- `server/` — a small Python (FastAPI) WebSocket server that relays signalling and sync
  messages. Audio and video go peer-to-peer over WebRTC and never touch the server, so a
  free-tier box is plenty.

## Run the server

```bash
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn signaling:app --host 0.0.0.0 --port 8080
```

Check it with `curl localhost:8080/health`, or run the protocol test:
`.venv/bin/python test_signaling.py`.

For someone else to reach it, the server needs to be on the public internet with TLS. A
browser on `https://netflix.com` will refuse a plain `ws://` URL to anything except
`localhost`, so you need `wss://`.

### Option A: Cloudflare quick tunnel (fastest, free, no account)

Keep the server running, then in a second terminal:

```bash
cloudflared tunnel --url http://localhost:8080
```

It prints a `https://<random>.trycloudflare.com` URL. Put `wss://<random>.trycloudflare.com/ws`
into the extension popup on both machines. Your Mac has to stay on with the server and the
tunnel running. The URL changes every time you restart the tunnel.

Install cloudflared if you don't have it: `brew install cloudflared`.

### Option B: Render (permanent URL, runs in the cloud, your Mac can be off)

1. Push this repo to GitHub.
2. render.com > New > Web Service > connect the repo. It reads `server/render.yaml` (Docker,
   free plan).
3. Use `wss://your-app.onrender.com/ws` in the popup.

Free-tier Render sleeps after ~15 min idle, so the first join takes ~30s to wake.

## Install the extension

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the
   `extension/` folder.
2. Click the Plixteam icon, hit **Grant camera & mic** once and allow. Chrome only lets the
   overlay use your camera after you approve it from an extension page, so this step is not
   optional.
3. Set your name, a shared room code, and the signalling server URL. Both of you must type the
   same room code.
4. Open a Netflix title, press **Start party**. The call panel appears bottom-right; drag it by
   its title bar, collapse it with `–`, leave with `×`.

Whoever is alphabetically first by connection id becomes the room "leader" and broadcasts a
position heartbeat every 4 seconds; everyone else quietly corrects drift over 2.5 seconds.
Anyone can still play, pause, or seek and it applies to the whole room.

## If the call doesn't connect

Direct peer-to-peer fails on some mobile and carrier-grade NAT networks. Run the included
coturn relay alongside the signalling server and put its address under **Advanced** in the
popup (`turn:your-host:3478` plus the username and password you chose):

```bash
cd server
EXTERNAL_IP=<server public IP> TURN_USER=plix TURN_PASS=<something> docker compose up -d
```

`EXTERNAL_IP` has to be the address the two of you can actually reach; Chrome throws away
relay candidates on loopback or on an address it can't route to.

## Tests

- `server/test_signaling.py` — joins, relays, broadcasts, disconnects.
- `tests/e2e.mjs` — launches three real Chrome profiles with the extension loaded and a
  stubbed Netflix watch page, then asserts every leg of the mesh carries real audio and video
  bytes, that play / seek / pause propagate from any viewer to all the others without a sync
  loop, that the overlay stays visible and connected in fullscreen, and that the party
  survives someone leaving and the signalling server restarting.
- `tests/turn.mjs` — starts a local coturn, feeds the popup's TURN fields into a relay-only
  connection and pushes data through it. Needs Docker.

```bash
cd tests && npm install
npm test           # 3 viewers; HEADFUL=1 to watch it, VIEWERS=2 for a pair
npm run test:turn
```

The stub is used because a real Netflix session needs a login and Widevine DRM, which a test
browser can't provide. Everything under test is the same code path: the same URL pattern, the
same content scripts, the same player bridge (which falls back to the media element when
Netflix's internal player API isn't there).

## Legal note

Everyone in the room needs their own Netflix account. This only synchronises playback of
content each person is already streaming; nothing is re-streamed or shared.
