/* audioY player.
 *
 * 16-bit PCM chunks come off a WebSocket into a Ring (ring.js), which
 * resamples them to the phone's rate. Blocks are then handed to the audio
 * hardware ahead of time, so playback does not depend on this thread staying
 * responsive: a busy moment only eats into the cushion instead of producing a
 * gap. The ring joins blocks seamlessly, so they play at normal speed and
 * nothing has to be stretched.
 */

var $ = function (id) { return document.getElementById(id); };

var ui = {
  swtch: $('switch'), readout: $('readout'), source: $('source'),
  curtain: $('curtain'),
  notice: $('notice'), noticeText: $('noticeText'), noticeFix: $('noticeFix'),
  bufferBar: $('bufferBar'), bufferMs: $('bufferMs'),
  levelBar: $('levelBar'), levelDb: $('levelDb'),
  volume: $('volume'), volumeOut: $('volumeOut'),
  delay: $('delay'), delayOut: $('delayOut'),
  wakelock: $('wakelock'), background: $('background'),
  factFormat: $('factFormat'), factRate: $('factRate'),
  factDrops: $('factDrops'), factSpeed: $('factSpeed'), factUptime: $('factUptime'),
  sink: $('sink')
};

var player = {
  running: false,
  socket: null,
  ctx: null,
  input: null,
  gain: null,
  analyser: null,
  streamOut: null,
  format: null,
  ring: null,
  drops: 0,
  bytes: 0,
  rateKbps: 0,
  startedAt: 0,
  lastChunkAt: 0,
  playHead: 0,       // audio clock time the next block starts at
  filling: true,     // building the cushion back up before playing
  attempts: 0,
  retryTimer: null,
  wakeLock: null
};

var MAX_DELAY = 700;
var SETTINGS = 'audioy.3';   // older versions saved delays that no longer mean
                             // the same thing, so start them fresh

/* --- settings ----------------------------------------------------------- */

function loadSettings() {
  try {
    var saved = JSON.parse(localStorage.getItem(SETTINGS) || '{}');
    if (saved.volume) ui.volume.value = saved.volume;
    if (saved.delay) ui.delay.value = saved.delay;
    if (saved.wakelock !== undefined) ui.wakelock.checked = saved.wakelock;
    if (saved.background !== undefined) ui.background.checked = saved.background;
  } catch (e) {
    // private browsing, or nothing saved yet
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS, JSON.stringify({
      volume: ui.volume.value,
      delay: ui.delay.value,
      wakelock: ui.wakelock.checked,
      background: ui.background.checked
    }));
  } catch (e) {
    // not important enough to bother the user about
  }
}

function showDelay() {
  ui.delayOut.textContent = ui.delay.value + ' ms';
}

/* --- audio graph -------------------------------------------------------- */

function buildGraph() {
  // No sampleRate here on purpose: forcing one that differs from the
  // hardware makes iOS crackle, worst of all on Bluetooth. The ring
  // resamples to whatever rate the phone picks.
  var Ctx = window.AudioContext || window.webkitAudioContext;
  var ctx;
  try {
    ctx = new Ctx({ latencyHint: 'playback' });
  } catch (e) {
    ctx = new Ctx();
  }

  // input feeds the meter as well as the volume control, so the meter shows
  // what the computer is sending rather than what the phone is playing
  var input = ctx.createGain();
  var gain = ctx.createGain();
  var analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  input.connect(analyser);
  input.connect(gain);

  player.ctx = ctx;
  player.input = input;
  player.gain = gain;
  player.analyser = analyser;

  applyVolume();
  routeOutput();

  // Safari will not consider the context started until it renders something.
  var poke = ctx.createBufferSource();
  poke.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  poke.connect(ctx.destination);
  poke.start();

  return ctx.resume();
}

