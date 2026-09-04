// Thin service worker. The websocket and WebRTC live in the injected call
// iframe (a real document, so it is never suspended while the tab is open);
// this worker only handles storage defaults and cross-tab commands.

const DEFAULTS = {
  server: "",
  room: "",
  name: "Me",
  turnUrl: "",
  turnUser: "",
  turnPass: "",
  mediaGranted: false,
  active: false,
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (current[key] === undefined) patch[key] = value;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "open-permissions") {
    chrome.tabs.create({ url: chrome.runtime.getURL("permissions.html") });
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "broadcast-to-netflix") {
    chrome.tabs.query({ url: "https://*.netflix.com/*" }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, msg.payload).catch(() => {});
      }
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});
