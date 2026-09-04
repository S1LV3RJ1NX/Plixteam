"""End-to-end check of the signaling server: join, relay, broadcast, leave.

Usage: python test_signaling.py [ws://localhost:8080/ws]
"""

import asyncio
import json
import sys

import websockets

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8080/ws"
ROOM = "test-room"


async def recv(ws, timeout=3.0):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def main() -> int:
    failures = []

    def check(label, condition, detail=""):
        print(("PASS " if condition else "FAIL ") + label + (f"  {detail}" if detail else ""))
        if not condition:
            failures.append(label)

    async with websockets.connect(URL) as alice:
        await alice.send(json.dumps({"type": "join", "room": ROOM, "name": "Alice"}))
        joined_a = await recv(alice)
        check("alice joins empty room", joined_a["type"] == "joined" and joined_a["peers"] == [], str(joined_a))

        async with websockets.connect(URL) as bob:
            await bob.send(json.dumps({"type": "join", "room": ROOM, "name": "Bob"}))
            joined_b = await recv(bob)
            check(
                "bob sees alice on join",
                [p["name"] for p in joined_b["peers"]] == ["Alice"],
                str(joined_b),
            )

            notify = await recv(alice)
            check("alice notified of bob", notify["type"] == "peer-join" and notify["name"] == "Bob", str(notify))

            await alice.send(
                json.dumps({"type": "signal", "to": joined_b["id"], "data": {"description": "offer"}})
            )
            sig = await recv(bob)
            check(
                "offer relayed to bob",
                sig["type"] == "signal" and sig["from"] == joined_a["id"] and sig["data"]["description"] == "offer",
                str(sig),
            )

            await bob.send(json.dumps({"type": "sync", "action": "pause", "time": 42.5}))
            sync = await recv(alice)
            check(
                "sync broadcast reaches alice",
                sync["type"] == "sync" and sync["action"] == "pause" and sync["time"] == 42.5 and sync["name"] == "Bob",
                str(sync),
            )

            await bob.send(json.dumps({"type": "signal", "to": "does-not-exist", "data": {}}))
            await bob.send(json.dumps({"type": "ping", "t": 7}))
            pong = await recv(bob)
            check("unknown target ignored, socket alive", pong["type"] == "pong" and pong["t"] == 7, str(pong))

        left = await recv(alice)
        check("alice told bob left", left["type"] == "peer-leave" and left["id"] == joined_b["id"], str(left))

    print("\n" + ("ALL CHECKS PASSED" if not failures else f"FAILURES: {failures}"))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
