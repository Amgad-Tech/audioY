"""Entry point.  python -m audioy  (or run audioY.exe)"""

import argparse
import ctypes
import socket
import sys
import time
import webbrowser

from . import APP_NAME, DEFAULT_PORT, VERSION, audio, net
from .server import Server


def timer_resolution(milliseconds):
    """Windows timers tick every 15.6 ms unless something asks for better,
    which is too coarse for pacing audio. Returns a function to undo it."""
    try:
        winmm = ctypes.windll.winmm
        winmm.timeBeginPeriod(milliseconds)
        return lambda: winmm.timeEndPeriod(milliseconds)
    except Exception:
        return lambda: None


def free_port(preferred, tries=20):
    """Use the preferred port if we can bind it, otherwise the next one free."""
    for port in range(preferred, preferred + tries):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("0.0.0.0", port))
            return port
        except OSError:
            continue
        finally:
            s.close()
    raise SystemExit("no free port in range {}-{}".format(preferred, preferred + tries))


def parse_args(argv):
    p = argparse.ArgumentParser(
        prog="audioy",
        description="{} {} - send this PC's sound to a phone over Wi-Fi".format(
            APP_NAME, VERSION))
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--device", type=int, default=None,
                   help="loopback device index (see --list)")
    p.add_argument("--gain", type=float, default=1.0,
                   help="multiply the signal before sending; 1.0 is unchanged")
    p.add_argument("--mono", action="store_true",
                   help="send one channel instead of two, halving the bandwidth")
    p.add_argument("--list", action="store_true",
                   help="print the loopback devices and exit")
    p.add_argument("--console", action="store_true",
                   help="run without the tray icon")
    p.add_argument("--no-browser", action="store_true",
                   help="do not open the connection page at startup")
    p.add_argument("--version", action="version",
                   version="{} {}".format(APP_NAME, VERSION))
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])

    if args.list:
        for d in audio.list_loopback_devices():
            print("{:>3}  {}  ({} Hz, {} ch)".format(
                d["index"], d["name"], d["rate"], d["channels"]))
        return 0

    restore_timers = timer_resolution(1)
    port = free_port(args.port)
    url = net.url_for(net.primary_ip(), port)

    capture = audio.Capture(on_chunk=lambda pcm: server.feed(pcm),
                            gain=args.gain, mono=args.mono, device=args.device)
    server = Server(capture, port)
    server.start()
    capture.start()

    print("{} {}".format(APP_NAME, VERSION))
    print("phone:   {}".format(url))
    print("console: http://127.0.0.1:{}/connect".format(port))

    state = audio.get_output_volume()
    if state["available"] and (state["muted"] or state["volume"] < 0.2):
        print("warning: output device '{}' is muted or near zero, so the phone "
              "will get silence".format(state["device"]))

    if args.console:
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        capture.stop()
        server.stop()
        restore_timers()
        return 0

    from .tray import Tray

    tray = Tray(server, url)
    server.on_change = tray.refresh

    if not args.no_browser:
        webbrowser.open("http://127.0.0.1:{}/connect".format(port))

    tray.run()

    capture.stop()
    server.stop()
    restore_timers()
    return 0


if __name__ == "__main__":
    sys.exit(main())
