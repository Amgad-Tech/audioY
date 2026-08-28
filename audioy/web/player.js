/* audioY player.
 *
 * Reads 16-bit PCM chunks off a WebSocket and schedules each one on the Web
 * Audio clock as its own buffer source. AudioWorklet would be tidier but it
 * needs a secure context, and this page is plain http on the local network.
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
  adaptive: $('adaptive'), wakelock: $('wakelock'), background: $('background'),
  factFormat: $('factFormat'), factRate: $('factRate'),
  factDrops: $('factDrops'), factUptime: $('factUptime'),
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
  playHead: 0,
  drops: 0,
  bytes: 0,
  rateKbps: 0,
  startedAt: 0,
  lastDrop: 0,
  attempts: 0,
  retryTimer: null,
  wakeLock: null
};

var MIN_DELAY = 80;
var MAX_DELAY = 700;

/* --- settings ----------------------------------------------------------- */

function loadSettings() {
  try {
    var saved = JSON.parse(localStorage.getItem('audioy') || '{}');
    if (saved.volume) ui.volume.value = saved.volume;
    if (saved.delay) ui.delay.value = saved.delay;
    if (saved.adaptive !== undefined) ui.adaptive.checked = saved.adaptive;
    if (saved.wakelock !== undefined) ui.wakelock.checked = saved.wakelock;
    if (saved.background !== undefined) ui.background.checked = saved.background;
  } catch (e) {
    // private browsing, or nothing saved yet
  }
}

function saveSettings() {
  try {
    localStorage.setItem('audioy', JSON.stringify({
      volume: ui.volume.value,
      delay: ui.delay.value,
      adaptive: ui.adaptive.checked,
      wakelock: ui.wakelock.checked,
      background: ui.background.checked
    }));
  } catch (e) {
    // not important enough to bother the user about
  }
}

function delaySeconds() {
  return Number(ui.delay.value) / 1000;
}

function setDelay(ms, remember) {
  ms = Math.max(MIN_DELAY, Math.min(MAX_DELAY, Math.round(ms / 20) * 20));
  ui.delay.value = ms;
  ui.delayOut.textContent = ms + ' ms';
  // Only what the user chose, and anything a dropout forced on us, is worth
  // keeping. Saving the automatic decreases as well would leave every new
  // session starting at the lowest value the last good one happened to reach.
  if (remember !== false) saveSettings();
}

/* --- audio graph -------------------------------------------------------- */

function buildGraph(sampleRate) {
  var Ctx = window.AudioContext || window.webkitAudioContext;
  var ctx;
  try {
    ctx = new Ctx({ sampleRate: sampleRate, latencyHint: 'playback' });
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

/* --- scheduling --------------------------------------------------------- */

function noteDropout() {
  player.drops++;
  player.lastDrop = Date.now();
  if (ui.adaptive.checked) setDelay(Number(ui.delay.value) + 60);
}

function playChunk(raw) {
  player.bytes += raw.byteLength;
  if (!player.running || !player.ctx || !player.format) return;

  var pcm = new Int16Array(raw);
  var channels = player.format.channels;
  var frames = pcm.length / channels;
  if (!frames) return;

  var buffer = player.ctx.createBuffer(channels, frames, player.format.sampleRate);
  for (var c = 0; c < channels; c++) {
    var out = buffer.getChannelData(c);
    for (var i = 0, j = c; i < frames; i++, j += channels) {
      out[i] = pcm[j] / 32768;
    }
  }

  var now = player.ctx.currentTime;
  var target = delaySeconds();

  if (player.playHead < now + 0.004) {
    // The queue ran dry. Start again one delay ahead of the clock.
    if (player.playHead !== 0) noteDropout();
    player.playHead = now + target;
  }

  var ahead = player.playHead - now;
  if (ahead > target * 3 + 0.3) {
    // Way too much backlog, usually after the page was in the background.
    noteDropout();
    player.playHead = now + target;
    return;
  }

  // The two machines' sound clocks are never exactly equal, so hold the queue
  // at the target depth by nudging playback speed instead of resyncing.
  var error = (ahead - target) / Math.max(target, 0.05);
  var speed = 1 + Math.max(-0.02, Math.min(0.02, error * 0.05));

  var source = player.ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = speed;
  source.connect(player.input);
  source.start(player.playHead);
  player.playHead += buffer.duration / speed;
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
      ui.source.textContent = 'Source: ' + (hello.device || 'unknown');
      ui.factFormat.textContent = (hello.rate / 1000).toFixed(1) + ' kHz, ' +
        (hello.channels === 1 ? 'mono' : 'stereo') + ', 16 bit';

      if (player.running && !player.ctx) {
        buildGraph(hello.rate);
      }
      player.playHead = 0;
      updateReadout();
      return;
    }
    playChunk(event.data);
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
  player.playHead = 0;
  player.startedAt = Date.now();
  player.lastDrop = Date.now();

  ui.swtch.classList.add('on');
  ui.swtch.textContent = 'Stop';

  var rate = player.format ? player.format.sampleRate : 48000;
  var ready = player.ctx ? player.ctx.resume() : buildGraph(rate);
  Promise.resolve(ready).then(updateReadout, updateReadout);

  if (!player.socket) connect();
  requestWakeLock();
  saveSettings();
}

function halt() {
  player.running = false;
  player.playHead = 0;
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
ui.delay.addEventListener('input', function () { setDelay(Number(ui.delay.value)); });
ui.adaptive.addEventListener('change', saveSettings);
ui.background.addEventListener('change', function () { routeOutput(); saveSettings(); });
ui.wakelock.addEventListener('change', function () {
  if (ui.wakelock.checked) requestWakeLock(); else releaseWakeLock();
  saveSettings();
});

var wave = new Uint8Array(512);
var lastBytes = 0;
var lastTick = Date.now();

setInterval(function () {
  var depth = (player.ctx && player.playHead)
    ? Math.max(0, player.playHead - player.ctx.currentTime) : 0;
  var ms = Math.round(depth * 1000);
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
  ui.factDrops.textContent = player.drops;

  var seconds = player.running
    ? Math.floor((now - player.startedAt) / 1000) : 0;
  var mm = Math.floor(seconds / 60);
  var ss = seconds % 60;
  ui.factUptime.textContent = mm + ':' + (ss < 10 ? '0' : '') + ss;

  // Give the delay back slowly once the connection has behaved for a while.
  if (player.running && ui.adaptive.checked &&
      now - player.lastDrop > 45000 && Number(ui.delay.value) > MIN_DELAY) {
    setDelay(Number(ui.delay.value) - 20, false);
    player.lastDrop = now;
  }
}, 250);

loadSettings();
setDelay(Number(ui.delay.value));
applyVolume();
connect();
checkOutput();
setInterval(checkOutput, 6000);
ui.curtain.hidden = false;
