"""WebSocket signaling + playback-sync relay for the Plixteam Netflix extension.

The server is intentionally dumb: it keeps rooms in memory, forwards WebRTC
offers/answers/ICE candidates between peers, and broadcasts playback-sync
events. No media ever touches this server, so a tiny free-tier box is enough.

Run locally:
    uvicorn signaling:app --host 0.0.0.0 --port 8080
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("plixteam")

MAX_ROOM_SIZE = int(os.environ.get("MAX_ROOM_SIZE", "6"))
# Messages the server blindly forwards to everyone else in the room.
BROADCAST_TYPES = {"sync", "chat", "reaction", "state"}


@dataclass
class Peer:
    id: str
    name: str
    socket: WebSocket

    async def send(self, payload: dict) -> None:
        try:
            await self.socket.send_text(json.dumps(payload))
        except Exception:  # peer vanished mid-send; cleanup happens on disconnect
            log.debug("send failed for peer %s", self.id)


@dataclass
class Room:
    name: str
    peers: dict[str, Peer] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)


class Hub:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}
        self.lock = asyncio.Lock()

    async def join(self, room_name: str, peer: Peer) -> Room:
        async with self.lock:
            room = self.rooms.setdefault(room_name, Room(name=room_name))
            room.peers[peer.id] = peer
            return room

    async def leave(self, room_name: str, peer_id: str) -> Room | None:
        async with self.lock:
            room = self.rooms.get(room_name)
            if not room:
                return None
            room.peers.pop(peer_id, None)
            if not room.peers:
                del self.rooms[room_name]
                return None
            return room


hub = Hub()
app = FastAPI(title="Plixteam signaling")


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "rooms": len(hub.rooms),
            "peers": sum(len(r.peers) for r in hub.rooms.values()),
        }
    )


@app.websocket("/ws")
async def ws_endpoint(socket: WebSocket) -> None:
    await socket.accept()
    peer: Peer | None = None
    room_name: str | None = None

    try:
        while True:
            raw = await socket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = msg.get("type")

            if kind == "join":
                if peer is not None:
                    continue
                room_name = str(msg.get("room", "")).strip().lower()
                if not room_name:
                    await socket.send_text(
                        json.dumps({"type": "error", "message": "room code required"})
                    )
                    continue

                existing = hub.rooms.get(room_name)
                if existing and len(existing.peers) >= MAX_ROOM_SIZE:
                    await socket.send_text(
                        json.dumps({"type": "error", "message": "room is full"})
                    )
                    await socket.close()
                    return

                peer = Peer(
                    id=uuid.uuid4().hex[:12],
                    name=str(msg.get("name") or "Guest")[:32],
                    socket=socket,
                )
                room = await hub.join(room_name, peer)
                others = [
                    {"id": p.id, "name": p.name}
                    for p in room.peers.values()
                    if p.id != peer.id
                ]
                await peer.send({"type": "joined", "id": peer.id, "peers": others})
                for other in room.peers.values():
                    if other.id != peer.id:
                        await other.send(
                            {"type": "peer-join", "id": peer.id, "name": peer.name}
                        )
                log.info("%s joined room %s (%d peers)", peer.name, room_name, len(room.peers))
                continue

            if peer is None or room_name is None:
                continue
            room = hub.rooms.get(room_name)
            if room is None:
                continue

            if kind == "signal":
                target = room.peers.get(msg.get("to"))
                if target:
                    await target.send(
                        {"type": "signal", "from": peer.id, "data": msg.get("data")}
                    )
            elif kind in BROADCAST_TYPES:
                payload = dict(msg)
                payload["from"] = peer.id
                payload["name"] = peer.name
                for other in room.peers.values():
                    if other.id != peer.id:
                        await other.send(payload)
            elif kind == "ping":
                await peer.send({"type": "pong", "t": msg.get("t")})

    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001 - never kill the server on one bad socket
        log.warning("socket error: %s", exc)
    finally:
        if peer and room_name:
            room = await hub.leave(room_name, peer.id)
            if room:
                for other in room.peers.values():
                    await other.send({"type": "peer-leave", "id": peer.id})
            log.info("%s left room %s", peer.name, room_name)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "signaling:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8080")),
        log_level="info",
    )
