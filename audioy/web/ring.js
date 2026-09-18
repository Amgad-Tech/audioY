/* audioY jitter buffer.

   Network chunks are written in at the computer's sample rate and read out in
   blocks at the phone's rate, through a fractional read position with linear
   interpolation. The read position carries across blocks, so consecutive
   blocks join seamlessly and the player can hand them straight to the audio
   hardware at normal speed. Any difference between the two sample rates, and
   any slow drift between the two clocks, is absorbed here.

   Loaded before player.js, and by scripts/check_ring.js under node. */

function Ring(channels, rate, seconds) {
  this.channels = channels;
  this.rate = rate;
  this.capacity = Math.ceil(rate * seconds);
  this.data = [];
  for (var c = 0; c < channels; c++) this.data.push(new Float32Array(this.capacity));
  this.written = 0;     // frames written, ever
  this.read = 0;        // frames read, ever (fractional)
  this.skips = 0;       // times the queue was too full and had to be cut back
  this.smoothed = 0;
  this.speed = 1;
}

Ring.prototype.available = function () {
  return this.written - this.read;
};

// Throw away the oldest audio so exactly `frames` are left waiting.
Ring.prototype.trim = function (frames) {
  if (this.available() > frames) this.read = this.written - Math.max(0, frames);
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

// Fill out[] (one Float32Array per output channel) with resampled audio.
//   step    source rate / output rate
//   queued  source frames already handed to the hardware but not played yet
//   target  total source frames to keep in flight, here plus queued
// Returns the number of frames written, or 0 if there is not enough yet, in
// which case out[] is untouched and the caller should try again later.
Ring.prototype.pull = function (out, step, queued, target) {
  var n = out[0].length;
  var need = n * step * 1.01 + 2;      // a little slack for the speed trim
  if (this.available() < need) return 0;

  var inFlight = this.available() + queued;
  if (inFlight > target * 2 + n * step) {
    // Far too much waiting, normally after the phone paused the page. Cut
    // back once rather than racing through it at a raised pitch.
    this.trim(target - queued);
    this.skips++;
    this.smoothed = target;
    if (this.available() < need) return 0;
    inFlight = this.available() + queued;
  }

  // The two machines' clocks disagree by a few parts per million. Hold the
  // queue at the target by reading up to 0.3% faster or slower, which is
  // below what an ear can hear as a pitch change.
  this.smoothed = this.smoothed ? this.smoothed + (inFlight - this.smoothed) * 0.05
                                : inFlight;
  var error = (this.smoothed - target) / target;
  this.speed = 1 + Math.max(-0.003, Math.min(0.003, error * 0.003));

  var s = step * this.speed;
  var cap = this.capacity;
  for (var i = 0; i < n; i++) {
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
  return n;
};

if (typeof module !== 'undefined') module.exports = Ring;
