// Runs in the page's MAIN world so it can reach Netflix's internal player API.
// The content script cannot touch `window.netflix`, so all playback *control*
// is funnelled through here. Reading state is done from the content script
// directly off the <video> element, which is shared across worlds.
(() => {
  const REQ = "plixteam:player-request";
  const RES = "plixteam:player-response";

  function netflixPlayer() {
    try {
      const api = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = api.getAllPlayerSessionIds();
      // Netflix names the playback session "watch-<id>", but fall back to
      // whatever session exists rather than dropping to the raw element.
      const sessionId = ids.find((id) => id.startsWith("watch-")) || ids[0];
      if (!sessionId) return null;
      return api.getVideoPlayerBySessionId(sessionId);
    } catch {
      return null;
    }
  }

  function videoEl() {
    return document.querySelector("video");
  }

  function handle(action, value) {
    const player = netflixPlayer();
    const video = videoEl();

    switch (action) {
      case "play":
        if (player) player.play();
        else if (video) video.play();
        return true;
      case "pause":
        if (player) player.pause();
        else if (video) video.pause();
        return true;
      case "seek":
        // Netflix's API works in milliseconds, the media element in seconds.
        if (player) player.seek(Math.round(value * 1000));
        else if (video) video.currentTime = value;
        return true;
      case "getTime":
        if (player) return player.getCurrentTime() / 1000;
        return video ? video.currentTime : null;
      default:
        return null;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== REQ) return;
    let result = null;
    try {
      result = handle(msg.action, msg.value);
    } catch (err) {
      result = { error: String(err) };
    }
    window.postMessage({ channel: RES, id: msg.id, result }, "*");
  });
})();
