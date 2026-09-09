/* ============================================================
 * 纸上生花 · 音效系统（WebAudio 实时合成，无外部资源）
 * SFX: 拾取 / 吸附 / 错误 / 提示 / 胜利（五声音阶琶音）
 * BGM: 慢速五声音阶"古筝拨弦"循环，按关卡调节速度与音量
 * ============================================================ */
(function (global) {
  'use strict';

  var ctx = null, muted = false;
  try { muted = localStorage.getItem('papercut_muted') === '1'; } catch (e) { /* 隐私模式忽略 */ }

  function ensure() {
    if (muted) return null;
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') {
      var p = ctx.resume();
      if (p && p.catch) p.catch(function () { /* 无用户手势时静默等待 */ });
    }
    return ctx;
  }

  /* 单音：freq 频率 / dur 时长 / opt: type, gain, delay, attack, slide */
  function tone(freq, dur, opt) {
    opt = opt || {};
    var c = ensure();
    if (!c) return;
    var t0 = c.currentTime + (opt.delay || 0);
    var osc = c.createOscillator(), g = c.createGain();
    osc.type = opt.type || 'triangle';
    if (opt.slide) {
      osc.frequency.setValueAtTime(freq, t0);
      osc.frequency.exponentialRampToValueAtTime(opt.slide, t0 + dur);
    } else {
      osc.frequency.value = freq;
    }
    var peak = (opt.gain == null) ? 0.12 : opt.gain;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (opt.attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /* 古筝式拨弦：基频 + 八度泛音快速衰减 */
  function pluck(freq, delay, gain) {
    gain = gain || 0.08;
    tone(freq, 0.55, { delay: delay, type: 'triangle', gain: gain });
    tone(freq * 2, 0.2, { delay: delay, type: 'sine', gain: gain * 0.35 });
  }

  var SFX = {
    /* 首次用户手势时调用，解锁音频上下文 */
    unlock: ensure,
    click: function () { tone(520, 0.06, { type: 'sine', gain: 0.05 }); },
    pick: function () {
      tone(392, 0.07, { type: 'sine', gain: 0.07 });
      tone(587, 0.07, { type: 'sine', gain: 0.05, delay: 0.045 });
    },
    place: function () { pluck(523.25, 0, 0.1); pluck(659.25, 0.055, 0.08); },
    wrong: function () { tone(196, 0.22, { type: 'square', gain: 0.04, slide: 147 }); },
    deselect: function () { tone(330, 0.06, { type: 'sine', gain: 0.04 }); },
    hint: function () {
      tone(880, 0.12, { type: 'sine', gain: 0.06 });
      tone(1174.7, 0.12, { type: 'sine', gain: 0.05, delay: 0.08 });
    },
    win: function () {
      /* 宫调五声音阶上行琶音 C D E G A C' */
      var seq = [523.25, 587.33, 659.25, 783.99, 880, 1046.5];
      seq.forEach(function (f, i) { pluck(f, i * 0.095, 0.1); });
      pluck(1318.5, seq.length * 0.095, 0.08);
    },
    star: function (i) { tone(1046.5 + i * 197, 0.16, { type: 'sine', gain: 0.06 }); }
  };

  /* ---------- 背景拨弦（五声音阶固定旋律 + 休止） ---------- */
  var bgm = { timer: 0, i: 0, gain: 0.028, step: 560 };
  var MELODY = [0, 2, 4, null, 3, 2, 0, null, 4, 5, 3, 1, 2, 0, null, null];
  var NOTES = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];

  function bgmTick() {
    var n = MELODY[bgm.i % MELODY.length];
    bgm.i++;
    if (n != null) pluck(NOTES[n], 0, bgm.gain);
  }

  function startBGM(level) {
    stopBGM();
    if (muted) return;
    if (level === 2) { bgm.step = 430; bgm.gain = 0.03; }       /* 青年关：轻快 */
    else if (level === 3) { bgm.step = 720; bgm.gain = 0.024; } /* 老年关：舒缓 */
    else { bgm.step = 520; bgm.gain = 0.03; }                   /* 儿童关：明亮 */
    bgm.i = 0;
    bgm.timer = setInterval(bgmTick, bgm.step);
  }

  function stopBGM() {
    if (bgm.timer) { clearInterval(bgm.timer); bgm.timer = 0; }
  }

  function setMuted(m) {
    muted = m;
    try { localStorage.setItem('papercut_muted', m ? '1' : '0'); } catch (e) { /* 忽略 */ }
    if (m) stopBGM();
  }

  global.PCAudio = {
    SFX: SFX,
    startBGM: startBGM,
    stopBGM: stopBGM,
    setMuted: setMuted,
    isMuted: function () { return muted; }
  };
})(window);
