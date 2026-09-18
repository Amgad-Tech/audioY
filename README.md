# audioY 3.0

Sends a Windows PC's sound to a phone over the local network. The phone plays
it, and the phone's Bluetooth carries it on to whatever earphones are paired
with it. The PC does not need Bluetooth at all.

```
Windows -> WASAPI loopback -> WebSocket over Wi-Fi -> phone browser -> earphones
```

It runs in the notification area. On start it opens a page with a QR code, you
scan the code with the phone's camera, tap once, and the sound follows you.

## Install

Download `audioY.exe` from the releases page and run it. Nothing to install and
no Python needed.

Windows Firewall will ask for permission the first time. Allow it on private
networks, otherwise the phone will not be able to reach the PC.

To run from source instead:

```bash
git clone https://github.com/Amgad-Tech/audioY.git
cd audioY
pip install -r requirements.txt
python -m audioy
```

`run.bat` does the same thing and installs the dependencies on first use.

## Using it

1. Start audioY. The connection page opens by itself.
2. Scan the QR code with the phone's camera and open the link.
3. Tap once on the phone. Safari and Chrome both refuse to play sound until the
   page has been touched.
4. Connect the earphones to the phone as usual.

The tray icon menu has the same page under "Show connection code", along with
the address on the clipboard, how many phones are connected, and what the
output device is doing.

Once the page is open on the phone, use Share then Add to Home Screen. It then
opens full screen with its own icon and remembers the volume and delay
settings.

## If the phone plays nothing

The most common cause is not audioY at all. Windows applies the output device's
volume and mute **before** the point where audioY taps the audio, so a muted
output device sends perfect silence: the meters move, the data rate is correct,
and there is nothing to hear.

Both pages detect this and offer a Correct button that unmutes the device and
sets it to 100%. The tray menu has the same command. After that, leave Windows
at 100% and use the volume control on the phone, because anything Windows takes
away is gone before audioY sees it.

If that is not it, run the wire check:

```bash
python scripts/check_stream.py
```

It connects the same way the phone does and prints the level it receives. If it
says `silence`, the problem is on the PC: muted output, the wrong capture
device, or nothing actually playing. If it prints a real level, the PC is fine
and the problem is the phone or the network.

## If the phone cannot open the page at all

The phone has to be on the same network as the PC. Check the address shown on
the connection page and make sure the phone has an address in the same range.

- A guest Wi-Fi network will not work. Guest networks isolate clients on
  purpose.
- Some routers have AP isolation or client isolation switched on, which does
  the same thing.
- If Windows Firewall blocked the first connection instead of asking, allow
  audioY through it for private networks.

Loading `http://<pc-address>:8770/api/status` in the phone's browser is a quick
test. If JSON comes back, the network is fine.

## Delay

Around 300 to 450 ms end to end:

| where it goes | roughly |
| --- | --- |
| capture and network | 20 to 40 ms |
| the Delay setting on the phone | 120 to 700 ms, starts at 300 |
| the Bluetooth link to the earphones | 150 ms, fixed |

That is fine for music, podcasts and anything you are only listening to. Video
will look out of sync unless the player can shift its audio. It is not usable
for games.

The Delay control is a trade, and it buys more than network slack. Audio is
handed to the phone's sound hardware up to that far ahead, so it is also how
long the phone can be busy with something else before you hear a gap. A phone
under load stalls for a couple of hundred milliseconds fairly often, which is
why the default is 300 ms. Raise it if the Dropouts counter climbs.

## What the readings mean

**Buffer** is how much audio is queued ahead of the speaker. It should sit close
to the Delay setting. If it keeps falling towards zero the network is not
keeping up.

**Level** is the signal arriving from the PC, measured before the phone's own
volume control. If the PC is playing something and this stays at the bottom,
the output device is muted or turned down.

**Dropouts** counts the times the queue ran dry or overflowed and had to be
restarted. A few over a long session is normal. A number that climbs steadily
means the Delay is too low. The computer going quiet is not counted: loopback
capture sends nothing at all when nothing is playing.

**Clock correction** is how much faster or slower than normal the phone is
playing to keep the queue at the Delay setting. It should read a few
thousandths of a percent. Parked at 0.300% means the phone cannot keep up with
the stream and the delay will keep being reset.

## Options

