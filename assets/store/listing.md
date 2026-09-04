# Chrome Web Store listing

## Name
Plixteam: Netflix watch party with free voice & video

## Summary (max 132 chars)
Watch Netflix in sync with friends and talk over built-in video and voice. Free, open source, no paywall.

## Category
Entertainment

## Description

Watch Netflix together, actually together.

Plixteam keeps everyone's playback in sync and adds a built-in video and voice call right on top of the Netflix player, so you can see and hear each other while you watch. No more juggling a separate call app and muting and unmuting every time something happens on screen.

WHAT YOU GET
• Synced playback — play, pause and seek apply to everyone in the room
• Built-in video AND voice call overlaid on the player
• A draggable call panel that stays put even in fullscreen
• Mute mic, turn camera off, or leave in one click
• Just share a room code, no accounts to create

FREE AND OPEN SOURCE
Plixteam is completely free with no subscription and no paywalled features. The whole thing is open source, so you can read exactly what it does:
https://github.com/S1LV3RJ1NX/Plixteam

BRING YOUR OWN SERVER (required)
Plixteam does not run on our servers — you host the tiny signaling server yourself, so your watch parties stay yours. It is one small Python service that ships with a Dockerfile and a one-command deploy. Full instructions, plus a Cloudflare Tunnel and a Render option, are in the GitHub repo above. Once it is running, paste your server address (wss://your-host/ws) into the extension's Advanced settings once, and share it with whoever you watch with.

PRIVACY
Your camera and microphone go peer-to-peer over WebRTC and never touch the signaling server — it only helps the browsers find each other and keeps playback in sync. Everyone needs their own Netflix account; Plixteam only synchronizes playback of content each person is already streaming.

Made for long-distance movie nights.

## Notes for reviewers
Requires a self-hosted signaling server (see the GitHub repo). Camera/mic are used only for the in-call video/voice between participants and are sent peer-to-peer via WebRTC.
