// Runs inside the injected extension iframe. Owns the websocket, the WebRTC
// mesh and the media UI. Living in a real document (not the service worker)
// means the connection survives for as long as the Netflix tab is open.

const params = new URLSearchParams(location.search);
const config = {
  server: params.get("server") || "ws://localhost:8080/ws",
  room: (params.get("room") || "").trim().toLowerCase(),
  name: params.get("name") || "Guest",
  turnUrl: params.get("turnUrl") || "",
  turnUser: params.get("turnUser") || "",
  turnPass: params.get("turnPass") || "",
};

const OVERLAY_CHANNEL = "plixteam:overlay";
const statusEl = document.getElementById("status");
const tilesEl = document.getElementById("tiles");
const localVideo = document.getElementById("local-video");

const iceServers = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
if (config.turnUrl) {
  iceServers.push({
    urls: config.turnUrl,
    username: config.turnUser,
    credential: config.turnPass,
  });
}

let ws = null;
let selfId = null;
let localStream = null;
let reconnectDelay = 1000;
const peers = new Map(); // peerId -> { pc, name, tile, video, pendingCandidates }

/* ------------------------------------------------------------------- utils */

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function toParent(payload) {
  parent.postMessage({ channel: OVERLAY_CHANNEL, ...payload }, "*");
}

function send(payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function refreshLayout() {
  tilesEl.classList.toggle("multi", peers.size >= 2);
}

/* ------------------------------------------------------------------- media */

async function startMedia() {
  const attempts = [
    {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } },
    },
    { audio: true, video: false },
  ];
  for (const constraints of attempts) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      // Tell the encoder to favour smooth motion over still sharpness, which
      // keeps latency down under CPU pressure.
      const vt = localStream.getVideoTracks()[0];
      if (vt) vt.contentHint = "motion";
      localVideo.srcObject = localStream;
      if (!constraints.video) {
        setStatus("Mic only — no camera available");
        document.getElementById("cam").classList.replace("on", "off");
      }
      return true;
    } catch (err) {
      if (err.name === "NotAllowedError") {
        setStatus("Camera/mic blocked. Grant access in the opened tab, then rejoin.", true);
        toParent({ kind: "needs-permission" });
        return false;
      }
    }
  }
  setStatus("No camera or microphone found", true);
  return false;
}

/* ------------------------------------------------------------------ webrtc */

function createPeer(peerId, peerName, polite) {
  if (peers.has(peerId)) return peers.get(peerId);

  const pc = new RTCPeerConnection({ iceServers });
  const tile = document.createElement("div");
  tile.className = "tile";
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = peerName || "Friend";
  tile.append(video, label);
  tilesEl.appendChild(tile);

  const entry = { pc, name: peerName, tile, video, pendingCandidates: [], polite };
  peers.set(peerId, entry);
  refreshLayout();

  if (localStream) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  }

  pc.ontrack = (event) => {
    video.srcObject = event.streams[0];
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({ type: "signal", to: peerId, data: { candidate: event.candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      setStatus(`Connected · ${peers.size + 1} in room`);
      tuneVideoSender(pc);
    }
    if (pc.connectionState === "failed") pc.restartIce();
  };

  return entry;
}

// Cap the outgoing video so it adapts instead of piling up latency. Without a
// ceiling, WebRTC keeps raising bitrate/resolution until the CPU or link can't
// keep up and frames queue, which is the "video lags" symptom. balanced +
// caps make it drop resolution/framerate gracefully and stay real-time.
async function tuneVideoSender(pc) {
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = 500_000; // ~500 kbps is plenty for a face
    params.encodings[0].maxFramerate = 24;
    params.degradationPreference = "balanced";
    await sender.setParameters(params);
  } catch {
    /* setParameters can race with renegotiation; ignore and let it retry next connect */
  }
}

async function offerTo(peerId) {
  const entry = peers.get(peerId);
  if (!entry) return;
  const offer = await entry.pc.createOffer();
  await entry.pc.setLocalDescription(offer);
  send({ type: "signal", to: peerId, data: { description: entry.pc.localDescription } });
}

