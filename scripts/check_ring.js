// Simulates the phone player against a stream from the computer and checks
// the jitter buffer: no clicks, correct pitch across sample rates, no drift in
// delay over time, and clean recovery from overflow and dropouts.
//
//     node scripts/check_ring.js

var assert = require('assert');
var Ring = require('../audioy/web/ring.js');

var SRC = 48000;
var CHUNK = 1920;         // 40 ms, what the server sends
var BLOCK = 4096;         // what the phone's audio node asks for
var HZ = 440;

// Runs `seconds` of simulated time. Returns the output and stats.
function simulate(opts) {
  var outRate = opts.outRate || SRC;
  var drift = opts.drift || 0;           // producer runs this much fast
  var jitter = opts.jitter || 0;         // seconds of random delivery lateness
  var target = Math.round(0.2 * SRC);
  var ring = new Ring(2, SRC, 4);
  var out = [];
  var phase = 0;
  var nextPush = 0, nextPull = 0, t = 0;
  var fills = [];
  var pending = [];

  while (t < opts.seconds) {
    if (nextPush <= nextPull) {
      t = nextPush;
      var pcm = new Int16Array(CHUNK * 2);
      for (var i = 0; i < CHUNK; i++) {
        var v = Math.round(Math.sin(phase) * 8000);
        pcm[i * 2] = pcm[i * 2 + 1] = v;
        phase += 2 * Math.PI * HZ / SRC;
      }
      var gapped = opts.gap && t > opts.gap[0] && t < opts.gap[1];
      // late, but never out of order: it is a TCP connection
      var at = Math.max(t + Math.random() * jitter, pending.length ? pending[pending.length - 1].at : 0);
      if (!gapped) pending.push({ at: at, pcm: pcm });
      nextPush += CHUNK / SRC / (1 + drift);
    } else {
      t = nextPull;
      pending = pending.filter(function (p) {
        if (p.at > t) return true;
        ring.push(p.pcm);
        return false;
      });
      if (opts.flood && Math.abs(t - opts.flood) < BLOCK / outRate / 2) {
        for (var k = 0; k < 50; k++) ring.push(new Int16Array(CHUNK * 2));
      }
      var l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
      if (opts.miss && Math.random() < opts.miss) {
        ring.discard(BLOCK * SRC / outRate);    // what the player does
      } else {
        ring.pull([l, r], target, SRC / outRate);
        for (var j = 0; j < BLOCK; j++) out.push(l[j]);
      }
      if (!ring.starved) fills.push(ring.available() / SRC);
      nextPull += BLOCK / outRate;
    }
  }
  return { out: out, ring: ring, fills: fills, outRate: outRate };
}

// Largest jump between neighbouring samples while playing. A clean 440 Hz
// sine at amplitude 0.244 never moves more than about 0.015 per sample.
function worstStep(out) {
  var worst = 0;
  for (var i = 1; i < out.length; i++) {
    if (out[i] === 0 || out[i - 1] === 0) continue;
    worst = Math.max(worst, Math.abs(out[i] - out[i - 1]));
  }
  return worst;
}

function frequency(out, rate) {
  var crossings = 0, first = -1, last = -1;
  for (var i = 1; i < out.length; i++) {
    if (out[i - 1] < 0 && out[i] >= 0) {
      if (first < 0) first = i;
      last = i;
      crossings++;
    }
  }
  return (crossings - 1) / ((last - first) / rate);
}

function mean(a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; }

// 1. same rate on both sides, realistic Wi-Fi jitter, ten minutes
var a = simulate({ seconds: 600, jitter: 0.06 });
assert(worstStep(a.out) < 0.02, 'click in steady playback: ' + worstStep(a.out));
assert.strictEqual(a.ring.skips, 0, 'skipped during steady playback');
assert(!a.ring.dry, 'ran dry during steady playback');
assert(Math.abs(frequency(a.out, SRC) - HZ) < 0.5, 'pitch off: ' + frequency(a.out, SRC));

// 2. phone running at 44.1 kHz: pitch must stay 440, not 479
var b = simulate({ seconds: 60, outRate: 44100, jitter: 0.03 });
assert(Math.abs(frequency(b.out, 44100) - HZ) < 0.5, 'resampled pitch off: ' + frequency(b.out, 44100));
assert(worstStep(b.out) < 0.02, 'click after resampling');

// 3. the computer's clock 100 ppm fast for twenty minutes: delay must not creep
var c = simulate({ seconds: 1200, drift: 0.0001, jitter: 0.03 });
var early = mean(c.fills.slice(100, 1000));
var late = mean(c.fills.slice(-1000));
assert(Math.abs(late - early) < 0.02, 'delay crept from ' + early + ' to ' + late);
assert.strictEqual(c.ring.skips, 0, 'drift caused skips');
assert(c.ring.speed > 1 && c.ring.speed < 1.003, 'speed out of range: ' + c.ring.speed);

// fill is sampled just after each read, so compare against an undisturbed run
var normal = mean(simulate({ seconds: 20 }).fills.slice(-50));

// 4. a two-second flood: one jump back to target, never two streams at once
var d = simulate({ seconds: 20, flood: 10 });
assert.strictEqual(d.ring.skips, 1, 'flood should cause exactly one skip');
assert(Math.abs(mean(d.fills.slice(-50)) - normal) < 0.03, 'did not settle back to target');

// 5. data stops for half a second, then comes back
var e = simulate({ seconds: 20, gap: [10, 10.5] });
assert(e.ring.dry, 'gap should run the buffer dry');
assert(!e.ring.starved, 'did not resume after the gap');
assert(Math.abs(mean(e.fills.slice(-50)) - normal) < 0.03, 'did not settle after the gap');

// 6. the phone misses 1% of its audio blocks for ten minutes: delay must hold
var g = simulate({ seconds: 600, miss: 0.01, jitter: 0.03 });
assert.strictEqual(g.ring.skips, 0, 'missed blocks caused skips');
assert(Math.abs(mean(g.fills.slice(-1000)) - mean(g.fills.slice(100, 1000))) < 0.02, 'missed blocks made the delay creep');

console.log('ring ok');
