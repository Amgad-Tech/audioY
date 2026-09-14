/* audioY jitter buffer.

   Network chunks are written in at the computer's sample rate and read back
   one output block at a time at the phone's rate, through a fractional read
   position with linear interpolation. It is one continuous stream, so there
   are no chunk boundaries to click and nothing can play on top of anything
   else. Loaded before player.js, and by scripts/check_ring.js under node. */

function Ring(channels, rate, seconds) {
  this.channels = channels;
  this.rate = rate;
  this.capacity = Math.ceil(rate * seconds);
  this.data = [];
  for (var c = 0; c < channels; c++) this.data.push(new Float32Array(this.capacity));
  this.written = 0;     // frames written, ever
  this.read = 0;        // frames read, ever (fractional)
  this.starved = true;  // waiting to fill up to the target before playing
  this.dry = false;     // ran out while playing; the owner clears it
  this.skips = 0;
  this.smoothed = 0;
  this.speed = 1;
}

Ring.prototype.available = function () {
  return this.written - this.read;
};

// pcm is interleaved 16-bit
Ring.prototype.push = function (pcm) {
  var ch = this.channels;
  var frames = pcm.length / ch;
  var cap = this.capacity;
  for (var i = 0; i < frames; i++) {
    var at = (this.written + i) % cap;
    for (var c = 0; c < ch; c++) this.data[c][at] = pcm[i * ch + c] / 32768;
  }
  this.written += frames;
  // never let the writer lap the reader
  if (this.available() > cap - 2) this.read = this.written - (cap - 2);
};

// Fill `out` (one Float32Array per output channel). `target` is how many
// source frames to keep queued, `step` is source rate / output rate.
Ring.prototype.pull = function (out, target, step) {
  var n = out[0].length;

  if (this.starved) {
    if (this.available() < target) return silence(out, 0);
    this.read = this.written - target;
    this.smoothed = target;
    this.starved = false;
  } else if (this.available() > target * 2 + n * step) {
    // Far too much queued, usually after the phone paused the page. Jump
    // once instead of racing through it at a raised pitch.
    this.read = this.written - target;
    this.smoothed = target;
    this.skips++;
  }

  // The two machines' clocks disagree by a few parts per million. Hold the
  // queue at the target by reading up to 0.3% faster or slower, which is
  // below what an ear can hear as a pitch change.
  this.smoothed += (this.available() - this.smoothed) * 0.05;
  var error = (this.smoothed - target) / target;
  this.speed = 1 + Math.max(-0.003, Math.min(0.003, error * 0.003));

  var s = step * this.speed;
  var cap = this.capacity;
  for (var i = 0; i < n; i++) {
    if (this.written - this.read < 2) {
      this.starved = true;
      this.dry = true;
      return silence(out, i);
    }
    var p = Math.floor(this.read);
    var f = this.read - p;
    var a = p % cap;
    var b = (p + 1) % cap;
    for (var c = 0; c < out.length; c++) {
      var d = this.data[Math.min(c, this.channels - 1)];
      out[c][i] = d[a] + (d[b] - d[a]) * f;
    }
    this.read += s;
  }
};

// The output skipped blocks without asking for them, which happens when the
// phone's main thread stalls. Drop the audio those blocks would have played,
// otherwise every stall adds to the delay for good.
Ring.prototype.discard = function (frames) {
  if (!this.starved) this.read = Math.min(this.read + frames, this.written);
};

function silence(out, from) {
  for (var c = 0; c < out.length; c++) out[c].fill(0, from);
}

if (typeof module !== 'undefined') module.exports = Ring;