function routeOutput() {
  if (!player.ctx) return;
  try { player.gain.disconnect(); } catch (e) { /* nothing connected yet */ }

  if (ui.background.checked) {
    // Feeding a media element makes iOS treat this as playback rather than as
    // page script, which sometimes survives the screen locking.
    if (!player.streamOut) {
      player.streamOut = player.ctx.createMediaStreamDestination();
    }
    player.gain.connect(player.streamOut);
    try {
      ui.sink.srcObject = player.streamOut.stream;
      var p = ui.sink.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {
      ui.background.checked = false;
      player.gain.connect(player.ctx.destination);
    }
  } else {
    try {
      ui.sink.pause();
      ui.sink.srcObject = null;
    } catch (e) { /* ignore */ }
    player.gain.connect(player.ctx.destination);
  }
}

function applyVolume() {
  ui.volumeOut.textContent = ui.volume.value + '%';
  if (player.gain) player.gain.gain.value = Number(ui.volume.value) / 100;
}

/* --- handing blocks to the hardware ------------------------------------- */

// One network chunk per block. The cushion can absorb a busy moment of up to
// (delay - BLOCK_MS), so keeping blocks small keeps that tolerance high.
var BLOCK_MS = 40;

// Keeps the hardware supplied up to `delay` ahead of the audio clock. Called
// whenever a chunk arrives and from a timer, so neither one alone has to be
// punctual.
function pump() {
  if (!player.running || !player.ctx || !player.ring) return;

  var ctx = player.ctx;
  var ring = player.ring;
  var rate = player.format.sampleRate;
  var step = rate / ctx.sampleRate;
  var target = Number(ui.delay.value) / 1000;
  var blockFrames = Math.round(BLOCK_MS / 1000 * ctx.sampleRate);
  var now = ctx.currentTime;

  if (player.playHead <= now) {
    // The cushion ran out. Anything still scheduled has already played.
    if (!player.filling) {
      player.filling = true;
      // The computer going quiet is not a dropout; loopback capture simply
      // sends nothing at all when nothing is playing.
      if (Date.now() - player.lastChunkAt < 1000) player.drops++;
    }
    player.playHead = now;
  }

  // Wait for a full cushion before starting, otherwise it starts by stuttering.
  if (player.filling) {
    if (ring.available() < target * rate) return;
    player.playHead = now + 0.02;
    player.filling = false;
    // Start at exactly the target, not at whatever piled up while refilling,
    // or every dropout would leave the delay a little longer than before.
    ring.trim((target - 0.02) * rate);
  }

  // Hand over everything the ring has, in blocks, so that what is waiting to
  // play sits with the hardware rather than here. That is what a busy moment
  // on this thread eats into instead of the sound.
  var least = Math.round(0.01 * ctx.sampleRate);
  while (player.playHead - ctx.currentTime < target) {
    var room = Math.floor((ring.available() - 2) / (step * 1.01));
    var frames = Math.min(blockFrames, room);
    if (frames < least) break;

    var buffer = ctx.createBuffer(2, frames, ctx.sampleRate);
    var out = [buffer.getChannelData(0), buffer.getChannelData(1)];
    var queued = (player.playHead - ctx.currentTime) * rate;
    if (!ring.pull(out, step, queued, target * rate)) break;

    var source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(player.input);
    source.start(player.playHead);
    player.playHead += frames / ctx.sampleRate;
  }
}

/* --- incoming audio --------------------------------------------------- */

function onChunk(raw) {
  player.bytes += raw.byteLength;
  if (!player.ring) return;
  player.lastChunkAt = Date.now();
  player.ring.push(new Int16Array(raw));
  pump();
}

/* --- connection --------------------------------------------------------- */

function connect() {
  var scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  var socket = new WebSocket(scheme + '://' + location.host + '/ws');
  socket.binaryType = 'arraybuffer';
  player.socket = socket;

  socket.onopen = function () {
    player.attempts = 0;
  };

  socket.onmessage = function (event) {
    if (typeof event.data === 'string') {
      var hello = JSON.parse(event.data);
      if (hello.type !== 'hello') return;

      player.format = { sampleRate: hello.rate, channels: hello.channels };
      player.ring = new Ring(hello.channels, hello.rate, 4);
      ui.source.textContent = 'Source: ' + (hello.device || 'unknown');
      ui.factFormat.textContent = (hello.rate / 1000).toFixed(1) + ' kHz, ' +
        (hello.channels === 1 ? 'mono' : 'stereo') + ', 16 bit';

      if (player.running && !player.ctx) buildGraph();
      updateReadout();
      return;
    }
    onChunk(event.data);
  };

  socket.onclose = function () {
    player.socket = null;
    player.attempts++;
    var wait = Math.min(500 * player.attempts, 5000);
    setReadout('Reconnecting', 'bad');
    player.retryTimer = setTimeout(connect, wait);
  };

  socket.onerror = function () {
    try { socket.close(); } catch (e) { /* already gone */ }
  };
}

/* --- start and stop ----------------------------------------------------- */

function begin() {
  ui.curtain.hidden = true;
  player.running = true;
  player.drops = 0;
  player.bytes = 0;
  player.startedAt = Date.now();
  player.playHead = 0;
  player.filling = true;

  ui.swtch.classList.add('on');
  ui.swtch.textContent = 'Stop';

  var ready = player.ctx ? player.ctx.resume() : buildGraph();
  Promise.resolve(ready).then(updateReadout, updateReadout);

  if (!player.socket) connect();
  requestWakeLock();
  saveSettings();
}

function halt() {
  player.running = false;
  player.filling = true;
  ui.swtch.classList.remove('on');
  ui.swtch.textContent = 'Listen';
  if (player.ctx) player.ctx.suspend();
  try { ui.sink.pause(); } catch (e) { /* ignore */ }
  releaseWakeLock();
  setReadout('Stopped');
}

function setReadout(text, kind) {
  ui.readout.textContent = text;
  ui.readout.className = 'readout' + (kind ? ' ' + kind : '');
}

function updateReadout() {
  if (!player.running) {
    setReadout('Stopped');
  } else if (!player.socket) {
    setReadout('Reconnecting', 'bad');
  } else {
    setReadout('Playing', 'live');
  }
}

/* --- screen --------------------------------------------------------------*/

function requestWakeLock() {
  if (!ui.wakelock.checked || !navigator.wakeLock || player.wakeLock) return;
  navigator.wakeLock.request('screen').then(function (lock) {
    player.wakeLock = lock;
    lock.addEventListener('release', function () { player.wakeLock = null; });
  }, function () { /* refused, or not supported on this iOS version */ });
}

function releaseWakeLock() {
  if (!player.wakeLock) return;
  player.wakeLock.release().catch(function () {});
  player.wakeLock = null;
}

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  if (!player.running) return;
  requestWakeLock();
  if (player.ctx && player.ctx.state === 'suspended') player.ctx.resume();
});

