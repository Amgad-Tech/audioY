"""Finding this machine's LAN address, and turning it into a QR code."""

import io
import socket

import qrcode
from qrcode.constants import ERROR_CORRECT_M


def primary_ip():
    """The address other machines on the LAN would use to reach us.

    Opening a UDP socket to a routable address makes Windows pick the interface
    it would actually send from. Nothing is transmitted.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def all_ips():
    """Every IPv4 address on this machine, primary one first."""
    found = []
    first = primary_ip()
    if first != "127.0.0.1":
        found.append(first)
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in found and not ip.startswith("127."):
                found.append(ip)
    except OSError:
        pass
    return found or ["127.0.0.1"]


def url_for(ip, port):
    return "http://{}:{}/".format(ip, port)


def qr_png(text, box_size=8, border=2):
    """Return a QR code for `text` as PNG bytes."""
    qr = qrcode.QRCode(
        version=None,
        error_correction=ERROR_CORRECT_M,
        box_size=box_size,
        border=border,
    )
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