async function handleSignal(from, data) {
  let entry = peers.get(from);
  if (!entry) entry = createPeer(from, "Friend", true);
  const { pc } = entry;

  if (data.description) {
    await pc.setRemoteDescription(data.description);
    for (const candidate of entry.pendingCandidates.splice(0)) {
      await pc.addIceCandidate(candidate).catch(() => {});
    }
    if (data.description.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "signal", to: from, data: { description: pc.localDescription } });
    }
  } else if (data.candidate) {
    if (pc.remoteDescription) {
      await pc.addIceCandidate(data.candidate).catch(() => {});
    } else {
      entry.pendingCandidates.push(data.candidate);
    }
  }
}

function dropPeer(peerId) {
  const entry = peers.get(peerId);
  if (!entry) return;
  entry.pc.close();
  entry.tile.remove();
  peers.delete(peerId);
  refreshLayout();
  setStatus(peers.size ? `Connected · ${peers.size + 1} in room` : "Waiting for your friend…");
}

/* --------------------------------------------------------------- signaling */

function connect() {
  setStatus("Connecting…");
  try {
    ws = new WebSocket(config.server);
  } catch {
    setStatus("Bad server URL", true);
    return;
  }

  ws.onopen = () => {
    reconnectDelay = 1000;
    send({ type: "join", room: config.room, name: config.name });
    setStatus("Waiting for your friend…");
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case "joined":
        selfId = msg.id;
        toParent({ kind: "self", id: selfId });
        // A reconnect gives us a fresh identity and everyone re-offers, so any
        // connection left over from the previous session is dead weight.
        for (const stale of [...peers.keys()]) dropPeer(stale);
        // Peers already in the room call us; we answer. Keeps offer glare away.
        for (const peer of msg.peers) createPeer(peer.id, peer.name, true);
        toParent({ kind: "peers", peers: [...peers.entries()].map(([id, p]) => ({ id, name: p.name })) });
        break;
      case "peer-join":
        createPeer(msg.id, msg.name, false);
        await offerTo(msg.id);
        toParent({ kind: "peers", peers: [...peers.entries()].map(([id, p]) => ({ id, name: p.name })) });
        break;
      case "signal":
        await handleSignal(msg.from, msg.data);
        break;
      case "sync":
        toParent({ kind: "sync-in", ...msg });
        break;
      case "peer-leave":
        dropPeer(msg.id);
        toParent({ kind: "peers", peers: [...peers.entries()].map(([id, p]) => ({ id, name: p.name })) });
        break;
      case "error":
        setStatus(msg.message, true);
        break;
      default:
        break;
    }
  };

  ws.onclose = () => {
    setStatus("Reconnecting…", true);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };

  ws.onerror = () => setStatus(`Cannot reach ${config.server}`, true);
}

/* -------------------------------------------------------------- parent bus */

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.channel !== OVERLAY_CHANNEL) return;
  if (msg.kind === "sync-out") {
    send({
      type: "sync",
      action: msg.action,
      time: msg.time,
      paused: msg.paused,
      videoId: msg.videoId,
      at: msg.at,
    });
  } else if (msg.kind === "notice") {
    setStatus(msg.text, true);
  }
});

/* ------------------------------------------------------------------ controls */

document.getElementById("mic").onclick = (event) => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  event.target.classList.toggle("on", track.enabled);
  event.target.classList.toggle("off", !track.enabled);
  event.target.textContent = track.enabled ? "Mic" : "Muted";
};

document.getElementById("cam").onclick = (event) => {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  event.target.classList.toggle("on", track.enabled);
  event.target.classList.toggle("off", !track.enabled);
  event.target.textContent = track.enabled ? "Cam" : "Cam off";
};

document.getElementById("leave").onclick = () => {
  for (const id of [...peers.keys()]) dropPeer(id);
  localStream?.getTracks().forEach((t) => t.stop());
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  toParent({ kind: "leave" });
};

/* ---------------------------------------------------------------- bootstrap */

(async () => {
  toParent({ kind: "ready" });
  if (!config.room) {
    setStatus("No room code set", true);
    return;
  }
  await startMedia();
  connect();
})();
