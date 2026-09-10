/* ============================================================
 * 纸上生花 · 游戏主逻辑
 * 状态机: home(选关) → patterns(选图) → play(拼图) → 结算弹窗
 * 玩法: 从底部"纸屑盘"拖动碎片(或点选-点放)吸附到剪影位置；
 *       同组碎片(如花瓣)可互换；提示会高亮；完成触发纸屑庆祝。
 * 支持 #preview=图案ID (全摆放, 供截图验证) / #patterns=关数
 * ============================================================ */
(function (global) {
  'use strict';

  var PC = global.PCPatterns, AUD = global.PCAudio;
  var BW = PC.BOARD.w, BH = PC.BOARD.h;
  var $ = function (id) { return document.getElementById(id); };

  var canvas = $('game-canvas'), ctx = canvas.getContext('2d');
  var freeCanvas = $('free-canvas');
  var els = {
    title: $('screen-title'), menu: $('screen-menu'), bye: $('screen-bye'),
    story: $('screen-story'), free: $('screen-free'),
    home: $('screen-home'), patterns: $('screen-patterns'), play: $('screen-play'),
    levelCards: $('level-cards'), patternCards: $('pattern-cards'), levelTitle: $('level-title'),
    hudName: $('hud-name'), hudProgress: $('hud-progress'), hudTimer: $('hud-timer'),
    btnHint: $('btn-hint'), modalDone: $('modal-done'), doneTitle: $('done-title'),
    snapshot: $('snapshot'), stars: $('stars'), doneMeta: $('done-meta'),
    modalHelp: $('modal-help'), btnSound: $('btn-sound'),
    cutToolbar: $('cut-toolbar'), cutPhaseLabel: $('cut-phase-label'), btnCutNext: $('btn-cut-next'),
    menuProgress: $('menu-progress')
  };

  /* 折纸剪裁引擎实例（二、三关）与自由剪纸实例 */
  var cutplay = null, freecut = null;

  /* ---------- 工具 ---------- */
  function now() { return performance.now(); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function easeOut(k) { return 1 - Math.pow(1 - k, 3); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function fmtTime(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function shade(hex, k) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgb(' + Math.round(((n >> 16) & 255) * k) + ',' +
      Math.round(((n >> 8) & 255) * k) + ',' + Math.round((n & 255) * k) + ')';
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function buildPath(cmds) {
    var p = new Path2D();
    cmds.forEach(function (c) {
      if (c[0] === 'M') p.moveTo(c[1], c[2]);
      else if (c[0] === 'L') p.lineTo(c[1], c[2]);
      else if (c[0] === 'C') p.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
      else p.closePath();
    });
    return p;
  }
  function bboxOf(cmds) {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    cmds.forEach(function (c) {
      if (c[0] === 'Z') return;
      for (var i = 1; i < c.length; i += 2) {
        var x = c[i], y = c[i + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    });
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }

  /* ---------- 存档 ---------- */
  var SAVE_KEY = 'papercut_save_v1';
  function loadSave() {
    try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch (e) { return {}; }
  }
  function storeSave() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) { /* 忽略 */ }
  }
  var save = loadSave();

  /* ---------- 全局状态 ---------- */
  var G = {
    screen: 'title', level: 1, pattern: null, pieces: [], trayOrder: [],
    placedCount: 0, selected: null, drag: null,
    hints: 0, mistakes: 0, startT: 0, elapsed: 0, timerId: 0,
    hintPiece: null, hintUntil: 0,
    particles: [], finished: false, previewMode: false,
    playMode: 'puzzle'   /* 'puzzle'(第一关拼图) | 'cut'(二、三关折剪) */
  };

  /* ---------- 布局 ---------- */
  var view = { w: 0, h: 0, dpr: 1, board: null, tray: null, scale: 1, bx: 0, by: 0 };
  function layout() {
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (w < 10 || h < 10) return;
    view.w = w; view.h = h; view.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    var m = 12, gap = 10;
    var availH = h - m * 2 - gap;
    var trayH = clamp(availH * 0.3, 84, 175);
    view.tray = { x: m, y: h - m - trayH, w: w - m * 2, h: trayH };
    view.board = { x: m, y: m, w: w - m * 2, h: availH - trayH };
    var s = Math.min(view.board.w / BW, view.board.h / BH) * 0.985;
    view.scale = s;
    view.bx = view.board.x + (view.board.w - BW * s) / 2;
    view.by = view.board.y + (view.board.h - BH * s) / 2;
  }
  function toBoard(px, py) {
    return { x: (px - view.bx) / view.scale, y: (py - view.by) / view.scale };
  }

  /* ---------- 开局 ---------- */
  function startPattern(level, pattern) {
    if (level >= 2) { startCutLevel(level); return; }
    G.playMode = 'puzzle';
    G.level = level; G.pattern = pattern;
    G.finished = false;
    G.pieces = pattern.pieces.map(function (def) {
      return {
        id: def.id, group: def.group || null, color: def.color,
        cmds: def.cmds, path2d: buildPath(def.cmds), bbox: bboxOf(def.cmds),
        placed: false, shakeT: -1e9, anim: null, ret: null
      };
    });
    G.trayOrder = shuffle(G.pieces.slice());
    G.placedCount = 0; G.selected = null; G.drag = null;
    G.hints = 0; G.mistakes = 0; G.elapsed = 0;
    G.hintPiece = null; G.hintUntil = 0;
    G.particles.length = 0;
    G.startT = now();
    document.body.dataset.level = level;
    show('play');
    layout();
    updateHud();
    startTimer();
    if (!G.previewMode) AUD.startBGM(level);
  }

  /* ---------- 折纸剪裁关（二、三关） ---------- */
  function startCutLevel(level) {
    G.playMode = 'cut';
    G.level = level;
    G.pattern = { name: PC.LEVELS[level - 1].name };
    G.finished = false;
    document.body.dataset.level = level;
    if (!cutplay) cutplay = new global.CutPlay(canvas, {
      onFolded: function () { updateCutPhase(); },
      onAllCut: function () { updateCutPhase(); },
      onUnfolded: function (cp) { finishCutLevel(cp); }
    });
    cutplay.start(level);
    els.hudName.textContent = '第' + level + '关 · ' + PC.LEVELS[level - 1].name + ' · 剪纸窗花';
    els.hudProgress.textContent = '';
    els.hudTimer.classList.add('hidden');
    G.startT = now();
    show('play');
    cutplay.layout();
    updateCutPhase();
    if (!G.previewMode) AUD.startBGM(level);
  }

  function updateCutPhase() {
    var label = '';
    if (cutplay.state === 'fold') {
      label = '第 ① 步 · 折纸：点击虚线折痕，共 ' + cutplay.cfg.folds.length + ' 折';
    } else if (cutplay.state === 'cut') {
      var total = cutplay.lines.length;
      var done = cutplay.lines.filter(function (L) { return L.cut; }).length;
      label = '第 ② 步 · 剪纸：按住剪刀沿虚线剪（' + done + '/' + total + ' 条）';
    } else {
      label = '第 ③ 步 · 欣赏你的窗花';
    }
    els.cutPhaseLabel.textContent = label;
    els.btnCutNext.textContent = cutplay.state === 'unfold' ? '完成'
      : cutplay.state === 'fold' ? '跳过折纸' : '按住剪刀开剪';
    els.btnCutNext.disabled = cutplay.state === 'cut';
  }

  els.btnCutNext.addEventListener('click', function () {
    if (!cutplay) return;
    if (cutplay.state === 'fold') {
      cutplay.foldIdx = cutplay.cfg.folds.length;
      cutplay.foldAnim = null;
      cutplay.state = 'cut';
      AUD.SFX.fold();
      updateCutPhase();
    } else if (cutplay.state === 'unfold') {
      finishCutLevel(cutplay);
    }
  });

  function finishCutLevel(cp) {
    if (G.finished) return;
    G.finished = true;
    G.elapsed = now() - G.startT;
    AUD.stopBGM();
    AUD.SFX.win();
    var stars = cp.stars();
    var rec = save['CUT-L' + G.level] || {};
    rec.stars = Math.max(rec.stars || 0, stars);
    save['CUT-L' + G.level] = rec;
    storeSave();
    setTimeout(function () {
      els.doneTitle.textContent = G.level === 2 ? '窗花绽放！' : '岁月静好 · 完成';
      /* 快照: 展开成品 */
      var sc = els.snapshot;
      sc.width = 680; sc.height = 472;
      var c2 = sc.getContext('2d');
      c2.clearRect(0, 0, sc.width, sc.height);
      if (cp.result) {
        var size = Math.min(sc.width, sc.height) * 0.94;
        c2.drawImage(cp.result, (sc.width - size) / 2, (sc.height - size) / 2, size, size);
      }
      var html = '';
      for (var i = 0; i < 3; i++) html += '<span class="' + (i < stars ? 's-full' : 's-empty') + '">★</span>';
      els.stars.innerHTML = html;
      els.doneMeta.textContent = '偏离虚线 ' + cp.misses + ' 次 · ' +
        (stars === 3 ? '刀工精准，像老艺人！' : stars === 2 ? '手很稳，窗花很漂亮！' : '慢慢来，窗花已经成形');
      els.modalDone.classList.remove('hidden');
      for (var j = 0; j < stars; j++) {
        (function (idx) { setTimeout(function () { AUD.SFX.star(idx); }, 200 + idx * 230); })(j);
      }
    }, 900);
  }

  /* ---------- 计时(仅第二关) ---------- */
  function startTimer() {
    stopTimer();
    if (G.level !== 2 || G.previewMode) { els.hudTimer.classList.add('hidden'); return; }
    els.hudTimer.classList.remove('hidden');
    els.hudTimer.textContent = '0:00';
    G.timerId = setInterval(function () {
      if (!G.finished) {
        G.elapsed = now() - G.startT;
        els.hudTimer.textContent = fmtTime(G.elapsed);
      }
    }, 400);
  }
  function stopTimer() { if (G.timerId) { clearInterval(G.timerId); G.timerId = 0; } }

  /* ---------- HUD ---------- */
  function updateHud() {
    var lv = PC.LEVELS[G.level - 1];
    els.hudName.textContent = '第' + G.level + '关 · ' + G.pattern.name;
    els.hudProgress.textContent = G.placedCount + ' / ' + G.pieces.length + ' 片';
  }

  /* ---------- 托盘布局 ---------- */
  function trayCells() {
    var list = G.trayOrder.filter(function (p) { return !p.placed; });
    var n = Math.max(list.length, 1);
    var tr = view.tray;
    var top = tr.y + 26, contentH = tr.h - 34;
    var cellW = tr.w / n;
    return list.map(function (p, i) {
      var k = Math.min(cellW * 0.92 / p.bbox.w, contentH * 0.88 / p.bbox.h);
      return {
        piece: p, k: k,
        cx: tr.x + cellW * (i + 0.5), cy: top + contentH / 2,
        w: cellW
      };
    });
  }
  function cellOf(piece, cells) {
    for (var i = 0; i < cells.length; i++) if (cells[i].piece === piece) return cells[i];
    return null;
  }
  function trayPieceAt(p) {
    var cells = trayCells(), tr = view.tray;
    for (var i = cells.length - 1; i >= 0; i--) {
      var c = cells[i];
      if (Math.abs(p.x - c.cx) < c.w / 2 && p.y > tr.y && p.y < tr.y + tr.h) return c.piece;
    }
    return null;
  }

  /* ---------- 放置判定 ---------- */
  function accepts(piece, slot) {
    return slot === piece || (!!piece.group && piece.group === slot.group);
  }
  function snapRadius(slot) {
    var base = Math.max(slot.bbox.w, slot.bbox.h) * 0.42 + 26;
    return base * (G.level === 1 ? 1.25 : G.level === 3 ? 1.45 : 1);
  }
  function nearestEmpty(b, factor) {
    var best = null, bestD = 1e9;
    G.pieces.forEach(function (s) {
      if (s.placed) return;
      var d = Math.hypot(s.bbox.cx - b.x, s.bbox.cy - b.y);
      if (d < bestD) { bestD = d; best = s; }
    });
    if (best && bestD <= snapRadius(best) * (factor || 1)) return { piece: best, d: bestD };
    return null;
  }

  /* ---------- 放置 / 失误 / 回托盘 ---------- */
  function swapGeom(a, b) {
    var t;
    t = a.cmds; a.cmds = b.cmds; b.cmds = t;
    t = a.path2d; a.path2d = b.path2d; b.path2d = t;
    t = a.bbox; a.bbox = b.bbox; b.bbox = t;
  }
  function placePiece(piece, slot, fx, fy) {
    if (piece !== slot) swapGeom(piece, slot);   /* 同组互换: 落位渲染采用目标剪影几何 */
    piece.placed = true;
    piece.ret = null;
    G.placedCount++;
    piece.anim = { t0: now(), fx: fx, fy: fy, dur: 150 };
    if (G.selected === piece) G.selected = null;
    if (G.hintPiece === piece) { G.hintPiece = null; G.hintUntil = 0; }
    if (!G.previewMode) {
      AUD.SFX.place();
      sparkleAt(view.bx + piece.bbox.cx * view.scale, view.by + piece.bbox.cy * view.scale);
    }
    updateHud();
    if (G.placedCount === G.pieces.length) finishPattern();
  }
  function mistake(slot, piece, p) {
    G.mistakes++;
    slot.shakeT = now();
    if (!G.previewMode) AUD.SFX.wrong();
    returnToTray(piece, p.x, p.y);
  }
  function returnToTray(piece, fx, fy) {
    piece.ret = { t0: now(), fx: fx, fy: fy, dur: 220 };
    if (G.selected === piece) G.selected = null;
  }
  function tryDrop(piece, p) {
    var b = toBoard(p.x, p.y);
    var near = nearestEmpty(b, 1);
    if (!near) { returnToTray(piece, p.x, p.y); return; }
    if (accepts(piece, near.piece)) placePiece(piece, near.piece, p.x, p.y);
    else mistake(near.piece, piece, p);
  }

  /* ---------- 提示 ---------- */
  function hint() {
    if (G.finished) return;
    var left = G.pieces.filter(function (p) { return !p.placed; });
    if (!left.length) return;
    G.hintPiece = left[Math.floor(Math.random() * left.length)];
    G.hintUntil = now() + 3600;
    G.hints++;
    AUD.SFX.hint();
  }

  /* ---------- 完成 ---------- */
  function starsOf() {
    if (G.mistakes === 0 && G.hints === 0) return 3;
    if (G.mistakes + G.hints <= 3) return 2;
    return 1;
  }
  function finishPattern() {
    G.finished = true;
    G.elapsed = now() - G.startT;
    if (G.level === 2 && !G.previewMode) els.hudTimer.textContent = fmtTime(G.elapsed);
    AUD.stopBGM();
    if (G.previewMode) return;
    AUD.SFX.win();
    confettiBurst();
    var stars = starsOf();
    var rec = save[G.pattern.id] || {};
    rec.stars = Math.max(rec.stars || 0, stars);
    if (G.level === 2) rec.best = rec.best ? Math.min(rec.best, G.elapsed) : G.elapsed;
    save[G.pattern.id] = rec;
    storeSave();
    setTimeout(function () { showDone(stars); }, 1250);
  }

  function showDone(stars) {
    var lv = G.level, meta = [];
    els.doneTitle.textContent = lv === 1 ? '太棒了！' : lv === 2 ? '作品完成！' : '岁月静好 · 完成';
    renderArtwork(els.snapshot, G.pattern);
    var html = '';
    for (var i = 0; i < 3; i++) html += '<span class="' + (i < stars ? 's-full' : 's-empty') + '">★</span>';
    els.stars.innerHTML = html;
    if (lv === 2) {
      meta.push('用时 ' + fmtTime(G.elapsed));
      var best = save[G.pattern.id] && save[G.pattern.id].best;
      if (best != null) meta.push(best <= G.elapsed + 1 ? '新纪录！' : '最佳 ' + fmtTime(best));
    }
    meta.push('失误 ' + G.mistakes + ' · 提示 ' + G.hints);
    if (lv === 1) meta.unshift(G.mistakes === 0 && G.hints === 0 ? '一次就拼好啦！' : '小手动一动，下次更快！');
    if (lv === 3) meta.unshift('不慌不忙，静心完成');
    els.doneMeta.textContent = meta.join(' · ');
    els.modalDone.classList.remove('hidden');
    for (var j = 0; j < stars; j++) {
      (function (idx) { setTimeout(function () { AUD.SFX.star(idx); }, 200 + idx * 230); })(j);
    }
  }

  /* ---------- 粒子 ---------- */
  function confettiBurst() {
    var colors = ['#c8341f', '#e0526e', '#e0a230', '#f2c94c', '#9c2113'];
    for (var i = 0; i < 130; i++) {
      G.particles.push({
        x: view.board.x + Math.random() * view.board.w,
        y: view.board.y - 30 - Math.random() * 80,
        vx: (Math.random() - 0.5) * 1.8, vy: 1 + Math.random() * 2.6,
        w: 5 + Math.random() * 7, h: 8 + Math.random() * 9,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.25,
        color: colors[Math.floor(Math.random() * colors.length)],
        age: 0, life: 2200 + Math.random() * 1000, shape: 'rect'
      });
    }
  }
  function sparkleAt(x, y) {
    var colors = ['#e0a230', '#c8341f', '#f2c94c'];
    for (var i = 0; i < 10; i++) {
      G.particles.push({
        x: x, y: y,
        vx: (Math.random() - 0.5) * 3.4, vy: (Math.random() - 0.5) * 3.4 - 0.8,
        w: 3.5, h: 3.5, rot: 0, vr: 0,
        color: colors[Math.floor(Math.random() * colors.length)],
        age: 0, life: 520, shape: 'dot'
      });
    }
  }
  function drawParticles(dt) {
    if (!G.particles.length) return;
    G.particles = G.particles.filter(function (p) { return (p.age += dt) < p.life; });
    G.particles.forEach(function (p) {
      var u = dt / 16.6;
      p.x += p.vx * u; p.y += p.vy * u; p.vy += 0.055 * u; p.rot += p.vr * u;
      ctx.save();
      ctx.globalAlpha = 1 - p.age / p.life;
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'dot') { ctx.beginPath(); ctx.arc(0, 0, p.w, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
  }

  /* ---------- 绘制 ---------- */
  function drawPieceAt(piece, cx, cy, scale, opts) {
    opts = opts || {};
    ctx.save();
    ctx.translate(cx - piece.bbox.cx * scale, cy - piece.bbox.cy * scale);
    ctx.scale(scale, scale);
    if (opts.shadow) {
      ctx.shadowColor = 'rgba(70, 12, 5, 0.35)';
      ctx.shadowBlur = 18; ctx.shadowOffsetY = 7;
    }
    ctx.fillStyle = piece.color;
    ctx.fill(piece.path2d, 'evenodd');
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.lineWidth = (opts.lw || 2.2) / scale;
    ctx.strokeStyle = shade(piece.color, 0.72);
    ctx.stroke(piece.path2d);
    ctx.restore();
  }

  function drawSlot(piece, state) {
    ctx.save();
    ctx.translate(view.bx, view.by);
    ctx.scale(view.scale, view.scale);
    var t = now(), sh = t - piece.shakeT;
    if (sh < 400) ctx.translate(Math.sin(sh * 0.09) * 5 * (1 - sh / 400), 0);
    if (state === 'hint' || state === 'target') {
      var pulse = 0.5 + 0.5 * Math.sin(t * 0.011);
      ctx.fillStyle = 'rgba(212,160,23,' + (state === 'target' ? 0.22 : 0.08 + 0.14 * pulse) + ')';
      ctx.strokeStyle = 'rgba(212,160,23,0.9)';
      ctx.lineWidth = 3.6 / view.scale;
      ctx.setLineDash([]);
    } else if (state === 'shake') {
      ctx.fillStyle = 'rgba(200,52,30,0.14)';
      ctx.strokeStyle = 'rgba(200,52,30,0.85)';
      ctx.lineWidth = 2.8 / view.scale;
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = 'rgba(200,52,30,0.06)';
      ctx.strokeStyle = 'rgba(156,33,19,0.5)';
      ctx.lineWidth = 2 / view.scale;
      ctx.setLineDash([7, 6]);
    }
    ctx.fill(piece.path2d, 'evenodd');
    ctx.stroke(piece.path2d);
    ctx.restore();
  }

  function drawPlaced(piece) {
    var sc = view.scale;
    var cx = view.bx + piece.bbox.cx * sc, cy = view.by + piece.bbox.cy * sc;
    if (piece.anim) {
      var k = clamp((now() - piece.anim.t0) / piece.anim.dur, 0, 1);
      var e = easeOut(k);
      cx = lerp(piece.anim.fx, cx, e); cy = lerp(piece.anim.fy, cy, e);
      sc = view.scale * (1 + 0.07 * (1 - e));
      if (k >= 1) piece.anim = null;
    }
    drawPieceAt(piece, cx, cy, sc, { lw: 2.2 });
  }

  function drawTray() {
    var tr = view.tray;
    ctx.fillStyle = 'rgba(253, 247, 232, 0.94)';
    roundRect(ctx, tr.x, tr.y, tr.w, tr.h, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(156,33,19,0.5)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([6, 5]);
    roundRect(ctx, tr.x, tr.y, tr.w, tr.h, 12);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(156,33,19,0.5)';
    ctx.font = (G.level === 3 ? '17px' : '13px') + ' KaiTi, STKaiti, serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('剪 纸 碎 片', tr.x + 12, tr.y + 7);

    var cells = trayCells();
    cells.forEach(function (cell) {
      var p = cell.piece;
      if (p.ret || (G.drag && G.drag.piece === p)) return;
      drawTrayPiece(p, cell, cells);
    });
    /* 返回托盘途中的碎片 */
    G.pieces.forEach(function (p) {
      if (!p.ret) return;
      var cell = cellOf(p, cells);
      if (!cell) { p.ret = null; return; }
      var k = clamp((now() - p.ret.t0) / p.ret.dur, 0, 1), e = easeOut(k);
      var sc = lerp(view.scale * 1.07, cell.k, e);
      drawPieceAt(p, lerp(p.ret.fx, cell.cx, e), lerp(p.ret.fy, cell.cy, e), sc, { lw: 2 });
      if (k >= 1) p.ret = null;
    });
  }
  function drawTrayPiece(p, cell, cells) {
    var t = now();
    var sel = G.selected === p;
    var hinted = G.hintPiece === p && t < G.hintUntil;
    var bob = sel ? Math.sin(t * 0.006) * 3 : 0;
    var sc = cell.k * (sel ? 1.1 : 1);
    if (sel || hinted) {
      ctx.save();
      ctx.strokeStyle = sel ? 'rgba(212,160,23,0.95)' : 'rgba(212,160,23,' + (0.5 + 0.4 * Math.sin(t * 0.011)) + ')';
      ctx.lineWidth = sel ? 3 : 2.4;
      ctx.setLineDash(sel ? [] : [7, 6]);
      ctx.beginPath();
      ctx.arc(cell.cx, cell.cy + bob, Math.max(cell.w * 0.36, 34), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    drawPieceAt(p, cell.cx, cell.cy + bob, sc, { lw: 2, shadow: sel });
  }

  function draw() {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, view.w, view.h);

    /* 画板"宣纸" */
    var b = view.board;
    ctx.fillStyle = '#fffdf4';
    roundRect(ctx, b.x, b.y, b.w, b.h, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(156,33,19,0.45)';
    ctx.lineWidth = 2;
    roundRect(ctx, b.x, b.y, b.w, b.h, 14);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(156,33,19,0.28)';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([7, 6]);
    roundRect(ctx, b.x + 6, b.y + 6, b.w - 12, b.h - 12, 10);
    ctx.stroke();
    ctx.setLineDash([]);

    /* 拖拽时计算吸附目标 */
    var dropTarget = null;
    if (G.drag && G.drag.moved) {
      var bd = toBoard(G.drag.x, G.drag.y);
      var near = nearestEmpty(bd, 1);
      if (near && accepts(G.drag.piece, near.piece)) dropTarget = near.piece;
    }

    /* 剪影(未放置) */
    G.pieces.forEach(function (p) {
      if (p.placed) return;
      var state = '';
      if (now() - p.shakeT < 400) state = 'shake';
      else if (p === dropTarget) state = 'target';
      else if (G.hintPiece === p && now() < G.hintUntil) state = 'hint';
      drawSlot(p, state);
    });

    /* 已放置(按图案顺序, 保证层叠正确) */
    G.pieces.forEach(function (p) { if (p.placed) drawPlaced(p); });

    drawTray();

    /* 拖拽中的碎片 */
    if (G.drag) {
      drawPieceAt(G.drag.piece, G.drag.x - G.drag.ox, G.drag.y - G.drag.oy,
        view.scale * 1.07, { lw: 2.4, shadow: true });
    }

    drawParticles(DT);

    if (G.previewMode) {
      ctx.fillStyle = 'rgba(156,33,19,0.4)';
      ctx.font = '14px KaiTi, STKaiti, serif';
      ctx.textBaseline = 'bottom';
      ctx.fillText('预 览 模 式 · 碎片已全部就位', b.x + 14, b.y + b.h - 12);
    }
  }

  /* ---------- 输入 ---------- */
  function posOf(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  canvas.addEventListener('pointerdown', function (e) {
    if (G.screen !== 'play' || G.playMode !== 'puzzle' || G.finished) return;
    var p = posOf(e);
    var tp = trayPieceAt(p);
    if (tp) {
      e.preventDefault();
      var cells = trayCells(), cell = cellOf(tp, cells);
      var ox = p.x - (cell ? cell.cx : p.x), oy = p.y - (cell ? cell.cy : p.y);
      G.drag = { piece: tp, x: p.x, y: p.y, ox: ox, oy: oy, moved: false, sx: p.x, sy: p.y };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    } else if (G.selected) {
      var near = nearestEmpty(toBoard(p.x, p.y), 1.15);
      if (near) {
        if (accepts(G.selected, near.piece)) {
          var c = cellOf(G.selected, trayCells());
          placePiece(G.selected, near.piece, c ? c.cx : p.x, c ? c.cy : p.y);
        } else {
          mistake(near.piece, G.selected, p);
        }
      } else {
        G.selected = null;
        AUD.SFX.deselect();
      }
    }
  });
  canvas.addEventListener('pointermove', function (e) {
    if (G.playMode !== 'puzzle') return;
    var p = posOf(e);
    if (G.drag) {
      if (Math.hypot(p.x - G.drag.sx, p.y - G.drag.sy) > 7) G.drag.moved = true;
      G.drag.x = p.x; G.drag.y = p.y;
    } else if (G.screen === 'play') {
      canvas.style.cursor = trayPieceAt(p) ? 'grab' : 'default';
    }
  });
  function endDrag(e) {
    if (!G.drag) return;
    var d = G.drag, p = posOf(e);
    G.drag = null;
    canvas.style.cursor = 'default';
    if (!d.moved) {
      /* 视为点选 */
      if (G.selected === d.piece) { G.selected = null; AUD.SFX.deselect(); }
      else { G.selected = d.piece; AUD.SFX.pick(); }
      return;
    }
    /* 用碎片视觉中心判定落点 */
    tryDrop(d.piece, { x: d.x - d.ox, y: d.y - d.oy });
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /* ---------- 屏幕切换 ---------- */
  var SCREENS = ['title', 'menu', 'story', 'home', 'patterns', 'play', 'free', 'bye'];
  function show(name) {
    G.screen = name;
    els.title.classList.toggle('active', name === 'title');
    els.menu.classList.toggle('active', name === 'menu');
    els.story.classList.toggle('active', name === 'story');
    els.home.classList.toggle('active', name === 'home');
    els.patterns.classList.toggle('active', name === 'patterns');
    els.play.classList.toggle('active', name === 'play');
    els.free.classList.toggle('active', name === 'free');
    els.bye.classList.toggle('active', name === 'bye');
    if (name === 'play') {
      els.cutToolbar.classList.toggle('hidden', G.playMode !== 'cut');
    } else {
      els.cutToolbar.classList.add('hidden');
    }
    if (name !== 'play') { AUD.stopBGM(); stopTimer(); }
  }

  /* ---------- 成品渲染(卡片预览/结算快照共用) ---------- */
  function renderArtwork(cnv, pattern) {
    var c2 = cnv.getContext('2d');
    var w = cnv.width, h = cnv.height;
    c2.clearRect(0, 0, w, h);
    var s = Math.min(w / BW, h / BH) * 0.96;
    c2.save();
    c2.translate((w - BW * s) / 2, (h - BH * s) / 2);
    c2.scale(s, s);
    pattern.pieces.forEach(function (def) {
      var p = buildPath(def.cmds);
      c2.fillStyle = def.color;
      c2.fill(p, 'evenodd');
      c2.lineWidth = 2.4 / s;
      c2.strokeStyle = shade(def.color, 0.72);
      c2.stroke(p);
    });
    c2.restore();
  }

  /* ---------- 主界面(选关) ---------- */
  function buildHome() {
    els.levelCards.innerHTML = '';
    PC.LEVELS.forEach(function (lv) {
      var pats = PC.PATTERNS.filter(function (p) { return p.level === lv.level; });
      var done = pats.filter(function (p) { return save[p.id] && save[p.id].stars > 0; }).length;
      if (lv.level >= 2) {
        var cutRec = save['CUT-L' + lv.level];
        if (cutRec && cutRec.stars > 0) done = 1;
      }
      var dots = lv.level === 2 ? '●●●' : lv.level === 3 ? '●●○' : '●○○';
      var total = lv.level === 1 ? pats.length : 1;
      var card = document.createElement('div');
      card.className = 'level-card lv' + lv.level;
      card.innerHTML =
        '<span class="lv-tag">第' + lv.level + '关 · ' + lv.tag + '</span>' +
        '<h3>' + lv.name + '</h3>' +
        '<p class="lv-desc">' + lv.desc + '</p>' +
        '<div class="lv-preview"><canvas width="450" height="320"></canvas></div>' +
        '<div class="lv-meta"><span class="lv-dots">' + dots + '</span>' +
        '<span class="lv-prog">' + (done > 0 ? '已完成 ' + done + '/' + total : '尚未开始') + '</span></div>';
      renderArtwork(card.querySelector('canvas'), pats[lv.previewIndex]);
      card.addEventListener('click', function () {
        AUD.SFX.click();
        if (lv.level >= 2) {
          G.previewMode = false;
          startCutLevel(lv.level);
        } else {
          buildPatterns(lv.level);
          show('patterns');
        }
      });
      els.levelCards.appendChild(card);
    });
  }

  /* ---------- 图案选择 ---------- */
  function buildPatterns(level) {
    var lv = PC.LEVELS[level - 1];
    els.levelTitle.innerHTML = '第' + level + '关 · ' + lv.name +
      ' <small>' + lv.tag + ' · ' + lv.desc + '</small>';
    els.patternCards.innerHTML = '';
    PC.PATTERNS.filter(function (p) { return p.level === level; }).forEach(function (pt) {
      var rec = save[pt.id];
      var starsHtml = '';
      for (var i = 0; i < 3; i++) {
        starsHtml += '<span class="' + (rec && rec.stars > i ? 'done' : 'empty') + '">★</span>';
      }
      var card = document.createElement('div');
      card.className = 'pattern-card';
      card.innerHTML = '<canvas width="450" height="320"></canvas>' +
        '<h4>' + pt.name + '</h4>' +
        '<div class="p-stars">' + (rec && rec.stars ? starsHtml : '<span class="empty">未完成</span>') + '</div>';
      renderArtwork(card.querySelector('canvas'), pt);
      card.addEventListener('click', function () {
        AUD.SFX.click();
        G.previewMode = false;
        startPattern(level, pt);
      });
      els.patternCards.appendChild(card);
    });
  }

  /* ---------- 结算按钮 ---------- */
  function patternListOf(level) {
    return PC.PATTERNS.filter(function (p) { return p.level === level; });
  }
  $('btn-replay').addEventListener('click', function () {
    els.modalDone.classList.add('hidden');
    AUD.SFX.click();
    if (G.playMode === 'cut') {
      G.previewMode = false;
      startCutLevel(G.level);
      return;
    }
    G.previewMode = false;
    startPattern(G.level, G.pattern);
  });
  $('btn-next').addEventListener('click', function () {
    els.modalDone.classList.add('hidden');
    AUD.SFX.click();
    if (G.playMode === 'cut') {
      show('home');
      return;
    }
    var list = patternListOf(G.level);
    var idx = list.indexOf(G.pattern);
    if (idx >= 0 && idx + 1 < list.length) {
      G.previewMode = false;
      startPattern(G.level, list[idx + 1]);
    } else {
      buildPatterns(G.level);
      show('patterns');
    }
  });

  /* ---------- 其他按钮 ---------- */
  $('btn-back-home').addEventListener('click', function () { AUD.SFX.click(); show('home'); });
  $('btn-back-patterns').addEventListener('click', function () {
    AUD.SFX.click();
    if (G.playMode === 'cut') { show('home'); return; }
    buildPatterns(G.level);
    show('patterns');
  });
  els.btnHint.addEventListener('click', function () { hint(); });
  $('btn-help').addEventListener('click', function () {
    AUD.SFX.click();
    els.modalHelp.classList.remove('hidden');
  });
  $('btn-help-close').addEventListener('click', function () {
    AUD.SFX.click();
    els.modalHelp.classList.add('hidden');
  });
  $('btn-reset').addEventListener('click', function () {
    if (confirm('确定要清空全部进度与星级吗？')) {
      save = {};
      storeSave();
      buildHome();
      updateMenuProgress();
      els.modalHelp.classList.add('hidden');
      show('title');
    }
  });
  function updateSoundBtn() { els.btnSound.classList.toggle('muted', AUD.isMuted()); }
  els.btnSound.addEventListener('click', function () {
    AUD.setMuted(!AUD.isMuted());
    updateSoundBtn();
    if (!AUD.isMuted()) {
      AUD.SFX.click();
      if (G.screen === 'play' && !G.finished && !G.previewMode) AUD.startBGM(G.level);
    }
  });

  /* ---------- 主循环 ---------- */
  var lastT = 0, DT = 16;
  function frame(t) {
    requestAnimationFrame(frame);
    DT = clamp(t - lastT, 8, 40); lastT = t;
    if (G.screen === 'play') {
      if (G.playMode === 'cut' && cutplay) {
        if (canvas.clientWidth !== cutplay.V.w || canvas.clientHeight !== cutplay.V.h) cutplay.layout();
        cutplay.frame(DT);
      } else {
        if (canvas.clientWidth !== view.w || canvas.clientHeight !== view.h) layout();
        if (!view.board) return;
        draw();
      }
    } else if (G.screen === 'free' && freecut) {
      if (freeCanvas.clientWidth !== freecut.V.w || freeCanvas.clientHeight !== freecut.V.h) freecut.layout();
      freecut.frame(DT);
    }
  }

  /* ---------- 预览模式(自动化截图用) ---------- */
  function enterPreview(pattern) {
    G.previewMode = true;
    startPattern(pattern.level, pattern);
    G.pieces.forEach(function (p) { p.placed = true; });
    G.placedCount = G.pieces.length;
    G.finished = true;
    updateHud();
  }

  /* ---------- 自动游玩(自动化验证用): #auto=图案ID ---------- */
  function autoPlay(pattern) {
    startPattern(pattern.level, pattern);
    var i = 0;
    var timer = setInterval(function () {
      if (G.finished) { clearInterval(timer); return; }
      var left = G.pieces.filter(function (p) { return !p.placed; });
      if (!left.length) { clearInterval(timer); return; }
      var piece = left[i % left.length];
      var slots = G.pieces.filter(function (s) { return !s.placed && accepts(piece, s); });
      if (!slots.length) { clearInterval(timer); return; }
      var slot = slots[i % slots.length];   /* 有分组时会触发几何互换 */
      placePiece(piece, slot, view.bx + slot.bbox.cx * view.scale,
        view.by + slot.bbox.cy * view.scale);
      i++;
    }, 320);
  }

  /* ---------- 开始界面 / 主菜单 / 故事 / 自由剪纸 / 退出 ---------- */
  function updateMenuProgress() {
    var total = PC.PATTERNS.length + 2;   /* 9 拼图图案 + 2 折剪关 */
    var done = 0;
    PC.PATTERNS.forEach(function (p) { if (save[p.id] && save[p.id].stars > 0) done++; });
    [2, 3].forEach(function (lv) { if (save['CUT-L' + lv] && save['CUT-L' + lv].stars > 0) done++; });
    els.menuProgress.textContent = done > 0
      ? '进度：已点亮 ' + done + ' / ' + total + ' 个作品 ★'
      : '还没有作品，从「故事背景」开始了解剪纸吧';
  }

  $('btn-enter').addEventListener('click', function () {
    AUD.SFX.click();
    updateMenuProgress();
    show('menu');
  });
  $('menu-story').addEventListener('click', function () {
    AUD.SFX.click();
    show('story');
  });
  $('menu-play').addEventListener('click', function () {
    AUD.SFX.click();
    show('home');
  });
  $('menu-free').addEventListener('click', function () {
    AUD.SFX.click();
    enterFreeCut();
  });
  $('menu-exit').addEventListener('click', function () {
    AUD.SFX.click();
    AUD.stopBGM();
    show('bye');
  });
  $('btn-back-menu1').addEventListener('click', function () { AUD.SFX.click(); show('menu'); });
  $('btn-back-menu2').addEventListener('click', function () { AUD.SFX.click(); show('menu'); });
  $('btn-story-start').addEventListener('click', function () {
    AUD.SFX.click();
    show('home');
  });
  $('btn-bye-close').addEventListener('click', function () {
    AUD.SFX.click();
    window.close();
    setTimeout(function () {
      els.bye.querySelector('.bye-text').innerHTML =
        '浏览器不允许网页自动关闭<br>请直接关闭这个标签页，或点「再玩一会儿」';
    }, 200);
  });
  $('btn-bye-back').addEventListener('click', function () {
    AUD.SFX.click();
    updateMenuProgress();
    show('menu');
  });
  $('btn-home').addEventListener('click', function () {
    AUD.SFX.click();
    AUD.stopBGM();
    updateMenuProgress();
    show('menu');
  });

  /* ---------- 自由剪纸 ---------- */
  function enterFreeCut() {
    document.body.dataset.level = '';
    if (!freecut) {
      freecut = new global.FreeCut(freeCanvas);
      bindFreeCutUI();
    }
    show('free');
    freecut.layout();
    freecut.frame(16);
  }
  function bindFreeCutUI() {
    document.querySelectorAll('.fold-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        if (freecut.addFold(b.dataset.fold)) updateFreeUI();
      });
    });
    $('btn-tool-cut').addEventListener('click', function () {
      freecut.tool = 'cut'; updateFreeUI();
    });
    $('btn-tool-punch').addEventListener('click', function () {
      freecut.tool = 'punch'; updateFreeUI();
    });
    $('btn-undo').addEventListener('click', function () { freecut.undo(); });
    $('btn-unfold').addEventListener('click', function () {
      if (freecut.unfold()) updateFreeUI();
    });
    $('btn-new-paper').addEventListener('click', function () {
      freecut.reset(); updateFreeUI();
    });
    $('btn-save-art').addEventListener('click', function () { freecut.saveImage(); });
  }
  function updateFreeUI() {
    $('btn-tool-cut').classList.toggle('active', freecut.tool === 'cut');
    $('btn-tool-punch').classList.toggle('active', freecut.tool === 'punch');
    $('btn-unfold').disabled = freecut.unfolded || !freecut.strokes.length;
  }

  /* ---------- 启动 ---------- */
  function init() {
    updateSoundBtn();
    document.addEventListener('pointerdown', function () { AUD.SFX.unlock(); },
      { once: true, capture: true });
    buildHome();
    drawStoryArt();

    var seen = false;
    try { seen = localStorage.getItem('papercut_seen') === '1'; } catch (e) { /* 忽略 */ }
    if (!seen) {
      els.modalHelp.classList.remove('hidden');
      try { localStorage.setItem('papercut_seen', '1'); } catch (e) { /* 忽略 */ }
    }

    /* URL hash 模式（供无头截图验证） */
    var h = location.hash || '';
    var mPrev = h.match(/preview=([\w\u4e00-\u9fa5-]+)/);
    var mAuto = h.match(/auto=([\w\u4e00-\u9fa5-]+)/);
    var mPat = h.match(/patterns=(\d)/);
    var mCut = h.match(/cut=(\d)(?::(\w+))?/);
    var mFree = h.match(/free/);
    var mMenu = h.match(/menu/);
    var mStory = h.match(/story/);
    if (mPrev || mAuto) {
      var key = (mAuto || mPrev)[1];
      var pt = PC.PATTERNS.filter(function (x) { return x.id === key || x.name === key; })[0];
      if (pt) {
        if (mAuto) autoPlay(pt);
        else enterPreview(pt);
        requestAnimationFrame(frame);
        return;
      }
    }
    if (mCut) {
      var lvCut = parseInt(mCut[1], 10);
      if (lvCut >= 2 && lvCut <= 3) {
        G.previewMode = !!mCut[2];
        startCutLevel(lvCut);
        if (mCut[2]) cutplay.debugSkip(mCut[2]);
        requestAnimationFrame(frame);
        return;
      }
    }
    if (mFree) { enterFreeCut(); requestAnimationFrame(frame); return; }
    if (mMenu) { updateMenuProgress(); show('menu'); requestAnimationFrame(frame); return; }
    if (mStory) { show('story'); requestAnimationFrame(frame); return; }
    if (mPat) {
      var lv = parseInt(mPat[1], 10);
      if (lv >= 1 && lv <= 3) {
        buildPatterns(lv);
        show('patterns');
        requestAnimationFrame(frame);
        return;
      }
    }
    show('title');
    requestAnimationFrame(frame);
  }

  /* ---------- 故事页配图 ---------- */
  function drawStoryArt() {
    [['story-art-1', 'L2-2'], ['story-art-2', 'L1-1'], ['story-art-3', 'L3-2']].forEach(function (pair) {
      var cnv = $(pair[0]);
      if (!cnv) return;
      var pat = PC.PATTERNS.filter(function (x) { return x.id === pair[1]; })[0];
      if (!pat) return;
      var c2 = cnv.getContext('2d');
      c2.clearRect(0, 0, cnv.width, cnv.height);
      var s = Math.min(cnv.width / BW, cnv.height / BH) * 0.92;
      c2.save();
      c2.translate((cnv.width - BW * s) / 2, (cnv.height - BH * s) / 2);
      c2.scale(s, s);
      pat.pieces.forEach(function (def) {
        var p = buildPath(def.cmds);
        c2.fillStyle = def.color;
        c2.fill(p, 'evenodd');
        c2.lineWidth = 2.2 / s;
        c2.strokeStyle = shade(def.color, 0.72);
        c2.stroke(p);
      });
      c2.restore();
    });
  }
  init();
})(window);
