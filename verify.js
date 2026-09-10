/* 图案数据校验 + ASCII 渲染预览（Node 运行，无需浏览器）
 * 用法: node verify.js [--render]
 */
'use strict';
require('./js/patterns.js');
var PC = globalThis.PCPatterns;
var fail = 0;

function ok(cond, msg) {
  if (cond) { if (!QUIET) console.log('  ✓ ' + msg); }
  else { console.log('  ✗ FAIL: ' + msg); fail++; }
}

/* ---------- 1. 数据结构校验 ---------- */
var QUIET = process.argv.indexOf('--render') >= 0 || process.argv.indexOf('--dump') >= 0;
console.log('== 数据校验' + (QUIET ? '（静默，异常才输出） ==' : ' =='));
ok(Array.isArray(PC.PATTERNS) && PC.PATTERNS.length === 9, '共 9 个图案');
var byLevel = { 1: [], 2: [], 3: [] };
PC.PATTERNS.forEach(function (p) { byLevel[p.level].push(p); });
[1, 2, 3].forEach(function (lv) { ok(byLevel[lv].length === 3, '第' + lv + '关有 3 个图案'); });

var W = PC.BOARD.w, H = PC.BOARD.h;

/* ---------- 1.5 折纸剪裁数据校验 ---------- */
(function () {
  if (!PC.FOLDCUT) return;
  var P = PC.FOLDCUT.PAPER;
  [2, 3].forEach(function (lv) {
    var cfg = PC.FOLDCUT.levels[lv];
    ok(!!cfg, '第' + lv + '关折剪配置存在');
    if (!cfg) return;
    var hasD = cfg.folds.indexOf('d') >= 0;
    ok(cfg.folds.length === (lv === 2 ? 3 : 2), '第' + lv + '关折数正确(' + cfg.folds.join(',') + ')');
    ok(cfg.tol > 0, '第' + lv + '关容差 ' + cfg.tol);
    ok(cfg.lines.length >= 5, '第' + lv + '关剪裁线 ' + cfg.lines.length + ' 条');
    var bad = 0, closed = 0;
    cfg.lines.forEach(function (L) {
      if (!L.pts || L.pts.length < 2) { bad++; return; }
      if (L.closed) closed++;
      L.pts.forEach(function (pt) {
        var x = pt[0], y = pt[1];
        var inRect = x >= 0 && x <= P && y >= 0 && y <= P;
        if (hasD) {
          if (L.closed && x + y > 235) bad++;      /* 剪孔必须落在楔形内 */
          if (!L.closed && x + y > 465) bad++;     /* 边缘线允许贴对角折痕 */
        } else if (!inRect) { bad++; }
        if (x < -1 || x > P + 1 || y < -1 || y > P + 1) bad++;
      });
    });
    ok(bad === 0, '第' + lv + '关剪裁线坐标合法（非法 ' + bad + '，闭合剪孔 ' + closed + '）');
  });
})();

PC.PATTERNS.forEach(function (p) {
  var n = p.pieces.length;
  var range = p.level === 1 ? [4, 10] : (p.level === 2 ? [6, 14] : [4, 10]);
  ok(n >= range[0] && n <= range[1], p.id + ' ' + p.name + ' 碎片数 ' + n + ' 在范围内 ' + range[0] + '-' + range[1]);

  var ids = {};
  var groups = {};
  p.pieces.forEach(function (piece) {
    if (!piece.id || !piece.color || !Array.isArray(piece.cmds) || piece.cmds.length === 0) {
      ok(false, p.id + '/' + piece.id + ' 基本字段缺失');
      return;
    }
    ok(!ids[piece.id], p.id + ' 碎片 id 唯一: ' + piece.id);
    ids[piece.id] = 1;
    if (piece.group) {
      groups[piece.group] = (groups[piece.group] || 0) + 1;
    }
  });
  Object.keys(groups).forEach(function (g) {
    ok(groups[g] >= 2, p.id + ' 分组 ' + g + ' 有 ' + groups[g] + ' 个可互换成员');
  });

  /* 指令合法性与坐标范围 */
  var bad = 0, out = 0, xs = [], ys = [];
  p.pieces.forEach(function (piece) {
    var cur = null;
    piece.cmds.forEach(function (c) {
      var t = c[0];
      if (t !== 'M' && t !== 'L' && t !== 'C' && t !== 'Z') bad++;
      for (var i = 1; i < c.length; i++) {
        if (!isFinite(c[i])) bad++;
        else {
          xs.push(c[i]);
          if (i % 2 === 1) { if (c[i] < -60 || c[i] > W + 60) out++; }
          else { if (c[i] < -60 || c[i] > H + 60) out++; }
        }
      }
      if (t === 'M') cur = [c[1], c[2]];
    });
  });
  ok(bad === 0, p.id + ' 指令均合法（非法 ' + bad + '）');
  ok(out === 0, p.id + ' 坐标均在画板范围内（越界 ' + out + '）');
});

