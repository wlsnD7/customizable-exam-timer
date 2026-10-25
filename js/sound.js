// Built-in sounds are synthesized with Web Audio, so the project ships no audio
// files. Custom audio is played through an <audio> element.
window.Sound = (function () {
  'use strict';

  var ctx = null;
  var voices = [];
  var audioEl = null;

  // [frequency Hz, start offset s, length s]
  var PATTERNS = {
    chime: [
      [880, 0, 1.2], [659.25, 0.6, 1.6],
      [880, 2.4, 1.2], [659.25, 3.0, 1.6]
    ],
    bell: [
      [523.25, 0, 1.4], [659.25, 0.35, 1.4], [783.99, 0.7, 1.4], [1046.5, 1.05, 2],
      [523.25, 2.6, 1.4], [659.25, 2.95, 1.4], [783.99, 3.3, 1.4], [1046.5, 3.65, 2.4]
    ]
  };

  function context() {
    if (!ctx) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(c, freq, t0, len) {
    var gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.35, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
    gain.connect(c.destination);

    // A quiet octave above the fundamental makes it sound more like a bell.
    [[freq, 1], [freq * 2, 0.2], [freq * 3, 0.06]].forEach(function (partial) {
      var osc = c.createOscillator();
      var g = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = partial[0];
      g.gain.value = partial[1];
      osc.connect(g).connect(gain);
      osc.start(t0);
      osc.stop(t0 + len + 0.05);
      voices.push(osc);
    });
  }

  function stop() {
    voices.forEach(function (osc) { try { osc.stop(); } catch (e) {} });
    voices = [];
    if (audioEl) {
      audioEl.pause();
      audioEl = null;
    }
  }

  function play(kind, customUrl) {
    stop();
    if (kind === 'custom') {
      if (!customUrl) return;
      audioEl = new Audio(customUrl);
      audioEl.play().catch(function () {});
      return;
    }
    var pattern = PATTERNS[kind];
    var c = pattern && context();
    if (!c) return;
    var t = c.currentTime + 0.05;
    pattern.forEach(function (n) { tone(c, n[0], t + n[1], n[2]); });
  }

  // Must run inside a click or key handler so the browser allows sound later.
  function unlock() {
    var c = context();
    if (!c) return;
    var buf = c.createBuffer(1, 1, 22050);
    var src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.start(0);
  }

  function needsGesture() {
    if (navigator.userActivation) return !navigator.userActivation.hasBeenActive;
    return !ctx || ctx.state !== 'running';
  }

  return { play: play, stop: stop, unlock: unlock, needsGesture: needsGesture };
})();
