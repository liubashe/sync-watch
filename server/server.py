import asyncio
import json
import os
import random
import sys
import time

from aiohttp import web

rooms = {}  # roomId -> { "host": ws, "clients": set(ws) }
ws_counter = 0

ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'


def log(*args):
    print("[Server]", *args, flush=True)


def generate_room_id():
    while True:
        rid = ''.join(random.choices(ROOM_CHARS, k=6))
        if rid not in rooms:
            return rid


async def broadcast(room_id, message, exclude=None):
    room = rooms.get(room_id)
    if not room:
        return
    data = json.dumps(message) if isinstance(message, dict) else message
    count = 0
    for client in list(room["clients"]):
        if client is not exclude:
            try:
                await client.send_str(data)
                count += 1
            except Exception as e:
                log(f"  broadcast error to ws#{getattr(client, '_ws_id', '?')}: {e}")
    msg_type = message.get("type", "?") if isinstance(message, dict) else "?"
    log(f"  broadcast {msg_type} in room {room_id} to {count} client(s)")


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
    ws_id = getattr(ws, '_ws_id', '?')
    room_id, action = remove_from_room(ws)
    log(f"ws#{ws_id} disconnected, action={action}, room={room_id}")
    if not room_id or room_id not in rooms:
        return
    room = rooms[room_id]
    if action == "host_left_promoted":
        new_host_id = getattr(room["host"], '_ws_id', '?')
        log(f"  promoted ws#{new_host_id} to host in room {room_id}")
        await room["host"].send_str(json.dumps({"type": "promoted", "roomId": room_id}))
        await broadcast(room_id, {"type": "room_update", "count": len(room["clients"]), "hostChanged": True})
    elif action == "client_left":
        await broadcast(room_id, {"type": "room_update", "count": len(room["clients"])})


async def websocket_handler(request):
    global ws_counter
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    ws_counter += 1
    ws._ws_id = ws_counter
    log(f"ws#{ws._ws_id} connected from {request.remote}")

    try:
        async for raw_msg in ws:
            if raw_msg.type != web.WSMsgType.TEXT:
                continue
            try:
                msg = json.loads(raw_msg.data)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type")
            log(f"ws#{ws._ws_id} ← {msg_type} {msg.get('action', '')} room={getattr(ws, '_room_id', None)}")

            if msg_type == "create_room":
                await handle_disconnect(ws)
                room_id = generate_room_id()
                rooms[room_id] = {"host": ws, "clients": {ws}}
                ws._room_id = room_id
                log(f"  created room {room_id}, ws#{ws._ws_id} is host")
                await ws.send_str(json.dumps({"type": "room_created", "roomId": room_id, "count": 1}))

            elif msg_type == "join_room":
                room_id = (msg.get("roomId") or "").upper()
                room = rooms.get(room_id)
                if not room:
                    log(f"  room {room_id} not found")
                    await ws.send_str(json.dumps({"type": "error", "message": "房间不存在"}))
                    continue
                await handle_disconnect(ws)
                room["clients"].add(ws)
                ws._room_id = room_id
                log(f"  ws#{ws._ws_id} joined room {room_id}, {len(room['clients'])} client(s)")
                await ws.send_str(json.dumps({"type": "room_joined", "roomId": room_id, "count": len(room["clients"])}))
                await broadcast(room_id, {"type": "room_update", "count": len(room["clients"])}, exclude=ws)
                host_id = getattr(room["host"], '_ws_id', '?')
                log(f"  requesting state from host ws#{host_id}")
                await room["host"].send_str(json.dumps({"type": "request_state"}))

            elif msg_type == "sync_event":
                room_id = getattr(ws, '_room_id', None)
                if not room_id:
                    log(f"  ws#{ws._ws_id} not in any room, ignoring")
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

    except Exception as e:
        log(f"ws#{ws._ws_id} error: {e}")
    finally:
        await handle_disconnect(ws)

    return ws


async def health_handler(request):
    room_count = len(rooms)
    client_count = sum(len(r["clients"]) for r in rooms.values())
    return web.Response(text=f"OK | {room_count} rooms, {client_count} clients\n")


app = web.Application()
app.router.add_get("/", websocket_handler)
app.router.add_get("/health", health_handler)
app.router.add_route("HEAD", "/", health_handler)
app.router.add_route("HEAD", "/health", health_handler)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    log(f"Starting on port {port}")
    web.run_app(app, host="0.0.0.0", port=port)
