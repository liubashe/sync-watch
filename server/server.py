import asyncio
import json
import random
import string
import time
from websockets.asyncio.server import serve

rooms = {}  # roomId -> { "host": ws, "clients": set(ws) }

ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'


def generate_room_id():
    while True:
        rid = ''.join(random.choices(ROOM_CHARS, k=6))
        if rid not in rooms:
            return rid


def send_json(ws, obj):
    return ws.send(json.dumps(obj))


async def broadcast(room_id, message, exclude=None):
    room = rooms.get(room_id)
    if not room:
        return
    data = json.dumps(message) if isinstance(message, dict) else message
    tasks = []
    for client in list(room["clients"]):
        if client is not exclude:
            tasks.append(client.send(data))
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


def remove_from_room(ws):
    room_id = getattr(ws, '_room_id', None)
    if not room_id or room_id not in rooms:
        return None, None
    room = rooms[room_id]
    room["clients"].discard(ws)
    ws._room_id = None

    if room["host"] is ws:
        if room["clients"]:
            room["host"] = next(iter(room["clients"]))
            return room_id, "host_left_promoted"
        else:
            del rooms[room_id]
            return room_id, "room_destroyed"
    else:
        return room_id, "client_left"


async def handle_disconnect(ws):
    room_id, action = remove_from_room(ws)
    if not room_id or room_id not in rooms:
        return
    room = rooms[room_id]
    if action == "host_left_promoted":
        await send_json(room["host"], {"type": "promoted", "roomId": room_id})
        await broadcast(room_id, {"type": "room_update", "count": len(room["clients"]), "hostChanged": True})
    elif action == "client_left":
        await broadcast(room_id, {"type": "room_update", "count": len(room["clients"])})


async def handler(ws):
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type")

            if msg_type == "create_room":
                await handle_disconnect(ws)
                room_id = generate_room_id()
                rooms[room_id] = {"host": ws, "clients": {ws}}
                ws._room_id = room_id
                await send_json(ws, {"type": "room_created", "roomId": room_id, "count": 1})

            elif msg_type == "join_room":
                room_id = (msg.get("roomId") or "").upper()
                room = rooms.get(room_id)
                if not room:
                    await send_json(ws, {"type": "error", "message": "房间不存在"})
                    continue
                await handle_disconnect(ws)
                room["clients"].add(ws)
                ws._room_id = room_id
                await send_json(ws, {"type": "room_joined", "roomId": room_id, "count": len(room["clients"])})
                await broadcast(room_id, {"type": "room_update", "count": len(room["clients"])}, exclude=ws)
                await send_json(room["host"], {"type": "request_state"})

            elif msg_type == "sync_event":
                room_id = getattr(ws, '_room_id', None)
                if not room_id:
                    continue
                await broadcast(room_id, {
                    "type": "sync_event",
                    "action": msg.get("action"),
                    "time": msg.get("time"),
                    "paused": msg.get("paused"),
                    "timestamp": int(time.time() * 1000)
                }, exclude=ws)

            elif msg_type == "heartbeat":
                room_id = getattr(ws, '_room_id', None)
                if not room_id:
                    continue
                room = rooms.get(room_id)
                if room and room["host"] is ws:
                    await broadcast(room_id, {
                        "type": "heartbeat",
                        "time": msg.get("time"),
                        "paused": msg.get("paused"),
                        "timestamp": int(time.time() * 1000)
                    }, exclude=ws)

            elif msg_type == "state_response":
                room_id = getattr(ws, '_room_id', None)
                if not room_id:
                    continue
                await broadcast(room_id, {
                    "type": "sync_state",
                    "time": msg.get("time"),
                    "paused": msg.get("paused"),
                    "timestamp": int(time.time() * 1000)
                }, exclude=ws)

    except Exception:
        pass
    finally:
        await handle_disconnect(ws)


async def main():
    port = 8080
    async with serve(handler, "0.0.0.0", port):
        print(f"Sync-Watch server running on ws://localhost:{port}")
        await asyncio.get_running_loop().create_future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
