/* The page audioY opens on the computer: address, QR code, and what the
   capture is currently doing. */

var $ = function (id) { return document.getElementById(id); };

var primary = null;

function refreshNetwork() {
  fetch('api/network', { cache: 'no-store' }).then(function (r) {
    return r.json();
  }).then(function (data) {
    var addresses = data.addresses || [];
    if (!addresses.length) return;

    if (addresses[0] !== primary) {
      primary = addresses[0];
      $('address').textContent = primary;
      // cache buster, otherwise the browser keeps the old code after a
      // network change
      $('qr').src = 'qr.png?url=' + encodeURIComponent(primary);
    }

    var others = addresses.slice(1);
    var list = $('alternates');
    list.innerHTML = '';
    if (others.length) {
      var head = document.createElement('li');
      head.textContent = 'Other addresses on this machine:';
      list.appendChild(head);
      others.forEach(function (url) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = 'qr.png?url=' + encodeURIComponent(url);
        a.textContent = url;
        a.title = 'Show the code for this address';
        a.addEventListener('click', function (e) {
          e.preventDefault();
          $('qr').src = a.href;
          $('address').textContent = url;
        });
        li.appendChild(a);
        list.appendChild(li);
      });
    }
  }).catch(function () { /* audioY was probably closed */ });
}

function refreshStatus() {
  fetch('api/status', { cache: 'no-store' }).then(function (r) {
    return r.json();
  }).then(function (status) {
    $('factSource').textContent = status.device || 'unknown';
    $('factListeners').textContent = status.listeners;
    $('factFormat').textContent = (status.rate / 1000).toFixed(1) + ' kHz, ' +
      (status.channels === 1 ? 'mono' : 'stereo') + ', 16 bit';

    var out = status.output || {};
    if (!out.available) {
      $('factOutput').textContent = 'unknown';
      return;
    }

    var percent = Math.round(out.volume * 100);
    $('factOutput').textContent = out.device +
      (out.muted ? ' (muted)' : ' at ' + percent + '%');

    if (out.muted) {
      notice('The output device is muted. Windows applies mute before audioY ' +
             'can capture anything, so the phone would get silence.');
    } else if (out.volume < 0.2) {
      notice('The output volume is ' + percent + '%. Windows lowers the signal ' +
             'before audioY captures it, so turn it up and use the volume ' +
             'control on the phone instead.');
    } else {
      $('notice').hidden = true;
    }
  }).catch(function () {
    $('factSource').textContent = 'audioY is not running';
  });
}

function notice(text) {
  $('noticeText').textContent = text;
  $('notice').hidden = false;
}

$('noticeFix').addEventListener('click', function () {
  var button = $('noticeFix');
  button.disabled = true;
  fetch('api/volume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume: 1.0, muted: false })
  }).then(refreshStatus).catch(function () {}).then(function () {
    button.disabled = false;
  });
});

refreshNetwork();
refreshStatus();
setInterval(refreshNetwork, 10000);
setInterval(refreshStatus, 2000);
