// End-to-end check with real Chrome profiles, the unpacked extension, and a
// stubbed Netflix watch page. Verifies the WebRTC mesh carries media between
// every pair of viewers and that play / pause / seek propagate to everyone.
//
//   node e2e.mjs             (3 viewers, headless)
//   VIEWERS=2 node e2e.mjs   (fewer viewers)
//   HEADFUL=1 node e2e.mjs   (watch it happen)

import puppeteer from "puppeteer";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, "../extension");
const SERVER_DIR = path.resolve(here, "../server");
const WATCH_URL = "https://www.netflix.com/watch/12345";
const ROOM = "e2e-" + Math.random().toString(36).slice(2, 7);
const NAMES = ["Alice", "Bob", "Carol", "Dan", "Erin"];
const COUNT = Math.min(Number(process.env.VIEWERS || 3), NAMES.length);
const fixture = readFileSync(path.join(here, "fixture.mp4"));

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirrors the bit of Netflix's structure the extension relies on: the player
// lives inside a .watch-video container, and that container is what goes
// fullscreen.
const PAGE_HTML = `<!doctype html><html><head><title>Fake Netflix</title></head>
<body style="margin:0;background:#000">
<div class="watch-video" style="position:relative;width:640px">
  <video id="v" src="/fixture.mp4" width="640" preload="auto"></video>
</div>
<button id="fs" style="position:fixed;top:0;right:0">fullscreen</button>
<script>
  document.getElementById("fs").onclick = () =>
    document.querySelector(".watch-video").requestFullscreen();
</script>
</body></html>`;

async function startServer() {
  // Own the server outright so the reconnect phase can restart it.
  spawnSync("bash", ["-c", "lsof -ti tcp:8080 | xargs kill -9 2>/dev/null"], { stdio: "ignore" });
  await sleep(500);
  const proc = spawn(
    path.join(SERVER_DIR, ".venv/bin/uvicorn"),
    ["signaling:app", "--host", "127.0.0.1", "--port", "8080"],
    { cwd: SERVER_DIR, stdio: "ignore" }
  );
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      if ((await fetch("http://127.0.0.1:8080/health")).ok) return proc;
    } catch {}
  }
  throw new Error("signaling server did not start");
}

