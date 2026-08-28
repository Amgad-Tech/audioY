"""Play a 440 Hz tone on the default output device, so there is something for
audioY to capture while testing.

    python scripts/tone.py 10
"""

import sys

import numpy as np
import pyaudiowpatch as pyaudio

seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 10.0

p = pyaudio.PyAudio()
try:
    info = p.get_device_info_by_index(
        p.get_host_api_info_by_type(pyaudio.paWASAPI)["defaultOutputDevice"])
    rate = int(info["defaultSampleRate"])
    print("playing {:.0f} s on {}".format(seconds, info["name"]))

    t = np.arange(int(rate * seconds)) / rate
    mono = (0.25 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    stereo = np.repeat(mono[:, None], 2, axis=1).tobytes()

    stream = p.open(format=pyaudio.paFloat32, channels=2, rate=rate,
                    output=True, output_device_index=info["index"])
    stream.write(stereo)
    stream.stop_stream()
    stream.close()
finally:
    p.terminate()
