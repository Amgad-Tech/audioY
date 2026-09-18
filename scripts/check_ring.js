// Simulates the phone player against a stream from the computer: the ring
// buffer plus the pump that hands blocks to the audio hardware ahead of time.
// Checks there are no clicks, that the pitch is right at any output rate, that
// the delay does not creep, and that a busy moment on the phone does not
// produce a gap.
//
//     node scripts/check_ring.js

var assert = require('assert');
var Ring = require('../audioy/web/ring.js');

var SRC = 48000;
var CHUNK = 1920;         // 40 ms, what the server sends
var HZ = 440;

// Runs `seconds` of simulated time through the same logic player.js uses.
function simulate(opts) {
  var outRate = opts.outRate || SRC;
  var target = opts.target || 0.2;                    // seconds of cushion
  var drift = opts.drift || 0;                        // producer runs this fast
  var jitter = opts.jitter || 0;                      // delivery lateness
  var blockFrames = Math.round(0.04 * outRate);

  var ring = new Ring(2, SRC, 4);
  var t = 0, nextPush = 0, nextPump = 0;
  var playHead = 0, filling = true;
  var out = [], joins = [], drops = 0, fills = [];
  var pending = [], phase = 0;

  function stalled() {
    return opts.stall && t > opts.stall[0] && t < opts.stall[1];
  }

  function pump() {
    if (playHead <= t) {
      if (!filling) { filling = true; drops++; }
      playHead = t;
    }
    if (filling) {
      if (ring.available() < target * SRC) return;
      playHead = t + 0.02;
      filling = false;
      ring.trim((target - 0.02) * SRC);
      joins.push(out.length);       // a jump is allowed exactly here
    }
    var step = SRC / outRate;
    var least = Math.round(0.01 * outRate);
    while (playHead - t < target) {
      var frames = Math.min(blockFrames, Math.floor((ring.available() - 2) / (step * 1.01)));
      if (frames < least) break;
      var l = new Float32Array(frames), r = new Float32Array(frames);
      if (!ring.pull([l, r], step, (playHead - t) * SRC, target * SRC)) break;
      for (var i = 0; i < frames; i++) out.push(l[i]);
      playHead += frames / outRate;
    }
    if (!filling) fills.push(ring.available() / SRC + Math.max(0, playHead - t));
  }

  while (t < opts.seconds) {
    if (nextPush <= nextPump) {
      t = nextPush;
      var pcm = new Int16Array(CHUNK * 2);
      for (var i = 0; i < CHUNK; i++) {
        var v = Math.round(Math.sin(phase) * 8000);
        pcm[i * 2] = pcm[i * 2 + 1] = v;
        phase += 2 * Math.PI * HZ / SRC;
      }
      // late, but never out of order: it is a TCP connection
      var at = Math.max(t + Math.random() * jitter,
                        pending.length ? pending[pending.length - 1].at : 0);
      if (!(opts.gap && t > opts.gap[0] && t < opts.gap[1])) {
        pending.push({ at: at, pcm: pcm });
      }
      nextPush += CHUNK / SRC / (1 + drift);
    } else {
      t = nextPump;
      pending = pending.filter(function (x) {
        if (x.at > t) return true;
        ring.push(x.pcm);
        return false;
      });
      if (opts.flood && Math.abs(t - opts.flood) < 0.02) {
        for (var k = 0; k < 50; k++) ring.push(new Int16Array(CHUNK * 2));
      }
      if (!stalled()) pump();       // a stalled main thread cannot pump
      nextPump += 0.025;
    }
  }
  return { out: out, ring: ring, fills: fills, drops: drops, joins: joins };
}

// Largest jump between neighbouring samples, ignoring the points where the
// player deliberately restarted. A clean 440 Hz sine at amplitude 0.244 never
// moves more than about 0.015 per sample.
function worstStep(r) {
  var worst = 0;
  for (var i = 1; i < r.out.length; i++) {
    if (r.joins.indexOf(i) >= 0) continue;
    worst = Math.max(worst, Math.abs(r.out[i] - r.out[i - 1]));
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

// 1. same rate both sides, realistic Wi-Fi jitter, ten minutes
var a = simulate({ seconds: 600, jitter: 0.06 });
assert(worstStep(a) < 0.02, 'click in steady playback: ' + worstStep(a));
assert.strictEqual(a.ring.skips, 0, 'skipped during steady playback');
assert.strictEqual(a.drops, 0, 'dropped out during steady playback');
assert(Math.abs(frequency(a.out, SRC) - HZ) < 0.5, 'pitch off: ' + frequency(a.out, SRC));

// 2. phone running at 44.1 kHz: pitch must stay 440, not 479
var b = simulate({ seconds: 60, outRate: 44100, jitter: 0.03 });
assert(Math.abs(frequency(b.out, 44100) - HZ) < 0.5, 'resampled pitch: ' + frequency(b.out, 44100));
assert(worstStep(b) < 0.02, 'click after resampling: ' + worstStep(b));

// 3. computer's clock 100 ppm fast for twenty minutes: delay must not creep
var c = simulate({ seconds: 1200, drift: 0.0001, jitter: 0.03 });
var early = mean(c.fills.slice(100, 1000));
var late = mean(c.fills.slice(-1000));
assert(Math.abs(late - early) < 0.02, 'delay crept from ' + early + ' to ' + late);
assert.strictEqual(c.ring.skips, 0, 'drift caused skips');
assert(c.ring.speed > 1 && c.ring.speed < 1.003, 'speed out of range: ' + c.ring.speed);

var normal = mean(simulate({ seconds: 20 }).fills.slice(-50));

// 4. a two-second flood: cut back once, never play two streams at once
var d = simulate({ seconds: 20, flood: 10 });
assert.strictEqual(d.ring.skips, 1, 'flood should cut back exactly once');
assert(Math.abs(mean(d.fills.slice(-50)) - normal) < 0.03, 'did not settle after flood');

// 5. data stops for half a second, then comes back
var e = simulate({ seconds: 20, gap: [10, 10.5] });
assert.strictEqual(e.drops, 1, 'gap should count one dropout, got ' + e.drops);
assert(Math.abs(mean(e.fills.slice(-50)) - normal) < 0.03, 'did not settle after the gap');

// 6. the phone's main thread is busy for 250 ms. The cushion has to cover it:
//    this is the whole reason blocks go to the hardware early.
var f = simulate({ seconds: 20, target: 0.3, stall: [10, 10.25] });
assert.strictEqual(f.drops, 0, 'a 250 ms stall under a 300 ms cushion dropped out');
assert.strictEqual(f.joins.length, 1, 'stall caused a restart');
assert(worstStep(f) < 0.02, 'click after the stall: ' + worstStep(f));

console.log('ring ok');
