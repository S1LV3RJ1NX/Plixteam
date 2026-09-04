const FIELDS = ["name", "room", "server", "turnUrl", "turnUser", "turnPass"];
const msg = document.getElementById("msg");

function show(text) {
  msg.textContent = text;
}

chrome.storage.local.get([...FIELDS, "mediaGranted"], (stored) => {
  for (const field of FIELDS) {
    if (stored[field]) document.getElementById(field).value = stored[field];
  }
  if (!document.getElementById("server").value) {
    document.getElementById("server").value = "ws://localhost:8080/ws";
  }
  if (!stored.mediaGranted) show("Tip: grant camera & mic once before joining.");
});

async function netflixTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /https:\/\/[^/]*netflix\.com\//.test(tab.url || "")) return tab;
  const [any] = await chrome.tabs.query({ url: "https://*.netflix.com/*" });
  return any || null;
}

document.getElementById("join").onclick = async () => {
  const config = {};
  for (const field of FIELDS) config[field] = document.getElementById(field).value.trim();
  if (!config.room) return show("Pick a room code first.");
  if (!config.name) config.name = "Me";
  config.active = true;
  await chrome.storage.local.set(config);

  const tab = await netflixTab();
  if (!tab) {
    await chrome.tabs.create({ url: "https://www.netflix.com/" });
    return show("Opened Netflix. Start playing, then hit Start party again.");
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "plixteam-join", config });
    show("Party started.");
  } catch {
    await chrome.tabs.reload(tab.id);
    show("Reloaded the tab; the overlay will appear.");
  }
};

document.getElementById("leave").onclick = async () => {
  await chrome.storage.local.set({ active: false });
  const tab = await netflixTab();
  if (tab) chrome.tabs.sendMessage(tab.id, { type: "plixteam-leave" }).catch(() => {});
  show("Left the party.");
};

document.getElementById("perms").onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("permissions.html") });
};