/* --- the computer's output device --------------------------------------- */

function checkOutput() {
  fetch('api/status', { cache: 'no-store' }).then(function (r) {
    return r.json();
  }).then(function (status) {
    var out = status.output || {};
    if (!out.available) return;

    if (out.muted) {
      showNotice('The computer’s output device is muted, so nothing but ' +
                 'silence is being sent.');
    } else if (out.volume < 0.2) {
      showNotice('The computer’s output volume is ' +
                 Math.round(out.volume * 100) + '%. Anything below about 20% ' +
                 'arrives too quiet to use.');
    } else {
      ui.notice.hidden = true;
    }
  }).catch(function () { /* the socket state already reports this */ });
}

function showNotice(text) {
  ui.noticeText.textContent = text;
  ui.notice.hidden = false;
}

ui.noticeFix.addEventListener('click', function () {
  ui.noticeFix.disabled = true;
  fetch('api/volume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume: 1.0, muted: false })
  }).then(checkOutput).catch(function () {}).then(function () {
    ui.noticeFix.disabled = false;
  });
});

/* --- wiring ------------------------------------------------------------- */

ui.swtch.addEventListener('click', function () {
  if (player.running) halt(); else begin();
});
ui.curtain.addEventListener('click', begin);
ui.volume.addEventListener('input', function () { applyVolume(); saveSettings(); });
ui.delay.addEventListener('input', function () { showDelay(); saveSettings(); });
ui.background.addEventListener('change', function () { routeOutput(); saveSettings(); });
ui.wakelock.addEventListener('change', function () {
  if (ui.wakelock.checked) requestWakeLock(); else releaseWakeLock();
  saveSettings();
});

var wave = new Uint8Array(512);
var lastBytes = 0;
var lastTick = Date.now();

setInterval(function () {
  var ring = player.ring;
  var ahead = (player.ctx && !player.filling)
    ? Math.max(0, player.playHead - player.ctx.currentTime) : 0;
  var ms = (ring && player.running)
    ? Math.round((ring.available() / ring.rate + ahead) * 1000) : 0;
  ui.bufferMs.textContent = ms;
  ui.bufferBar.style.width = Math.min(100, ms / MAX_DELAY * 100) + '%';
  ui.bufferBar.className = (player.running && ms < 40) ? 'bad' : '';

  var db = null;
  if (player.analyser && player.running) {
    player.analyser.getByteTimeDomainData(wave);
    var peak = 0;
    for (var i = 0; i < wave.length; i++) {
      var s = Math.abs(wave[i] - 128) / 128;
      if (s > peak) peak = s;
    }
    db = peak > 0 ? 20 * Math.log10(peak) : null;
  }
  ui.levelDb.textContent = db === null ? '--' : db.toFixed(0);
  ui.levelBar.style.width =
    (db === null ? 0 : Math.min(100, Math.max(0, (db + 60) / 60 * 100))) + '%';

  var now = Date.now();
  if (now - lastTick > 900) {
    player.rateKbps = (player.bytes - lastBytes) * 8 / (now - lastTick);
    lastBytes = player.bytes;
    lastTick = now;
  }
  ui.factRate.textContent = player.running
    ? Math.round(player.rateKbps) + ' kbit/s' : '--';
  ui.factDrops.textContent = player.drops + (ring ? ring.skips : 0);
  ui.factSpeed.textContent = (ring && player.running)
    ? ((ring.speed - 1) * 100).toFixed(3) + '%' : '--';
  if (player.running) pump();   // backstop if chunks stop arriving

  var seconds = player.running
    ? Math.floor((now - player.startedAt) / 1000) : 0;
  var mm = Math.floor(seconds / 60);
  var ss = seconds % 60;
  ui.factUptime.textContent = mm + ':' + (ss < 10 ? '0' : '') + ss;
}, 250);

loadSettings();
showDelay();
applyVolume();
connect();
checkOutput();
setInterval(checkOutput, 6000);
ui.curtain.hidden = false;
