"""Connect to audioY the same way the phone does and report what is on the wire.

    python scripts/check_stream.py
    python scripts/check_stream.py http://192.168.1.78:8770 5

If this prints silence, the problem is on the computer: a muted output device,
the wrong capture device, or nothing playing. If it prints a real level, the
computer is fine and the problem is on the phone or the network.
"""

import asyncio
import json
import sys

import aiohttp
import numpy as np


async def run(url, seconds):
    ws_url = url.rstrip("/").replace("https://", "wss://").replace("http://", "ws://") + "/ws"

    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(ws_url) as ws:
            hello = json.loads((await ws.receive()).data)
            print("device : {}".format(hello.get("device")))
            print("format : {} Hz, {} channels".format(hello["rate"], hello["channels"]))

            peak = 0.0
            chunks = 0
            samples = 0
            loop = asyncio.get_running_loop()
            deadline = loop.time() + seconds

            while loop.time() < deadline:
                try:
                    message = await asyncio.wait_for(ws.receive(), timeout=2.0)
                except asyncio.TimeoutError:
                    print("no data for two seconds")
                    break
                if message.type is not aiohttp.WSMsgType.BINARY:
                    continue

                block = np.frombuffer(message.data, dtype="<i2").astype(np.float32) / 32768.0
                if block.size:
                    peak = max(peak, float(np.abs(block).max()))
                chunks += 1
                samples += block.size

            per_second = hello["rate"] * hello["channels"]
            print("chunks : {}".format(chunks))
            print("audio  : {:.2f} s received over {:.1f} s of clock".format(
                samples / per_second, seconds))
            if peak > 0:
                print("peak   : {:.4f} ({:.1f} dBFS)".format(peak, 20 * np.log10(peak)))
            else:
                print("peak   : silence")


if __name__ == "__main__":
    address = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8770"
    duration = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
    asyncio.run(run(address, duration))
