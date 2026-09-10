/* ============================================================
 * 纸上生花 · 图案与形状库
 * 所有形状输出"纯路径指令数组"（Node 可直接校验，无需浏览器）：
 *   ['M',x,y] ['L',x,y] ['C',c1x,c1y,c2x,c2y,x,y] ['Z']
 * 渲染端使用 evenodd 填充：同一 piece 内嵌套的子路径为镂空，
 * 互不重叠的子路径为并集。画板坐标系 900 x 640。
 * ============================================================ */
(function (global) {
  'use strict';

  var TAU = Math.PI * 2, D2R = Math.PI / 180;

  /* ---------- 配色 ---------- */
  var COL = {
    red: '#c8341f', redDeep: '#9c2113', redSoft: '#e05a41', pink: '#e0526e',
    gold: '#e0a230', goldDeep: '#b5850d', green: '#4a8a3f', greenDeep: '#2f6b2a',
    orange: '#e77e22', yellow: '#f2c94c', blue: '#4a90b8', blueLight: '#8fc1dd',
    white: '#fdf6e3', brown: '#8a5a2b'
  };

  /* ---------- 基础几何 ---------- */
  function rotXY(x, y, a) {
    var c = Math.cos(a), s = Math.sin(a);
    return [x * c - y * s, x * s + y * c];
  }

  /* 变换指令：先绕 (cx,cy) 缩放旋转，再平移 (dx,dy) */
  function XF(cmds, opt) {
    var o = opt || {};
    var a = (o.rot || 0) * D2R;
    var sx = (o.sx == null) ? 1 : o.sx, sy = (o.sy == null) ? 1 : o.sy;
    var cx = o.cx || 0, cy = o.cy || 0, dx = o.dx || 0, dy = o.dy || 0;
    var c2 = Math.cos(a), s2 = Math.sin(a);
    return cmds.map(function (c) {
      if (c[0] === 'Z') return c;
      var out = [c[0]];
      for (var i = 1; i < c.length; i += 2) {
        var x = (c[i] - cx) * sx, y = (c[i + 1] - cy) * sy;
        out.push(x * c2 - y * s2 + cx + dx, x * s2 + y * c2 + cy + dy);
      }
      return out;
    });
  }

  function MERGE() {
    var out = [];
    for (var i = 0; i < arguments.length; i++) out = out.concat(arguments[i]);
    return out;
  }

  function POLY(pts) {
    var c = [['M', pts[0][0], pts[0][1]]];
    for (var i = 1; i < pts.length; i++) c.push(['L', pts[i][0], pts[i][1]]);
    c.push(['Z']);
    return c;
  }

  function ELL(cx, cy, rx, ry, rotDeg, n) {
    var segs = n || 48, c = [];
    for (var i = 0; i <= segs; i++) {
      var t = TAU * i / segs;
      var p = rotXY(rx * Math.cos(t), ry * Math.sin(t), (rotDeg || 0) * D2R);
      c.push(i === 0 ? ['M', cx + p[0], cy + p[1]] : ['L', cx + p[0], cy + p[1]]);
    }
    c.push(['Z']);
    return c;
  }

  function CIR(cx, cy, r, n) { return ELL(cx, cy, r, r, 0, n || 40); }

  function RR(cx, cy, w, h, rad, rotDeg) {
    rad = Math.min(rad || 0, w / 2, h / 2);
    var x0 = -w / 2, y0 = -h / 2, x1 = w / 2, y1 = h / 2, k = 0.5523 * rad, c;
    if (rad <= 0) {
      c = [['M', x0, y0], ['L', x1, y0], ['L', x1, y1], ['L', x0, y1], ['Z']];
    } else {
      c = [
        ['M', x0 + rad, y0], ['L', x1 - rad, y0],
        ['C', x1 - rad + k, y0, x1, y0 + rad - k, x1, y0 + rad],
        ['L', x1, y1 - rad],
        ['C', x1, y1 - rad + k, x1 - rad + k, y1, x1 - rad, y1],
        ['L', x0 + rad, y1],
        ['C', x0 + rad - k, y1, x0, y1 - rad + k, x0, y1 - rad],
        ['L', x0, y0 + rad],
        ['C', x0, y0 + rad - k, x0 + rad - k, y0, x0 + rad, y0],
        ['Z']
      ];
    }
    return XF(c, { dx: cx, dy: cy, rot: rotDeg || 0 });
  }

  function STAR(cx, cy, R, r, n, rotDeg) {
    var pts = [];
    for (var i = 0; i < n * 2; i++) {
      var rad = (i % 2 === 0) ? R : r;
      var a = ((rotDeg == null ? -90 : rotDeg) + 180 * i / n) * D2R;
      pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
    }
    return POLY(pts);
  }

  /* 闭合 Catmull-Rom 平滑曲线 → 贝塞尔 */
  function BLOB(pts, tension) {
    var t = (tension == null) ? 1 : tension, n = pts.length;
    var c = [['M', pts[0][0], pts[0][1]]];
    for (var i = 0; i < n; i++) {
      var p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      c.push(['C',
        p1[0] + (p2[0] - p0[0]) / 6 * t, p1[1] + (p2[1] - p0[1]) / 6 * t,
        p2[0] - (p3[0] - p1[0]) / 6 * t, p2[1] - (p3[1] - p1[1]) / 6 * t,
        p2[0], p2[1]]);
    }
    c.push(['Z']);
    return c;
  }

  /* 花瓣：基部在 (cx,cy)，向 angDeg 方向伸出（0=正上，顺时针） */
  function PETAL(cx, cy, len, wid, angDeg) {
    var local = BLOB([
      [0, -2], [-wid / 2, -len * 0.32], [-wid * 0.54, -len * 0.78],
      [0, -len], [wid * 0.54, -len * 0.78], [wid / 2, -len * 0.32]
    ]);
    return XF(local, { dx: cx, dy: cy, rot: angDeg || 0 });
  }

  /* 叶片：基部在 (cx,cy)，向 angDeg 方向（0=正右，顺时针） */
  function LEAF(cx, cy, len, wid, angDeg) {
    var local = BLOB([[0, 0], [len * 0.5, -wid / 2], [len, 0], [len * 0.5, wid / 2]]);
    return XF(local, { dx: cx, dy: cy, rot: angDeg || 0 });
  }

  /* ---------- 折纸剪裁数据辅助 ---------- */
  /* 圆弧采样点（角度制，0=正右，顺时针为正） */
  function ARC(cx, cy, r, a0, a1, n) {
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var a = (a0 + (a1 - a0) * i / n) * D2R;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }
  /* 圆形采样点（closed=true 为闭合剪孔） */
  function CIRCPT(cx, cy, r, n) {
    var pts = [];
    for (var i = 0; i < n; i++) {
      var a = TAU * i / n;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }

  /* ============================================================
   * 折纸剪裁数据（第二关 / 第三关）
   * 纸张局部坐标：正方形 0..460 × 0..460，原点左上
   * 折法: v=竖对折(右折向左) h=横对折(下折向上) d=对角折(沿x+y=230)
   * lines: 剪裁虚线（点折线，在折后楔形上）；closed=true 为剪孔
   * ============================================================ */
  var FOLDCUT = {
    PAPER: 460,
    levels: {
      2: {
        folds: ['v', 'h', 'd'],
        tol: 16,
        lines: [
          { pts: ARC(230, 230, 228, 180, 270, 10) },
          { pts: [[26, 0], [11, 11], [0, 26]] },
          { pts: [[0, 78], [16, 94], [0, 110]] },
          { pts: [[78, 0], [94, 16], [110, 0]] },
          { pts: CIRCPT(52, 140, 13, 14), closed: true },
          { pts: CIRCPT(140, 52, 13, 14), closed: true }
        ]
      },
      3: {
        folds: ['v', 'h'],
        tol: 26,
        lines: [
          { pts: ARC(230, 230, 190, 180, 270, 10) },
          { pts: [[44, 0], [22, 22], [0, 44]] },
          { pts: [[84, 0], [104, 18], [124, 0]] },
          { pts: [[0, 84], [18, 104], [0, 124]] },
          { pts: CIRCPT(56, 56, 14, 14), closed: true },
          { pts: ARC(230, 230, 120, 187, 263, 8) }
        ]
      }
    }
  };

  /* 灯笼椭圆四分之一楔形（含中间刀口镂空） */
  function LANTERN_QUAD(a0, a1) {
    var cx = 450, cy = 335, rx = 150, ry = 122, N = 18, c = [];
    for (var i = 0; i <= N; i++) {
      var t = (a0 + (a1 - a0) * i / N) * D2R;
      c.push(i === 0 ? ['M', cx + rx * Math.cos(t), cy + ry * Math.sin(t)]
                     : ['L', cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
    }
    c.push(['L', cx, cy], ['Z']);
    var m = (a0 + a1) / 2;
    var px = cx + 0.6 * rx * Math.cos(m * D2R), py = cy + 0.6 * ry * Math.sin(m * D2R);
    return MERGE(c, RR(px, py, 52, 13, 6, m));
  }

  /* 五瓣小花（基部长在半径 16 的圆上，中心自然留孔） */
  function BLOOM5() {
    var c = [];
    for (var k = 0; k < 5; k++) {
      var a = k * 72;
      c = MERGE(c, PETAL(16 * Math.sin(a * D2R), -16 * Math.cos(a * D2R), 44, 30, a));
    }
    return c;
  }

  /* 四瓣角花（四重对称，四个角通用） */
  function CORNER_BLOOM() {
    var c = [];
    for (var k = 0; k < 4; k++) {
      var a = k * 90;
      c = MERGE(c, PETAL(16 * Math.sin(a * D2R), -16 * Math.cos(a * D2R), 40, 30, a));
    }
    return c;
  }

  /* 水波纹带（局部坐标，宽 240） */
  function WAVE() {
    return BLOB([[0, 0], [60, -28], [120, 4], [180, -26], [240, 0], [240, 26], [120, 34], [0, 28]]);
  }

  var cloudBase = BLOB([[0, 10], [14, -8], [34, -14], [50, -4], [66, -18], [88, -10],
    [104, 4], [88, 16], [52, 20], [20, 20]]);

  /* ---------- 九个图案（每关三个） ---------- */
  var PATTERNS = [];

  /* ======== 第一关 · 童心巧手（儿童益智：大块、少数量、明快） ======== */

  PATTERNS.push({
    id: 'L1-1', level: 1, name: '梅花开春', desc: '五片花瓣，贴成一朵春天的花',
    pieces: (function () {
      var ps = [
        { id: 'stem', color: COL.greenDeep, cmds: RR(450, 455, 22, 150, 11) },
        { id: 'leafL', group: 'leaf', color: COL.green, cmds: LEAF(444, 470, 120, 48, 160) },
        { id: 'leafR', group: 'leaf', color: COL.green, cmds: LEAF(456, 470, 120, 48, 20) }
      ];
      for (var k = 0; k < 5; k++) {
        var a = k * 72;
        ps.push({
          id: 'petal' + k, group: 'petal', color: COL.pink,
          cmds: PETAL(450 + 52 * Math.sin(a * D2R), 268 - 52 * Math.cos(a * D2R), 95, 72, a)
        });
      }
      ps.push({ id: 'center', color: COL.gold, cmds: MERGE(CIR(450, 268, 55), CIR(450, 268, 22)) });
      return ps;
    })()
  });

  PATTERNS.push({
    id: 'L1-2', level: 1, name: '暖暖小屋', desc: '屋顶、门窗……搭一座小房子',
    pieces: [
      { id: 'chimney', color: COL.orange, cmds: RR(530, 178, 30, 58, 5) },
      { id: 'roof', color: COL.red, cmds: POLY([[315, 255], [450, 150], [585, 255]]) },
      { id: 'body', color: COL.yellow, cmds: RR(450, 350, 230, 190, 6) },
      { id: 'windows', color: COL.blue, cmds: MERGE(
          CIR(392, 310, 30), CIR(392, 310, 12),
          CIR(508, 310, 30), CIR(508, 310, 12)) },
      { id: 'door', color: COL.green, cmds: RR(450, 400, 62, 90, 8) }
    ]
  });

  PATTERNS.push({
    id: 'L1-3', level: 1, name: '快乐小鱼', desc: '鱼儿吐泡泡，游啊游',
    pieces: [
      { id: 'bubbles', color: COL.blueLight, cmds: MERGE(
          CIR(230, 250, 13, 28), CIR(200, 205, 9, 24), CIR(215, 165, 6, 20)) },
      { id: 'tail', color: COL.red, cmds: XF(
          BLOB([[0, 0], [70, -78], [30, -18], [70, 80], [0, 6]]), { dx: 520, dy: 300 }) },
      { id: 'body', color: COL.orange, cmds: ELL(430, 300, 150, 88) },
      { id: 'fin', color: COL.red, cmds: XF(
          BLOB([[0, 12], [38, -52], [78, 2]]), { dx: 450, dy: 218 }) },
      { id: 'eye', color: COL.white, cmds: MERGE(CIR(350, 275, 20), CIR(350, 275, 8)) }
    ]
  });

  /* ======== 第二关 · 指尖飞花（青年普通：更碎、计时挑战） ======== */

  PATTERNS.push({
    id: 'L2-1', level: 2, name: '大红灯笼', desc: '四片灯身拼一盏团圆的灯',
    pieces: [
      { id: 'tassel', color: COL.redDeep, cmds: MERGE(
          RR(450, 495, 9, 28, 4), RR(450, 522, 26, 16, 7),
          XF(BLOB([[0, -8], [-13, 4], [-10, 36], [0, 44], [10, 36], [13, 4]]), { dx: 450, dy: 556 }),
          CIR(450, 607, 7)) },
      { id: 'capBottom', color: COL.gold, cmds: RR(450, 458, 106, 26, 8) },
      { id: 'quadTL', color: COL.red, cmds: LANTERN_QUAD(180, 270) },
      { id: 'quadTR', color: COL.red, cmds: LANTERN_QUAD(-90, 0) },
      { id: 'quadBL', color: COL.red, cmds: LANTERN_QUAD(90, 180) },
      { id: 'quadBR', color: COL.red, cmds: LANTERN_QUAD(0, 90) },
      { id: 'capTop', color: COL.gold, cmds: RR(450, 196, 118, 30, 9) },
      { id: 'ring', color: COL.red, cmds: MERGE(CIR(450, 168, 14), CIR(450, 168, 5.5, 24)) }
    ]
  });

  PATTERNS.push({
    id: 'L2-2', level: 2, name: '花间蝴蝶', desc: '对称的翅膀，找对左右再落下',
    pieces: (function () {
      var wingU = MERGE(BLOB([[432, 252], [352, 190], [272, 202], [250, 278], [296, 342],
          [372, 332], [428, 296]]), CIR(322, 252, 14), CIR(370, 298, 9));
      var wingL = MERGE(BLOB([[430, 312], [348, 330], [316, 398], [364, 444], [428, 418]]),
          CIR(378, 374, 9));
      var flower = BLOOM5();
      return [
        { id: 'flowerL', group: 'flower', color: COL.pink, cmds: XF(flower, { dx: 280, dy: 480 }) },
        { id: 'flowerR', group: 'flower', color: COL.pink, cmds: XF(flower, { dx: 620, dy: 480 }) },
        { id: 'wingLoL', color: COL.redSoft, cmds: wingL },
        { id: 'wingLoR', color: COL.redSoft, cmds: XF(wingL, { sx: -1, cx: 450 }) },
        { id: 'wingUpL', color: COL.red, cmds: wingU },
        { id: 'wingUpR', color: COL.red, cmds: XF(wingU, { sx: -1, cx: 450 }) },
        { id: 'body', color: COL.redDeep, cmds: MERGE(
            BLOB([[428, 342], [428, 248], [414, 202], [430, 170], [450, 156], [470, 170],
                  [486, 202], [472, 248], [472, 342]]),
            CIR(437, 182, 5, 16), CIR(463, 182, 5, 16)) },
        { id: 'antennae', color: COL.redDeep, cmds: MERGE(
            ELL(418, 150, 30, 8, -55), ELL(482, 150, 30, 8, 55)) }
      ];
    })()
  });

  PATTERNS.push({
    id: 'L2-3', level: 2, name: '荷塘清趣', desc: '荷、鱼、水波，拼一池夏日',
    pieces: (function () {
      var wave = WAVE();
      return [
        { id: 'wave1', group: 'wave', color: COL.blue, cmds: XF(wave, { dx: 320, dy: 556 }) },
        { id: 'wave2', group: 'wave', color: COL.blue, cmds: XF(wave, { dx: 340, dy: 596 }) },
        { id: 'leaf', color: COL.green, cmds: MERGE(
            BLOB([[620, 335], [690, 365], [712, 430], [680, 495], [610, 515], [545, 480], [528, 410]]),
            POLY([[620, 425], [703, 468], [668, 479]])) },
        { id: 'fishTail', color: COL.red, cmds: XF(
            BLOB([[0, 0], [42, -48], [18, -10], [42, 50], [0, 4]]), { dx: 352, dy: 470 }) },
        { id: 'fishBody', color: COL.orange, cmds: MERGE(ELL(300, 470, 72, 40), CIR(252, 458, 7, 20)) },
        { id: 'petalL', color: COL.pink, cmds: PETAL(400, 272, 118, 58, -16) },
        { id: 'petalR', color: COL.pink, cmds: PETAL(500, 272, 118, 58, 16) },
        { id: 'petalC', color: COL.red, cmds: PETAL(450, 268, 150, 66, 0) }
      ];
    })()
  });

  /* ======== 第三关 · 岁月静好（老年闲玩：传统纹样、大块、不限时） ======== */

  PATTERNS.push({
    id: 'L3-1', level: 3, name: '仙桃献寿', desc: '祥云配寿桃，福寿又安康',
    pieces: [
      { id: 'cloudA', group: 'cloud', color: COL.gold, cmds: XF(cloudBase, { dx: 195, dy: 248 }) },
      { id: 'cloudB', group: 'cloud', color: COL.gold,
        cmds: XF(cloudBase, { sx: -1, cx: 52, dx: 660, dy: 253 }) },
      { id: 'stem', color: COL.brown, cmds: RR(450, 215, 18, 64, 9, 8) },
      { id: 'peach', color: COL.red, cmds: MERGE(
          BLOB([[412, 230], [450, 262], [488, 230], [560, 258], [600, 330], [590, 415],
                [520, 470], [450, 482], [380, 470], [310, 415], [300, 330], [340, 258]]),
          BLOB([[450, 272], [438, 335], [450, 410], [462, 335]])) },
      { id: 'leafL', group: 'leaf', color: COL.green, cmds: LEAF(444, 205, 125, 46, 195) },
      { id: 'leafR', group: 'leaf', color: COL.green, cmds: LEAF(456, 205, 125, 46, -15) }
    ]
  });

  PATTERNS.push({
    id: 'L3-2', level: 3, name: '福到我家', desc: '一笔一画，拼出大红福字',
    pieces: (function () {
      var cf = CORNER_BLOOM();
      return [
        { id: 'cornerTL', group: 'corner', color: COL.gold, cmds: XF(cf, { dx: 95, dy: 95 }) },
        { id: 'cornerTR', group: 'corner', color: COL.gold, cmds: XF(cf, { dx: 805, dy: 95 }) },
        { id: 'cornerBL', group: 'corner', color: COL.gold, cmds: XF(cf, { dx: 95, dy: 545 }) },
        { id: 'cornerBR', group: 'corner', color: COL.gold, cmds: XF(cf, { dx: 805, dy: 545 }) },
        { id: 'shi', color: COL.red, cmds: MERGE(
            CIR(330, 185, 16), RR(312, 222, 104, 26, 12),
            RR(330, 318, 30, 120, 13),
            RR(287, 410, 80, 24, 11, 156), RR(383, 410, 80, 24, 11, 24)) },
        { id: 'yi', color: COL.red, cmds: RR(520, 200, 170, 32, 14) },
        { id: 'kou', color: COL.red, cmds: MERGE(RR(520, 288, 150, 80, 12), RR(520, 288, 96, 40, 8)) },
        { id: 'tian', color: COL.red, cmds: MERGE(
            RR(520, 398, 150, 132, 12),
            RR(520, 398, 30, 104, 9), RR(520, 398, 132, 30, 9)) }
      ];
    })()
  });

  PATTERNS.push({
    id: 'L3-3', level: 3, name: '年年有余', desc: '双鱼抱珠，富贵有余',
    pieces: (function () {
      var wave = WAVE();
      return [
        { id: 'wave1', group: 'wave', color: COL.redSoft, cmds: XF(wave, { dx: 190, dy: 498 }) },
        { id: 'wave2', group: 'wave', color: COL.redSoft, cmds: XF(wave, { dx: 450, dy: 528 }) },
        { id: 'tailL', color: COL.redDeep, cmds: XF(
            BLOB([[0, 0], [-62, -64], [-24, -14], [-62, 66], [0, 5]]), { dx: 222, dy: 278 }) },
        { id: 'tailR', color: COL.redDeep, cmds: XF(
            BLOB([[0, 0], [62, -64], [24, -14], [62, 66], [0, 5]]), { dx: 678, dy: 278 }) },
        { id: 'bodyL', color: COL.red, cmds: MERGE(ELL(312, 278, 104, 70), CIR(372, 258, 9, 24)) },
        { id: 'bodyR', color: COL.red, cmds: MERGE(ELL(588, 278, 104, 70), CIR(528, 258, 9, 24)) },
        { id: 'pearl', color: COL.gold, cmds: MERGE(CIR(450, 300, 52), CIR(450, 300, 24)) },
        { id: 'knot', color: COL.gold, cmds: MERGE(RR(450, 175, 66, 66, 8, 45), CIR(450, 175, 13)) }
      ];
    })()
  });

  /* ---------- 导出 ---------- */
  global.PCPatterns = {
    BOARD: { w: 900, h: 640 },
    COL: COL,
    LEVELS: [
      { level: 1, name: '童心巧手', tag: '儿童益智', desc: '萌新拼图玩法：碎片大、数量少，五颜六色最好玩', previewIndex: 0 },
      { level: 2, name: '指尖飞花', tag: '青年普通', desc: '折三折，沿虚线剪出精细窗花', previewIndex: 1 },
      { level: 3, name: '岁月静好', tag: '老年闲玩', desc: '折两折慢慢剪，大线条不限时', previewIndex: 1 }
    ],
    PATTERNS: PATTERNS,
    FOLDCUT: FOLDCUT
  };
})(typeof window !== 'undefined' ? window : globalThis);
