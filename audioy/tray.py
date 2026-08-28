"""System tray icon and its menu."""

import ctypes
import time
import webbrowser

from PIL import Image, ImageDraw
from pystray import Icon, Menu, MenuItem

from . import APP_NAME, VERSION, audio


def make_icon_image(size=64):
    """Three bars in a ring. Drawn light so it reads on a dark taskbar."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    ink = (245, 245, 245, 255)

    pad = size // 16
    d.ellipse([pad, pad, size - pad - 1, size - pad - 1], outline=ink,
              width=max(2, size // 16))

    bar_w = max(2, size // 12)
    gap = bar_w * 2
    heights = (size * 0.22, size * 0.40, size * 0.28)
    x = size / 2 - (bar_w * 3 + gap * 2) / 2
    for h in heights:
        d.rectangle([x, size / 2 - h / 2, x + bar_w, size / 2 + h / 2], fill=ink)
        x += bar_w + gap
    return img


def copy_to_clipboard(text):
    CF_UNICODETEXT = 13
    GMEM_MOVEABLE = 0x0002

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    kernel32.GlobalAlloc.restype = ctypes.c_void_p
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]

    buf = ctypes.create_unicode_buffer(text)
    size = ctypes.sizeof(buf)

    handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, size)
    if not handle:
        return False
    pointer = kernel32.GlobalLock(handle)
    ctypes.memmove(pointer, buf, size)
    kernel32.GlobalUnlock(handle)

    if not user32.OpenClipboard(None):
        return False
    try:
        user32.EmptyClipboard()
        user32.SetClipboardData(CF_UNICODETEXT, handle)
    finally:
        user32.CloseClipboard()
    return True


class Tray:
    def __init__(self, server, url):
        self.server = server
        self.url = url
        self._output = None
        self._output_read_at = 0.0
        self.icon = Icon(APP_NAME, make_icon_image(), self._title(), self._menu())

    def output_state(self):
        # Reading this talks to COM, and pystray asks for it once per menu item
        # every time the menu is drawn.
        now = time.monotonic()
        if self._output is None or now - self._output_read_at > 2.0:
            self._output = audio.get_output_volume()
            self._output_read_at = now
        return self._output

    # -- menu --------------------------------------------------------------

    def _title(self):
        return "{} {}".format(APP_NAME, VERSION)

    def _listeners_label(self, item=None):
        n = self.server.listener_count
        if n == 0:
            return "No phone connected"
        return "{} phone{} connected".format(n, "" if n == 1 else "s")

    def _output_label(self, item=None):
        state = self.output_state()
        if not state["available"]:
            return "Output: unknown"
        name = state["device"] or "unknown"
        if state["muted"]:
            return "Output: {} (MUTED)".format(name)
        return "Output: {} at {}%".format(name, round(state["volume"] * 100))

    def _output_needs_fix(self, item=None):
        state = self.output_state()
        return bool(state["available"] and (state["muted"] or state["volume"] < 0.2))

    def _menu(self):
        return Menu(
            MenuItem("Show connection code", self._show_code, default=True),
            MenuItem("Copy address", self._copy),
            Menu.SEPARATOR,
            MenuItem(self._listeners_label, None, enabled=False),
            MenuItem(self._output_label, None, enabled=False),
            MenuItem("Unmute and set output to 100%", self._fix_output,
                     visible=self._output_needs_fix),
            MenuItem("Restart capture", self._restart),
            Menu.SEPARATOR,
            MenuItem("Quit", self._quit),
        )

    # -- actions -----------------------------------------------------------

    def _show_code(self, icon=None, item=None):
        webbrowser.open("http://127.0.0.1:{}/connect".format(self.server.port))

    def _copy(self, icon=None, item=None):
        if copy_to_clipboard(self.url):
            self.notify("Address copied", self.url)

    def _fix_output(self, icon=None, item=None):
        state = audio.set_output_volume(volume=1.0, muted=False)
        self._output = state
        self._output_read_at = time.monotonic()
        self.notify("Output enabled", state["device"] or "")
        self.refresh()

    def _restart(self, icon=None, item=None):
        self.server.capture.restart()
        self.notify("Capture restarting", "")

    def _quit(self, icon=None, item=None):
        self.icon.visible = False
        self.icon.stop()

    # -- plumbing ----------------------------------------------------------

    def notify(self, title, message):
        try:
            self.icon.notify(message, title)
        except Exception:
            pass

    def refresh(self):
        try:
            self.icon.update_menu()
        except Exception:
            pass

    def run(self):
        """Blocks on the main thread until Quit."""
        self.icon.run(setup=lambda icon: setattr(icon, "visible", True))
