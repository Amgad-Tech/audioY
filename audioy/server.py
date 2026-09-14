"""HTTP + WebSocket server. Runs on its own thread so the tray icon owns the
main thread."""

import asyncio
import os
import sys
import threading

from aiohttp import WSMsgType, web

from . import APP_NAME, VERSION, audio, net

# How much audio a slow client may fall behind before we start dropping.
QUEUE_CHUNKS = 40


def web_dir():
    """PyInstaller unpacks bundled data to a temp dir; use it when frozen."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "web")


class Listener:
    def __init__(self):
        self.queue = asyncio.Queue(maxsize=QUEUE_CHUNKS)
        self.dropped = 0

    def push(self, data):
        if self.queue.full():
            try:
                self.queue.get_nowait()
                self.dropped += 1
            except asyncio.QueueEmpty:
                pass
        self.queue.put_nowait(data)


class Server:
    def __init__(self, capture, port, on_change=None):
        self.capture = capture
        self.port = port
        self.on_change = on_change or (lambda: None)

        self.listeners = set()

        self._loop = None
        self._thread = threading.Thread(target=self._run, name="server", daemon=True)
        self._ready = threading.Event()

    # -- lifecycle ---------------------------------------------------------

    def start(self):
        self._thread.start()
        self._ready.wait(timeout=10)

    def stop(self):
        if self._loop:
            self._loop.call_soon_threadsafe(self._loop.stop)

    @property
    def listener_count(self):
        return len(self.listeners)

    def feed(self, pcm):
        """Called from the capture thread."""
        if self._loop:
            self._loop.call_soon_threadsafe(self._publish, pcm)

    # -- internals ---------------------------------------------------------

    def _publish(self, pcm):
        # No silence is sent when the computer goes quiet. The phone's buffer
        # handles gaps, and padding here raced real audio when the computer
        # was busy, putting silence in the middle of songs.
        for listener in self.listeners:
            listener.push(pcm)

    def _run(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop

        app = web.Application()
        app.router.add_get("/", self._page("index.html"))
        app.router.add_get("/connect", self._page("connect.html"))
        app.router.add_get("/qr.png", self._qr)
        app.router.add_get("/ws", self._websocket)
        app.router.add_get("/api/status", self._status)
        app.router.add_get("/api/network", self._network)
        app.router.add_get("/api/devices", self._devices)
        app.router.add_post("/api/restart", self._restart)
        app.router.add_route("*", "/api/volume", self._volume)
        app.router.add_static("/", web_dir(), show_index=False)

        runner = web.AppRunner(app, access_log=None)
        loop.run_until_complete(runner.setup())
        site = web.TCPSite(runner, "0.0.0.0", self.port, reuse_address=True)
        loop.run_until_complete(site.start())

        self._ready.set()
        try:
            loop.run_forever()
        finally:
            loop.run_until_complete(runner.cleanup())
            loop.close()

    # -- handlers ----------------------------------------------------------

    def _page(self, filename):
        path = os.path.join(web_dir(), filename)

        async def handler(request):
            return web.FileResponse(path, headers={"Cache-Control": "no-cache"})

        return handler

    async def _qr(self, request):
        url = request.query.get("url") or net.url_for(net.primary_ip(), self.port)
        png = await asyncio.to_thread(net.qr_png, url)
        return web.Response(body=png, content_type="image/png",
                            headers={"Cache-Control": "no-cache"})

    async def _websocket(self, request):
        ws = web.WebSocketResponse(heartbeat=20, compress=False, max_msg_size=0)
        await ws.prepare(request)

        listener = Listener()
        self.listeners.add(listener)
        self.on_change()
        print("connected: {} ({} listening)".format(request.remote, len(self.listeners)))

        await ws.send_json(dict({"type": "hello", "format": "s16le",
                                 "app": APP_NAME, "version": VERSION},
                                **self.capture.status()))

        async def send_loop():
            while True:
                await ws.send_bytes(await listener.queue.get())

        task = asyncio.create_task(send_loop())
        try:
            async for msg in ws:
                if msg.type == WSMsgType.ERROR:
                    break
        finally:
            task.cancel()
            self.listeners.discard(listener)
            self.on_change()
            print("disconnected: {} ({} listening, {} chunks dropped)".format(
                request.remote, len(self.listeners), listener.dropped))
        return ws

    async def _status(self, request):
        output = await asyncio.to_thread(audio.get_output_volume)
        return web.json_response(dict({
            "app": APP_NAME,
            "version": VERSION,
            "listeners": len(self.listeners),
            "output": output,
        }, **self.capture.status()))

    async def _network(self, request):
        ips = await asyncio.to_thread(net.all_ips)
        return web.json_response({
            "port": self.port,
            "addresses": [net.url_for(ip, self.port) for ip in ips],
        })

    async def _devices(self, request):
        devices = await asyncio.to_thread(audio.list_loopback_devices)
        return web.json_response({"devices": devices})

    async def _restart(self, request):
        self.capture.restart()
        return web.json_response({"ok": True})

    async def _volume(self, request):
        if request.method == "POST":
            body = await request.json() if request.can_read_body else {}
            state = await asyncio.to_thread(audio.set_output_volume,
                                            body.get("volume"), body.get("muted"))
        else:
            state = await asyncio.to_thread(audio.get_output_volume)
        return web.json_response(state)
