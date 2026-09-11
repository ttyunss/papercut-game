/* ============================================================
 * 纸上生花 · 折纸剪裁引擎（第二/三关玩法）
 * 阶段: fold(折纸: 点折痕→翻折) → cut(按住剪刀沿虚线剪) → unfold(展开窗花)
 * 数据: PCPatterns.FOLDCUT.levels[level]
 * 渲染到主游戏 canvas（game.js 提供画布与布局回调）
 * ============================================================ */
(function (global) {
  'use strict';

  var PC = global.PCPatterns, AUD = global.PCAudio;
  var P = PC.FOLDCUT.PAPER;

  /* ---------- 工具 ---------- */
  function now() { return performance.now(); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function easeOut(k) { return 1 - Math.pow(1 - k, 3); }
  function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }

  /* ---------- 折后保留区域: 用"真实折纸"逐步缩小 ----------
   * v: x∈[x0, xm] 保留左半  h: y∈[y0, ym] 保留上半
   * d: 在当前矩形上沿对角线(左上→右下的反对角)折, 保留 x+y ≤ x1 的三角
   * 返回 {x0,y0,x1,y1,diag} diag=true 时区域为三角 (x0,y0)-(x1,y0)-(x0,y1) */
  function foldRegion(folds) {
    var r = { x0: 0, y0: 0, x1: P, y1: P, diag: false };
    folds.forEach(function (f) {
      if (f === 'v') r.x1 = (r.x0 + r.x1) / 2;
      else if (f === 'h') r.y1 = (r.y0 + r.y1) / 2;
      else if (f === 'd') r.diag = true;   /* v,h 之后纸为 230², d 折保留 x+y≤230 */
    });
    return r;
  }

  function CutPlay(canvas, host) {
    var self = this;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.host = host;   /* game.js 提供: layout()/onFinish()/mode 接口 */
    this.dpr = 1;
    this.V = { w: 0, h: 0, cx: 0, cy: 0, k: 1 };   /* 纸张中心/缩放 */

    this.state = 'fold';   /* fold | cut | unfold */
    this.level = 2;
    this.cfg = null;
    this.foldIdx = 0;      /* 已完成的折数 */
    this.foldAnim = null;  /* {t0, dur, kind} */
    this.lines = [];       /* {pts, closed, done:[0..n], cut:false} */
    this.scraps = [];      /* 纸屑粒子 */
    this.scissor = null;   /* {x,y,down, target, seg} */
    this.misses = 0;
    this.unfoldAnim = null;
    this.result = null;    /* 展开后的成品 canvas */
    this.finished = false;

    canvas.addEventListener('pointerdown', function (e) { self.onDown(e); });
    canvas.addEventListener('pointermove', function (e) { self.onMove(e); });
    canvas.addEventListener('pointerup', function (e) { self.onUp(e); });
    canvas.addEventListener('pointercancel', function (e) { self.onUp(e); });
  }

  /* ---------- 局部坐标 ⇄ 画布坐标 ----------
   * 以"折后区域中心"为屏幕中心: 区域随折叠缩小, 视图同步放大, 始终居中 */
  CutPlay.prototype.px = function (x, y) {
    var v = this.viewInfo();
    return { x: this.V.cx + (x - v.cx) * v.s, y: this.V.cy + (y - v.cy) * v.s };
  };
  CutPlay.prototype.pv = function (px, py) {
    var v = this.viewInfo();
    return { x: (px - this.V.cx) / v.s + v.cx, y: (py - this.V.cy) / v.s + v.cy };
  };
  CutPlay.prototype.viewInfo = function () {
    var r = this.regionNow();
    var w = r.x1 - r.x0, h = r.y1 - r.y0;
    /* 三角形视觉重心比几何中心更靠直角处 */
    var cx = r.diag ? r.x0 + w * 0.34 : r.x0 + w / 2;
    var cy = r.diag ? r.y0 + h * 0.34 : r.y0 + h / 2;
    var m = r.diag ? (w + h) * 0.62 : Math.max(w, h) * 1.02;
    var s = Math.min(this.V.w, this.V.h) * 0.72 / m;
    return { s: s, cx: cx, cy: cy };
  };

  /* ---------- 开局 ---------- */
  CutPlay.prototype.start = function (level) {
    this.level = level;
    this.cfg = PC.FOLDCUT.levels[level];
    this.state = 'fold';
    this.foldIdx = 0;
    this.foldAnim = null;
    this.lines = this.cfg.lines.map(function (L) {
      return { pts: L.pts, closed: !!L.closed, cut: false, head: 0 };
    });
    this.scraps.length = 0;
    this.scissor = null;
    this.misses = 0;
    this.unfoldAnim = null;
    this.result = null;
    this.finished = false;
    this.layout();
  };

  CutPlay.prototype.layout = function () {
    var c = this.canvas;
    var w = c.clientWidth, h = c.clientHeight;
    if (w < 10 || h < 10) return;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.V.w = w; this.V.h = h;
    var m = 20;
    var size = Math.min(w - m * 2, h - m * 2);
    this.V.k = size / P;
    this.V.cx = w / 2;
    this.V.cy = h / 2;
  };

  /* ---------- 当前折纸展示区域（含折纸动画中的中间态） ---------- */
  CutPlay.prototype.regionNow = function () {
    var folds = this.cfg.folds.slice(0, this.foldIdx);
    var r = foldRegion(folds);
    if (this.foldAnim && this.foldAnim.t < 1) {
      /* 动画中：目标区域 = 前 foldIdx 折(动画将完成)，源区域 = 少一折 */
      var rFrom = foldRegion(this.cfg.folds.slice(0, this.foldIdx - 1));
      var t = this.foldAnim.t;
      return { x0: lerp(rFrom.x0, r.x0, t), y0: lerp(rFrom.y0, r.y0, t),
               x1: lerp(rFrom.x1, r.x1, t), y1: lerp(rFrom.y1, r.y1, t) };
    }
    return r;
  };

  /* ---------- 折痕几何（提示与点击判定共用） ---------- */
  CutPlay.prototype.foldLinePts = function () {
    if (this.foldIdx >= this.cfg.folds.length) return null;
    var f = this.cfg.folds[this.foldIdx];
    var r = foldRegion(this.cfg.folds.slice(0, this.foldIdx));
    if (f === 'v') {
      var mx = (r.x0 + r.x1) / 2;
      return [this.px(mx, r.y0), this.px(mx, r.y1)];
    }
    if (f === 'h') {
      var my = (r.y0 + r.y1) / 2;
      return [this.px(r.x0, my), this.px(r.x1, my)];
    }
    return [this.px(r.x1, r.y0), this.px(r.x0, r.y1)];
  };
  CutPlay.prototype.nearFoldLine = function (x, y, tol) {
    var pts = this.foldLinePts();
    if (!pts) return true;
    /* 点到线段距离 */
    var ax = pts[0].x, ay = pts[0].y, bx = pts[1].x, by = pts[1].y;
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy || 1;
    var t = ((x - ax) * dx + (y - ay) * dy) / len2;
    t = clamp(t, 0, 1);
    var cx = ax + dx * t, cy = ay + dy * t;
    return Math.hypot(x - cx, y - cy) <= tol;
  };

  /* ---------- 输入 ---------- */
  CutPlay.prototype.onDown = function (e) {
    if (this.finished || !this.cfg) return;
    var c = this.canvas.getBoundingClientRect();
    var x = e.clientX - c.left, y = e.clientY - c.top;
    if (this.state === 'fold') {
      /* 点在折痕附近(60px)才执行折叠 */
      if (!this.foldAnim && this.foldIdx < this.cfg.folds.length && this.nearFoldLine(x, y, 60)) {
        this.foldAnim = { t0: now(), dur: 620, t: 0 };
        this.foldIdx++;
        AUD.SFX.fold();
      }
    } else if (this.state === 'cut') {
      this.scissor = { x: x, y: y, down: true, lastX: x, lastY: y, lastT: now() };
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      this.cutAt(x, y);
    }
  };
  CutPlay.prototype.onMove = function (e) {
    if (!this.cfg || this.finished) return;
    var c = this.canvas.getBoundingClientRect();
    var x = e.clientX - c.left, y = e.clientY - c.top;
    if (this.state === 'cut') {
      if (this.scissor && this.scissor.down) {
        this.scissor.x = x; this.scissor.y = y;
        this.cutAt(x, y);
      } else {
        this.scissor = this.scissor || {};
        this.scissor.x = x; this.scissor.y = y;
      }
      e.preventDefault();
    }
  };
  CutPlay.prototype.onUp = function () {
    if (this.scissor) this.scissor.down = false;
  };

  /* ---------- 剪裁推进: 找最近未剪线段的最近点 ---------- */
  CutPlay.prototype.cutAt = function (px, py) {
    if (this.state !== 'cut') return;
    var pv = this.pv(px, py);
    var tol = this.cfg.tol;
    var best = null, bestD = 1e9;
    for (var li = 0; li < this.lines.length; li++) {
      var L = this.lines[li];
      if (L.cut) continue;
      for (var s = L.head; s < L.pts.length; s++) {
        var pt = L.pts[s];
        var d = dist(pv.x, pv.y, pt[0], pt[1]);
        if (d < bestD) { bestD = d; best = { line: L, seg: s, pt: pt }; }
      }
    }
    if (!best) return;
    if (bestD <= tol) {
      /* 剪切推进 */
      best.line.head = best.seg + 1;
      if (best.line.head >= best.line.pts.length) {
        best.line.cut = true;
        this.spawnScraps(best.line);
      }
      AUD.SFX.snip();
      if (this.lines.every(function (L) { return L.cut; })) {
        this.state = 'unfold';
        this.beginUnfold();
        this.host.onAllCut();
      }
    } else {
      /* 偏离虚线: 记失误（节流） */
      var t = now();
      if (!this._lastMiss || t - this._lastMiss > 700) {
        this._lastMiss = t;
        this.misses++;
        AUD.SFX.wrong();
      }
    }
  };

  CutPlay.prototype.spawnScraps = function (L) {
    var mid = L.pts[Math.floor(L.pts.length / 2)];
    var q = this.px(mid[0], mid[1]);
    for (var i = 0; i < 14; i++) {
      this.scraps.push({
        x: q.x, y: q.y,
        vx: (Math.random() - 0.5) * 2.4, vy: -1 - Math.random() * 2,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        size: 4 + Math.random() * 6, age: 0, life: 900 + Math.random() * 600,
        color: Math.random() < 0.5 ? '#c8341f' : '#e05a41'
      });
    }
  };

  /* ---------- 展开: 用离屏画布做最终窗花 ---------- */
  CutPlay.prototype.buildResult = function () {
    var S = 900;   /* 成品画布尺寸 */
    var out = document.createElement('canvas');
    out.width = S; out.height = S;
    var c2 = out.getContext('2d');
    var paper = PC.FOLDCUT.PAPER;
    var k = S / paper;

    /* 生成最终形状: 以折后楔形为基础, 把每条剪线转成"剪掉区域"(粗带/孔) */
    c2.save();
    c2.scale(k, k);
    /* 1. 折后纸形状 */
    var region = foldRegion(this.cfg.folds);
    c2.fillStyle = '#c8341f';
    if (region.diag) {
      /* v,h 之后纸为 0..230²; d 折沿 x+y=230, 保留 x+y≤230 的三角 */
      c2.beginPath();
      c2.moveTo(0, 0);
      c2.lineTo(230, 0);
      c2.lineTo(0, 230);
      c2.closePath();
      c2.fill();
    } else {
      c2.fillRect(region.x0, region.y0, region.x1 - region.x0, region.y1 - region.y0);
    }
    /* 2. 减去剪线（evenodd: 再描一遍剪线的闭合形状） */
    c2.globalCompositeOperation = 'destination-out';
    this.lines.forEach(function (L) {
      c2.beginPath();
      c2.moveTo(L.pts[0][0], L.pts[0][1]);
      for (var i = 1; i < L.pts.length; i++) c2.lineTo(L.pts[i][0], L.pts[i][1]);
      if (L.closed) c2.closePath();
      c2.lineWidth = L.closed ? 1 : 26;
      c2.lineCap = 'round'; c2.lineJoin = 'round';
      c2.strokeStyle = '#000';
      if (!L.closed) c2.stroke();
      else c2.fill();
    });
    c2.restore();

    /* 3. 展开: 从最后一折倒序, 每次沿折痕做镜像复制
     * v 折痕 x=m: 新增部分 = mirror_x(2m - x)
     * h 折痕 y=m: 新增部分 = mirror_y
     * d 折痕 x+y=s(在 230² 纸上): 沿对角线反射 = 变换(x,y)→(y,x) */
    var folds = this.cfg.folds;
    var k0 = S / paper;
    var piece = out;

    for (var fi = folds.length - 1; fi >= 0; fi--) {
      var f = folds[fi];
      var next = document.createElement('canvas');
      next.width = S; next.height = S;
      var cx = next.getContext('2d');
      cx.drawImage(piece, 0, 0);
      cx.save();
      if (f === 'v') {
        var mv = 230;   /* 该折发生时的折痕（v 总在 h/d 之前, 纸宽 460 → 折痕 230） */
        cx.translate(k0 * mv * 2, 0);
        cx.scale(-1, 1);
      } else if (f === 'h') {
        var mh = 230;   /* h 折时纸高 460（若 v 已折过, 折痕仍为 y=230, 因 h 折的是整纸高度的一半？）
                         * 实际: v 折后纸为 230x460, h 折折痕 y=230 ✓ */
        cx.translate(0, k0 * mh * 2);
        cx.scale(1, -1);
      } else {
        /* d 折: 折痕 x+y=230, 反射 (x,y)→(230-y, 230-x) */
        var md = 230;
        cx.translate(k0 * md, k0 * md);
        cx.transform(0, -1, -1, 0, 0, 0);
      }
      cx.drawImage(piece, 0, 0);
      cx.restore();
      piece = next;
    }

    this.result = piece;
    return piece;
  };

  /* ---------- 绘制 ---------- */
  CutPlay.prototype.draw = function (dt) {
    var ctx = this.ctx;
    var dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.V.w, this.V.h);
    if (!this.cfg) return;

    /* 工作台背景 */
    ctx.fillStyle = '#fbf3de';
    ctx.fillRect(0, 0, this.V.w, this.V.h);

    if (this.state === 'unfold') {
      this.drawUnfold(ctx, dt);
      this.drawScraps(ctx, dt);
      return;
    }

    /* 纸张（折后区域；对角折为三角形） */
    var r = this.regionNow();
    var a = this.px(r.x0, r.y0), b = this.px(r.x1, r.y0),
        c = this.px(r.x1, r.y1), d = this.px(r.x0, r.y1);

    ctx.save();
    /* 层叠感: 多层纸（每层轻微错位） */
    for (var layer = this.foldIdx; layer >= 0; layer--) {
      var off = layer * 2.5;
      ctx.fillStyle = layer === 0 ? '#c8341f' : shadeFor(layer);
      ctx.beginPath();
      if (r.diag) {
        /* 三角楔形 (x0,y0)-(x1,y0)-(x0,y1) */
        ctx.moveTo(a.x + off, a.y + off);
        ctx.lineTo(b.x + off, b.y + off - layer * 1.2);
        ctx.lineTo(d.x + off - layer * 1.2, d.y + off);
      } else {
        ctx.moveTo(a.x + off, a.y + off - layer * 1.2);
        ctx.lineTo(b.x + off, b.y + off - layer * 1.2);
        ctx.lineTo(c.x + off, c.y + off - layer * 1.2);
        ctx.lineTo(d.x + off, d.y + off - layer * 1.2);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    /* 剪裁虚线（折完才显示） */
    if (this.state === 'cut') {
      var self = this;
      ctx.save();
      ctx.setLineDash([8, 7]);
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = 'rgba(255,246,220,0.95)';
      this.lines.forEach(function (L) {
        if (L.head <= 0 && L.cut) return;
        ctx.beginPath();
        var start = L.closed ? 0 : 0;
        for (var i = start; i < L.pts.length; i++) {
          var q = self.px(L.pts[i][0], L.pts[i][1]);
          if (i === start) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
        }
        if (L.closed) ctx.closePath();
        /* 已剪部分实线更亮 */
        ctx.globalAlpha = L.cut ? 0.15 : 0.9;
        ctx.stroke();
      });
      ctx.restore();

      /* 进度标记: 已剪到的点画金点 */
      ctx.fillStyle = '#f2c94c';
      this.lines.forEach(function (L) {
        for (var i = 0; i < L.head && i < L.pts.length; i++) {
          var q = self.px(L.pts[i][0], L.pts[i][1]);
          ctx.beginPath();
          ctx.arc(q.x, q.y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    }

    /* 折痕提示（fold 阶段） */
    if (this.state === 'fold') {
      this.drawFoldHint(ctx);
    }

    this.drawScraps(ctx, dt);

    /* 剪刀光标 */
    if (this.state === 'cut' && this.scissor) {
      this.drawScissor(ctx, this.scissor.x, this.scissor.y);
    }
  };

  function shadeFor(layer) {
    var k = 1 - layer * 0.09;
    return 'rgb(' + Math.round(200 * k) + ',' + Math.round(52 * k) + ',' + Math.round(31 * k) + ')';
  }
  function roundQuad(ctx, x1, y1, x2, y2, x3, y3, x4, y4, rr) {
    ctx.beginPath();
    ctx.moveTo(x1 + rr, y1);
    ctx.lineTo(x2 - rr, y2);
    ctx.quadraticCurveTo(x2, y2, x3, y3 + rr * 0.4);
    ctx.lineTo(x4, y4 - rr * 0.4);
    ctx.quadraticCurveTo(x4, y4, x1, y1);
    ctx.closePath();
  }

  CutPlay.prototype.drawFoldHint = function (ctx) {
    if (this.foldAnim || this.foldIdx >= this.cfg.folds.length) return;
    var pts = this.foldLinePts();
    if (!pts) return;
    var p1 = pts[0], p2 = pts[1];
    var t = now();
    ctx.save();
    ctx.strokeStyle = 'rgba(255,246,220,0.95)';
    ctx.lineWidth = 3.5;
    ctx.setLineDash([11, 8]);
    ctx.lineDashOffset = -(t * 0.02) % 19;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.restore();

    /* 折痕中点: 一个"点击"呼吸圆提示 */
    var mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    var pulse = 0.5 + 0.5 * Math.sin(t * 0.008);
    ctx.save();
    ctx.strokeStyle = 'rgba(242,201,76,' + (0.5 + 0.4 * pulse) + ')';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(mid.x, mid.y, 14 + 6 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    /* 提示文字（画布顶部, 不与纸重叠） */
    var f = this.cfg.folds[this.foldIdx];
    ctx.save();
    ctx.fillStyle = 'rgba(74,28,20,0.8)';
    ctx.font = '18px KaiTi, STKaiti, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var label = f === 'v' ? '✂ 点击虚线折痕 · 竖向对折'
      : f === 'h' ? '✂ 点击虚线折痕 · 横向对折' : '✂ 点击虚线折痕 · 对角折';
    ctx.fillText(label, this.V.cx, 16);
    ctx.restore();
  };

  CutPlay.prototype.drawScraps = function (ctx, dt) {
    this.scraps = this.scraps.filter(function (s) { return (s.age += dt) < s.life; });
    this.scraps.forEach(function (s) {
      var u = dt / 16.6;
      s.x += s.vx * u; s.y += s.vy * u; s.vy += 0.09 * u; s.rot += s.vr * u;
      ctx.save();
      ctx.globalAlpha = 1 - s.age / s.life;
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.fillStyle = s.color;
      ctx.fillRect(-s.size / 2, -s.size / 3, s.size, s.size * 0.66);
      ctx.restore();
    });
  };

  CutPlay.prototype.drawScissor = function (ctx, x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.5);
    /* 两刃 */
    ctx.strokeStyle = '#6b7280';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(17, -13);
    ctx.moveTo(0, 0); ctx.lineTo(17, 13);
    ctx.stroke();
    /* 指环 */
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#9aa2ad';
    ctx.beginPath();
    ctx.arc(-9, -11, 5.5, 0, Math.PI * 2);
    ctx.moveTo(-3.5, 5.5);
    ctx.arc(-9, 11, 5.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };

  /* ---------- 展开动画 ---------- */
  CutPlay.prototype.beginUnfold = function () {
    if (!this.result) this.buildResult();
    this.unfoldAnim = { t0: now(), dur: 1400 };
    AUD.SFX.bloom();
  };

  CutPlay.prototype.drawUnfold = function (ctx, dt) {
    var k = clamp((now() - this.unfoldAnim.t0) / this.unfoldAnim.dur, 0, 1);
    var e = easeOut(k);
    var size = Math.min(this.V.w, this.V.h) * 0.82;
    var cx = this.V.cx, cy = this.V.cy;
    ctx.save();
    ctx.translate(cx, cy);
    /* 旋转进入 + 缩放绽放 */
    ctx.rotate((1 - e) * 0.35);
    var s = lerp(0.1, 1, e);
    ctx.scale(s, s);
    ctx.shadowColor = 'rgba(120,30,15,0.3)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 10;
    ctx.drawImage(this.result, -size / 2, -size / 2, size, size);
    ctx.restore();

    if (k >= 1 && !this.finished) {
      this.finished = true;
      this.host.onUnfolded(this);
    }
  };

  /* 星级: 失误次数 */
  CutPlay.prototype.stars = function () {
    if (this.misses === 0) return 3;
    if (this.misses <= 4) return 2;
    return 1;
  };

  /* ---------- 帧循环入口（由 game.js 调用） ---------- */
  CutPlay.prototype.frame = function (dt) {
    if (this.foldAnim) {
      this.foldAnim.t = clamp((now() - this.foldAnim.t0) / this.foldAnim.dur, 0, 1);
      if (this.foldAnim.t >= 1) {
        this.foldAnim = null;
        if (this.foldIdx >= this.cfg.folds.length) {
          this.state = 'cut';
          this.host.onFolded(this);
        }
      }
    }
    this.draw(dt);
  };

  /* 调试: 跳到某阶段 (#cut=2:fold / 2:cut / 2:unfold) */
  CutPlay.prototype.debugSkip = function (phase) {
    if (phase === 'cut') {
      this.foldIdx = this.cfg.folds.length;
      this.state = 'cut';
      if (this.host && this.host.onFolded) this.host.onFolded(this);
    } else if (phase === 'unfold') {
      this.foldIdx = this.cfg.folds.length;
      this.lines.forEach(function (L) { L.cut = true; L.head = L.pts.length; });
      this.state = 'unfold';
      this.beginUnfold();
      if (this.host && this.host.onAllCut) this.host.onAllCut();
    }
  };

  global.CutPlay = CutPlay;
})(window);
