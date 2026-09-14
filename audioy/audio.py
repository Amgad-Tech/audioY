"""Windows audio: WASAPI loopback capture, and the output device's volume.

Loopback capture taps whatever Windows is already playing, so it needs no
virtual cable and no extra drivers. Two things about it are worth knowing:

  * the tap happens after Windows applies the output device's volume and mute,
    so a muted device captures pure silence
  * it delivers nothing at all while no application is playing, so the
    stream simply pauses and the phone plays silence until it resumes
"""

import sys
import threading
import time

import numpy as np

try:
    import pyaudiowpatch as pyaudio
except ImportError:
    sys.exit("PyAudioWPatch is missing. Run: pip install -r requirements.txt")

try:
    if getattr(sys, "frozen", False):
        # A bundled executable has nowhere to write comtypes' generated
        # modules, so keep them in memory.
        import comtypes.client
        comtypes.client.gen_dir = None
    from pycaw.utils import AudioUtilities
    HAVE_PYCAW = True
except Exception:
    AudioUtilities = None
    HAVE_PYCAW = False


CHUNK_MS = 40


# --------------------------------------------------------------------------
# output device volume
# --------------------------------------------------------------------------

def _with_com(fn):
    import comtypes
    comtypes.CoInitialize()
    try:
        return fn()
    finally:
        comtypes.CoUninitialize()


def get_output_volume():
    """-> {'available', 'device', 'volume' (0..1), 'muted'}"""
    if not HAVE_PYCAW:
        return {"available": False, "device": None, "volume": None, "muted": None}

    def read():
        dev = AudioUtilities.GetSpeakers()
        ev = dev.EndpointVolume
        return {
            "available": True,
            "device": dev.FriendlyName,
            "volume": round(ev.GetMasterVolumeLevelScalar(), 4),
            "muted": bool(ev.GetMute()),
        }

    try:
        return _with_com(read)
    except Exception as exc:
        return {"available": False, "device": None, "volume": None,
                "muted": None, "error": str(exc)}


def set_output_volume(volume=None, muted=None):
    """volume is 0..1. Returns the state afterwards."""
    if not HAVE_PYCAW:
        return get_output_volume()

    def write():
        ev = AudioUtilities.GetSpeakers().EndpointVolume
        if volume is not None:
            ev.SetMasterVolumeLevelScalar(max(0.0, min(1.0, float(volume))), None)
        if muted is not None:
            ev.SetMute(bool(muted), None)

    try:
        _with_com(write)
    except Exception:
        pass
    return get_output_volume()


def default_output_name():
    """Name of the current default playback device, or None."""
    if not HAVE_PYCAW:
        return None
    try:
        return _with_com(lambda: AudioUtilities.GetSpeakers().FriendlyName)
    except Exception:
        return None


def list_loopback_devices():
    p = pyaudio.PyAudio()
    try:
        return [{"index": d["index"], "name": d["name"],
                 "rate": int(d["defaultSampleRate"]),
                 "channels": int(d["maxInputChannels"])}
                for d in p.get_loopback_device_info_generator()]
    finally:
        p.terminate()


# --------------------------------------------------------------------------
# capture
# --------------------------------------------------------------------------

class Capture:
    """Reads the loopback device on a PortAudio thread and hands 16-bit PCM to
    `on_chunk`. Reopens the stream if it dies or if the device is switched."""

    def __init__(self, on_chunk, gain=1.0, mono=False, device=None):
        self.on_chunk = on_chunk
        self.gain = gain
        self.mono = mono
        self.device = device

        self.rate = 48000
        self.channels = 1 if mono else 2
        self.chunk_frames = int(self.rate * CHUNK_MS / 1000)
        self.device_name = "starting"
        self.error = None
        self.peak = 0.0
        self.frames = 0

        self._src_channels = 2
        self._stop = threading.Event()
        self._restart = threading.Event()
        self._thread = threading.Thread(target=self._run, name="capture", daemon=True)

    def start(self):
        self._thread.start()

    def restart(self):
        self._restart.set()

    def stop(self):
        self._stop.set()
        self._restart.set()

    def status(self):
        return {
            "device": self.device_name,
            "rate": self.rate,
            "channels": self.channels,
            "chunkFrames": self.chunk_frames,
            "error": self.error,
            "peak": round(self.peak, 4),
            "frames": self.frames,
        }

    def _pick_device(self, p):
        if self.device is not None:
            return p.get_device_info_by_index(self.device)
        try:
            return p.get_default_wasapi_loopback()
        except (OSError, LookupError):
            pass
        for info in p.get_loopback_device_info_generator():
            return info
        raise RuntimeError("no WASAPI loopback device found")

    def _callback(self, in_data, frame_count, time_info, status):
        try:
            a = np.frombuffer(in_data, dtype=np.float32).reshape(-1, self._src_channels)
            if self.mono:
                a = a.mean(axis=1, keepdims=True)
            elif self._src_channels > 2:
                a = a[:, :2]
            if self.gain != 1.0:
                a = a * self.gain

            self.peak = float(np.abs(a).max()) if a.size else 0.0
            self.frames += frame_count
            self.on_chunk(np.clip(a * 32767.0, -32768, 32767).astype("<i2").tobytes())
        except Exception as exc:
            # A raised exception here would tear down the PortAudio stream.
            self.error = "convert: {}".format(exc)
        return (None, pyaudio.paContinue)

    def _run(self):
        while not self._stop.is_set():
            p = stream = None
            try:
                p = pyaudio.PyAudio()
                info = self._pick_device(p)

                self.device_name = info["name"]
                self.rate = int(info["defaultSampleRate"])
                self._src_channels = max(1, int(info["maxInputChannels"]))
                self.channels = 1 if self.mono else min(2, self._src_channels)
                self.chunk_frames = int(self.rate * CHUNK_MS / 1000)
                self.error = None

                print("capture: {} at {} Hz, {} channels".format(
                    self.device_name, self.rate, self.channels))

                stream = p.open(
                    format=pyaudio.paFloat32,
                    channels=self._src_channels,
                    rate=self.rate,
                    input=True,
                    input_device_index=info["index"],
                    frames_per_buffer=self.chunk_frames,
                    stream_callback=self._callback,
                )
                stream.start_stream()
                self._restart.clear()

                # Watch for the stream dying or the user switching output device.
                expected = default_output_name()
                while not self._stop.is_set() and not self._restart.is_set():
                    if not stream.is_active():
                        self.error = "stream stopped"
                        break
                    if expected and default_output_name() != expected:
                        print("capture: default output changed, reopening")
                        break
                    time.sleep(1.0)

            except Exception as exc:
                self.error = str(exc)
                print("capture error: {}".format(exc), file=sys.stderr)
                time.sleep(2.0)

            finally:
                try:
                    if stream is not None:
                        stream.stop_stream()
                        stream.close()
                finally:
                    if p is not None:
                        p.terminate()