/* ---------- 2. 渲染（每块各自 evenodd，块间取并集，与游戏渲染一致） ---------- */
function flatten(cmds) {
  /* 返回多段折线（每段为一组点），供偶奇规则测试 */
  var polys = [], cur = null;
  cmds.forEach(function (c) {
    var t = c[0];
    if (t === 'M') { if (cur) polys.push(cur); cur = [[c[1], c[2]]]; }
    else if (t === 'L') { cur.push([c[1], c[2]]); }
    else if (t === 'C') {
      var x0 = cur[cur.length - 1][0], y0 = cur[cur.length - 1][1];
      for (var s = 1; s <= 8; s++) {
        var u = s / 8, v = 1 - u;
        cur.push([
          v * v * v * x0 + 3 * v * v * u * c[1] + 3 * v * u * u * c[3] + u * u * u * c[5],
          v * v * v * y0 + 3 * v * v * u * c[2] + 3 * v * u * u * c[4] + u * u * u * c[6]
        ]);
      }
    }
  });
  if (cur) polys.push(cur);
  return polys;
}

function insideEvenOdd(polys, x, y) {
  var cross = 0;
  polys.forEach(function (pts) {
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) cross++;
    }
  });
  return (cross % 2) === 1;
}

var COLS = 90, ROWS = 40;
function filledAt(p, x, y) {
  for (var i = 0; i < p.pieces.length; i++) {
    if (insideEvenOdd(p._polys[i], x, y)) return true;
  }
  return false;
}

if (process.argv.indexOf('--render') >= 0 || process.argv.indexOf('--dump') >= 0) {
  var onlyArg = process.argv.filter(function (a) { return a.indexOf('--only=') === 0; })[0];
  var only = onlyArg ? onlyArg.slice(7) : null;
  console.log('\n== 渲染 ==');
  PC.PATTERNS.forEach(function (p) {
    if (only && p.id !== only && p.name !== only) return;
    p._polys = p.pieces.map(function (piece) { return flatten(piece.cmds); });
    console.log('\n--- ' + p.id + ' ' + p.name + ' (' + p.pieces.length + ' 块) ---');
    for (var r = 0; r < ROWS; r++) {
      var y = (r + 0.5) * H / ROWS;
      if (process.argv.indexOf('--dump') >= 0) {
        var segs = [], st = null;
        for (var c2 = 0; c2 < COLS; c2++) {
          var x2 = (c2 + 0.5) * W / COLS;
          if (filledAt(p, x2, y)) { if (st === null) st = x2; }
          else if (st !== null) { segs.push([Math.round(st), Math.round(x2)]); st = null; }
        }
        if (st !== null) segs.push([Math.round(st), Math.round(W)]);
        console.log('y=' + y.toFixed(0).padStart(3) + ' | ' + (segs.length
          ? segs.map(function (s) { return s[0] + '-' + s[1]; }).join('  ') : '(空)'));
      } else {
        var line = '';
        for (var c3 = 0; c3 < COLS; c3++) {
          line += filledAt(p, (c3 + 0.5) * W / COLS, y) ? '█' : '·';
        }
        console.log(line);
      }
    }
    delete p._polys;
  });
}

console.log(fail === 0 ? '\n全部通过 ✓' : '\n有 ' + fail + ' 项失败 ✗');
process.exit(fail === 0 ? 0 : 1);