function serveNetflix(page) {
  page.on("request", (req) => {
    const url = req.url();
    if (url === WATCH_URL) {
      req.respond({ status: 200, contentType: "text/html", body: PAGE_HTML });
    } else if (url.endsWith("/fixture.mp4")) {
      // The media element seeks with Range requests; answering every one with
      // a full 200 makes Chrome give up and reset playback to zero.
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers().range || "");
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : fixture.length - 1;
        req.respond({
          status: 206,
          contentType: "video/mp4",
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${start}-${end}/${fixture.length}`,
          },
          body: fixture.subarray(start, end + 1),
        });
      } else {
        req.respond({
          status: 200,
          contentType: "video/mp4",
          headers: { "Accept-Ranges": "bytes" },
          body: fixture,
        });
      }
    } else if (url.startsWith("https://www.netflix.com/")) {
      req.respond({ status: 200, contentType: "text/html", body: "<html></html>" });
    } else {
      req.continue();
    }
  });
}

async function launchViewer(name) {
  const browser = await puppeteer.launch({
    headless: !process.env.HEADFUL,
    userDataDir: mkdtempSync(path.join(tmpdir(), "plix-")),
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
    ],
  });

  let worker = browser.targets().find((t) => t.type() === "service_worker");
  for (let i = 0; i < 40 && !worker; i++) {
    await sleep(250);
    worker = browser.targets().find((t) => t.type() === "service_worker");
  }
  if (!worker) throw new Error(`${name}: extension service worker never appeared`);

  const sw = await worker.worker();
  await sw.evaluate(
    (cfg) => new Promise((res) => chrome.storage.local.set(cfg, res)),
    { active: true, room: ROOM, name, server: "ws://127.0.0.1:8080/ws", mediaGranted: true }
  );

  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`   [${name} console] ${m.text()}`);
  });
  await page.evaluateOnNewDocument(() => {
    window.__vlog = [];
    const start = Date.now();
    const attach = () => {
      const v = document.querySelector("video");
      if (!v || v.__tapped) return;
      v.__tapped = true;
      for (const type of ["play", "pause", "seeked", "stalled", "waiting", "ended", "error"]) {
        v.addEventListener(type, () =>
          window.__vlog.push(`+${((Date.now() - start) / 1000).toFixed(1)}s ${type}@${v.currentTime.toFixed(1)}`)
        );
      }
    };
    setInterval(attach, 300);
  });
  await page.setRequestInterception(true);
  serveNetflix(page);
  await page.goto(WATCH_URL, { waitUntil: "domcontentloaded" });

  const viewer = { browser, page, name };
  viewer.frame = await waitForFrame(page, name);
  return viewer;
}

async function waitForFrame(page, label) {
  for (let i = 0; i < 60; i++) {
    const frame = page.frames().find((f) => f.url().includes("call.html"));
    if (frame) {
      try {
        await frame.waitForSelector("#status", { timeout: 500 });
        return frame;
      } catch {}
    }
    await sleep(300);
  }
  throw new Error(`${label}: call iframe never loaded`);
}

const videoState = (viewer) =>
  viewer.page.evaluate(() => {
    const v = document.querySelector("video");
    return { time: v.currentTime, paused: v.paused };
  });

const peerStates = (viewer) =>
  viewer.frame.evaluate(() => [...peers.values()].map((p) => p.pc.connectionState));

async function waitFor(fn, timeout = 20000) {
  const started = Date.now();
  let last = { ok: false, detail: "never ran" };
  while (Date.now() - started < timeout) {
    last = await fn();
    if (last.ok) return last;
    await sleep(400);
  }
  return { ...last, ok: false };
}

const viewers = [];
let serverProc = null;

try {
  serverProc = await startServer();
  for (let i = 0; i < COUNT; i++) viewers.push(await launchViewer(NAMES[i]));
  check(`overlay mounts for all ${COUNT} viewers`, true);

  // --- WebRTC mesh -------------------------------------------------------
  const mesh = await waitFor(async () => {
    const states = await Promise.all(viewers.map(peerStates));
    const ok = states.every(
      (s) => s.length === COUNT - 1 && s.every((c) => c === "connected")
    );
    return { ok, detail: states.map((s, i) => `${viewers[i].name}=${JSON.stringify(s)}`).join(" ") };
  }, 40000);
  check(`full mesh connected (${COUNT - 1} peers each)`, mesh.ok, mesh.detail);

  const media = await waitFor(async () => {
    const all = await Promise.all(
      viewers.map((v) =>
        v.frame.evaluate(() =>
          [...peers.values()].map((p) => ({
            kinds: (p.video.srcObject?.getTracks() || []).map((t) => t.kind).sort().join(","),
            playing: p.video.readyState >= 2,
          }))
        )
      )
    );
    const ok = all.every(
      (list) =>
        list.length === COUNT - 1 && list.every((t) => t.kinds === "audio,video" && t.playing)
    );
    return { ok, detail: all.map((l, i) => `${viewers[i].name}=${JSON.stringify(l)}`).join(" ") };
  });
  check("every viewer receives audio + video from every peer", media.ok, media.detail);

  const bytes = await waitFor(async () => {
    const all = await Promise.all(
      viewers.map((v) =>
        v.frame.evaluate(async () => {
          const out = [];
          for (const entry of peers.values()) {
            let audio = 0;
            let video = 0;
            (await entry.pc.getStats()).forEach((s) => {
              if (s.type === "inbound-rtp" && s.kind === "audio") audio = s.bytesReceived || 0;
              if (s.type === "inbound-rtp" && s.kind === "video") video = s.bytesReceived || 0;
            });
            out.push({ audio, video });
          }
          return out;
        })
      )
    );
    const ok = all.every((list) => list.every((s) => s.audio > 0 && s.video > 0));
    return { ok, detail: all.map((l, i) => `${viewers[i].name}=${JSON.stringify(l)}`).join(" ") };
  });
  check("real media bytes flowing on every leg", bytes.ok, bytes.detail);

  // --- Fullscreen, which is how anyone actually watches ------------------
  await viewers[0].page.click("#fs");
  await sleep(1500);
  const fs = await viewers[0].page.evaluate(() => {
    const root = document.getElementById("plixteam-root");
    const rect = root?.getBoundingClientRect();
    return {
      fullscreen: !!document.fullscreenElement,
      insideFullscreen: !!(root && document.fullscreenElement?.contains(root)),
      visible: !!rect && rect.width > 0 && rect.height > 0,
    };
  });
  check(
    "overlay survives fullscreen",
    fs.fullscreen && fs.insideFullscreen && fs.visible,
    JSON.stringify(fs)
  );

  const stillUp = await waitFor(async () => {
    const s = await peerStates(viewers[0]);
    return { ok: s.every((c) => c === "connected"), detail: JSON.stringify(s) };
  }, 10000);
  check("call keeps running through fullscreen", stillUp.ok, stillUp.detail);
  await viewers[0].page.evaluate(() => document.exitFullscreen());
  await sleep(800);

  // --- Playback sync, driven by each viewer in turn ----------------------
  const others = (driver) => viewers.filter((v) => v !== driver);

  const play = async (v) =>
    v.page.evaluate(async () => {
      const video = document.querySelector("video");
      try {
        await video.play();
        return "ok";
      } catch (err) {
        return `${err.name}: ${err.message} (readyState=${video.readyState} networkState=${video.networkState} error=${video.error?.code})`;
      }
    });
  const pause = async (v) => v.page.evaluate(() => document.querySelector("video").pause());
  const seek = async (v, t) =>
    v.page.evaluate((time) => {
      document.querySelector("video").currentTime = time;
    }, t);

  const expectAll = async (list, predicate, label) => {
    const res = await waitFor(async () => {
      const states = await Promise.all(list.map(videoState));
      return {
        ok: states.every(predicate),
        detail: states.map((s, i) => `${list[i].name}=${JSON.stringify(s)}`).join(" "),
      };
    });
    check(label, res.ok, res.detail);
  };

  await play(viewers[0]);
  await expectAll(others(viewers[0]), (s) => !s.paused, "play by viewer 1 reaches everyone");

  const driver = viewers[COUNT - 1];
  await seek(driver, 42);
  await expectAll(
    others(driver),
    (s) => Math.abs(s.time - 42) < 4,
    "seek by the last viewer reaches everyone"
  );

  const middle = viewers[Math.floor(COUNT / 2)];
  await pause(middle);
  await expectAll(others(middle), (s) => s.paused, "pause by a middle viewer reaches everyone");

  await play(middle);
  await expectAll(others(middle), (s) => !s.paused, "resume right after a pause is not swallowed");

  await sleep(6000);
  const settled = await Promise.all(viewers.map(videoState));
  const spread = Math.max(...settled.map((s) => s.time)) - Math.min(...settled.map((s) => s.time));
  check(
    "room stays in sync with no seek war",
    spread < 3 && new Set(settled.map((s) => s.paused)).size === 1,
    settled.map((s, i) => `${viewers[i].name}=${JSON.stringify(s)}`).join(" ")
  );

  // --- Someone leaves ----------------------------------------------------
  if (COUNT > 2) {
    const leaving = viewers.pop();
    const leavingName = leaving.name;
    await leaving.browser.close();
    const dropped = await waitFor(async () => {
      const states = await Promise.all(viewers.map(peerStates));
      const ok = states.every((s) => s.length === viewers.length - 1);
      return { ok, detail: states.map((s, i) => `${viewers[i].name}=${s.length}`).join(" ") };
    });
    check(`tiles clean up when ${leavingName} leaves`, dropped.ok, dropped.detail);

    await pause(viewers[0]);
    await expectAll(others(viewers[0]), (s) => s.paused, "sync survives a viewer leaving");
  }

  // --- The signalling server restarts under them --------------------------
  // WebRTC survives the signalling server dying, so "still connected" proves
  // nothing here: the rebuild is only real once every peer id is new.
  const peerIds = (v) => v.frame.evaluate(() => [...peers.keys()]);
  const before = await Promise.all(viewers.map(peerIds));

  serverProc.kill("SIGKILL");
  await sleep(2500);
  serverProc = await startServer();

  const rejoined = await waitFor(async () => {
    const ids = await Promise.all(viewers.map(peerIds));
    const states = await Promise.all(viewers.map(peerStates));
    const ok = ids.every(
      (list, i) =>
        list.length === viewers.length - 1 &&
        list.every((id) => !before[i].includes(id)) &&
        states[i].every((c) => c === "connected")
    );
    return {
      ok,
      detail: viewers.map((v, i) => `${v.name}=${JSON.stringify(states[i])}`).join(" "),
    };
  }, 60000);
  check("call rebuilds itself after the server restarts", rejoined.ok, rejoined.detail);
  await sleep(1000);

  // Diagnostics for the phase below: shows whether a lost sync stopped at the
  // content script, at the call frame, or at the websocket.
  for (const v of viewers) {
    await v.frame.evaluate(() => {
      window.__log = [];
      const tap = (socket) => {
        socket.addEventListener("message", (e) => window.__log.push("in " + e.data));
        const origSend = socket.send.bind(socket);
        socket.send = (d) => {
          window.__log.push("out " + d);
          origSend(d);
        };
        return socket;
      };
      window.addEventListener("message", (e) => {
        if (e.data && e.data.channel === "plixteam:overlay") {
          window.__log.push(`from-content-script ${e.data.kind} ${e.data.action || ""}`);
        }
      });
      tap(ws);
    });
  }

  const playResult = await play(viewers[0]);
  await expectAll(others(viewers[0]), (s) => !s.paused, "sync works again after reconnect");
  if (results.at(-1).ok === false) console.log(`   play() returned: ${playResult}`);

  if (results.at(-1).ok === false) {
    for (const v of viewers) {
      const frame = await v.frame.evaluate(() => ({
        status: document.getElementById("status").textContent,
        ws: ws ? ws.readyState : "none",
        selfId,
        peers: [...peers.keys()],
        log: window.__log.slice(0, 10),
      }));
      console.log(`   ${v.name}: ${JSON.stringify(await videoState(v))}`);
      const frameCount = v.page.frames().filter((f) => f.url().includes("call.html")).length;
      console.log(`   ${v.name} frame (${frameCount} call frames): ${JSON.stringify(frame)}`);
      console.log(`   ${v.name} video events: ${(await v.page.evaluate(() => window.__vlog)).join(" | ")}`);
    }
  }
} catch (err) {
  check("test harness ran", false, String(err));
} finally {
  for (const v of viewers) await v.browser.close().catch(() => {});
  if (serverProc) serverProc.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
