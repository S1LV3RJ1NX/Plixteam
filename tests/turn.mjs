// Proves the TURN settings from the extension popup actually produce a working
// relayed path: starts a local coturn, loads the extension with those
// credentials, then forces a relay-only connection using the exact iceServers
// array the call page built and pushes data through it.
//
//   node turn.mjs

import puppeteer from "puppeteer";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, "../extension");
const NAME = "plix-turn-test";
const USER = "plix";
const PASS = "test-secret";

// Chrome discards relay candidates on loopback, so the relay has to advertise
// a routable address. Any non-internal IPv4 on this machine will do.
const HOST_IP = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startCoturn() {
  spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
  execSync(
    [
      "docker run -d --name",
      NAME,
      "-p 3478:3478 -p 3478:3478/udp -p 50000-50010:50000-50010/udp",
      "coturn/coturn:latest -n --listening-port=3478",
      "--min-port=50000 --max-port=50010",
      "--realm=plixteam --lt-cred-mech",
      `--user=${USER}:${PASS}`,
      `--external-ip=${HOST_IP}`,
      "--no-tls --no-dtls --no-multicast-peers --log-file=stdout",
    ].join(" "),
    { stdio: "ignore" }
  );
}

let browser = null;
try {
  startCoturn();
  await sleep(3000);
  const running = execSync(`docker inspect -f '{{.State.Running}}' ${NAME}`).toString().trim();
  check("coturn is up", running.includes("true"), running);

  browser = await puppeteer.launch({
    headless: !process.env.HEADFUL,
    userDataDir: mkdtempSync(path.join(tmpdir(), "plix-turn-")),
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--no-sandbox",
    ],
  });

  let worker = browser.targets().find((t) => t.type() === "service_worker");
  for (let i = 0; i < 40 && !worker; i++) {
    await sleep(250);
    worker = browser.targets().find((t) => t.type() === "service_worker");
  }
  const extId = new URL(worker.url()).host;

  // Load the call page exactly as the content script would, with the TURN
  // fields a user would type into the popup.
  const page = await browser.newPage();
  const params = new URLSearchParams({
    server: "ws://127.0.0.1:9/ws", // unused here; the websocket is irrelevant to TURN
    room: "turn-check",
    name: "Tester",
    turnUrl: `turn:${HOST_IP}:3478`,
    turnUser: USER,
    turnPass: PASS,
  });
  await page.goto(`chrome-extension://${extId}/call.html?${params}`);
  await page.waitForSelector("#status");

  const built = await page.evaluate(() => JSON.parse(JSON.stringify(iceServers)));
  check(
    "popup TURN fields reach the peer connection config",
    built.some((s) => String(s.urls).startsWith("turn:") && s.username === "plix"),
    JSON.stringify(built)
  );

  const relay = await page.evaluate(async () => {
    // Relay-only on both ends: if TURN is broken, nothing connects.
    const a = new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay" });
    const b = new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay" });
    const candidates = [];
    const errors = [];
    for (const pc of [a, b]) {
      pc.onicecandidateerror = (e) =>
        errors.push({ code: e.errorCode, text: e.errorText, url: e.url });
    }
    a.onicecandidate = (e) => {
      if (!e.candidate) return;
      candidates.push(e.candidate.candidate);
      b.addIceCandidate(e.candidate);
    };
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);

    const channel = a.createDataChannel("probe");
    const got = new Promise((resolve) => {
      b.ondatachannel = (e) => (e.channel.onmessage = (m) => resolve(m.data));
    });

    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);

    const connected = await Promise.race([
      new Promise((resolve) => {
        a.onconnectionstatechange = () => {
          if (a.connectionState === "connected") resolve(true);
          if (a.connectionState === "failed") resolve(false);
        };
      }),
      new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
    ]);

    let types = [];
    (await a.getStats()).forEach((s) => {
      if (s.type === "local-candidate") types.push(s.candidateType);
    });

    let message = null;
    if (connected) {
      const send = () => channel.readyState === "open" && channel.send("hello over turn");
      if (channel.readyState === "open") send();
      else channel.onopen = send;
      message = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 5000))]);
    }

    a.close();
    b.close();
    return { connected, types: [...new Set(types)], message, candidates, errors };
  });

  if (!relay.connected) {
    console.log("   candidates:", JSON.stringify(relay.candidates));
    console.log("   ice errors:", JSON.stringify(relay.errors));
    console.log(execSync(`docker logs --tail 25 ${NAME} 2>&1`).toString());
  }
  check(
    "TURN allocation succeeds (relay candidate gathered)",
    relay.types.includes("relay") || relay.candidates.some((c) => c.includes(" typ relay")),
    JSON.stringify(relay.types)
  );
  check("relay-only connection establishes", relay.connected === true, JSON.stringify(relay));
  check("data flows through the relay", relay.message === "hello over turn", String(relay.message));
} catch (err) {
  check("turn harness ran", false, String(err));
} finally {
  if (browser) await browser.close().catch(() => {});
  spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
