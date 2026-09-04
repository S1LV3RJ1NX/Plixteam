const result = document.getElementById("result");
const preview = document.getElementById("preview");

document.getElementById("grant").onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    preview.srcObject = stream;
    await chrome.storage.local.set({ mediaGranted: true });
    result.className = "ok";
    result.textContent = "Granted. You can close this tab and start the party.";
    // Keep the preview alive briefly so the grant is obviously working.
    setTimeout(() => stream.getTracks().forEach((track) => track.stop()), 5000);
  } catch (err) {
    result.className = "bad";
    result.textContent = `Denied (${err.name}). Open the padlock in the address bar and allow camera and microphone.`;
  }
};
