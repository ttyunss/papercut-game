/* ============================================================
 * 纸上生花 · 自由剪纸
 * 红纸自由折(横/竖/对角, 最多4折) → 剪刀自由剪 / 戳孔 → 展开对称窗花
 * 剪切记录在"折后坐标系"上; 展开时对折痕做镜像复原
 * ============================================================ */
(function (global) {
  'use strict';

  var PC = global.PCPatterns, AUD = global.PCAudio;
  var P = PC.FOLDCUT.PAPER;
  var MAX_FOLDS = 4;

  function now() { return performance.now(); }
  function clamp(v, a, b) { return (v < a) ? a : ((v > b) ? b : v); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function easeOut(k) { return 1 - Math.pow(1 - k, 3); }

  function FreeCut(canvas) {
    var self = this;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.V = { w: 0, h: 0, cx: 0, cy: 0, k: 1 };

    this.folds = [];        /* ['v','h','d',...] */
    this.strokes = [];      /* 剪切笔迹 [{pts:[[x,y]...], tool:'cut'|'punch'}]（折后坐标） */
    this.tool = 'cut';
    this.dragging = false;
    this.unfolded = false;
    this.unfoldAnim = null;
    this.result = null;
    this.scraps = [];

    canvas.addEventListener('pointerdown', function (e) { self.onDown(e); });
    canvas.addEventListener('pointermove', function (e) { self.onMove(e); });
    canvas.addEventListener('pointerup', function (e) { self.onUp(e); });
    canvas.addEventListener('pointercancel', function (e) { self.onUp(e); });
  }

  /* ---------- 坐标 ---------- */
  FreeCut.prototype.px = function (x, y) {
    return { x: this.V.cx + (x - P / 2) * this.V.k, y: this.V.cy + (y - P / 2) * this.V.k };
  };
  FreeCut.prototype.pv = function (px, py) {
    return { x: (px - this.V.cx) / this.V.k + P / 2, y: (py - this.V.cy) / this.V.k + P / 2 };
  };

  /* ---------- 保留区域（当前折后可见范围） ---------- */
  FreeCut.prototype.region = function () {
    var r = { x0: 0, y0: 0, x1: P, y1: P, diag: false };
    this.folds.forEach(function (f) {
      if (f === 'v') r.x1 = (r.x0 + r.x1) / 2;
      else if (f === 'h') r.y1 = (r.y0 + r.y1) / 2;
      else if (f === 'd') r.diag = true;
    });
    if (r.diag) {
      var s = this.folds.indexOf('d') === 0 ? P : r.x1;
      r.x1 = s; r.y1 = s;
    }
    return r;
  };

  /* ---------- 操作 ---------- */
  FreeCut.prototype.reset = function () {
    this.folds.length = 0;
    this.strokes.length = 0;
    this.unfolded = false;
    this.unfoldAnim = null;
    this.result = null;
    this.scraps.length = 0;
    this.dragging = false;
    this.layout();
  };

  FreeCut.prototype.addFold = function (kind) {
    if (this.unfolded || this.folds.length >= MAX_FOLDS) return false;
    this.folds.push(kind);
    AUD.SFX.fold();
    this.layout();
    return true;
  };

  FreeCut.prototype.undo = function () {
    if (this.unfolded) return;
    if (this.strokes.length) this.strokes.pop();
    else if (this.folds.length) this.folds.pop();
    AUD.SFX.deselect();
  };

  /* ---------- 输入 ---------- */
  FreeCut.prototype.onDown = function (e) {
    if (this.unfolded) return;
    var c = this.canvas.getBoundingClientRect();
    var x = e.clientX - c.left, y = e.clientY - c.top;
    var p = this.pv(x, y);
    var r = this.region();
    /* 只能在纸内剪 */
    var inside = p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
    if (!inside) return;
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    if (this.tool === 'punch') {
      this.strokes.push({ tool: 'punch', pts: [[p.x, p.y]] });
      AUD.SFX.punch();
      this.spawnScraps(x, y, 8);
    } else {
      this.dragging = true;
      this.strokes.push({ tool: 'cut', pts: [[p.x, p.y]] });
      AUD.SFX.snip();
    }
  };
  FreeCut.prototype.onMove = function (e) {
    if (!this.dragging || this.unfolded) return;
    var c = this.canvas.getBoundingClientRect();
    var x = e.clientX - c.left, y = e.clientY - c.top;
    var p = this.pv(x, y);
    var s = this.strokes[this.strokes.length - 1];
    var last = s.pts[s.pts.length - 1];
    /* 限速: 间距>6 才记录, 剪切感 */
    if (Math.hypot(p.x - last[0], p.y - last[1]) > 6) {
      s.pts.push([p.x, p.y]);
      this.spawnScraps(x, y, 1);
      AUD.SFX.snip();
    }
    e.preventDefault();
  };
  FreeCut.prototype.onUp = function () { this.dragging = false; };

  FreeCut.prototype.spawnScraps = function (x, y, n) {
    for (var i = 0; i < n; i++) {
      this.scraps.push({
        x: x, y: y, vx: (Math.random() - 0.5) * 2, vy: -0.8 - Math.random() * 1.6,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        size: 4 + Math.random() * 5, age: 0, life: 800 + Math.random() * 500,
        color: Math.random() < 0.5 ? '#c8341f' : '#e05a41'
      });
    }
  };

  /* ---------- 展开成品 ---------- */
  FreeCut.prototype.buildResult = function () {
    var S = 900;
    var out = document.createElement('canvas');
    out.width = S; out.height = S;
    var k = S / P;

    /* 楔形红纸 */
    var c = out.getContext('2d');
    var r = this.region();
    c.save();
    c.scale(k, k);
    c.fillStyle = '#c8341f';
    if (r.diag) {
      var s = r.x1;   /* region() 对角时已把 x1/y1 收敛为楔形直角边长 */
      c.beginPath(); c.moveTo(0, 0); c.lineTo(s, 0); c.lineTo(0, s); c.closePath(); c.fill();
    } else {
      c.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    }
    /* 减去笔迹 */
    c.globalCompositeOperation = 'destination-out';
    var self = this;
    this.strokes.forEach(function (st) {
      c.beginPath();
      c.moveTo(st.pts[0][0], st.pts[0][1]);
      for (var i = 1; i < st.pts.length; i++) c.lineTo(st.pts[i][0], st.pts[i][1]);
      if (st.tool === 'punch') {
        c.arc(st.pts[0][0], st.pts[0][1], 16, 0, Math.PI * 2);
        c.fillStyle = '#000'; c.fill();
      } else {
        c.lineWidth = 22;
        c.lineCap = 'round'; c.lineJoin = 'round';
        c.strokeStyle = '#000'; c.stroke();
      }
    });
    c.restore();

    /* 依次按折痕镜像展开（从最后一折倒着展开） */
    var piece = out;
    for (var i = this.folds.length - 1; i >= 0; i--) {
      var f = this.folds[i];
      /* 此时的镜像轴 = 该折之前的保留边界 */
      var foldsBefore = this.folds.slice(0, i);
      var rb = { x0: 0, y0: 0, x1: P, y1: P };
      foldsBefore.forEach(function (g) {
        if (g === 'v') rb.x1 = (rb.x0 + rb.x1) / 2;
        else if (g === 'h') rb.y1 = (rb.y0 + rb.y1) / 2;
      });
      var next = document.createElement('canvas');
      next.width = S; next.height = S;
      var c2 = next.getContext('2d');
      c2.drawImage(piece, 0, 0);
      c2.save();
      if (f === 'v') {
        /* 折痕 x = rb.x1/2（该折发生时纸宽的一半）, 镜像轴即折痕 */
        c2.translate(k * rb.x1, 0);
        c2.scale(-1, 1);
      } else if (f === 'h') {
        c2.translate(0, k * rb.y1);
        c2.scale(1, -1);
      } else {
        /* 对角折: 折痕 x+y=s, 反射 (x,y)→(s-y, s-x) */
        var sd = i === 0 ? P : rb.x1;
        c2.translate(k * sd, k * sd);
        c2.transform(0, -1, -1, 0, 0, 0);
      }
      c2.drawImage(piece, 0, 0);
      c2.restore();
      piece = next;
    }
    this.result = piece;
    return piece;
  };

  FreeCut.prototype.unfold = function () {
    if (this.unfolded) return;
    if (!this.strokes.length) return false;
    this.buildResult();
    this.unfolded = true;
    this.unfoldAnim = { t0: now(), dur: 1300 };
    AUD.SFX.bloom();
    return true;
  };

  /* ---------- 保存图片 ---------- */
  FreeCut.prototype.saveImage = function () {
    if (!this.result) return;
    var a = document.createElement('a');
    a.download = '我的窗花-' + Date.now() + '.png';
    a.href = this.result.toDataURL('image/png');
    a.click();
    AUD.SFX.click();
  };

  /* ---------- 布局与绘制 ---------- */
  FreeCut.prototype.layout = function () {
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
    var m = 24;
    var size = Math.min(w - m * 2, h - m * 2);
    this.V.k = size / P;
    this.V.cx = w / 2;
    this.V.cy = h / 2;
  };

  FreeCut.prototype.draw = function (dt) {
    var ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.V.w, this.V.h);
    ctx.fillStyle = '#fbf3de';
    ctx.fillRect(0, 0, this.V.w, this.V.h);

    if (this.unfolded && this.result) {
      var k = clamp((now() - this.unfoldAnim.t0) / this.unfoldAnim.dur, 0, 1);
      var e = easeOut(k);
      var size = Math.min(this.V.w, this.V.h) * 0.9;
      ctx.save();
      ctx.translate(this.V.cx, this.V.cy);
      ctx.rotate((1 - e) * 0.3);
      var s = lerp(0.1, 1, e);
      ctx.scale(s, s);
      ctx.shadowColor = 'rgba(120,30,15,0.3)';
      ctx.shadowBlur = 24; ctx.shadowOffsetY = 10;
      ctx.drawImage(this.result, -size / 2, -size / 2, size, size);
      ctx.restore();

      if (k >= 1) {
        ctx.fillStyle = 'rgba(74,28,20,0.7)';
        ctx.font = '18px KaiTi, STKaiti, serif';
        ctx.textAlign = 'center';
        ctx.fillText('这是你剪出来的窗花！点击「换张红纸」再剪一张', this.V.cx, this.V.h - 18);
      }
    } else {
      /* 折后的纸 */
      var r = this.region();
      var a = this.px(r.x0, r.y0), b = this.px(r.x1, r.y0),
          c = this.px(r.x1, r.y1), d = this.px(r.x0, r.y1);
      ctx.save();
      for (var layer = this.folds.length; layer >= 0; layer--) {
        var off = layer * 2.5;
        var shade = 1 - layer * 0.08;
        ctx.fillStyle = 'rgb(' + Math.round(200 * shade) + ',' + Math.round(52 * shade) + ',' + Math.round(31 * shade) + ')';
        ctx.beginPath();
        if (r.diag) {
          ctx.moveTo(a.x + off, a.y + off);
          ctx.lineTo(b.x + off, b.y + off);
          ctx.lineTo(d.x + off, d.y + off);
        } else {
          ctx.moveTo(a.x + off, a.y + off - layer);
          ctx.lineTo(b.x + off, b.y + off - layer);
          ctx.lineTo(c.x + off, c.y + off - layer);
          ctx.lineTo(d.x + off, d.y + off - layer);
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      /* 剪切笔迹 */
      var self = this;
      ctx.save();
      this.strokes.forEach(function (st) {
        ctx.beginPath();
        var q0 = self.px(st.pts[0][0], st.pts[0][1]);
        ctx.moveTo(q0.x, q0.y);
        for (var i = 1; i < st.pts.length; i++) {
          var q = self.px(st.pts[i][0], st.pts[i][1]);
          ctx.lineTo(q.x, q.y);
        }
        if (st.tool === 'punch') {
          ctx.arc(q0.x, q0.y, 16 * self.V.k, 0, Math.PI * 2);
          ctx.fillStyle = '#fbf3de';
          ctx.fill();
          ctx.strokeStyle = 'rgba(120,30,15,0.4)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else {
          ctx.strokeStyle = '#fbf3de';
          ctx.lineWidth = 6;
          ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          ctx.stroke();
        }
      });
      ctx.restore();

      /* 状态提示 */
      ctx.fillStyle = 'rgba(74,28,20,0.75)';
      ctx.font = '16px KaiTi, STKaiti, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      var hint = this.folds.length >= MAX_FOLDS
        ? '已折 ' + this.folds.length + ' 折 · 用剪刀或戳孔创作吧'
        : this.folds.length === 0
          ? '先在左侧折纸，再拿起剪刀 ✂'
          : '已折 ' + this.folds.length + ' 折 · 可以继续折或开剪';
      ctx.fillText(hint, this.V.cx, 26);
    }

    this.drawScraps(ctx, dt);
  };

  FreeCut.prototype.drawScraps = function (ctx, dt) {
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

  FreeCut.prototype.frame = function (dt) {
    this.draw(dt);
  };

  global.FreeCut = FreeCut;
})(window);
