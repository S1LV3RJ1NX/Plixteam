# Plixteam Privacy Policy

_Last updated: 2026-09-04_

Plixteam is a free, open-source browser extension that synchronizes Netflix playback between
people in a shared room and provides a built-in voice and video call. This policy explains
exactly what data the extension handles.

## What the developer collects

Nothing. Plixteam has no analytics, no tracking, and no servers operated by the developer.
The developer does not receive your name, your viewing activity, your messages, or your
audio or video.

## Data the extension handles

- **Settings (stored on your device):** your display name (a nickname you choose), the room
  code, and the address of the signalling server you configure. These are saved with
  `chrome.storage.local` on your own computer and are not sent to the developer.
- **Voice and video call:** your camera and microphone streams are sent **peer-to-peer**
  directly to the other participants in your room using WebRTC. They are not routed to or
  stored by the developer.
- **Playback sync and call-setup messages:** small messages (play/pause/seek events and the
  technical handshake needed to start a call) pass through the **signalling server that you or
  the person running your party chooses**. The developer does not operate this server; you
  host it yourself. See https://github.com/S1LV3RJ1NX/Plixteam for how to run it.

## Third parties

Plixteam does not sell or transfer your data to third parties. To establish a direct call
connection, WebRTC may contact public STUN servers (for example Google's public STUN service)
to discover your network address. STUN is used only for connectivity; no audio, video, or
personal content passes through it.

## Permissions

- **netflix.com host access:** to place the watch-party overlay on the Netflix player and to
  read and control playback (play, pause, current time) so viewers stay in sync.
- **storage:** to remember your settings on your device.
- **tabs:** to find your open Netflix tab so a party can start there.

## Your control

All data lives on your device or on a server you control. Removing the extension deletes its
stored settings. Ending a call stops all camera and microphone access.

## Contact

Questions: pratamesh1867@gmail.com