```bash
python -m audioy --list          # print the loopback devices
python -m audioy --device 10     # capture a specific one
python -m audioy --mono          # one channel, half the data
python -m audioy --gain 1.5      # make a quiet source louder before sending
python -m audioy --port 9000
python -m audioy --console       # no tray icon, logs to the terminal
python -m audioy --no-browser    # do not open the connection page at startup
```

The same switches work on `audioY.exe`.

By default it captures whatever Windows calls the default playback device. If
you switch output devices while it is running it notices within a second and
reopens the capture on the new one.

## Building the executable

```bash
build.bat
```

That installs PyInstaller, regenerates the icons and writes `dist\audioY.exe`,
a single file of about 30 MB.

## Notes for anyone reading the code

- Audio arrives in 40 ms chunks and goes into a ring buffer
  (`audioy/web/ring.js`), which resamples to whatever rate the phone is using
  through a fractional read position with linear interpolation. The read
  position carries across blocks, so consecutive blocks join seamlessly and
  there are no chunk boundaries to click.
- Blocks are then handed to the sound hardware ahead of time and play at normal
  speed. Nothing is stretched, and the play position never moves backwards, so
  two pieces of audio can never overlap. The important part is that playback
  does not depend on the page's own thread staying responsive: a busy moment
  eats into the cushion instead of making a hole in the sound. Driving playback
  from the page thread with a `ScriptProcessor` was tried and is much worse on
  a phone, because every stall is immediately audible. `AudioWorklet` would fix
  that properly, but it needs a secure context and this page is plain HTTP on
  the local network.
- The PC's sound clock and the phone's are never exactly the same speed. The
  ring reads up to 0.3% faster or slower to hold the queue at the Delay
  setting, which is below what an ear hears as a pitch change. Anything larger
  is a single cut back to the target, not a speed change, because a noticeable
  pitch shift is worse than one skip.
- The AudioContext is created without a `sampleRate`. Forcing one that differs
  from the hardware makes iOS crackle, worst of all over Bluetooth.
- WASAPI loopback delivers nothing at all while no application is playing. The
  stream simply pauses; the phone plays silence and refills when it resumes.
  Padding the gaps with silence on the PC side sounds like the obvious fix, but
  it raced real audio whenever the PC was busy and put silence in the middle of
  songs.
- Do not open anything that uses the microphone on the phone while listening.
  iOS switches Bluetooth earphones to the 16 kHz call profile as soon as
  anything asks for input, and the sound stays bad until it is closed.
- iOS suspends Web Audio when the browser goes to the background. "Keep the
  screen on" is the reliable answer. The screen-off option routes through a
  media element to try to survive locking; it works on some iOS versions and
  not others.

## Layout

```
audioy/__main__.py   command line, startup, shutdown
audioy/audio.py      WASAPI loopback capture and the output device volume
audioy/server.py     HTTP and WebSocket
audioy/tray.py       notification area icon and menu
audioy/net.py        finding the LAN address, making the QR code
audioy/web/          the two pages: the phone player and the connection page
audioy/web/ring.js    the jitter buffer, the part worth reading
scripts/             icon generation, diagnostics, and the ring buffer check
build.bat            builds dist\audioY.exe
```

## HTTP interface

Everything the pages use is a plain endpoint, so it is easy to drive from
somewhere else.

| path | what it does |
| --- | --- |
| `GET /` | the player page for the phone |
| `GET /connect` | the connection page with the QR code |
| `GET /qr.png?url=` | QR code image, defaults to this machine's address |
| `GET /ws` | WebSocket: one JSON greeting, then 16-bit PCM chunks |
| `GET /api/status` | capture device, format, listeners, output volume |
| `GET /api/network` | every address this machine can be reached on |
| `GET /api/devices` | the loopback devices available |
| `GET,POST /api/volume` | read or set the output device volume and mute |
| `POST /api/restart` | reopen the capture |

## Checking a change

```bash
node scripts/check_ring.js
```

Runs the buffer and the block scheduler through ten minutes of Wi-Fi jitter, a
phone at a different sample rate, twenty minutes of clock drift, a flood, a
dropout, and a phone whose main thread is busy for 250 ms. It asserts there are
no clicks, that the pitch is right, that the delay does not creep, and that a
busy moment does not produce a gap. It takes a few seconds and needs nothing
installed.

## Licence

MIT. See LICENSE.
