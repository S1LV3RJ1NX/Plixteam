// Mounts the call overlay on Netflix and keeps playback in sync with the room.
(() => {
  if (window.__plixteamLoaded) return;
  window.__plixteamLoaded = true;

  const EXT_ORIGIN = new URL(chrome.runtime.getURL("/")).origin;
  const OVERLAY_CHANNEL = "plixteam:overlay";
  const PLAYER_REQ = "plixteam:player-request";
  const PLAYER_RES = "plixteam:player-response";

  const state = {
    root: null,
    iframe: null,
    video: null,
    selfId: null,
    peers: new Map(), // id -> name
    // Very short blanket guard for the burst of events a single remote
    // command produces.
    muteEventsUntil: 0,
    lastSent: 0,
    collapsed: false,
  };

  // Applying a remote command makes our own player fire play/pause/seeked
  // events. Rather than gagging the player for a fixed window (which also
  // swallows what the user does next), we remember the exact echo we expect
  // and let anything else through.
  // Each pending echo carries its own expiry. A shared deadline would let an
  // echo that never arrived (the player sometimes swallows an event) be kept
  // alive by later activity, and it would then eat a real click from the user.
  const echoes = [];

  function expectEcho(action, value) {
    echoes.push({ action, value, until: Date.now() + 3000 });
  }

  function consumeEcho(action, value) {
    const now = Date.now();
    for (let i = echoes.length - 1; i >= 0; i--) {
      if (echoes[i].until < now) echoes.splice(i, 1);
    }
    const index = echoes.findIndex(
      (e) => e.action === action && (action !== "seek" || Math.abs(value - e.value) <= 0.6)
    );
    if (index === -1) return false;
    echoes.splice(index, 1);
    return true;
  }

  /* ---------------------------------------------------------------- player */

  const pending = new Map();
  let reqId = 0;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== PLAYER_RES) return;
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg.result);
    }
  });

  function callPlayer(action, value) {
    return new Promise((resolve) => {
      const id = ++reqId;
      pending.set(id, resolve);
      window.postMessage({ channel: PLAYER_REQ, id, action, value }, "*");
      setTimeout(() => {
        if (pending.delete(id)) resolve(null);
      }, 1000);
    });
  }

  function currentTime() {
    return state.video ? state.video.currentTime : 0;
  }

  function isPaused() {
    return state.video ? state.video.paused : true;
  }

  function videoId() {
    const match = location.pathname.match(/\/watch\/(\d+)/);
    return match ? match[1] : null;
  }

  function suppress(ms = 1200) {
    state.muteEventsUntil = Date.now() + ms;
  }

  function suppressed() {
    return Date.now() < state.muteEventsUntil;
  }

  /* ------------------------------------------------------------------ sync */

  function send(payload) {
    if (!state.iframe?.contentWindow) return;
    state.iframe.contentWindow.postMessage(
      { channel: OVERLAY_CHANNEL, ...payload },
      EXT_ORIGIN
    );
  }

  // A local event during the guard window is deferred, never dropped: the user
  // clicking play must always reach the room, even if it lands a few
  // milliseconds after a remote command we were still applying.
  let flushTimer = null;

  function localEvent(action) {
    if (consumeEcho(action, action === "seek" ? currentTime() : undefined)) return;
    if (!suppressed()) {
      broadcast(action);
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      broadcast(isPaused() ? "pause" : "play");
    }, Math.max(50, state.muteEventsUntil - Date.now() + 100));
  }

  function broadcast(action, extra = {}) {
    if (suppressed()) return;
    send({
      kind: "sync-out",
      action,
      time: currentTime(),
      videoId: videoId(),
      at: Date.now(),
      ...extra,
    });
  }

  async function applyRemote(msg) {
    if (!state.video) return;
    if (msg.videoId && videoId() && msg.videoId !== videoId()) {
      send({ kind: "notice", text: `${msg.name || "A friend"} is on a different title` });
      return;
    }
    const drift = Math.abs(currentTime() - msg.time);
    const todo = [];

    switch (msg.action) {
      case "play":
        if (drift > 0.7) todo.push(["seek", msg.time]);
        if (isPaused()) todo.push(["play"]);
        break;
      case "pause":
        if (!isPaused()) todo.push(["pause"]);
        if (drift > 0.7) todo.push(["seek", msg.time]);
        break;
      case "seek":
        if (drift > 0.5) todo.push(["seek", msg.time]);
        break;
      case "heartbeat":
        // Only correct against the room leader, otherwise peers fight over
        // whose clock is right and seek at each other forever.
        if (msg.from !== leaderId()) return;
        if (msg.paused !== isPaused()) todo.push([msg.paused ? "pause" : "play"]);
        if (drift > 2.5) todo.push(["seek", msg.time]);
        break;
      default:
        return;
    }

    // A heartbeat that changes nothing must not gag us: if we suppressed on
    // every incoming message, the local user's own clicks would be swallowed.
    if (!todo.length) return;

    for (const [action, value] of todo) {
      expectEcho(action, value);
      suppress(250);
      await callPlayer(action, value);
    }
    suppress(250);
  }

  function leaderId() {
    const ids = [state.selfId, ...state.peers.keys()].filter(Boolean).sort();
    return ids[0] || null;
  }

  function attachVideo(video) {
    if (!video || video === state.video) return;
    state.video = video;
    video.addEventListener("play", () => localEvent("play"));
    video.addEventListener("pause", () => localEvent("pause"));
    video.addEventListener("seeked", () => {
      const now = Date.now();
      if (now - state.lastSent < 300 && !suppressed()) return;
      state.lastSent = now;
      localEvent("seek");
    });
  }

  function watchForVideo() {
    const tick = () => {
      const video = document.querySelector("video");
      if (video) attachVideo(video);
    };
    tick();
    setInterval(tick, 1500);
  }

  setInterval(() => {
    if (!state.video || !state.selfId) return;
    if (leaderId() !== state.selfId) return;
    if (suppressed()) return;
    send({
      kind: "sync-out",
      action: "heartbeat",
      time: currentTime(),
      paused: isPaused(),
      videoId: videoId(),
      at: Date.now(),
    });
  }, 4000);

  /* --------------------------------------------------------------- overlay */

  function mount(config) {
    if (state.root) return;

    const root = document.createElement("div");
    root.id = "plixteam-root";
    root.innerHTML = `
      <div id="plixteam-bar">
        <span id="plixteam-title">Plixteam · ${escapeHtml(config.room)}</span>
        <span class="plixteam-spacer"></span>
        <button id="plixteam-collapse" title="Collapse">–</button>
        <button id="plixteam-close" title="Leave party">×</button>
      </div>
    `;

    const iframe = document.createElement("iframe");
    iframe.id = "plixteam-frame";
    iframe.allow = "camera; microphone; autoplay";
    iframe.src =
      chrome.runtime.getURL("call.html") +
      "?" +
      new URLSearchParams({
        server: config.server,
        room: config.room,
        name: config.name,
        turnUrl: config.turnUrl || "",
        turnUser: config.turnUser || "",
        turnPass: config.turnPass || "",
      }).toString();
    root.appendChild(iframe);
    playerHost().appendChild(root);

    state.root = root;
    state.iframe = iframe;

    root.querySelector("#plixteam-collapse").onclick = () => {
      state.collapsed = !state.collapsed;
      root.classList.toggle("plixteam-collapsed", state.collapsed);
    };
    root.querySelector("#plixteam-close").onclick = () => {
      chrome.storage.local.set({ active: false });
      unmount();
    };

    makeDraggable(root, root.querySelector("#plixteam-bar"));
  }

  // Only the fullscreen element's subtree is painted, so an overlay parked on
  // <html> vanishes the moment Netflix goes fullscreen. Living inside the
  // player container keeps it visible in both modes without re-parenting,
  // which would reload the iframe and drop the call.
  function playerHost() {
    const video = document.querySelector("video");
    return (
      video?.closest(".watch-video") ||
      document.querySelector(".watch-video") ||
      document.documentElement
    );
  }

  document.addEventListener("fullscreenchange", () => {
    if (!state.root) return;
    const host = document.fullscreenElement;
    // Last resort if Netflix fullscreens something we're not inside: move, and
    // accept the brief reconnect, rather than leaving the user with no call.
    if (host && !host.contains(state.root)) host.appendChild(state.root);
  });

  function unmount() {
    state.root?.remove();
    state.root = null;
    state.iframe = null;
    state.selfId = null;
    state.peers.clear();
  }

  function makeDraggable(root, handle) {
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;

    handle.addEventListener("pointerdown", (event) => {
      if (event.target.tagName === "BUTTON") return;
      const rect = root.getBoundingClientRect();
      originX = rect.left;
      originY = rect.top;
      startX = event.clientX;
      startY = event.clientY;
      handle.setPointerCapture(event.pointerId);

      const move = (moveEvent) => {
        const x = Math.max(0, Math.min(window.innerWidth - 80, originX + moveEvent.clientX - startX));
        const y = Math.max(0, Math.min(window.innerHeight - 40, originY + moveEvent.clientY - startY));
        root.style.left = `${x}px`;
        root.style.top = `${y}px`;
        root.style.right = "auto";
        root.style.bottom = "auto";
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  /* -------------------------------------------------------------- messages */

  window.addEventListener("message", (event) => {
    if (event.origin !== EXT_ORIGIN) return;
    const msg = event.data;
    if (!msg || msg.channel !== OVERLAY_CHANNEL) return;

    switch (msg.kind) {
      case "ready":
        send({ kind: "hello" });
        break;
      case "self":
        state.selfId = msg.id;
        break;
      case "peers":
        state.peers = new Map(msg.peers.map((p) => [p.id, p.name]));
        break;
      case "sync-in":
        applyRemote(msg);
        break;
      case "needs-permission":
        chrome.runtime.sendMessage({ type: "open-permissions" });
        break;
      case "leave":
        chrome.storage.local.set({ active: false });
        unmount();
        break;
      default:
        break;
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "plixteam-join") {
      mount(msg.config);
    } else if (msg?.type === "plixteam-leave") {
      unmount();
    }
  });

  /* ----------------------------------------------------------------- start */

  watchForVideo();

  chrome.storage.local.get(
    ["active", "server", "room", "name", "turnUrl", "turnUser", "turnPass"],
    (config) => {
      if (config.active && config.room) mount(config);
    }
  );
})();
