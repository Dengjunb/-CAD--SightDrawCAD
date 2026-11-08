/* =========================================================================
   CAD 风格绘图工作区  mdraw.js
   功能区 / 命令行 / 图层 / 对象捕捉 / 动态输入 / 模型·布局
   对外接口 window.MDraw（与旧版兼容）：build show hide isVisible entities
   selected fit setTool exportDXF grid state
   ========================================================================= */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var STORE_KEY = 'mdraw.draft.v3';
  var MIN_ZOOM = 0.005;
  var MAX_ZOOM = 400;

  var KIND_NAME = { line: '直线', polyline: '多段线', rect: '矩形', circle: '圆', arc: '圆弧', text: '文字', hatch: '填充', insert: '块引用' };
  var LTYPES = {
    continuous: { name: 'Continuous', dash: '' },
    dashed: { name: 'Dashed', dash: '9 5' },
    dashdot: { name: 'DashDot', dash: '14 5 3 5' }
  };

  var DEFAULT_LAYERS = [
    { id: '0', name: '0', color: '#e8eef8', ltype: 'continuous', visible: true, locked: false },
    { id: 'outline', name: '轮廓线', color: '#8ecbff', ltype: 'continuous', visible: true, locked: false },
    { id: 'center', name: '中心线', color: '#ff8b8b', ltype: 'dashdot', visible: true, locked: false },
    { id: 'dim', name: '标注', color: '#7be0a6', ltype: 'continuous', visible: true, locked: false },
    { id: 'aux', name: '辅助线', color: '#93a0b3', ltype: 'dashed', visible: true, locked: false }
  ];

  var ALIAS = {
    L: 'line', LINE: 'line', PL: 'polyline', PLINE: 'polyline',
    REC: 'rect', RECT: 'rect', RECTANG: 'rect', RECTANGLE: 'rect',
    C: 'circle', CIRCLE: 'circle', A: 'arc', ARC: 'arc',
    M: 'move', MOVE: 'move', CO: 'copy', CP: 'copy', COPY: 'copy',
    RO: 'rotate', ROTATE: 'rotate', MI: 'mirror', MIRROR: 'mirror',
    O: 'offset', OFFSET: 'offset', SC: 'scale', SCALE: 'scale',
    AR: 'array', ARRAY: 'array',
    TR: 'trim', TRIM: 'trim', EX: 'extend', EXTEND: 'extend', AUTO: 'autodim',
    TED: 'textedit', TEXTEDIT: 'textedit', RC: 'revcloud', REVCLOUD: 'revcloud', BOMR: 'bomrefresh',
    H: 'hatch', HATCH: 'hatch', HP: 'hatch45', HC: 'hatchcross', AT: 'attr', BE: 'bedit', BEDIT: 'bedit', BC: 'bclose', BCLOSE: 'bclose', TB: 'table', TABLE: 'table', BOM: 'bom', B: 'block', BLOCK: 'block', I: 'insert', INSERT: 'insert',
    DIM: 'dim', DIAD: 'dimdia', DDR: 'dimdia', LE: 'leader', LEADER: 'leader',
    E: 'erase', ERASE: 'erase', DEL: 'erase',
    X: 'explode', EXPLODE: 'explode', DI: 'dist', DIST: 'dist',
    Z: 'zoom', ZOOM: 'zoom', P: 'pan', PAN: 'pan',
    U: 'undo', UNDO: 'undo', REDO: 'redo',
    LA: 'layers', LAYER: 'layers', PR: 'props', PROPERTIES: 'props',
    OS: 'osnap', OSNAP: 'osnap', GRID: 'grid', ORTHO: 'ortho', POLAR: 'polar',
    DXFOUT: 'export', EXPORT: 'export', QSAVE: 'save', SAVE: 'save',
    HELP: 'help', '?': 'help',
    SS: 'selsame', SELECTSIMILAR: 'selsame'
  };

  var CMD_LABEL = {
    line: '直线', polyline: '多段线', rect: '矩形', circle: '圆', arc: '圆弧',
    move: '移动', copy: '复制', rotate: '旋转', mirror: '镜像', offset: '偏移',
    scale: '缩放', array: '阵列', trim: '修剪', extend: '延伸', dim: '线性标注', dimdia: '直径标注', autodim: '自动标注', leader: '引线标注', hatch: '填充', hatch45: '剖面线', hatchcross: '交叉线', attr: '块属性', table: '表格', bom: '明细栏', bedit: '块编辑', bclose: '保存块编辑', textedit: '文字编辑', revcloud: '修订云线', bomrefresh: '刷新明细栏', block: '块定义', insert: '插入块', insertRef: '块引用', erase: '删除', explode: '分解', dist: '距离',
    zoom: '缩放视图', pan: '平移', undo: '撤销', redo: '重做',
    layers: '图层管理器', props: '特性面板', osnap: '对象捕捉设置',
    grid: '栅格开关', ortho: '正交开关', polar: '极轴开关',
    export: '导出 DXF', save: '保存草稿', help: '操作说明', selsame: '选择同类'
  };

  /* 命令行补全：主别名 / 中文名（AutoCAD 命令行提示的简化版） */
  var CMD_LIST = [
    ['line', 'L'], ['polyline', 'PL'], ['rect', 'REC'], ['circle', 'C'], ['arc', 'A'],
    ['move', 'M'], ['copy', 'CO'], ['rotate', 'RO'], ['mirror', 'MI'], ['offset', 'O'],
    ['scale', 'SC'], ['array', 'AR'], ['trim', 'TR'], ['extend', 'EX'], ['dim', 'DIM'], ['dimdia', 'DIAD'], ['autodim', 'AUTO'], ['leader', 'LE'], ['hatch', 'H'], ['hatch45', 'HP'], ['hatchcross', 'HC'], ['attr', 'AT'], ['table', 'TB'], ['bom', 'BOM'], ['block', 'B'], ['insert', 'I'], ['erase', 'E'], ['explode', 'X'], ['dist', 'DI'],
    ['selsame', 'SS'], ['zoom', 'Z'], ['pan', 'P'], ['undo', 'U'], ['redo', 'REDO'],
    ['layers', 'LA'], ['props', 'PR'], ['osnap', 'OS'], ['grid', 'GRID'],
    ['ortho', 'ORTHO'], ['polar', 'POLAR'], ['export', 'DXFOUT'], ['save', 'QSAVE'], ['help', '?']
  ];
  var ALIAS_BY_CMD = (function () {
    var m = {};
    Object.keys(ALIAS).forEach(function (k) {
      var c = ALIAS[k];
      (m[c] || (m[c] = [])).push(k);
    });
    return m;
  })();

  /* ---------------- 基础工具 ---------------- */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function norm2pi(a) { a = a % (Math.PI * 2); return a < 0 ? a + Math.PI * 2 : a; }
  function deg(r) { return r * 180 / Math.PI; }
  function rad(d) { return d * Math.PI / 180; }
  function normDeg(d) { d = d % 360; return d < 0 ? d + 360 : d; }
  function round4(v) { return Math.round(v * 10000) / 10000; }
  function fmt(v, n) {
    if (!isFinite(v)) return '0';
    return (Math.round(v * Math.pow(10, n)) / Math.pow(10, n)).toFixed(n);
  }
  function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
  function deepClone(v) { return JSON.parse(JSON.stringify(v)); }
  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    return n;
  }
  function clearNode(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function isField(el) {
    if (!el) return false;
    var t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable;
  }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /* ---------------- 状态 ---------------- */
  var state = {
    entities: [],
    dimSets: [],
    dimStyle: { textSize: 3.5, arrow: 5, precision: 2, tolMode: 'none', tol: 0.05, tol2: 0.02, arrowStyle: 'hollow' },
    sheet: { title: '手动绘图练习', code: 'A3-001', scale: '1 : 1', designer: '—', unit: 'mm' },
    layouts: [{ name: '布局1', sheet: { title: '手动绘图练习', code: 'A3-001', scale: '1 : 1', designer: '—', unit: 'mm' } },
              { name: '布局2', sheet: { title: '装配图', code: 'A3-002', scale: '1 : 2', designer: '—', unit: 'mm' } }],
    curLayout: 0,
    printStyle: { lw: 1, mono: false },
    printMap: {},
    cloudBump: 5,
    snapshot: null,
    diffIds: null,
    tables: {},
    layerStates: [],
    tableAlign: 'left',
    dimTpls: [],
    snaps: [],
    lastBlock: null,
    layerIso: null,
    blocks: {},
    blockSeq: 1,
    lastBlock: null,
    selection: new Set(),
    layers: deepClone(DEFAULT_LAYERS),
    curLayer: '0',
    curColor: null,   /* null = ByLayer；否则 #rrggbb */
    bg: 'light',      /* dark | light（白底，默认浅色） */
    space: 'model',
    tool: 'select',
    cmd: null,
    lastCmd: null,
    grid: 10,
    gridOn: true,
    snapOn: true,
    orthoOn: false,
    polarOn: false,
    lwOn: true,
    dynOn: true,
    crossPct: 100,
    pickPx: 8,
    polarStep: 15,
    osnap: {
      endpoint: true, midpoint: true, center: true, quadrant: true,
      intersection: true, perpendicular: false, nearest: false
    },
    view: { tx: 0, ty: 0, zoom: 1 },
    viewInit: false,
    pointer: { x: 0, y: 0, wx: 0, wy: 0, inside: false },
    snap: null,
    lastPoint: null,
    dyn: { fields: [], idx: 0, buf: '', values: [] },
    restored: 0
  };

  var els = {};
  var built = false;
  var drag = null;
  var hoverId = null;
  var cyclePick = { t: 0, x: 0, y: 0, ids: [], idx: 0 };
  var shiftDown = false;
  var undoStack = [];
  var redoStack = [];
  var nudgeSession = null;
  var nudgeTimer = 0;
  var saveTimer = 0;
  var toastTimer = 0;
  var idSeq = 1;
  var gridSig = '';
  var cmdHistory = [];
  var cmdHistIdx = -1;
  var sideTab = 'props';
  var menuOpen = null;
  var lastDxfText = '';
  var lastScreen = { x: 0, y: 0 };
  var dimStyle = { textSize: 3.5, arrow: 5, precision: 2 };

  function uid() { return 'e' + (idSeq++).toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

  /* ---------------- 图层 ---------------- */
  function layerList() { return state.layers; }
  function layerById(id) {
    for (var i = 0; i < state.layers.length; i++) if (state.layers[i].id === id) return state.layers[i];
    return state.layers[0];
  }
  function layerOf(e) { return layerById(e.layer || state.curLayer); }
  function layerName(id) { return layerById(id).name; }
  function entityVisible(e) {
    if (state.layerIso && !state.layerIso[String(e.layer)]) return false; var L = layerOf(e); return L.visible && (!e.hidden); }
  function editable(e) { var L = layerOf(e); return L.visible && !L.locked && !e.locked; }
  function entityColor(e) { var L = layerOf(e); return e.color || L.color; }
  function displayColor(e) {
    var c = entityColor(e);
    if (state.bg !== 'light') return c;
    var h = String(c).replace('#', '');
    if (h.length === 3) h = h.split('').map(function (k) { return k + k; }).join('');
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    if (!isFinite(r)) return c;
    /* 相对亮度（近似）：太亮在白底上看不见，换成深灰 */
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.72 ? '#1f2933' : c;
  }
  function entityDash(e) { var L = layerOf(e); return (LTYPES[e.ltype || L.ltype] || LTYPES.continuous).dash; }

  /* ---------------- 几何 ---------------- */
  function ptSeg(px, py, x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
    var t = len2 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
  }

  function arcSweep(e) { return e.dir > 0 ? norm2pi(e.a1 - e.a0) : norm2pi(e.a0 - e.a1); }
  function arcPointAt(e, a) { return { x: e.cx + e.r * Math.cos(a), y: e.cy + e.r * Math.sin(a) }; }
  function arcContainsAngle(e, a) {
    var rel = e.dir > 0 ? norm2pi(a - e.a0) : norm2pi(e.a0 - a);
    return rel <= arcSweep(e) + 1e-9;
  }

  /* 三点定弧：p0 起点、p1 终点、p2 弧上一点 */
  function arcFrom3(p0, p1, p2) {
    var d = 2 * (p0.x * (p1.y - p2.y) + p1.x * (p2.y - p0.y) + p2.x * (p0.y - p1.y));
    if (Math.abs(d) < 1e-9) return null;
    var a2 = p0.x * p0.x + p0.y * p0.y;
    var b2 = p1.x * p1.x + p1.y * p1.y;
    var c2 = p2.x * p2.x + p2.y * p2.y;
    var cx = (a2 * (p1.y - p2.y) + b2 * (p2.y - p0.y) + c2 * (p0.y - p1.y)) / d;
    var cy = (a2 * (p2.x - p1.x) + b2 * (p0.x - p2.x) + c2 * (p1.x - p0.x)) / d;
    var r = Math.hypot(p0.x - cx, p0.y - cy);
    if (!isFinite(r) || r > 1e6) return null;
    var a0 = Math.atan2(p0.y - cy, p0.x - cx);
    var a1 = Math.atan2(p1.y - cy, p1.x - cx);
    var am = Math.atan2(p2.y - cy, p2.x - cx);
    var dPlus = norm2pi(a1 - a0);
    var mPlus = norm2pi(am - a0);
    var dir = mPlus <= dPlus ? 1 : -1;
    return { cx: round4(cx), cy: round4(cy), r: round4(r), a0: a0, a1: a1, dir: dir };
  }

  function polySegs(e) {
    var out = [], p = e.pts;
    for (var i = 1; i < p.length; i++) out.push([p[i - 1].x, p[i - 1].y, p[i].x, p[i].y]);
    if (e.closed && p.length > 2) out.push([p[p.length - 1].x, p[p.length - 1].y, p[0].x, p[0].y]);
    return out;
  }

  function entityBounds(e) {
    if (e.kind === 'line' || e.kind === 'rect') {
      return {
        x0: Math.min(e.x0, e.x1), y0: Math.min(e.y0, e.y1),
        x1: Math.max(e.x0, e.x1), y1: Math.max(e.y0, e.y1)
      };
    }
    if (e.kind === 'polyline' || e.kind === 'hatch') {
      var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      e.pts.forEach(function (p) {
        b.x0 = Math.min(b.x0, p.x); b.y0 = Math.min(b.y0, p.y);
        b.x1 = Math.max(b.x1, p.x); b.y1 = Math.max(b.y1, p.y);
      });
      if (!isFinite(b.x0)) b = { x0: 0, y0: 0, x1: 0, y1: 0 };
      return b;
    }
    if (e.kind === 'circle') return { x0: e.cx - e.r, y0: e.cy - e.r, x1: e.cx + e.r, y1: e.cy + e.r };
    if (e.kind === 'insert') {
      var blk0 = state.blocks[e.name];
      if (!blk0) return { x0: e.x, y0: e.y, x1: e.x, y1: e.y };
      var dxb = e.x - blk0.base.x, dyb = e.y - blk0.base.y;
      var bb0 = unionBounds(blk0.entities);
      return { x0: bb0.x0 + dxb, y0: bb0.y0 + dyb, x1: bb0.x1 + dxb, y1: bb0.y1 + dyb };
    }
    if (e.kind === 'text') {
      var sz = e.size || 3.5, wch = (e.text || '').length * sz * 0.62;
      return { x0: e.cx, y0: e.cy - sz, x1: e.cx + Math.max(wch, sz), y1: e.cy + sz * 0.3 };
    }
    var n = 64, sweep = arcSweep(e), bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (var i = 0; i <= n; i++) {
      var p2 = arcPointAt(e, e.a0 + e.dir * sweep * i / n);
      bx0 = Math.min(bx0, p2.x); by0 = Math.min(by0, p2.y);
      bx1 = Math.max(bx1, p2.x); by1 = Math.max(by1, p2.y);
    }
    return { x0: bx0, y0: by0, x1: bx1, y1: by1 };
  }

  function unionBounds(list) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    list.forEach(function (e) {
      var eb = entityBounds(e);
      b.x0 = Math.min(b.x0, eb.x0); b.y0 = Math.min(b.y0, eb.y0);
      b.x1 = Math.max(b.x1, eb.x1); b.y1 = Math.max(b.y1, eb.y1);
    });
    return b;
  }

  function distToEntity(px, py, e) {
    if (e.kind === 'line') return ptSeg(px, py, e.x0, e.y0, e.x1, e.y1);
    if (e.kind === 'rect') {
      var b = entityBounds(e);
      return Math.min(
        ptSeg(px, py, b.x0, b.y0, b.x1, b.y0),
        ptSeg(px, py, b.x1, b.y0, b.x1, b.y1),
        ptSeg(px, py, b.x1, b.y1, b.x0, b.y1),
        ptSeg(px, py, b.x0, b.y1, b.x0, b.y0)
      );
    }
    if (e.kind === 'polyline' || e.kind === 'hatch') {
      var dmin = Infinity, segs = polySegs(e);
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        dmin = Math.min(dmin, ptSeg(px, py, s[0], s[1], s[2], s[3]));
      }
      return dmin;
    }
    if (e.kind === 'insert') {
      var blk1 = state.blocks[e.name];
      if (!blk1) return Infinity;
      var dx1 = e.x - blk1.base.x, dy1 = e.y - blk1.base.y;
      var dm = Infinity;
      blk1.entities.forEach(function (ce) {
        var cc = deepClone(ce); translateEntity(cc, ce, dx1, dy1);
        dm = Math.min(dm, distToEntity(px, py, cc));
      });
      return dm;
    }
    if (e.kind === 'text') {
      var bb = entityBounds(e);
      var dx0 = Math.max(bb.x0, Math.min(px, bb.x1)), dy0 = Math.max(bb.y0, Math.min(py, bb.y1));
      return Math.hypot(px - dx0, py - dy0);
    }
    var dd = Math.abs(Math.hypot(px - e.cx, py - e.cy) - e.r);
    if (e.kind === 'circle') return dd;
    var ang = Math.atan2(py - e.cy, px - e.cx);
    if (arcContainsAngle(e, ang)) return dd;
    var p0 = arcPointAt(e, e.a0), p1 = arcPointAt(e, e.a1);
    return Math.min(dist(px, py, p0.x, p0.y), dist(px, py, p1.x, p1.y));
  }

  function pickTol() { return Math.max(3, (state.pickPx || 8) / 2 + 2.5) / state.view.zoom; }

  function hitTest(px, py, list) {
    var best = null, bestD = pickTol();
    var arr = list || state.entities;
    for (var i = arr.length - 1; i >= 0; i--) {
      var e = arr[i];
      if (!entityVisible(e) || layerOf(e).locked || e.locked) continue;
      var d = distToEntity(px, py, e);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /* 同一点命中的全部对象（按距离由近到远），用于重叠对象选择循环 */
  function hitTestAll(px, py) {
    var tol = pickTol(), out = [];
    for (var i = state.entities.length - 1; i >= 0; i--) {
      var e = state.entities[i];
      if (!entityVisible(e) || layerOf(e).locked) continue;
      var d = distToEntity(px, py, e);
      if (d <= tol) out.push({ e: e, d: d });
    }
    out.sort(function (a, b) { return a.d - b.d; });
    return out.map(function (o) { return o.e; });
  }

  function entityMeta(e) {
    if (e.kind === 'line') return 'L ' + fmt(dist(e.x0, e.y0, e.x1, e.y1), 1);
    if (e.kind === 'polyline') return e.pts.length + ' 点' + (e.closed ? ' · 闭合' : '');
    if (e.kind === 'rect') return fmt(Math.abs(e.x1 - e.x0), 1) + ' × ' + fmt(Math.abs(e.y1 - e.y0), 1);
    if (e.kind === 'circle') return 'R ' + fmt(e.r, 1);
    return 'R ' + fmt(e.r, 1) + ' · ' + fmt(deg(arcSweep(e)), 0) + '°';
  }

  function lineAngle(p0, p1) {
    return deg(Math.atan2(-(p1.y - p0.y), p1.x - p0.x));
  }

  /* 屏幕坐标系旋转（视觉逆时针 θ 为正） */
  function rotatePoint(p, base, th) {
    var dx = p.x - base.x, dy = p.y - base.y;
    var c = Math.cos(th), s = Math.sin(th);
    return { x: base.x + dx * c + dy * s, y: base.y - dx * s + dy * c };
  }
  function reflectPoint(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var l2 = dx * dx + dy * dy;
    if (!l2) return { x: p.x, y: p.y };
    var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    var fx = a.x + t * dx, fy = a.y + t * dy;
    return { x: 2 * fx - p.x, y: 2 * fy - p.y };
  }
  function scalePoint(p, base, k) {
    return { x: base.x + (p.x - base.x) * k, y: base.y + (p.y - base.y) * k };
  }

  function mapEntity(e, fn) {
    var c = deepClone(e);
    if (c.kind === 'line' || c.kind === 'rect') {
      var p0 = fn({ x: c.x0, y: c.y0 }), p1 = fn({ x: c.x1, y: c.y1 });
      c.x0 = p0.x; c.y0 = p0.y; c.x1 = p1.x; c.y1 = p1.y;
    } else if (c.kind === 'insert') {
      var pi = fn({ x: c.x, y: c.y }); c.x = pi.x; c.y = pi.y;
    } else if (c.kind === 'polyline' || c.kind === 'hatch') {
      c.pts = c.pts.map(fn);
    } else {
      var pc = fn({ x: c.cx, y: c.cy });
      c.cx = pc.x; c.cy = pc.y;
    }
    return c;
  }

  function translateEntity(e, src, dx, dy) {
    if (e.kind === 'line' || e.kind === 'rect') {
      e.x0 = src.x0 + dx; e.y0 = src.y0 + dy; e.x1 = src.x1 + dx; e.y1 = src.y1 + dy;
    } else if (e.kind === 'insert') {
      e.x = (src.x || 0) + dx; e.y = (src.y || 0) + dy;
    } else if (e.kind === 'polyline' || e.kind === 'hatch') {
      e.pts = src.pts.map(function (p) { return { x: p.x + dx, y: p.y + dy }; });
    } else {
      e.cx = src.cx + dx; e.cy = src.cy + dy;
    }
  }

  function rotateEntity(e, base, th) {
    var c = mapEntity(e, function (p) { return rotatePoint(p, base, th); });
    if (c.kind === 'arc') { c.a0 = c.a0 - th; c.a1 = c.a1 - th; }
    ['x0', 'x1', 'cx', 'pts'].forEach(function () { });
    return roundEntity(c);
  }

  function scaleEntity(e, base, k) {
    var c = mapEntity(e, function (p) { return scalePoint(p, base, k); });
    if (c.kind === 'arc' || c.kind === 'circle') c.r = Math.abs(e.r * k);
    if (c.kind === 'arc' && k < 0) { c.a0 += Math.PI; c.a1 += Math.PI; }
    return roundEntity(c);
  }

  function mirrorEntity(e, a, b) {
    var c = mapEntity(e, function (p) { return reflectPoint(p, a, b); });
    if (c.kind === 'arc') {
      var ang = Math.atan2(b.y - a.y, b.x - a.x);
      c.a0 = 2 * ang - c.a0; c.a1 = 2 * ang - c.a1; c.dir = -c.dir;
    }
    return roundEntity(c);
  }

  function roundEntity(e) {
    if (e.kind === 'line' || e.kind === 'rect') {
      e.x0 = round4(e.x0); e.y0 = round4(e.y0); e.x1 = round4(e.x1); e.y1 = round4(e.y1);
    } else if (e.kind === 'insert') {
      e.x = round4(e.x); e.y = round4(e.y);
    } else if (e.kind === 'polyline' || e.kind === 'hatch') {
      e.pts.forEach(function (p) { p.x = round4(p.x); p.y = round4(p.y); });
    } else {
      e.cx = round4(e.cx); e.cy = round4(e.cy);
      if (e.kind === 'circle' || e.kind === 'arc') e.r = round4(e.r);
    }
    return e;
  }

  function cloneEntity(e) {
    var c = deepClone(e);
    c.id = uid();
    return c;
  }

  function offsetEntity(e, d, side) {
    if (e.kind === 'line') {
      var dx = e.x1 - e.x0, dy = e.y1 - e.y0, L = Math.hypot(dx, dy);
      if (!L) return null;
      var nx = -dy / L, ny = dx / L;
      var cross = dx * (side.y - e.y0) - dy * (side.x - e.x0);
      var sg = cross >= 0 ? 1 : -1;
      return {
        id: uid(), kind: 'line', layer: e.layer,
        x0: round4(e.x0 + nx * d * sg), y0: round4(e.y0 + ny * d * sg),
        x1: round4(e.x1 + nx * d * sg), y1: round4(e.y1 + ny * d * sg)
      };
    }
    if (e.kind === 'circle' || e.kind === 'arc') {
      var outside = dist(side.x, side.y, e.cx, e.cy) > e.r;
      var r = outside ? e.r + d : e.r - d;
      if (r < 0.5) return null;
      var c = deepClone(e);
      c.id = uid(); c.r = round4(r);
      return c;
    }
    if (e.kind === 'rect') {
      var b = entityBounds(e);
      var outsideR = side.x < b.x0 || side.x > b.x1 || side.y < b.y0 || side.y > b.y1;
      var s = outsideR ? d : -d;
      if (Math.abs(b.x1 - b.x0 + 2 * s) < 0.6 || Math.abs(b.y1 - b.y0 + 2 * s) < 0.6) return null;
      return {
        id: uid(), kind: 'rect', layer: e.layer,
        x0: round4(b.x0 - s), y0: round4(b.y0 - s),
        x1: round4(b.x1 + s), y1: round4(b.y1 + s)
      };
    }
    return null;
  }

  function explodeEntity(e) {
    if (e.kind === 'insert') {
      var bk = state.blocks[e.name];
      if (!bk) return null;
      var dxe = e.x - bk.base.x, dye = e.y - bk.base.y;
      return bk.entities.map(function (ce) {
        var cc = deepClone(ce); cc.id = uid(); translateEntity(cc, ce, dxe, dye); return cc;
      });
    }
    var out = [];
    if (e.kind === 'rect') {
      var b = entityBounds(e);
      var c = [[b.x0, b.y0, b.x1, b.y0], [b.x1, b.y0, b.x1, b.y1], [b.x1, b.y1, b.x0, b.y1], [b.x0, b.y1, b.x0, b.y0]];
      c.forEach(function (l) {
        out.push({ id: uid(), kind: 'line', layer: e.layer, x0: l[0], y0: l[1], x1: l[2], y1: l[3] });
      });
      return out;
    }
    if (e.kind === 'polyline') {
      var segs = polySegs(e);
      segs.forEach(function (l) {
        out.push({ id: uid(), kind: 'line', layer: e.layer, x0: round4(l[0]), y0: round4(l[1]), x1: round4(l[2]), y1: round4(l[3]) });
      });
      return out;
    }
    return null;
  }

  /* ---------------- 坐标与视图 ---------------- */
  function zoneSize() {
    return { w: (els.zone && els.zone.clientWidth) || 900, h: (els.zone && els.zone.clientHeight) || 600 };
  }
  function w2s(x, y) {
    var v = state.view;
    return { x: x * v.zoom + v.tx, y: y * v.zoom + v.ty };
  }
  function s2w(x, y) {
    var v = state.view;
    return { x: (x - v.tx) / v.zoom, y: (y - v.ty) / v.zoom };
  }

  function resetView() {
    var s = zoneSize();
    state.view.zoom = 1;
    state.view.tx = Math.round(s.w / 2 - 190);
    state.view.ty = Math.round(s.h / 2 - 120);
  }

  function fit(silent) {
    var s = zoneSize();
    var list = state.entities.filter(entityVisible);
    if (!list.length) {
      resetView();
      redrawAll();
      return;
    }
    var b = unionBounds(list);
    var bw = Math.max(b.x1 - b.x0, 1), bh = Math.max(b.y1 - b.y0, 1);
    var pad = 72;
    var z = clamp(Math.min((s.w - pad * 2) / bw, (s.h - pad * 2) / bh), MIN_ZOOM, 40);
    state.view.zoom = z;
    state.view.tx = s.w / 2 - (b.x0 + b.x1) / 2 * z;
    state.view.ty = s.h / 2 - (b.y0 + b.y1) / 2 * z;
    redrawAll();
    if (!silent) msg('缩放至图形范围');
  }

  function zoomAt(sx, sy, factor) {
    if (state.space === 'layout') { layoutZoom(factor, sx, sy); return; }
    var before = s2w(sx, sy);
    state.view.zoom = clamp(state.view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    state.view.tx = sx - before.x * state.view.zoom;
    state.view.ty = sy - before.y * state.view.zoom;
    scheduleAll();
  }

  function zoomStep(mult) {
    var s = zoneSize();
    zoomAt(s.w / 2, s.h / 2, mult);
  }

  /* ---------------- 布局（A3 图框） ---------------- */
  function sheetRect() {
    var s = zoneSize();
    var pw = 420, ph = 297;
    var k = Math.min((s.w - 90) / pw, (s.h - 70) / ph);
    var w = pw * k, h = ph * k;
    return { x: (s.w - w) / 2, y: (s.h - h) / 2, w: w, h: h, k: k, pw: pw, ph: ph };
  }
  function innerRect(sh) {
    var m = 10 * sh.k;
    return { x: sh.x + m, y: sh.y + m, w: sh.w - m * 2, h: sh.h - m * 2 };
  }
  function fitLayout(silent) {
    var sh = sheetRect();
    var ir = innerRect(sh);
    var list = state.entities.filter(entityVisible);
    if (!list.length) { state.view.zoom = 1; state.view.tx = ir.x + ir.w / 2; state.view.ty = ir.y + ir.h / 2; redrawAll(); return; }
    var b = unionBounds(list);
    var bw = Math.max(b.x1 - b.x0, 1), bh = Math.max(b.y1 - b.y0, 1);
    var z = Math.min((ir.w * 0.86) / bw, (ir.h * 0.86) / bh);
    state.view.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
    state.view.tx = ir.x + ir.w / 2 - (b.x0 + b.x1) / 2 * z;
    state.view.ty = ir.y + ir.h / 2 - (b.y0 + b.y1) / 2 * z;
    redrawAll();
    if (!silent) msg('布局：A3 图框预览');
  }
  function layoutZoom(factor, sx, sy) {
    var before = s2w(sx, sy);
    state.view.zoom = clamp(state.view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    state.view.tx = sx - before.x * state.view.zoom;
    state.view.ty = sy - before.y * state.view.zoom;
    scheduleAll();
  }

  /* ---------------- 对象捕捉 ---------------- */
  function nearbyEntities(w) {
    var s = zoneSize();
    var a = s2w(0, 0), b = s2w(s.w, s.h);
    var pad = 80 / state.view.zoom;
    var out = [];
    for (var i = 0; i < state.entities.length; i++) {
      var e = state.entities[i];
      if (!entityVisible(e) || layerOf(e).locked) continue;
      var bb = entityBounds(e);
      if (bb.x1 < a.x - pad || bb.x0 > b.x + pad || bb.y1 < a.y - pad || bb.y0 > b.y + pad) continue;
      out.push(e);
      if (out.length >= 140) break;
    }
    return out;
  }

  function segList(list) {
    var segs = [];
    list.forEach(function (e) {
      if (e.kind === 'line') segs.push([e.x0, e.y0, e.x1, e.y1, e]);
      else if (e.kind === 'rect') {
        var b = entityBounds(e);
        segs.push([b.x0, b.y0, b.x1, b.y0, e], [b.x1, b.y0, b.x1, b.y1, e],
          [b.x1, b.y1, b.x0, b.y1, e], [b.x0, b.y1, b.x0, b.y0, e]);
      } else if (e.kind === 'polyline') {
        polySegs(e).forEach(function (s) { segs.push([s[0], s[1], s[2], s[3], e]); });
      }
    });
    return segs;
  }

  function segSegX(a, b) {
    var x1 = a[0], y1 = a[1], x2 = a[2], y2 = a[3];
    var x3 = b[0], y3 = b[1], x4 = b[2], y4 = b[3];
    var d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
    if (Math.abs(d) < 1e-12) return null;
    var t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
    var u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
  }

  function segCircleX(s, e) {
    var x0 = s[0], y0 = s[1], dx = s[2] - x0, dy = s[3] - y0;
    var fx = x0 - e.cx, fy = y0 - e.cy;
    var A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - e.r * e.r;
    if (A < 1e-12) return [];
    var disc = B * B - 4 * A * C;
    if (disc < 0) return [];
    var sq = Math.sqrt(disc), out = [];
    [-1, 1].forEach(function (sg) {
      var t = (-B + sg * sq) / (2 * A);
      if (t < -1e-9 || t > 1 + 1e-9) return;
      var px = x0 + t * dx, py = y0 + t * dy;
      if (e.kind === 'arc' && !arcContainsAngle(e, Math.atan2(py - e.cy, px - e.cx))) return;
      out.push({ x: px, y: py });
    });
    return out;
  }

  function circleCircleX(a, b) {
    var dx = b.cx - a.cx, dy = b.cy - a.cy, d = Math.hypot(dx, dy);
    if (d < 1e-9 || d > a.r + b.r || d < Math.abs(a.r - b.r)) return [];
    var x = (a.r * a.r - b.r * b.r + d * d) / (2 * d);
    var h2 = a.r * a.r - x * x;
    if (h2 < 0) return [];
    var h = Math.sqrt(h2), mx = a.cx + x * dx / d, my = a.cy + x * dy / d;
    var p1 = { x: mx - h * dy / d, y: my + h * dx / d };
    var p2 = { x: mx + h * dy / d, y: my - h * dx / d };
    var out = [];
    [p1, p2].forEach(function (p) {
      if (a.kind === 'arc' && !arcContainsAngle(a, Math.atan2(p.y - a.cy, p.x - a.cx))) return;
      if (b.kind === 'arc' && !arcContainsAngle(b, Math.atan2(p.y - b.cy, p.x - b.cx))) return;
      out.push(p);
    });
    return out;
  }

  function closestOnEntity(px, py, e) {
    if (e.kind === 'line') {
      var dx = e.x1 - e.x0, dy = e.y1 - e.y0, l2 = dx * dx + dy * dy;
      var t = l2 ? clamp(((px - e.x0) * dx + (py - e.y0) * dy) / l2, 0, 1) : 0;
      return { x: e.x0 + t * dx, y: e.y0 + t * dy };
    }
    if (e.kind === 'rect' || e.kind === 'polyline') {
      var segs = e.kind === 'rect' ? segList([e]) : polySegs(e).map(function (s) { return [s[0], s[1], s[2], s[3]]; });
      var best = null, bd = Infinity;
      segs.forEach(function (s) {
        var dx2 = s[2] - s[0], dy2 = s[3] - s[1], l2 = dx2 * dx2 + dy2 * dy2;
        var t = l2 ? clamp(((px - s[0]) * dx2 + (py - s[1]) * dy2) / l2, 0, 1) : 0;
        var q = { x: s[0] + t * dx2, y: s[1] + t * dy2 };
        var d = dist(px, py, q.x, q.y);
        if (d < bd) { bd = d; best = q; }
      });
      return best;
    }
    var ang = Math.atan2(py - e.cy, px - e.cx);
    if (e.kind === 'arc' && !arcContainsAngle(e, ang)) {
      var p0 = arcPointAt(e, e.a0), p1 = arcPointAt(e, e.a1);
      return dist(px, py, p0.x, p0.y) < dist(px, py, p1.x, p1.y) ? p0 : p1;
    }
    return { x: e.cx + e.r * Math.cos(ang), y: e.cy + e.r * Math.sin(ang) };
  }

  function osnapCandidates(w, anchor) {
    var out = [];
    var o = state.osnap;
    var list = nearbyEntities(w);
    var tol = 14 / state.view.zoom;
    var segs = segList(list);
    var arcs = list.filter(function (e) { return e.kind === 'circle' || e.kind === 'arc'; });

    function add(p, type, pri) {
      if (!p || !isFinite(p.x) || !isFinite(p.y)) return;
      var d = dist(w.x, w.y, p.x, p.y);
      if (d > tol) return;
      out.push({ x: p.x, y: p.y, type: type, d: d, pri: pri });
    }

    list.forEach(function (e) {
      if (o.endpoint) {
        if (e.kind === 'line') add({ x: e.x0, y: e.y0 }, '端点', 1), add({ x: e.x1, y: e.y1 }, '端点', 1);
        else if (e.kind === 'rect') {
          var b = entityBounds(e);
          add({ x: b.x0, y: b.y0 }, '端点', 1); add({ x: b.x1, y: b.y0 }, '端点', 1);
          add({ x: b.x1, y: b.y1 }, '端点', 1); add({ x: b.x0, y: b.y1 }, '端点', 1);
        } else if (e.kind === 'polyline') {
          e.pts.forEach(function (p) { add(p, '端点', 1); });
        } else if (e.kind === 'arc') {
          add(arcPointAt(e, e.a0), '端点', 1); add(arcPointAt(e, e.a1), '端点', 1);
        }
      }
      if (o.midpoint) {
        if (e.kind === 'line') add({ x: (e.x0 + e.x1) / 2, y: (e.y0 + e.y1) / 2 }, '中点', 3);
        else if (e.kind === 'rect') {
          var bb = entityBounds(e);
          add({ x: (bb.x0 + bb.x1) / 2, y: bb.y0 }, '中点', 3);
          add({ x: (bb.x0 + bb.x1) / 2, y: bb.y1 }, '中点', 3);
          add({ x: bb.x0, y: (bb.y0 + bb.y1) / 2 }, '中点', 3);
          add({ x: bb.x1, y: (bb.y0 + bb.y1) / 2 }, '中点', 3);
        } else if (e.kind === 'polyline') {
          polySegs(e).forEach(function (s) { add({ x: (s[0] + s[2]) / 2, y: (s[1] + s[3]) / 2 }, '中点', 3); });
        } else if (e.kind === 'arc') {
          add(arcPointAt(e, e.a0 + e.dir * arcSweep(e) / 2), '中点', 3);
        }
      }
      if (o.center && (e.kind === 'circle' || e.kind === 'arc')) add({ x: e.cx, y: e.cy }, '圆心', 2);
      if (o.quadrant && (e.kind === 'circle' || e.kind === 'arc')) {
        for (var q = 0; q < 4; q++) {
          var a = q * Math.PI / 2;
          if (e.kind === 'arc' && !arcContainsAngle(e, a)) continue;
          add(arcPointAt(e, a), '象限点', 4);
        }
      }
      if (o.nearest) add(closestOnEntity(w.x, w.y, e), '最近点', 8);
    });

    if (o.intersection) {
      var i, j;
      for (i = 0; i < segs.length; i++) {
        for (j = i + 1; j < segs.length; j++) {
          if (segs[i][4] === segs[j][4]) continue;
          add(segSegX(segs[i], segs[j]), '交点', 2);
        }
        for (j = 0; j < arcs.length; j++) {
          if (segs[i][4] === arcs[j]) continue;
          segCircleX(segs[i], arcs[j]).forEach(function (p) { add(p, '交点', 2); });
        }
      }
      for (i = 0; i < arcs.length; i++) {
        for (j = i + 1; j < arcs.length; j++) {
          circleCircleX(arcs[i], arcs[j]).forEach(function (p) { add(p, '交点', 2); });
        }
      }
    }

    if (o.perpendicular && anchor) {
      segs.forEach(function (s) {
        var dx = s[2] - s[0], dy = s[3] - s[1], l2 = dx * dx + dy * dy;
        if (!l2) return;
        var t = ((anchor.x - s[0]) * dx + (anchor.y - s[1]) * dy) / l2;
        if (t < 0 || t > 1) return;
        add({ x: s[0] + t * dx, y: s[1] + t * dy }, '垂足', 6);
      });
      arcs.forEach(function (e) {
        var ang = Math.atan2(anchor.y - e.cy, anchor.x - e.cx);
        if (e.kind === 'arc' && !arcContainsAngle(e, ang)) return;
        add(arcPointAt(e, ang), '垂足', 6);
      });
    }
    return out;
  }

  function snapPoint(w, anchor) {
    if (state.snapOn) {
      var cand = osnapCandidates(w, anchor);
      if (cand.length) {
        cand.sort(function (a, b) { return a.pri - b.pri || a.d - b.d; });
        return { x: cand[0].x, y: cand[0].y, type: cand[0].type };
      }
      if (state.gridOn) {
        var g = state.grid;
        if (g > 0) {
          return { x: Math.round(w.x / g) * g, y: Math.round(w.y / g) * g, type: '栅格' };
        }
      }
    }
    return { x: w.x, y: w.y, type: null };
  }

  function applyOrtho(p, anchor) {
    if (!anchor) return p;
    var dx = p.x - anchor.x, dy = p.y - anchor.y;
    var step = Math.PI / 2;
    var a = Math.round(Math.atan2(dy, dx) / step) * step;
    var len = Math.hypot(dx, dy);
    return { x: anchor.x + Math.cos(a) * len, y: anchor.y + Math.sin(a) * len, type: p.type };
  }

  /* 极轴追踪：靠近 15° 整数倍方向时吸附，并记录角度用于提示 */
  function applyPolar(p, anchor) {
    if (!anchor) return p;
    var dx = p.x - anchor.x, dy = p.y - anchor.y;
    var radius = Math.hypot(dx, dy);
    if (radius < 1e-6) return p;
    var step = rad(state.polarStep || 15);
    var a = Math.atan2(dy, dx);
    var na = Math.round(a / step) * step;
    var offPx = Math.abs(Math.sin(a - na)) * radius * state.view.zoom;
    if (offPx > 10) return p;
    var t = dx * Math.cos(na) + dy * Math.sin(na);
    if (t <= 0) return p;
    var out = { x: anchor.x + Math.cos(na) * t, y: anchor.y + Math.sin(na) * t, type: p.type };
    out.polar = normDeg(deg(na));
    return out;
  }

  function cursorPoint(sx, sy, anchor) {
    var w = s2w(sx, sy);
    var p = snapPoint(w, anchor);
    if (!anchor) return p;
    /* 对象捕捉优先于正交 / 极轴 */
    if (p.type && p.type !== '栅格') return p;
    if (state.orthoOn || shiftDown) return applyOrtho(p, anchor);
    if (state.polarOn) return applyPolar(p, anchor);
    return p;
  }

  /* ---------------- 夹点 ---------------- */
  function gripsOf(e) {
    if (e.kind === 'line') {
      return [
        { x: e.x0, y: e.y0, role: 'p0' }, { x: e.x1, y: e.y1, role: 'p1' },
        { x: (e.x0 + e.x1) / 2, y: (e.y0 + e.y1) / 2, role: 'mid' }
      ];
    }
    if (e.kind === 'rect') {
      return [
        { x: e.x0, y: e.y0, role: 'c0' }, { x: e.x1, y: e.y0, role: 'c1' },
        { x: e.x1, y: e.y1, role: 'c2' }, { x: e.x0, y: e.y1, role: 'c3' }
      ];
    }
    if (e.kind === 'polyline') {
      return e.pts.map(function (p, i) { return { x: p.x, y: p.y, role: 'v' + i }; });
    }
    if (e.kind === 'circle') {
      return [{ x: e.cx, y: e.cy, role: 'c' }, { x: e.cx + e.r, y: e.cy, role: 'r' }];
    }
    if (e.kind === 'insert') return [{ x: e.x, y: e.y, role: 'c' }];
    return [
      { x: e.cx, y: e.cy, role: 'c' },
      { x: arcPointAt(e, e.a0).x, y: arcPointAt(e, e.a0).y, role: 'p0' },
      { x: arcPointAt(e, e.a1).x, y: arcPointAt(e, e.a1).y, role: 'p1' }
    ];
  }

  function applyGrip(e, role, p) {
    if (e.kind === 'line') {
      if (role === 'p0') { e.x0 = p.x; e.y0 = p.y; }
      else if (role === 'p1') { e.x1 = p.x; e.y1 = p.y; }
      else {
        var dx = p.x - (e.x0 + e.x1) / 2, dy = p.y - (e.y0 + e.y1) / 2;
        e.x0 += dx; e.x1 += dx; e.y0 += dy; e.y1 += dy;
      }
    } else if (e.kind === 'rect') {
      if (role === 'c0') { e.x0 = p.x; e.y0 = p.y; }
      else if (role === 'c1') { e.x1 = p.x; e.y0 = p.y; }
      else if (role === 'c2') { e.x1 = p.x; e.y1 = p.y; }
      else { e.x0 = p.x; e.y1 = p.y; }
    } else if (e.kind === 'polyline') {
      var i = parseInt(role.slice(1), 10);
      if (e.pts[i]) { e.pts[i].x = p.x; e.pts[i].y = p.y; }
    } else if (e.kind === 'circle') {
      if (role === 'c') { e.cx = p.x; e.cy = p.y; }
      else e.r = Math.max(0.2, dist(e.cx, e.cy, p.x, p.y));
    } else if (e.kind === 'insert') {
      e.x = p.x; e.y = p.y;
    } else {
      if (role === 'c') {
        var ox = p.x - e.cx, oy = p.y - e.cy;
        e.cx = p.x; e.cy = p.y;
        void ox; void oy;
      } else {
        var a = Math.atan2(p.y - e.cy, p.x - e.cx);
        if (role === 'p0') e.a0 = a; else e.a1 = a;
      }
    }
    roundEntity(e);
  }

  function gripAt(sx, sy) {
    if (state.selection.size === 0) return null;
    var s = zoneSize();
    void s;
    var best = null, bd = 9;
    state.entities.forEach(function (e) {
      if (!state.selection.has(e.id)) return;
      gripsOf(e).forEach(function (g) {
        var p = w2s(g.x, g.y);
        var d = Math.hypot(p.x - sx, p.y - sy);
        if (d < bd) { bd = d; best = { e: e, grip: g }; }
      });
    });
    return best;
  }

  /* ---------------- 撤销栈 ---------------- */
  function snapshot() {
    return { entities: deepClone(state.entities), layers: deepClone(state.layers), curLayer: state.curLayer, curColor: state.curColor, bg: state.bg, blocks: deepClone(state.blocks), lastBlock: state.lastBlock, dimSets: deepClone(state.dimSets) };
  }
  function restoreSnap(s) {
    state.entities = s.entities;
    state.layers = s.layers;
    state.curLayer = s.curLayer;
    state.curColor = s.curColor || null;
    if (s.blocks) state.blocks = s.blocks;
    if (s.snaps) state.snaps = s.snaps;
    if (s.dimSets) state.dimSets = s.dimSets;
    if (s.lastBlock) state.lastBlock = s.lastBlock;
    if (s.bg) { state.bg = s.bg; if (els.app) els.app.classList.toggle('is-light', s.bg === 'light'); }
    cleanSelection();
  }
  function pushUndo(before, label) {
    undoStack.push({ snap: before, label: label });
    if (undoStack.length > 150) undoStack.shift();
    redoStack.length = 0;
    updateHistoryButtons();
    scheduleSave();
  }
  function undo() {
    if (!undoStack.length) { msg('没有可撤销的操作'); return; }
    var item = undoStack.pop();
    redoStack.push({ snap: snapshot(), label: item.label });
    restoreSnap(item.snap);
    cancelCmd(true, true);
    afterChange();
    msg('已撤销：' + item.label);
  }
  function redo() {
    if (!redoStack.length) { msg('没有可重做的操作'); return; }
    var item = redoStack.pop();
    undoStack.push({ snap: snapshot(), label: item.label });
    restoreSnap(item.snap);
    cancelCmd(true, true);
    afterChange();
    msg('已重做：' + item.label);
  }
  function cleanSelection() {
    var ids = {};
    state.entities.forEach(function (e) { ids[e.id] = 1; });
    Array.from(state.selection).forEach(function (id) { if (!ids[id]) state.selection.delete(id); });
  }
  function updateHistoryButtons() {
    if (els.undoBtn) els.undoBtn.disabled = !undoStack.length;
    if (els.redoBtn) els.redoBtn.disabled = !redoStack.length;
    if (els.delBtn) els.delBtn.disabled = !state.selection.size;
  }

  function selectedEntities() {
    return state.entities.filter(function (e) { return state.selection.has(e.id); });
  }
  function editableSelection() {
    return selectedEntities().filter(editable);
  }

  /* ---------------- 消息 / 命令历史 ---------------- */
  function msg(text, cls) {
    if (!text) return;
    cmdHistory.push({ text: text, cls: cls || 'out' });
    if (cmdHistory.length > 120) cmdHistory.shift();
    renderCmdHist();
  }
  function renderCmdHist() {
    if (!els.cmdHist) return;
    var shown = cmdHistory.slice(-60);
    els.cmdHist.innerHTML = shown.map(function (h) {
      return '<div class="cad-hist ' + h.cls + '">' + escapeHtml(h.text) + '</div>';
    }).join('');
    els.cmdHist.scrollTop = els.cmdHist.scrollHeight;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function toast(text) {
    if (!els.toast) return;
    els.toast.textContent = text;
    els.toast.hidden = false;
    els.toast.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.remove('is-show');
      toastTimer = setTimeout(function () { els.toast.hidden = true; }, 200);
    }, 1800);
  }
  function setPrompt(t) {
    if (els.cmdPrompt) els.cmdPrompt.textContent = t;
    syncPalette();
  }

  /* 视图变换：所有世界坐标图层统一 translate + scale（以前没有应用，导致缩放平移不生效） */
  function syncViewTransform() {
    if (!els.viewG) return;
    var v = state.view;
    els.viewG.setAttribute('transform',
      'translate(' + v.tx.toFixed(2) + ' ' + v.ty.toFixed(2) + ') scale(' + v.zoom.toFixed(4) + ')');
  }

  /* ---------------- 渲染：网格 ---------------- */
  function drawGrid(force) {
    if (!els.grid) return;
    syncViewTransform();
    var s = zoneSize();
    var sig = [s.w, s.h, state.view.zoom, state.view.tx, state.view.ty, state.grid, state.gridOn, state.space].join('|');
    if (!force && sig === gridSig) return;
    gridSig = sig;
    clearNode(els.grid);
    if (state.space === 'layout' || !state.gridOn) return;
    var step = state.grid;
    if (!(step > 0)) return;
    var z = state.view.zoom;
    while (step * z < 8) step *= 2;
    var major = step * 5;
    var v0 = s2w(0, 0), v1 = s2w(s.w, s.h);
    var x0 = Math.floor(v0.x / step) * step, x1 = v1.x;
    var y0 = Math.floor(v0.y / step) * step, y1 = v1.y;
    if ((x1 - x0) / step > 800 || (y1 - y0) / step > 800) return;
    var frag = document.createDocumentFragment();
    var minorD = [], majorD = [];
    var x, y;
    for (x = x0; x <= x1; x += step) {
      if (Math.abs(x) < step * 1e-6) continue;
      var isMaj = Math.abs(x / major - Math.round(x / major)) < 1e-6;
      (isMaj ? majorD : minorD).push('M ' + x.toFixed(3) + ' ' + v0.y.toFixed(3) + ' L ' + x.toFixed(3) + ' ' + v1.y.toFixed(3));
    }
    for (y = y0; y <= y1; y += step) {
      if (Math.abs(y) < step * 1e-6) continue;
      var isMajY = Math.abs(y / major - Math.round(y / major)) < 1e-6;
      (isMajY ? majorD : minorD).push('M ' + v0.x.toFixed(3) + ' ' + y.toFixed(3) + ' L ' + v1.x.toFixed(3) + ' ' + y.toFixed(3));
    }
    if (minorD.length) frag.appendChild(svgEl('path', { d: minorD.join(' '), 'class': 'cad-grid-minor' }));
    if (majorD.length) frag.appendChild(svgEl('path', { d: majorD.join(' '), 'class': 'cad-grid-major' }));
    els.grid.appendChild(frag);
    els.grid.appendChild(svgEl('line', { x1: 0, y1: v0.y, x2: 0, y2: v1.y, 'class': 'cad-axis' }));
    els.grid.appendChild(svgEl('line', { x1: v0.x, y1: 0, x2: v1.x, y2: 0, 'class': 'cad-axis' }));
  }

  /* ---------------- 渲染：图纸 / 图框 ---------------- */
  function drawSheet() {
    if (!els.sheet) return;
    syncViewTransform();
    clearNode(els.sheet);
    if (state.space !== 'layout') return;
    var sh = sheetRect();
    var g = els.sheet;
    g.appendChild(svgEl('rect', { x: sh.x + 3, y: sh.y + 4, width: sh.w, height: sh.h, 'class': 'cad-sheet-shadow' }));
    g.appendChild(svgEl('rect', { x: sh.x, y: sh.y, width: sh.w, height: sh.h, 'class': 'cad-sheet' }));
    var k = sh.k;
    var m = 10 * k;
    g.appendChild(svgEl('rect', { x: sh.x + m, y: sh.y + m, width: sh.w - 2 * m, height: sh.h - 2 * m, 'class': 'cad-frame' }));
    /* 标题栏 180×56 mm，右下 */
    var tw = 180 * k, th = 56 * k;
    var tx = sh.x + sh.w - m - tw, ty = sh.y + sh.h - m - th;
    g.appendChild(svgEl('rect', { x: tx, y: ty, width: tw, height: th, 'class': 'cad-frame' }));
    var rows = [0, 14, 28, 42];
    for (var i = 1; i < rows.length; i++) {
      g.appendChild(svgEl('line', { x1: tx, y1: ty + rows[i] * k, x2: tx + tw, y2: ty + rows[i] * k, 'class': 'cad-frame-thin' }));
    }
    var cols = [90, 135];
    for (var j = 0; j < cols.length; j++) {
      g.appendChild(svgEl('line', { x1: tx + cols[j] * k, y1: ty + 42 * k, x2: tx + cols[j] * k, y2: ty + th, 'class': 'cad-frame-thin' }));
    }
    function label(x, y, text, size, bold) {
      var t = svgEl('text', { x: x, y: y, 'class': 'cad-sheet-text' + (bold ? ' is-bold' : '') });
      t.setAttribute('font-size', (size || 3.2) * k);
      t.textContent = text;
      g.appendChild(t);
    }
    label(tx + 3 * k, ty + 9 * k, '识绘 CAD', 4.2, true);
    var sheetMeta = state.sheet || {};
    label(tx + 3 * k, ty + 22 * k, '图名  ' + (sheetMeta.title || '手动绘图练习'), 3.1);
    label(tx + 3 * k, ty + 36 * k, '设计', 2.8);
    label(tx + 20 * k, ty + 36 * k, sheetMeta.designer || '—', 2.8);
    label(tx + 96 * k, ty + 36 * k, '比例', 2.8);
    label(tx + 114 * k, ty + 36 * k, sheetMeta.scale || '1 : 1', 2.8);
    label(tx + 3 * k, ty + 50 * k, '图号', 2.8);
    label(tx + 20 * k, ty + 50 * k, sheetMeta.code || 'A3-001', 2.8);
    label(tx + 96 * k, ty + 50 * k, '单位', 2.8);
    label(tx + 114 * k, ty + 50 * k, sheetMeta.unit || 'mm', 2.8);
    label(tx + 140 * k, ty + 50 * k, sheetDate(), 2.6);
    /* 图纸空间角标 */
    var tag = svgEl('text', { x: sh.x + 4 * k, y: sh.y + sh.h - 4 * k, 'class': 'cad-sheet-text dim' });
    tag.setAttribute('font-size', 2.8 * k);
    tag.textContent = 'A3 · 420 × 297 mm · 图纸空间（只读预览）';
    g.appendChild(tag);
  }
  function sheetDate() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* ---------------- 渲染：图元 ---------------- */
  function arcPathD(e) {
    var sweep = arcSweep(e);
    if (sweep < 1e-6) return '';
    var f = function (v) { return v.toFixed(3); };
    var sw = e.dir > 0 ? 1 : 0;
    if (sweep > Math.PI * 1.999) {
      var m = arcPointAt(e, e.a0 + e.dir * Math.PI);
      var p0 = arcPointAt(e, e.a0);
      var p2 = arcPointAt(e, e.a0 + e.dir * Math.PI * 2);
      return 'M ' + f(p0.x) + ' ' + f(p0.y) + ' A ' + f(e.r) + ' ' + f(e.r) + ' 0 0 ' + sw + ' ' + f(m.x) + ' ' + f(m.y) +
        ' A ' + f(e.r) + ' ' + f(e.r) + ' 0 0 ' + sw + ' ' + f(p2.x) + ' ' + f(p2.y);
    }
    var a = arcPointAt(e, e.a0), b = arcPointAt(e, e.a1);
    var large = sweep > Math.PI ? 1 : 0;
    return 'M ' + f(a.x) + ' ' + f(a.y) + ' A ' + f(e.r) + ' ' + f(e.r) + ' 0 ' + large + ' ' + sw + ' ' + f(b.x) + ' ' + f(b.y);
  }

  function shapeEl(e) {
    if (e.kind === 'line') return svgEl('line', { x1: e.x0, y1: e.y0, x2: e.x1, y2: e.y1 });
    if (e.kind === 'rect') {
      return svgEl('rect', {
        x: Math.min(e.x0, e.x1), y: Math.min(e.y0, e.y1),
        width: Math.abs(e.x1 - e.x0), height: Math.abs(e.y1 - e.y0)
      });
    }
    if (e.kind === 'polyline' || e.kind === 'hatch') {
      var d = '';
      e.pts.forEach(function (p, i) { d += (i ? ' L ' : 'M ') + p.x.toFixed(3) + ' ' + p.y.toFixed(3); });
      if (e.closed || e.kind === 'hatch') d += ' Z';
      var pth = svgEl('path', { d: d });
      if (e.kind === 'hatch' && e.pattern && e.pattern !== 'solid') {
        var pid = ensureHatchPattern(e.pattern, e.spacing || 6, displayColor(e));
        if (pid) pth.setAttribute('fill', 'url(#' + pid + ')');
      }
      return pth;
    }
    if (e.kind === 'circle') return svgEl('circle', { cx: e.cx, cy: e.cy, r: Math.max(e.r, 0.001) });
    if (e.kind === 'text') {
      var tx = svgEl('text', { x: e.cx, y: e.cy });
      tx.setAttribute('font-size', e.size || 3.5);
      tx.setAttribute('class', 'cad-text-ent');
      var rawT = String(e.text || '');
      if (rawT.indexOf('\n') >= 0) {
        var lns = rawT.split('\n');
        lns.forEach(function (ln, li) {
          var tspan = svgEl('tspan', { x: e.cx, dy: li === 0 ? 0 : (e.size || 3.5) * 1.25 });
          tspan.textContent = ln;
          tx.appendChild(tspan);
        });
      } else {
        tx.textContent = rawT;
      }
      return tx;
    }
    return svgEl('path', { d: arcPathD(e) });
  }

  function drawEntities() {
    if (!els.world) return;
    syncViewTransform();
    clearNode(els.world);
    state.entities.forEach(function (e) {
      if (!entityVisible(e)) return;
      if (e.kind === 'insert') {
        var bk = state.blocks[e.name];
        if (!bk) return;
        var dxi = e.x - bk.base.x, dyi = e.y - bk.base.y;
        bk.entities.forEach(function (ce, ci) {
          var cc = deepClone(ce); cc.id = e.id; translateEntity(cc, ce, dxi, dyi);
          if (cc.kind === 'text' && e.attrs && e.attrs.length) {
            var ti2 = bk.entities.slice(0, ci).filter(function (x) { return x.kind === 'text'; }).length;
            if (e.attrs[ti2]) cc.text = e.attrs[ti2];
          }
          var cel = shapeEl(cc);
          var ccls = 'cad-ent';
          if (state.selection.has(e.id)) ccls += ' is-sel';
          if (cc.kind === 'text') ccls += ' cad-text-ent';
          cel.setAttribute('class', ccls);
          cel.setAttribute('data-id', e.id);
          if (cc.kind === 'text') cel.style.fill = displayColor(cc);
          else cel.style.stroke = displayColor(cc);
          els.world.appendChild(cel);
        });
        return;
      }
      var el = shapeEl(e);
      var cls = 'cad-ent';
      if (state.selection.has(e.id)) cls += ' is-sel';
      var pm = state.printMap || {};
      var mc = (e.color || (layerOf(e) && layerOf(e).color) || '').toLowerCase();
      if (mc && pm[mc]) el.style.strokeWidth = String(pm[mc] * (state.printStyle && state.printStyle.lw || 1));
      if (hoverId === e.id) cls += ' is-hover';
      if (layerOf(e).locked || e.locked) cls += ' is-locked';
      if (state.diffIds && state.diffIds[e.id]) cls += ' is-diff';
      if (e.kind === 'text') cls += ' cad-text-ent';
      el.setAttribute('class', cls);
      el.setAttribute('data-id', e.id);
      if (e.kind === 'text') el.style.fill = displayColor(e);
      else if (e.kind === 'hatch') {
        el.style.fill = displayColor(e);
        el.style.fillOpacity = (e.pattern && e.pattern !== 'solid') ? '1' : '0.45';
        el.style.stroke = displayColor(e);
        el.style.strokeWidth = '0.8';
      } else el.style.stroke = state.selection.has(e.id) ? '' : displayColor(e);
      var dash = entityDash(e);
      if (dash) el.style.strokeDasharray = dash;
      els.world.appendChild(el);
    });
  }

  function drawPreview(g) {
    var cmd = state.cmd;
    if (!cmd) return;
    var p = cmd.cursor;
    var pts = cmd.pts || [];
    var mk = function (pt, cls) {
      g.appendChild(svgEl('circle', { cx: pt.x, cy: pt.y, r: 3, 'class': cls || 'cad-node' }));
    };
    var line = function (a, b, cls) {
      g.appendChild(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'class': cls || 'cad-preview' }));
    };
    var name = cmd.name;

    if (name === 'line' || name === 'polyline') {
      var prev = pts[pts.length - 1];
      if (!prev) return;
      if (pts.length > 1) {
        var d = '';
        pts.forEach(function (q, i) { d += (i ? ' L ' : 'M ') + q.x.toFixed(2) + ' ' + q.y.toFixed(2); });
        d += ' L ' + p.x.toFixed(2) + ' ' + p.y.toFixed(2);
        g.appendChild(svgEl('path', { d: d, 'class': 'cad-preview' }));
      } else line(prev, p);
      pts.forEach(function (q) { mk(q); });
      mk(p);
      return;
    }
    if (name === 'rect' || name === 'circle') {
      if (!pts.length) return;
      var a = pts[0];
      if (name === 'rect') {
        g.appendChild(svgEl('rect', {
          x: Math.min(a.x, p.x), y: Math.min(a.y, p.y),
          width: Math.abs(p.x - a.x), height: Math.abs(p.y - a.y), 'class': 'cad-preview'
        }));
      } else {
        var r = dist(a.x, a.y, p.x, p.y);
        g.appendChild(svgEl('circle', { cx: a.x, cy: a.y, r: Math.max(r, 0.001), 'class': 'cad-preview' }));
        line(a, p, 'cad-guide');
        mk(p);
      }
      mk(a);
      return;
    }
    if (name === 'arc') {
      if (!pts.length) return;
      if (pts.length === 1) { line(pts[0], p, 'cad-guide'); mk(pts[0]); mk(p); return; }
      var arc = arcFrom3(pts[0], pts[1], p);
      if (arc) g.appendChild(svgEl('path', { d: arcPathD(arc), 'class': 'cad-preview' }));
      else line(pts[0], pts[1], 'cad-guide');
      mk(pts[0]); mk(pts[1]); mk(p);
      return;
    }
    if (name === 'move' || name === 'copy') {
      if (!cmd.base) return;
      var dx = p.x - cmd.base.x, dy = p.y - cmd.base.y;
      line(cmd.base, p, 'cad-guide');
      selectedEntities().forEach(function (e) {
        var ghost = shapeEl(e);
        var pts0 = null;
        if (e.kind === 'line') { ghost.setAttribute('x1', e.x0 + dx); ghost.setAttribute('y1', e.y0 + dy); ghost.setAttribute('x2', e.x1 + dx); ghost.setAttribute('y2', e.y1 + dy); }
        else if (e.kind === 'rect') { ghost.setAttribute('x', Math.min(e.x0, e.x1) + dx); ghost.setAttribute('y', Math.min(e.y0, e.y1) + dy); }
        else if (e.kind === 'polyline') {
          var d2 = ''; e.pts.forEach(function (q, i) { d2 += (i ? ' L ' : 'M ') + (q.x + dx).toFixed(2) + ' ' + (q.y + dy).toFixed(2); });
          if (e.closed) d2 += ' Z'; ghost.setAttribute('d', d2);
        } else { ghost.setAttribute('cx', e.cx + dx); ghost.setAttribute('cy', e.cy + dy); }
        ghost.setAttribute('class', 'cad-ghost');
        void pts0;
        g.appendChild(ghost);
      });
      mk(cmd.base);
      return;
    }
    if (name === 'rotate') {
      if (!cmd.base) return;
      var th = rad(lineAngle(cmd.base, p));
      line(cmd.base, p, 'cad-guide');
      selectedEntities().forEach(function (e) {
        var ghost = shapeEl(rotateEntity(e, cmd.base, th));
        ghost.setAttribute('class', 'cad-ghost');
        g.appendChild(ghost);
      });
      mk(cmd.base);
      return;
    }
    if (name === 'scale') {
      if (!cmd.base) return;
      var k = Math.max(0.01, dist(cmd.base.x, cmd.base.y, p.x, p.y) / (cmd.refLen || 1));
      selectedEntities().forEach(function (e) {
        var ghost = shapeEl(scaleEntity(e, cmd.base, k));
        ghost.setAttribute('class', 'cad-ghost');
        g.appendChild(ghost);
      });
      line(cmd.base, p, 'cad-guide');
      mk(cmd.base);
      return;
    }
    if (name === 'mirror') {
      if (!pts.length) return;
      line(pts[0], p, 'cad-guide');
      selectedEntities().forEach(function (e) {
        var ghost = shapeEl(mirrorEntity(e, pts[0], p));
        ghost.setAttribute('class', 'cad-ghost');
        g.appendChild(ghost);
      });
      mk(pts[0]);
      return;
    }
    if (name === 'offset') {
      if (!cmd.target || !cmd.dist) return;
      var off = offsetEntity(cmd.target, cmd.dist, p);
      if (off) {
        var ghost2 = shapeEl(off);
        ghost2.setAttribute('class', 'cad-ghost');
        g.appendChild(ghost2);
      }
      return;
    }
  }

  /* ---------------- 渲染：覆盖层 ---------------- */
  function drawOverlay() {
    if (!els.overlay) return;
    clearNode(els.overlay);
    var g = els.overlay;
    var s = zoneSize();

    /* 夹点 */
    if (state.selection.size && !drag) {
      state.entities.forEach(function (e) {
        if (!state.selection.has(e.id) || !entityVisible(e)) return;
        var bb = entityBounds(e);
        var p0 = w2s(bb.x0, bb.y0), p1 = w2s(bb.x1, bb.y1);
        g.appendChild(svgEl('rect', {
          x: Math.min(p0.x, p1.x) - 3, y: Math.min(p0.y, p1.y) - 3,
          width: Math.abs(p1.x - p0.x) + 6, height: Math.abs(p1.y - p0.y) + 6, 'class': 'cad-sel-box'
        }));
        gripsOf(e).forEach(function (gp) {
          var sp = w2s(gp.x, gp.y);
          g.appendChild(svgEl('rect', { x: sp.x - 3.5, y: sp.y - 3.5, width: 7, height: 7, 'class': 'cad-grip' }));
        });
      });
    }

    /* 框选 */
    if (drag && drag.mode === 'marquee') {
      var a = w2s(drag.start.x, drag.start.y), b = w2s(drag.cur.x, drag.cur.y);
      var crossing = drag.cur.x < drag.start.x;
      g.appendChild(svgEl('rect', {
        x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
        'class': crossing ? 'cad-marquee crossing' : 'cad-marquee'
      }));
    }

    /* 极轴追踪辅助射线：从基点沿吸附方向延伸到视口外 */
    if (state.cmd && state.cmd.cursor && state.cmd.cursor.polar != null && state.pointer.inside) {
      var pa = state.cmd.base || state.cmd.pts[state.cmd.pts.length - 1];
      if (pa) {
        var a1 = w2s(pa.x, pa.y), a2 = w2s(state.cmd.cursor.x, state.cmd.cursor.y);
        var dxp = a2.x - a1.x, dyp = a2.y - a1.y, lp = Math.hypot(dxp, dyp) || 1;
        var ext = Math.hypot(s.w, s.h);
        g.appendChild(svgEl('line', {
          x1: a1.x, y1: a1.y,
          x2: a1.x + dxp / lp * ext, y2: a1.y + dyp / lp * ext,
          'class': 'cad-polar-ray'
        }));
      }
    }

    /* 预览：预览也用世界坐标，放到世界层（随视图缩放平移） */
    if (els.preview) { clearNode(els.preview); drawPreview(els.preview); syncViewTransform(); }

    /* 十字光标（大小可调，默认全屏） */
    if (state.pointer.inside && !drag) {
      var px = state.pointer.x, py = state.pointer.y;
      var half = Math.max(18, state.crossPct / 100 * Math.max(s.w, s.h) / 2);
      var pb = state.pickPx || 8;
      g.appendChild(svgEl('line', { x1: px - half, y1: py, x2: px + half, y2: py, 'class': 'cad-cross' }));
      g.appendChild(svgEl('line', { x1: px, y1: py - half, x2: px, y2: py + half, 'class': 'cad-cross' }));
      g.appendChild(svgEl('rect', { x: px - pb / 2 - 1.6, y: py - pb / 2 - 1.6, width: pb + 3.2, height: pb + 3.2, 'class': 'cad-pickbox-halo' }));
      g.appendChild(svgEl('rect', { x: px - pb / 2, y: py - pb / 2, width: pb, height: pb, 'class': 'cad-pickbox' }));
    }

    /* 捕捉标记：不同捕捉类型对应 CAD 常见图形 */
    var sn = state.snap;
    var showSnap = sn && state.snapOn && sn.type && sn.type !== '栅格';
    if (showSnap) {
      var sp2 = w2s(sn.x, sn.y);
      var box = svgEl('g', { 'class': 'cad-snap' });
      var st2 = sn.type;
      if (st2 === '中点') {
        box.appendChild(svgEl('polygon', { points: sp2.x + ',' + (sp2.y - 6.5) + ' ' + (sp2.x - 6) + ',' + (sp2.y + 5) + ' ' + (sp2.x + 6) + ',' + (sp2.y + 5), 'class': 'cad-snap-mark' }));
      } else if (st2 === '圆心') {
        box.appendChild(svgEl('circle', { cx: sp2.x, cy: sp2.y, r: 5.5, 'class': 'cad-snap-mark' }));
        box.appendChild(svgEl('circle', { cx: sp2.x, cy: sp2.y, r: 1.3, 'class': 'cad-snap-mark' }));
      } else if (st2 === '象限点') {
        box.appendChild(svgEl('polygon', { points: sp2.x + ',' + (sp2.y - 6.5) + ' ' + (sp2.x + 6.5) + ',' + sp2.y + ' ' + sp2.x + ',' + (sp2.y + 6.5) + ' ' + (sp2.x - 6.5) + ',' + sp2.y, 'class': 'cad-snap-mark' }));
      } else if (st2 === '交点') {
        box.appendChild(svgEl('path', { d: 'M ' + (sp2.x - 5.5) + ' ' + (sp2.y - 5.5) + ' L ' + (sp2.x + 5.5) + ' ' + (sp2.y + 5.5) + ' M ' + (sp2.x + 5.5) + ' ' + (sp2.y - 5.5) + ' L ' + (sp2.x - 5.5) + ' ' + (sp2.y + 5.5), 'class': 'cad-snap-mark' }));
      } else if (st2 === '垂足') {
        box.appendChild(svgEl('path', { d: 'M ' + (sp2.x - 5.5) + ' ' + (sp2.y + 5.5) + ' L ' + (sp2.x - 5.5) + ' ' + (sp2.y - 5.5) + ' L ' + (sp2.x + 5.5) + ' ' + (sp2.y - 5.5), 'class': 'cad-snap-mark' }));
      } else if (st2 === '最近点') {
        box.appendChild(svgEl('polygon', { points: (sp2.x - 5) + ',' + (sp2.y - 5) + ' ' + (sp2.x + 5) + ',' + (sp2.y - 5) + ' ' + (sp2.x - 5) + ',' + (sp2.y + 5) + ' ' + (sp2.x + 5) + ',' + (sp2.y + 5), 'class': 'cad-snap-mark' }));
      } else {
        box.appendChild(svgEl('rect', { x: sp2.x - 5, y: sp2.y - 5, width: 10, height: 10, 'class': 'cad-snap-mark' }));
      }
      box.appendChild(svgEl('line', { x1: sp2.x - 10, y1: sp2.y, x2: sp2.x - 6.5, y2: sp2.y, 'class': 'cad-snap-line' }));
      box.appendChild(svgEl('line', { x1: sp2.x + 6.5, y1: sp2.y, x2: sp2.x + 10, y2: sp2.y, 'class': 'cad-snap-line' }));
      box.appendChild(svgEl('line', { x1: sp2.x, y1: sp2.y - 10, x2: sp2.x, y2: sp2.y - 6.5, 'class': 'cad-snap-line' }));
      box.appendChild(svgEl('line', { x1: sp2.x, y1: sp2.y + 6.5, x2: sp2.x, y2: sp2.y + 10, 'class': 'cad-snap-line' }));
      var snapLab = svgEl('text', { x: sp2.x + 13, y: sp2.y - 11, 'class': 'cad-snap-text' });
      snapLab.textContent = st2;
      box.appendChild(snapLab);
      g.appendChild(box);
      /* 绘图时在捕捉点周围显示短对齐追踪线（避免整屏十字造成干扰） */
      if (state.cmd) {
        var tl = 44;
        g.appendChild(svgEl('line', { x1: sp2.x - tl, y1: sp2.y, x2: sp2.x + tl, y2: sp2.y, 'class': 'cad-track' }));
        g.appendChild(svgEl('line', { x1: sp2.x, y1: sp2.y - tl, x2: sp2.x, y2: sp2.y + tl, 'class': 'cad-track' }));
      }
    }
  }

  /* ---------------- 状态栏 / 浮动提示 ---------------- */
  function updateStatus() {
    var p = state.pointer;
    if (state.space === 'layout') {
      setText(els.coord, '图纸空间');
    } else {
      setText(els.coord, 'X ' + fmt(p.wx, 2) + '   Y ' + fmt(p.wy, 2));
    }
    setText(els.zoomTxt, Math.round(state.view.zoom * 100) + '%');
    setText(els.layerTxt, layerById(state.curLayer).name);
    setText(els.countTxt, state.entities.length + ' 对象');
    setText(els.count, String(state.entities.length));
    if (els.selCount) syncSelCount();
    var pct = Math.round(state.view.zoom * 100) + '%';
    if (els.zoomBtn) els.zoomBtn.textContent = pct;
    syncStatusToggles();
    syncPalette();
    syncSelBar();
  }

  function syncSelCount() {
    if (!els.selCount) return;
    var ns = state.selection.size;
    els.selCount.hidden = ns === 0;
    if (ns) setText(els.selCount, '已选 ' + ns);
  }

  function setText(el, t) { if (el && el.textContent !== t) el.textContent = t; }

  function syncStatusToggles() {
    toggleClass(els.stGrid, state.gridOn);
    toggleClass(els.stOrtho, state.orthoOn);
    toggleClass(els.stPolar, state.polarOn);
    toggleClass(els.stOsnap, state.snapOn && anyOsnap());
    toggleClass(els.stDyn, state.dynOn);
    toggleClass(els.stLw, state.lwOn);
    toggleClass(els.rGrid, state.gridOn);
    toggleClass(els.rOrtho, state.orthoOn);
    toggleClass(els.rOsnap, state.snapOn);
    toggleClass(els.rDyn, state.dynOn);
    toggleClass(els.tabModel, state.space === 'model');
    toggleClass(els.tabLayout, state.space === 'layout');
    if (els.svg) els.svg.classList.toggle('is-layout', state.space === 'layout');
  }
  function anyOsnap() {
    var o = state.osnap;
    for (var k in o) if (o.hasOwnProperty(k) && o[k]) return true;
    return false;
  }
  function toggleClass(el, on) { if (el) el.classList.toggle('is-on', !!on); }

  function draftingInfo() {
    var cmd = state.cmd;
    if (!cmd) return '';
    var p = cmd.cursor;
    if (!p) return '';
    if (cmd.name === 'line' || cmd.name === 'polyline') {
      var q = cmd.pts[cmd.pts.length - 1];
      if (!q) return '';
      return 'L ' + fmt(dist(q.x, q.y, p.x, p.y), 2) + '   ∠ ' + fmt(lineAngle(q, p), 1) + '°';
    }
    if (cmd.name === 'rect' && cmd.pts.length) {
      var a = cmd.pts[0];
      return 'W ' + fmt(Math.abs(p.x - a.x), 2) + '   H ' + fmt(Math.abs(p.y - a.y), 2);
    }
    if (cmd.name === 'circle' && cmd.pts.length) {
      var r = dist(cmd.pts[0].x, cmd.pts[0].y, p.x, p.y);
      return 'R ' + fmt(r, 2) + '   ⌀ ' + fmt(r * 2, 2);
    }
    if (cmd.name === 'arc' && cmd.pts.length === 2) {
      var arc = arcFrom3(cmd.pts[0], cmd.pts[1], p);
      if (arc) return 'R ' + fmt(arc.r, 2) + '   ∠ ' + fmt(deg(arcSweep(arc)), 1) + '°';
    }
    if (cmd.name === 'rotate' && cmd.base) {
      return '∠ ' + fmt(lineAngle(cmd.base, p), 1) + '°';
    }
    if (cmd.name === 'scale' && cmd.base) {
      return '比例 ' + fmt(dist(cmd.base.x, cmd.base.y, p.x, p.y) / (cmd.refLen || 1), 3);
    }
    if (cmd.name === 'mirror' && cmd.pts.length) {
      return '镜像线 ∠ ' + fmt(lineAngle(cmd.pts[0], p), 1) + '°';
    }
    if ((cmd.name === 'move' || cmd.name === 'copy') && cmd.base) {
      return 'ΔX ' + fmt(p.x - cmd.base.x, 2) + '   ΔY ' + fmt(p.y - cmd.base.y, 2);
    }
    return '';
  }

  function updateDim() {
    if (!els.dim) return;
    var text = draftingInfo();
    if (!text || !state.pointer.inside) { els.dim.hidden = true; return; }
    els.dim.hidden = false;
    els.dim.textContent = text;
    var s = zoneSize();
    var x = clamp(state.pointer.x + 20, 8, s.w - els.dim.offsetWidth - 8);
    var y = clamp(state.pointer.y + 24, 8, s.h - els.dim.offsetHeight - 8);
    els.dim.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  }

  /* 重叠对象提示（类似 AutoCAD 的选择循环图标） */
  function updateCycleTag(n) {
    if (!els.cycleTag) return;
    if (!n || n < 2 || state.cmd || drag || state.space === 'layout' || !state.pointer.inside) {
      els.cycleTag.hidden = true;
      return;
    }
    var z = zoneSize();
    els.cycleTag.textContent = '重叠 ' + n + ' 个 · 单击切换';
    els.cycleTag.hidden = false;
    els.cycleTag.style.transform = 'translate(' + Math.round(clamp(state.pointer.x + 16, 4, z.w - 128)) + 'px,' +
      Math.round(clamp(state.pointer.y + 18, 4, z.h - 26)) + 'px)';
  }

  function updateSnapTag() {
    if (!els.snapTag) return;
    var sn = state.snap;
    var hasSnap = sn && state.snapOn && sn.type && sn.type !== '栅格';
    var pol = state.cmd && state.cmd.cursor && state.cmd.cursor.polar;
    var zone = zoneSize();
    if (!hasSnap && pol != null && state.pointer.inside) {
      els.snapTag.hidden = false;
      els.snapTag.classList.add('is-polar');
      els.snapTag.textContent = '极轴 ' + fmt(pol, 1) + '°';
      els.snapTag.style.transform = 'translate(' + Math.round(clamp(state.pointer.x + 14, 4, zone.w - 80)) + 'px,' +
        Math.round(clamp(state.pointer.y - 26, 4, zone.h - 24)) + 'px)';
      return;
    }
    els.snapTag.classList.remove('is-polar');
    if (!hasSnap) { els.snapTag.hidden = true; return; }
    els.snapTag.hidden = false;
    els.snapTag.textContent = sn.type;
    var p = w2s(sn.x, sn.y);
    els.snapTag.style.transform = 'translate(' + Math.round(clamp(p.x + 12, 4, zone.w - 60)) + 'px,' +
      Math.round(clamp(p.y - 26, 4, zone.h - 24)) + 'px)';
  }

  function redrawAll() {
    drawSheet();
    drawGrid(true);
    drawEntities();
    drawOverlay();
    updateStatus();
    updateDim();
    updateSnapTag();
    renderDyn();
    renderEmpty();
  }
  function redrawLive() {
    drawEntities();
    drawOverlay();
    updateStatus();
    updateDim();
    updateSnapTag();
    renderDyn();
    renderEmpty();
  }
  function afterChange() {
    syncHatches();
    syncDims();
    redrawLive();
    renderProps();
    renderList();
    renderLayers();
    updateHistoryButtons();
    setCursor();
    scheduleSave();
  }

  /* 高频交互时按帧合并重绘，避免每个 mousemove 都重建全部图元 DOM */
  var liveRaf = 0, liveTimer = 0, allRaf = 0, allTimer = 0;
  function scheduleLive() {
    if (liveRaf || liveTimer) return;
    var done = false;
    var run = function () {
      if (done) return;
      done = true;
      liveRaf = 0;
      if (liveTimer) { clearTimeout(liveTimer); liveTimer = 0; }
      if (isVisible()) redrawLive();
    };
    liveRaf = requestAnimationFrame(run);
    liveTimer = setTimeout(run, 80);
  }
  function scheduleAll() {
    if (allRaf || allTimer) return;
    var done = false;
    var run = function () {
      if (done) return;
      done = true;
      allRaf = 0;
      if (allTimer) { clearTimeout(allTimer); allTimer = 0; }
      if (isVisible()) redrawAll();
    };
    allRaf = requestAnimationFrame(run);
    allTimer = setTimeout(run, 80);
  }
  function zoomExtents() {
    if (state.space === 'layout') fitLayout();
    else fit();
  }

  function renderEmpty() {
    if (!els.empty) return;
    els.empty.hidden = state.entities.length > 0 || !!state.cmd || state.space === 'layout';
  }

  /* ---------------- 侧栏：对象列表 / 特性 ---------------- */
  function renderList() {
    if (!els.list) return;
    clearNode(els.list);
    if (!state.entities.length) {
      var em = document.createElement('div');
      em.className = 'cad-empty-row';
      em.textContent = '暂无对象';
      els.list.appendChild(em);
      return;
    }
    state.entities.forEach(function (e, i) {
      var row = document.createElement('div');
      row.className = 'cad-row' + (state.selection.has(e.id) ? ' is-sel' : '');
      row.setAttribute('data-id', e.id);
      row.title = KIND_NAME[e.kind] + ' · 双击定位 · 图层 ' + layerName(e.layer);
      var col = displayColor(e);
      row.innerHTML = '<span class="sw" style="background:' + col + '"></span>' +
        '<span class="nm">' + (i + 1) + ' · ' + KIND_NAME[e.kind] + '</span>' +
        '<span class="meta">' + entityMeta(e) + '</span>';
      els.list.appendChild(row);
    });
    syncSelCount();
  }

  function fieldDefs(e) {
    if (e.kind === 'line') return [['x0', '起点 X'], ['y0', '起点 Y'], ['x1', '终点 X'], ['y1', '终点 Y']];
    if (e.kind === 'rect') return [['x0', '角点 X1'], ['y0', '角点 Y1'], ['x1', '角点 X2'], ['y1', '角点 Y2']];
    if (e.kind === 'circle') return [['cx', '圆心 X'], ['cy', '圆心 Y'], ['r', '半径 R']];
    if (e.kind === 'arc') return [['cx', '圆心 X'], ['cy', '圆心 Y'], ['r', '半径 R'], ['a0d', '起始角 °'], ['a1d', '结束角 °']];
    return [];
  }

  function bindAttrInputs() {
    if (!els.props) return;
    var addBtn = els.props.querySelector('#mdAttrAdd');
    if (addBtn) addBtn.addEventListener('click', function () {
      var selI = selectedEntities().filter(function (x) { return x.kind === 'insert'; });
      if (!selI.length) return;
      var ins = selI[0];
      var blk = state.blocks[ins.name];
      if (!blk) return;
      var before = snapshot();
      var txts = blk.entities.filter(function (x) { return x.kind === 'text'; });
      var n = txts.length;
      var last = txts[n - 1];
      var nx = last ? last.cx : blk.base.x + 8;
      var ny = last ? last.cy - 6 : blk.base.y + 8;
      blk.entities.push({ id: uid(), kind: 'text', layer: blk.entities[0] ? blk.entities[0].layer : state.curLayer, cx: round4(nx), cy: round4(ny), size: 3.5, text: '属性' + (n + 1) });
      if (!Array.isArray(ins.attrs)) ins.attrs = [];
      ins.attrs[n] = '属性' + (n + 1);
      pushUndo(before, '新增块属性');
      msg('已新增属性 ' + (n + 1));
      afterChange();
    });
    Array.prototype.forEach.call(els.props.querySelectorAll('.cad-attr-del'), function (b) {
      b.addEventListener('click', function () {
        var selI = selectedEntities().filter(function (x) { return x.kind === 'insert'; });
        if (!selI.length) return;
        var ins = selI[0];
        var blk = state.blocks[ins.name];
        if (!blk) return;
        var idx = parseInt(b.getAttribute('data-del'), 10);
        var before = snapshot();
        var texts = blk.entities.map(function (x, i) { return { x: x, i: i }; }).filter(function (o) { return o.x.kind === 'text'; });
        if (!texts[idx]) return;
        blk.entities.splice(texts[idx].i, 1);
        if (Array.isArray(ins.attrs)) ins.attrs.splice(idx, 1);
        pushUndo(before, '删除块属性');
        msg('已删除属性 ' + (idx + 1));
        afterChange();
      });
    });
    Array.prototype.forEach.call(els.props.querySelectorAll('.cad-attr-input'), function (inp) {
      inp.addEventListener('change', function () {
        var selI = selectedEntities().filter(function (x) { return x.kind === 'insert'; });
        if (!selI.length) return;
        var ins = selI[0];
        var idx = parseInt(inp.getAttribute('data-attr'), 10);
        if (!Array.isArray(ins.attrs)) ins.attrs = [];
        ins.attrs[idx] = inp.value;
        if (state.lastBom) refreshBom();
        redrawLive();
        scheduleSave();
      });
    });
  }

  function renderProps() {
    if (!els.props) return;
    var list = selectedEntities();
    if (!list.length) {
      els.props.innerHTML = '<div class="cad-prop-empty">未选择对象<br><span>单击图形即可查看并修改特性</span></div>';
      return;
    }
    if (list.length > 1) {
      var sameKind = list.every(function (x) { return x.kind === list[0].kind; });
      var bdefs = sameKind ? fieldDefs(list[0]) : [];
      var htmlMeta = '<div class="cad-prop-block"><label class="cad-pf"><span>批量图层</span><select data-bmeta="layer">';
      state.layers.forEach(function (L2) { htmlMeta += '<option value="' + L2.id + '">' + escapeHtml(L2.name) + '</option>'; });
      htmlMeta += '</select></label><label class="cad-pf"><span>批量颜色</span><input type="color" data-bmeta="color" value="' + (list[0].color || layerOf(list[0]).color) + '"></label>' +
        '<label class="cad-pf"><span>批量线型</span><select data-bmeta="ltype">' +
        '<option value="">随层</option><option value="continuous">实线</option><option value="dashed">虚线</option><option value="dashdot">点划线</option>' +
        '</select></label></div>';
      if (bdefs.length) {
        var htmlB = '<div class="cad-prop-head">已选择 <em>' + list.length + '</em> 个' + KIND_NAME[list[0].kind] + '（批量改）</div><div class="cad-prop-grid">';
        htmlB += htmlMeta;
        bdefs.forEach(function (d) {
          var v0 = fmt(list[0][d[0]], 2);
          htmlB += '<label class="cad-pf"><span>' + d[1] + '</span><input type="number" step="1" data-batch="' + d[0] + '" value="' + v0 + '"></label>';
        });
        htmlB += '</div>';
        els.props.innerHTML = htmlB;
        return;
      }
      var layersUsed = {};
      list.forEach(function (e) { layersUsed[e.layer] = 1; });
      els.props.innerHTML = htmlMeta +
        '<div class="cad-prop-head">已选择 <em>' + list.length + '</em> 个对象</div>' +
        '<div class="cad-prop-empty">拖动可整体移动 · Delete 删除<br>方向键微调（Shift 步长 1）<br>图层：' +
        Object.keys(layersUsed).map(layerName).join(' / ') + '</div>';
      return;
    }
    var e = list[0];
    var defs = fieldDefs(e);
    var html = '<div class="cad-prop-head">' + KIND_NAME[e.kind] + '<em>' + e.id.slice(-4) + '</em></div>';
    html += '<div class="cad-prop-block"><label class="cad-pf"><span>图层</span><select data-p="layer">';
    state.layers.forEach(function (L) {
      html += '<option value="' + L.id + '"' + (L.id === e.layer ? ' selected' : '') + '>' + escapeHtml(L.name) + '</option>';
    });
    html += '</select></label>';
    if (e.kind === 'insert') {
      html += '<div class="cad-pf"><span>块名</span><b>' + (e.name || '') + '</b></div>';
      var blkP = state.blocks[e.name];
      var textsP = blkP ? blkP.entities.filter(function (x) { return x.kind === 'text'; }) : [];
      textsP.forEach(function (te, i2) {
        var cur = (e.attrs && e.attrs[i2]) || te.text || '';
        html += '<label class="cad-pf cad-attr-row"><span>属性 ' + (i2 + 1) + '</span>' +
          '<input class="cad-attr-input" data-attr="' + i2 + '" value="' + String(cur).replace(/"/g, '&quot;') + '">' +
          '<button type="button" class="cad-attr-del" data-del="' + i2 + '" title="删除该属性">×</button></label>';
      });
      html += '<button type="button" class="cad-attr-add" id="mdAttrAdd">+ 新增属性</button>';
    }
    html += '<div class="cad-pf"><span>颜色</span><b class="cad-color-chip" style="background:' + entityColor(e) + '"></b>' +
      '<i class="cad-dim-txt">随层 · ' + LTYPES[layerOf(e).ltype].name + '</i></div></div>';
    if (e.kind === 'polyline') {
      html += '<div class="cad-prop-block"><div class="cad-pf"><span>顶点数</span><b>' + e.pts.length + '</b></div>' +
        '<label class="cad-pf"><span>闭合</span><input type="checkbox" data-p="closed"' + (e.closed ? ' checked' : '') + '></label></div>';
    }
    if (defs.length) {
      html += '<div class="cad-prop-grid">';
      defs.forEach(function (d) {
        var v = d[0] === 'a0d' ? fmt(normDeg(deg(e.a0)), 1) : d[0] === 'a1d' ? fmt(normDeg(deg(e.a1)), 1) : fmt(e[d[0]], 2);
        html += '<label class="cad-pf"><span>' + d[1] + '</span><input type="number" step="1" data-f="' + d[0] + '" value="' + v + '"></label>';
      });
      html += '</div>';
    }
    html += '<div class="cad-prop-meta">';
    if (e.kind === 'line') {
      html += '<span>长度 <b>' + fmt(dist(e.x0, e.y0, e.x1, e.y1), 2) + '</b></span>' +
        '<span>角度 <b>' + fmt(lineAngle({ x: e.x0, y: e.y0 }, { x: e.x1, y: e.y1 }), 1) + '°</b></span>';
    } else if (e.kind === 'rect') {
      html += '<span>宽 <b>' + fmt(Math.abs(e.x1 - e.x0), 2) + '</b></span>' +
        '<span>高 <b>' + fmt(Math.abs(e.y1 - e.y0), 2) + '</b></span>';
    } else if (e.kind === 'circle') {
      html += '<span>直径 <b>' + fmt(e.r * 2, 2) + '</b></span>';
    } else if (e.kind === 'arc') {
      var sweep = deg(arcSweep(e));
      html += '<span>圆心角 <b>' + fmt(sweep, 1) + '°</b></span>' +
        '<span>弧长 <b>' + fmt(e.r * sweep * Math.PI / 180, 2) + '</b></span>' +
        '<button type="button" class="cad-mini" data-act="flip">反向</button>';
    }
    html += '</div>';
    els.props.innerHTML = html; bindAttrInputs();
  }

  /* ---------------- 侧栏：图层 ---------------- */
  function renderLayers() {
    if (!els.layers) return;
    var lst = document.getElementById('mdLayersList') || els.layers;
    clearNode(lst);
    var fq = (document.getElementById('mdLayerFilter') || {}).value || '';
    state.layers.forEach(function (L) {
      if (fq && String(L.name).toLowerCase().indexOf(fq.toLowerCase()) < 0 && String(L.id).toLowerCase().indexOf(fq.toLowerCase()) < 0) return;
      var row = document.createElement('div');
      row.className = 'cad-layer' + (L.id === state.curLayer ? ' is-cur' : '');
      row.setAttribute('data-layer', L.id);
      row.innerHTML =
        '<button type="button" class="cad-eye' + (L.visible ? ' is-on' : '') + '" data-act="vis" title="显示/隐藏">' +
        (L.visible ? '&#128065;' : '&#8212;') + '</button>' +
        '<button type="button" class="cad-lock' + (L.locked ? ' is-on' : '') + '" data-act="lock" title="锁定/解锁">' +
        (L.locked ? '&#128274;' : '&#128275;') + '</button>' +
        '<input type="color" class="cad-swatch" data-act="color" value="' + L.color + '" title="图层颜色">' +
        '<span class="nm">' + escapeHtml(L.name) + '</span>' +
        (L.id === state.curLayer ? '<span class="cur">当前</span>' : '') +
        '<button type="button" class="lt" data-act="ltype" title="点击切换线型">' +
        (L.ltype === 'continuous' ? '实线' : L.ltype === 'dashed' ? '虚线' : '点划线') + '</button>';
      lst.appendChild(row);
    });
    var foot = document.createElement('div');
    foot.className = 'cad-layer-actions';
    foot.innerHTML = '<button type="button" class="cad-btn" data-act="add">+ 新建图层</button>' +
      '<button type="button" class="cad-btn" data-act="setcur">置为当前</button>';
    els.layers.appendChild(foot);
    if (els.curLayerSel) {
      var opts = state.layers.map(function (L) {
        return '<option value="' + L.id + '"' + (L.id === state.curLayer ? ' selected' : '') + '>' + escapeHtml(L.name) + '</option>';
      }).join('');
      if (els.curLayerSel.innerHTML !== opts) els.curLayerSel.innerHTML = opts;
      els.curLayerSel.value = state.curLayer;
    }
  }

  function addLayer() {
    var n = 1, name;
    do { name = '图层' + n++; } while (state.layers.some(function (L) { return L.name === name; }));
    var L = { id: 'L' + Date.now().toString(36), name: name, color: '#e8eef8', ltype: 'continuous', visible: true, locked: false };
    state.layers.push(L);
    state.curLayer = L.id;
    renderLayers();
    renderProps();
    scheduleSave();
    msg('已新建图层「' + name + '」并置为当前');
  }

  function showSidePanel() {
    if (els.side && els.side.hidden) {
      els.side.hidden = false;
      if (els.split) els.split.hidden = false;
      var btn = document.getElementById('mdSideToggle');
      if (btn) btn.classList.add('is-on');
    }
  }

  function setSideTab(tab) {
    showSidePanel();
    sideTab = tab;
    if (els.props) els.props.hidden = tab !== 'props';
    if (els.layers) els.layers.hidden = tab !== 'layers';
    if (els.sideTabs) {
      Array.prototype.forEach.call(els.sideTabs.querySelectorAll('[data-side]'), function (b) {
        b.classList.toggle('is-on', b.getAttribute('data-side') === tab);
      });
    }
    if (tab === 'layers') renderLayers();
  }

  /* ---------------- 动态输入 ---------------- */
  function dynFieldsFor(cmd) {
    if (!cmd) return [];
    var n = cmd.name, step = cmd.step;
    if (step !== 1) return [];
    if (n === 'line' || n === 'polyline') {
      var q = cmd.pts[cmd.pts.length - 1];
      if (!q) return [];
      return [{ key: 'len', label: '长度', unit: 'mm' }, { key: 'ang', label: '角度', unit: '°' }];
    }
    if (n === 'rect') return [{ key: 'w', label: '宽度', unit: 'mm' }, { key: 'h', label: '高度', unit: 'mm' }];
    if (n === 'circle') return [{ key: 'r', label: '半径', unit: 'mm' }];
    if (n === 'rotate') return [{ key: 'ang', label: '角度', unit: '°' }];
    if (n === 'scale') return [{ key: 'f', label: '比例', unit: '' }];
    return [];
  }

  function resetDynInput(keepIdx) {
    state.dyn.values = [];
    state.dyn.buf = '';
    if (!keepIdx) state.dyn.idx = 0;
  }

  function syncDyn() {
    if (!els.dyn) return;
    var cmd = state.cmd;
    var fields = state.dynOn && !drag && cmd ? dynFieldsFor(cmd) : [];
    state.dyn.fields = fields;
    if (!fields.length) { els.dyn.hidden = true; return; }
    if (state.dyn.idx >= fields.length) state.dyn.idx = 0;
    if (state.dyn.values.length > fields.length) state.dyn.values.length = fields.length;
    els.dyn.hidden = false;
    var html = fields.map(function (f, i) {
      var val = state.dyn.values[i] || '';
      return '<span class="cad-dyn-f' + (i === state.dyn.idx ? ' is-on' : '') + '">' +
        '<i>' + f.label + '</i><b>' + (val || '—') + '</b><em>' + f.unit + '</em></span>';
    }).join('');
    els.dyn.innerHTML = html;
    if (state.pointer.inside) {
      var s = zoneSize();
      var x = clamp(state.pointer.x + 26, 10, s.w - 180);
      var y = clamp(state.pointer.y + 30, 10, s.h - 50);
      els.dyn.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    }
  }
  function renderDyn() { syncDyn(); }

  /* ---------------- 命令：启动与结束 ---------------- */
  function startCmd(name, preset) {
    if (state.space === 'layout') {
      msg('图纸空间只读预览，请切换到【模型】后绘制');
      toast('图纸空间只读，切回模型');
      return;
    }
    if (els.cycleTag) els.cycleTag.hidden = true;
    var key = String(name || '').toUpperCase();
    var cmdName = ALIAS[key] || (CMD_LABEL[name] ? name : null);
    if (!cmdName) { msg('未知命令「' + name + '」。输入 ? 查看帮助。'); return; }
    if (cmdName === 'undo') { undo(); return; }
    if (cmdName === 'redo') { redo(); return; }
    if (cmdName === 'erase') { deleteSelection(); return; }
    if (cmdName === 'explode') { explodeSelection(); return; }
    if (cmdName === 'pan') { setTool('pan'); msg('平移：按住左键拖动，Esc 退出'); return; }
    if (cmdName === 'zoom') { startZoom(); return; }
    if (cmdName === 'dist') { startDist(); return; }
    if (cmdName === 'layers') { setSideTab('layers'); return; }
    if (cmdName === 'props') { setSideTab('props'); return; }
    if (cmdName === 'selsame') { selectSimilar(); return; }
    if (cmdName === 'osnap') { openOsnap(); return; }
    if (cmdName === 'export') { exportDXF(); return; }
    if (cmdName === 'save') { saveNow(); msg('草稿已保存到本机'); toast('草稿已保存'); return; }
    if (cmdName === 'help') { toggleHelp(true); return; }
    if (cmdName === 'grid') { toggleGrid(); return; }
    if (cmdName === 'ortho') { toggleOrtho(); return; }
    if (cmdName === 'polar') { togglePolar(); return; }

    cancelCmd(true);
    if (cmdName === 'block') {
      if (!state.selection.size) { msg('块定义：先选中要成块的图元'); return; }
      var bc = { name: 'block', step: 1, pts: [], data: {}, base: null, cursor: state.snap || null, target: null, dist: 0, refLen: 0, pick: false, selSaved: new Set(state.selection) };
      state.cmd = bc;
      setPrompt('输入块名（Enter 用默认 Block' + state.blockSeq + '）:');
      redrawLive(); syncPalette(); renderDyn();
      return;
    }
    if (cmdName === 'textedit') {
      var tsel = selectedEntities().filter(function (x) { return x.kind === 'text'; });
      if (!tsel.length) { msg('文字编辑：先选中文字'); return; }
      state.cmd = { name: 'textedit', step: 1, pts: [], data: {}, base: null, cursor: state.snap || null, target: tsel, dist: 0, refLen: 0, pick: false, selSaved: new Set(state.selection) };
      setPrompt('输入新文字（' + tsel.length + ' 处）:');
      redrawLive(); syncPalette(); renderDyn();
      return;
    }
    if (cmdName === 'revcloud') {
      state.cmd = { name: 'revcloud', step: 0, pts: [], data: {}, base: null, cursor: state.snap || null, target: null, dist: 0, refLen: 0, pick: false, selSaved: new Set(state.selection) };
      setPrompt('修订云线：点第一个点:');
      redrawLive(); syncPalette(); renderDyn();
      return;
    }
    if (cmdName === 'bomrefresh') {
      refreshBom();
      return;
    }
    if (cmdName === 'bedit') {
      var insE = selectedEntities().filter(function (x) { return x.kind === 'insert'; })[0];
      if (!insE) { msg('块编辑：先选中一个块引用'); return; }
      var bkE = state.blocks[insE.name];
      if (!bkE) { msg('找不到块定义'); return; }
      var dbe = insE.x - bkE.base.x, dbe2 = insE.y - bkE.base.y;
      var tempIds = [];
      bkE.entities.forEach(function (ce) {
        var ne = deepClone(ce); ne.id = uid(); translateEntity(ne, ce, dbe, dbe2);
        ne._bedit = true; ne._beditBlock = insE.name;
        state.entities.push(ne); tempIds.push(ne.id);
      });
      insE.hidden = true;
      state.blockEdit = { name: insE.name, insertId: insE.id, tempIds: tempIds, dx: dbe, dy: dbe2 };
      state.selection = new Set(tempIds);
      msg('进入块编辑「' + insE.name + '」：改完输入 BC 保存并退出');
      afterChange();
      return;
    }
    if (cmdName === 'bclose') {
      if (!state.blockEdit) { msg('当前不在块编辑状态'); return; }
      var be = state.blockEdit;
      var temps = state.entities.filter(function (x) { return x._bedit && x._beditBlock === be.name; });
      var before = snapshot();
      var local = temps.map(function (te) {
        var ce = deepClone(te);
        ce.id = uid(); delete ce._bedit; delete ce._beditBlock;
        translateEntity(ce, te, -be.dx, -be.dy);
        return ce;
      });
      state.blocks[be.name].entities = local;
      var keep = {}; temps.forEach(function (t) { keep[t.id] = 1; });
      state.entities = state.entities.filter(function (x) { return !keep[x.id]; });
      var insR = state.entities.find(function (x) { return x.id === be.insertId; });
      if (insR) insR.hidden = false;
      state.blockEdit = null;
      state.selection = new Set(insR ? [insR.id] : []);
      pushUndo(before, '保存块编辑');
      msg('块「' + be.name + '」已更新：' + local.length + ' 个图元');
      afterChange();
      return;
    }
    if (cmdName === 'table') {
      state.cmd = { name: 'table', step: 1, pts: [], data: {}, base: null, cursor: state.snap || null, target: null, dist: 0, refLen: 0, pick: false, selSaved: new Set(state.selection) };
      setPrompt('输入表格内容（行用 ; 列用 ,，例：序号,名称,数量;1,底板,1）:');
      redrawLive(); syncPalette(); renderDyn();
      return;
    }
    if (cmdName === 'bom') {
      state.cmd = { name: 'bom', step: 0, pts: [], data: {}, base: null, cursor: state.snap || null, target: null, dist: 0, refLen: 0, pick: false, selSaved: new Set(state.selection) };
      setPrompt('指定明细栏左下角位置:');
      redrawLive(); syncPalette(); renderDyn();
      return;
    }
    if (cmdName === 'attr') {
      var selAttr = selectedEntities().filter(function (e) { return e.kind === 'insert'; });
      if (!selAttr.length) { msg('块属性：先选中一个块引用'); return; }
      var blkA = state.blocks[selAttr[0].name];
      var txtCount = blkA ? blkA.entities.filter(function (x) { return x.kind === 'text'; }).length : 0;
      if (!txtCount) { msg('这个块里没有文字，无法设属性'); return; }
      state.cmd = { name: 'attr', step: 1, idx: 0, count: txtCount, pts: [], data: {}, base: null, cursor: state.snap || null, target: selAttr[0], dist: 0, refLen: 0, pick: false, selSaved: new Set(state.selection) };
      setPrompt('属性 1/' + txtCount + '：输入文字');
      redrawLive(); syncPalette(); renderDyn();
      return;
    }
    if (cmdName === 'insert') {
      var ic = { name: 'insert', step: 0, pts: [], data: {}, base: null, cursor: state.snap || null, target: null, dist: 0, refLen: 0, pick: false, selSaved: new Set(state.selection), blockName: null };
      state.cmd = ic;
      setPrompt('输入块名（Enter 用最近块）:');
      redrawLive(); syncPalette(); renderDyn();
      return;
    }
    var c = {
      name: cmdName, step: 0, pts: [], data: {}, base: null, cursor: state.snap || null,
      target: null, dist: 0, refLen: 0, pick: false, selSaved: new Set(state.selection)
    };
    state.cmd = c;
    state.lastCmd = cmdName;
    msg('命令: ' + (CMD_LABEL[cmdName] || cmdName));
    if (cmdName === 'offset') {
      c.dist = 10;
      c.step = 0;
      prompt('指定偏移距离 <10>:');
      syncDyn();
      redrawLive();
      return;
    }
    if (cmdName === 'array') {
      prompt('输入行数 <3>:');
      syncDyn();
      redrawLive();
      return;
    }
    if (isModify(cmdName)) {
      if (!state.selection.size) {
        c.pick = true;
        prompt('选择对象:');
      } else {
        c.step = 1;
        prompt(modifyPrompt(cmdName));
      }
      syncDyn();
      redrawLive();
      return;
    }
    prompt(drawPrompt(cmdName, 0));
    syncDyn();
    redrawLive();
  }

  function isModify(n) {
    return ['move', 'copy', 'rotate', 'mirror', 'offset', 'scale', 'array'].indexOf(n) >= 0;
  }
  function drawPrompt(n, step) {
    if (n === 'line') return step ? '指定下一点或 [放弃(U)]:' : '指定第一点:';
    if (n === 'polyline') return step ? '指定下一点或 [闭合(C)/放弃(U)]:' : '指定起点:';
    if (n === 'rect') return step ? '指定另一个角点:' : '指定第一个角点:';
    if (n === 'circle') return step ? '指定半径:' : '指定圆心:';
    if (n === 'arc') return step === 0 ? '指定圆弧起点:' : step === 1 ? '指定圆弧端点:' : '指定弧上一点:';
    return '';
  }
  function modifyPrompt(n) {
    if (n === 'rotate' || n === 'scale') return '指定基点:';
    if (n === 'mirror') return '指定镜像线第一点:';
    if (n === 'move' || n === 'copy') return '指定基点:';
    return '指定点:';
  }
  function prompt(t) {
    if (state.cmd) state.cmd.prompt = t;
    setPrompt(t || '命令:');
  }

  function endCmd(silent) {
    var c = state.cmd;
    state.cmd = null;
    state.dyn.fields = [];
    resetDynInput();
    setPrompt('命令:');
    if (!silent) syncDyn();
    redrawLive();
    if (!silent && c) msg('命令结束');
    void c;
  }

  function cancelCmd(silent, discard) {
    if (!state.cmd) return false;
    var c = state.cmd;
    var kept = false;
    if (!discard && c.name === 'polyline' && c.pts.length >= 2) {
      /* 取消时保留已画段 */
      finishPolyline(false, true, c);
      kept = true;
    }
    state.cmd = null;
    state.dyn.fields = [];
    resetDynInput();
    setPrompt('命令:');
    if (!silent) { syncDyn(); if (kept) afterChange(); else redrawLive(); msg('*取消*'); }
    else if (kept) afterChange();
    return true;
  }

  /* ---------------- 命令：点输入 ---------------- */
  function cmdPoint(p, fromDyn) {
    var c = state.cmd;
    if (!c) return;
    p = { x: round4(p.x), y: round4(p.y) };
    state.lastPoint = p;
    c.cursor = p;

    if (c.pick) {
      var hit = hitTest(p.x, p.y);
      if (hit) {
        if (c.selSaved.has(hit.id)) { state.selection.delete(hit.id); c.selSaved.delete(hit.id); }
        else { state.selection.add(hit.id); c.selSaved.add(hit.id); }
        redrawLive();
        renderProps();
        renderList();
        prompt('选择对象（回车继续）:');
      }
      return;
    }

    switch (c.name) {
      case 'line':
        if (!c.pts.length) { c.pts = [p]; c.step = 1; prompt(drawPrompt('line', 1)); }
        else {
          var before = snapshot();
          state.entities.push({
            id: uid(), kind: 'line', layer: state.curLayer, color: state.curColor || undefined,
            x0: round4(c.pts[0].x), y0: round4(c.pts[0].y), x1: p.x, y1: p.y
          });
          pushUndo(before, '绘制直线');
          c.pts = [p];
          prompt('指定下一点或 [放弃(U)]:');
          afterChange();
          if (fromDyn) state.dyn.buf = '';
        }
        break;
      case 'polyline':
        c.pts.push(p);
        c.step = 1;
        prompt(drawPrompt('polyline', 1));
        break;
      case 'rect':
        if (!c.pts.length) { c.pts = [p]; c.step = 1; prompt(drawPrompt('rect', 1)); }
        else { commitRect(c.pts[0], p); }
        break;
      case 'circle':
        if (!c.pts.length) { c.pts = [p]; c.step = 1; prompt(drawPrompt('circle', 1)); }
        else { commitCircle(c.pts[0], p); }
        break;
      case 'arc':
        c.pts.push(p);
        if (c.pts.length >= 3) commitArc(c.pts[0], c.pts[1], c.pts[2]);
        else { c.step = c.pts.length; prompt(drawPrompt('arc', c.pts.length)); }
        break;
      case 'move':
      case 'copy':
        if (!c.base) { c.base = p; c.step = 1; prompt('指定第二点:'); }
        else commitMoveCopy(c.name, c.base, p);
        break;
      case 'rotate':
        if (!c.base) { c.base = p; c.step = 1; prompt('指定旋转角度:'); }
        else commitRotate(c.base, lineAngle(c.base, p));
        break;
      case 'scale':
        if (!c.base) { c.base = p; c.step = 1; prompt('指定比例因子或 [参照(R)]:'); }
        else if (!c.refLen) { c.refLen = Math.max(0.0001, dist(c.base.x, c.base.y, p.x, p.y)); prompt('指定新长度点:'); }
        else commitScale(c.base, Math.max(0.01, dist(c.base.x, c.base.y, p.x, p.y) / c.refLen));
        break;
      case 'mirror':
        c.pts.push(p);
        if (c.pts.length === 1) prompt('指定镜像线第二点:');
        else {
          c.data.mirrorA = c.pts[0];
          c.data.mirrorB = c.pts[1];
          prompt('要删除源对象吗? [是(Y)/否(N)] <否>:');
        }
        break;
      case 'offset':
        if (!c.target) {
          var hit2 = hitTest(p.x, p.y);
          if (hit2) { c.target = hit2; prompt('指定要偏移的那一侧:'); }
        } else {
          var off = offsetEntity(c.target, c.dist, p);
          if (!off) { msg('该对象无法按此距离偏移'); return; }
          off.layer = c.target.layer;
          var before2 = snapshot();
          state.entities.push(off);
          pushUndo(before2, '偏移');
          msg('已偏移：' + KIND_NAME[off.kind] + ' · 距离 ' + fmt(c.dist, 2));
          c.target = null;
          c.step = 1;
          prompt('选择要偏移的对象（距离 ' + fmt(c.dist, 1) + '）:');
          afterChange();
        }
        break;
      case 'leader': {
        c.pts.push(p);
        prompt('下一点（Enter 完成折线，再输入文字）:');
        break;
      }
      case 'dim': {
        c.pts.push(p);
        if (c.pts.length === 1) prompt('指定尺寸线位置:');
        else if (c.pts.length === 2) { c.step = 2; prompt('指定尺寸线偏移位置:'); }
        else { buildLinearDim(c.pts[0], c.pts[1], p); }
        break;
      }
      case 'dimdia': {
        if (!c.target) {
          var hc = hitTest(p.x, p.y);
          if (hc && (hc.kind === 'circle')) { c.target = hc; prompt('指定标注文字位置:'); }
          else msg('请选择一个圆');
        } else { buildDiaDim(c.target, p); }
        break;
      }
      case 'autodim':
        autoDimSelection();
        break;
      case 'revcloud': {
        c.pts.push(p);
        prompt('继续点（Enter 闭合云线）:');
        break;
      }
      case 'bom': {
        var insAll = state.entities.filter(function (x) { return x.kind === 'insert'; });
        var bomRows = [['序号', '名称', '数量', '材料']];
        if (insAll.length) {
          var cnt = {};
          insAll.forEach(function (x) {
            var nm = (x.attrs && x.attrs[0]) || x.name;
            cnt[nm] = (cnt[nm] || 0) + 1;
          });
          var idxB = 1;
          Object.keys(cnt).forEach(function (nm) { bomRows.push([String(idxB++), nm, String(cnt[nm]), '—']); });
        } else {
          bomRows = [['序号', '名称', '数量', '材料'], ['1', '底板', '1', 'Q235'], ['2', '螺栓', '4', '8.8级'], ['3', '垫圈', '4', '65Mn']];
        }
        var startB = state.entities.length;
        createTable(bomRows, p.x, p.y);
        for (var kb = startB; kb < state.entities.length; kb++) state.entities[kb]._bom = true;
        state.lastBom = { x: p.x, y: p.y };
        msg('已插入明细栏（' + bomRows.length + ' 行）');
        endCmd(true);
        afterChange();
        break;
      }
      case 'hatch':
      case 'hatch45':
      case 'hatchcross': {
        var hb = hitTest(p.x, p.y);
        var hp = hb ? boundaryPts(hb) : null;
        if (!hp || hp.length < 3) { msg('填充：请点一个闭合边界（矩形 / 闭合多段线 / 圆）'); break; }
        var beforeH = snapshot();
        var pat = c.name === 'hatch45' ? 'diag' : (c.name === 'hatchcross' ? 'cross' : 'solid');
        state.entities.push({ id: uid(), kind: 'hatch', layer: state.curLayer, pts: hp, pattern: pat, spacing: 6, boundaryRef: { id: hb.id } });
        pushUndo(beforeH, pat === 'solid' ? '填充' : '剖面线填充');
        msg(pat === 'solid' ? ('已填充：' + hp.length + ' 个顶点') : ('已加剖面线（' + pat + '）'));
        endCmd(true);
        afterChange();
        break;
      }
      case 'insert': {
        var blk = c.blockName ? state.blocks[c.blockName] : null;
        if (!blk) { msg('没有可插入的块'); endCmd(true); break; }
        var beforeI = snapshot();
        state.entities.push({ id: uid(), kind: 'insert', name: c.blockName, x: round4(p.x), y: round4(p.y), layer: state.curLayer, attrs: [] });
        pushUndo(beforeI, '插入块');
        msg('已插入块引用「' + c.blockName + '」（X ' + fmt(p.x, 1) + ' / Y ' + fmt(p.y, 1) + '）');
        endCmd(true);
        afterChange();
        break;
      }
      case 'trim': {
        var hTrim = hitTest(p.x, p.y);
        if (!hTrim) { msg('修剪：点在被剪掉的那一段上'); break; }
        quickTrim(hTrim, p);
        break;
      }
      case 'extend': {
        var hExt = hitTest(p.x, p.y);
        if (!hExt) { msg('延伸：点在要延伸的那一端附近'); break; }
        quickExtend(hExt, p);
        break;
      }
      case 'zoom':
        if (!c.pts.length) { c.pts = [p]; prompt('指定对角点:'); }
        else {
          var b = {
            x0: Math.min(c.pts[0].x, p.x), y0: Math.min(c.pts[0].y, p.y),
            x1: Math.max(c.pts[0].x, p.x), y1: Math.max(c.pts[0].y, p.y)
          };
          zoomWindow(b);
          endCmd(true);
        }
        break;
      case 'dist':
        if (!c.pts.length) { c.pts = [p]; prompt('指定第二点:'); }
        else {
          var d = dist(c.pts[0].x, c.pts[0].y, p.x, p.y);
          msg('距离 = ' + fmt(d, 3) + '  ΔX = ' + fmt(p.x - c.pts[0].x, 3) + '  ΔY = ' + fmt(p.y - c.pts[0].y, 3) +
            '  角度 = ' + fmt(lineAngle(c.pts[0], p), 2) + '°', 'ok');
          toast('距离 ' + fmt(d, 2));
          endCmd(true);
        }
        break;
    }
    resetDynInput(false);
    redrawLive();
    renderDyn();
  }

  /* ---------------- 命令：提交 ---------------- */
  function commitRect(a, b) {
    if (Math.abs(b.x - a.x) < 0.1 && Math.abs(b.y - a.y) < 0.1) { msg('矩形尺寸过小'); return; }
    var before = snapshot();
    state.entities.push({
      id: uid(), kind: 'rect', layer: state.curLayer, color: state.curColor || undefined,
      x0: round4(a.x), y0: round4(a.y), x1: round4(b.x), y1: round4(b.y)
    });
    pushUndo(before, '绘制矩形');
    msg('矩形 ' + fmt(Math.abs(b.x - a.x), 2) + ' × ' + fmt(Math.abs(b.y - a.y), 2));
    endCmd(true);
    afterChange();
  }
  function commitCircle(a, b) {
    var r = dist(a.x, a.y, b.x, b.y);
    if (r < 0.1) { msg('半径过小'); return; }
    var before = snapshot();
    state.entities.push({ id: uid(), kind: 'circle', layer: state.curLayer, color: state.curColor || undefined, cx: round4(a.x), cy: round4(a.y), r: round4(r) });
    pushUndo(before, '绘制圆');
    msg('圆 R = ' + fmt(r, 2));
    endCmd(true);
    afterChange();
  }
  function commitArc(a, b, m) {
    var arc = arcFrom3(a, b, m);
    if (!arc) { msg('三点接近共线，请重新指定弧上一点'); state.cmd.pts = [a, b]; prompt(drawPrompt('arc', 2)); return; }
    arc.id = uid();
    arc.kind = 'arc';
    arc.layer = state.curLayer;
    if (state.curColor) arc.color = state.curColor;
    var before = snapshot();
    state.entities.push(arc);
    pushUndo(before, '绘制圆弧');
    msg('圆弧 R = ' + fmt(arc.r, 2) + '  圆心角 ' + fmt(deg(arcSweep(arc)), 1) + '°');
    endCmd(true);
    afterChange();
  }

  function finishPolyline(closed, keepPts, src) {
    var c = src || state.cmd;
    var pts = c ? c.pts.slice() : [];
    if (!keepPts) state.cmd = null;
    if (pts.length < 2) { endCmd(true); return; }
    var before = snapshot();
    state.entities.push({ id: uid(), kind: 'polyline', layer: state.curLayer, color: state.curColor || undefined, pts: pts.map(function (p) { return { x: round4(p.x), y: round4(p.y) }; }), closed: !!closed });
    pushUndo(before, closed ? '绘制闭合多段线' : '绘制多段线');
    msg('多段线 ' + pts.length + ' 个顶点' + (closed ? '（闭合）' : ''));
    if (!keepPts) { endCmd(true); afterChange(); }
  }

  function commitMoveCopy(kind, base, p) {
    var list = editableSelection();
    if (!list.length) { msg('所选对象位于锁定或隐藏图层'); endCmd(true); return; }
    var dx = p.x - base.x, dy = p.y - base.y;
    var before = snapshot();
    if (kind === 'move') {
      list.forEach(function (e) { translateEntity(e, e, dx, dy); });
      pushUndo(before, '移动');
      msg('移动 ΔX ' + fmt(dx, 2) + '  ΔY ' + fmt(dy, 2));
      endCmd(true);
    } else {
      var clones = list.map(function (e) { var c2 = cloneEntity(e); translateEntity(c2, e, dx, dy); return c2; });
      state.entities = state.entities.concat(clones);
      pushUndo(before, '复制');
      msg('复制 ' + clones.length + ' 个对象');
      if (state.cmd) { state.cmd.base = base; prompt('指定第二点（Esc 结束）:'); }
    }
    afterChange();
  }

  function commitRotate(base, angleDeg) {
    var list = editableSelection();
    if (!list.length) { endCmd(true); return; }
    var before = snapshot();
    list.forEach(function (e) {
      var r = rotateEntity(e, base, rad(angleDeg));
      assignEntity(e, r);
    });
    pushUndo(before, '旋转');
    msg('旋转 ' + fmt(angleDeg, 2) + '°');
    endCmd(true);
    afterChange();
  }

  function commitScale(base, factor) {
    var list = editableSelection();
    if (!list.length) { endCmd(true); return; }
    if (!isFinite(factor) || Math.abs(factor) < 0.001) { msg('比例因子无效'); return; }
    var before = snapshot();
    list.forEach(function (e) { assignEntity(e, scaleEntity(e, base, factor)); });
    pushUndo(before, '缩放');
    msg('缩放比例 ×' + fmt(factor, 3));
    endCmd(true);
    afterChange();
  }

  function commitMirror(delSource) {
    var c = state.cmd;
    if (!c) return;
    var list = editableSelection();
    var before = snapshot();
    var clones = list.map(function (e) { return mirrorEntity(e, c.data.mirrorA, c.data.mirrorB); });
    if (delSource) {
      state.entities = state.entities.filter(function (e) { return !state.selection.has(e.id); }).concat(clones);
      state.selection = new Set(clones.map(function (e) { return e.id; }));
    } else {
      state.entities = state.entities.concat(clones);
      state.selection = new Set(clones.map(function (e) { return e.id; }));
    }
    pushUndo(before, '镜像');
    msg('镜像 ' + clones.length + ' 个对象' + (delSource ? '（删除源对象）' : ''));
    endCmd(true);
    afterChange();
  }

  function assignEntity(dst, src) {
    Object.keys(dst).forEach(function (k) { if (k !== 'id') delete dst[k]; });
    Object.keys(src).forEach(function (k) { dst[k] = src[k]; });
  }

  function explodeSelection() {
    var list = editableSelection();
    if (!list.length) { msg('请先选择可分解的对象'); return; }
    var before = snapshot();
    var add = [], del = {};
    list.forEach(function (e) {
      var parts = explodeEntity(e);
      if (parts) { add = add.concat(parts); del[e.id] = 1; }
    });
    if (!add.length) { msg('所选对象无法分解'); return; }
    state.entities = state.entities.filter(function (e) { return !del[e.id]; }).concat(add);
    state.selection = new Set(add.map(function (e) { return e.id; }));
    pushUndo(before, '分解');
    msg('分解为 ' + add.length + ' 个对象');
    afterChange();
  }

  /* ---------------- 命令：选项 / 回车 ---------------- */
  function cmdEnter() {
    var c = state.cmd;
    if (!c) {
      if (state.lastCmd) startCmd(state.lastCmd);
      return;
    }
    if (c.name === 'revcloud' && c.pts.length >= 3) {
      createCloud(c.pts, state.cloudBump || 5);
      endCmd(true);
      afterChange();
      return;
    }
    if (c.name === 'leader' && c.pts.length >= 2 && c.step !== 2) {
      c.step = 2;
      setPrompt('输入引线文字（Enter 确认）:');
      return;
    }
    if (c.name === 'insert' && c.step === 0) {
      var nm = state.lastBlock;
      if (!nm || !state.blocks[nm]) { msg('还没有块，请先「块定义」'); return; }
      c.blockName = nm;
      c.step = 1;
      setPrompt('指定插入点（块「' + nm + '」）:');
      return;
    }
    if (c.pick) {
      if (!state.selection.size) { msg('未选择对象'); return; }
      c.pick = false;
      c.step = 1;
      prompt(modifyPrompt(c.name));
      redrawLive();
      return;
    }
    switch (c.name) {
      case 'line':
      case 'polyline':
        if (c.name === 'polyline') finishPolyline(false);
        else endCmd(true);
        return;
      case 'offset':
        if (c.step === 0) { offsetSetDistance(c.dist || 10); return; }
        if (!c.target) { msg('请选择要偏移的对象'); return; }
        return;
      case 'array':
        nextArrayStep(null);
        return;
      case 'scale':
        if (c.step >= 1 && c.base) commitScale(c.base, 1);
        else endCmd(true);
        return;
      case 'rotate':
        if (c.base) { commitRotate(c.base, 0); }
        return;
      case 'mirror':
        if (c.pts.length >= 2) commitMirror(false);
        else endCmd(true);
        return;
      default:
        endCmd();
    }
  }

  function offsetSetDistance(d) {
    var c = state.cmd;
    if (!c || c.name !== 'offset') return;
    var v = isFinite(d) && d > 0 ? d : 10;
    c.dist = v;
    c.step = 1;
    var sel = editableSelection();
    if (sel.length === 1) {
      c.target = sel[0];
      prompt('指定要偏移的那一侧:');
    } else {
      c.target = null;
      prompt('选择要偏移的对象（距离 ' + fmt(v, 1) + '）:');
    }
    msg('偏移距离 = ' + fmt(v, 2));
    redrawLive();
  }

  function cmdOption(letter) {
    var c = state.cmd;
    if (!c) return false;
    var up = letter.toUpperCase();
    if (c.name === 'polyline' && c.pts.length >= 2) {
      if (up === 'C') { finishPolyline(true); return true; }
      if (up === 'U') { c.pts.pop(); c.step = c.pts.length ? 1 : 0; prompt(drawPrompt('polyline', c.step)); redrawLive(); return true; }
    }
    if (c.name === 'zoom') {
      if (up === 'E') { fit(); endCmd(true); return true; }
      if (up === 'A') { fit(); endCmd(true); return true; }
      if (up === 'I') { zoomStep(1.6); return true; }
      if (up === 'O') { zoomStep(1 / 1.6); return true; }
    }
    if (c.name === 'mirror' && c.pts.length >= 2) {
      if (up === 'Y') { commitMirror(true); return true; }
      if (up === 'N') { commitMirror(false); return true; }
    }
    if (c.name === 'scale') {
      if (up === 'R') { c.refLen = 0; prompt('指定参照长度起点:'); return true; }
    }
    if (c.name === 'offset') {
      if (up === 'U') { msg('偏移：直接输入距离后选择对象'); return true; }
    }
    return false;
  }

  /* ---------------- 阵列 ---------------- */
  function nextArrayStep(input) {
    var c = state.cmd;
    if (!c || c.name !== 'array') return;
    var d = c.data;
    var labels = [
      ['rows', '输入行数 <3>:', 3],
      ['cols', '输入列数 <3>:', 3],
      ['dr', '输入行距 <20>:', 20],
      ['dc', '输入列距 <20>:', 20]
    ];
    var idx = c.step || 0;
    var item = labels[idx];
    if (!item) { applyArray(); return; }
    var v = input == null ? item[2] : parseFloat(input);
    if (!isFinite(v)) v = item[2];
    d[item[0]] = item[0] === 'rows' || item[0] === 'cols' ? Math.max(1, Math.round(v)) : v;
    c.step = idx + 1;
    if (c.step >= labels.length) { applyArray(); return; }
    prompt(labels[c.step][1]);
    msg(item[0] === 'rows' ? '行数 ' + d.rows : item[0] === 'cols' ? '列数 ' + d.cols : item[0] === 'dr' ? '行距 ' + fmt(d.dr, 2) : '列距 ' + fmt(d.dc, 2));
  }

  function applyArray() {
    var c = state.cmd;
    var d = c && c.data;
    if (!d) return;
    var list = editableSelection();
    if (!list.length) { msg('请先选择要阵列的对象'); endCmd(true); return; }
    var rows = d.rows || 3, cols = d.cols || 3, dr = d.dr || 20, dc = d.dc || 20;
    var before = snapshot();
    var added = [];
    for (var r = 0; r < rows; r++) {
      for (var j = 0; j < cols; j++) {
        if (!r && !j) continue;
        list.forEach(function (e) {
          var cl = cloneEntity(e);
          translateEntity(cl, e, j * dc, r * dr);
          added.push(cl);
        });
      }
    }
    state.entities = state.entities.concat(added);
    pushUndo(before, '矩形阵列');
    msg('矩形阵列 ' + rows + ' 行 × ' + cols + ' 列，共新增 ' + added.length + ' 个对象');
    endCmd(true);
    afterChange();
  }

  /* ---------------- 缩放 / 距离 ---------------- */
  function startZoom() {
    cancelCmd(true);
    state.cmd = { name: 'zoom', step: 0, pts: [], data: {}, prompt: '' };
    prompt('指定窗口角点或 [全部(A)/范围(E)/放大(I)/缩小(O)] <范围>:');
    redrawLive();
  }
  function startDist() {
    cancelCmd(true);
    state.cmd = { name: 'dist', step: 0, pts: [], data: {}, prompt: '' };
    prompt('指定第一点:');
    redrawLive();
  }
  function zoomWindow(b) {
    var s = zoneSize();
    var bw = Math.max(b.x1 - b.x0, 0.001), bh = Math.max(b.y1 - b.y0, 0.001);
    var z = clamp(Math.min(s.w / bw, s.h / bh) * 0.9, MIN_ZOOM, MAX_ZOOM);
    state.view.zoom = z;
    state.view.tx = s.w / 2 - (b.x0 + b.x1) / 2 * z;
    state.view.ty = s.h / 2 - (b.y0 + b.y1) / 2 * z;
    redrawAll();
    msg('缩放至窗口');
  }

  /* ---------------- 选择与编辑 ---------------- */
  function deleteSelection() {
    if (!state.selection.size) { msg('请先选择要删除的对象'); return; }
    var list = editableSelection();
    if (!list.length) { msg('所选对象位于锁定图层，无法删除'); return; }
    var before = snapshot();
    var del = {};
    list.forEach(function (e) { del[e.id] = 1; });
    state.entities = state.entities.filter(function (e) { return !del[e.id]; });
    state.selection.clear();
    pushUndo(before, '删除');
    afterChange();
    msg('已删除 ' + Object.keys(del).length + ' 个对象');
  }

  function clearAll() {
    if (!state.entities.length) { msg('画布已经是空的'); return; }
    var before = snapshot();
    state.entities = [];
    state.selection.clear();
    pushUndo(before, '新建画布');
    afterChange();
    msg('已清空画布（可撤销）');
  }

  function duplicateSelection() {
    if (!state.selection.size) { msg('请先选择要复制的对象'); return; }
    var list = editableSelection();
    if (!list.length) { msg('所选对象位于锁定图层'); return; }
    var before = snapshot();
    var off = Math.max(state.grid, 1) * 2;
    var clones = list.map(function (e) {
      var c = cloneEntity(e);
      translateEntity(c, e, off, off);
      return c;
    });
    state.entities = state.entities.concat(clones);
    state.selection = new Set(clones.map(function (c) { return c.id; }));
    pushUndo(before, '复制');
    afterChange();
    msg('已复制 ' + clones.length + ' 个对象');
  }

  function selectAll() {
    state.selection = new Set(state.entities.filter(editable).map(function (e) { return e.id; }));
    redrawLive();
    renderProps();
    renderList();
    updateHistoryButtons();
    setCursor();
  }

  /* 选择同类：同类型 + 同图层（AutoCAD SELECTSIMILAR 的简化实现） */
  function selectSimilar() {
    var src = selectedEntities();
    if (!src.length) {
      var h = hitTest(state.pointer.wx, state.pointer.wy);
      if (!h) { msg('请先选择对象，或把鼠标移到对象上再执行 SS'); return; }
      src = [h];
    }
    var kinds = {}, layers = {};
    src.forEach(function (e) { kinds[e.kind] = 1; layers[e.layer] = 1; });
    var ids = state.entities.filter(function (e) {
      return editable(e) && kinds[e.kind] && layers[e.layer];
    }).map(function (e) { return e.id; });
    state.selection = new Set(ids);
    redrawLive();
    renderProps();
    renderList();
    updateHistoryButtons();
    setCursor();
    msg('已选择同类对象 ' + ids.length + ' 个（' + Object.keys(kinds).map(function (k) { return KIND_NAME[k]; }).join(' / ') + '）');
    toast('选择同类：' + ids.length + ' 个对象');
  }

  function nudge(dx, dy) {
    if (!state.selection.size) return;
    if (!nudgeSession) { nudgeSession = true; pushUndo(snapshot(), '微调'); }
    state.entities.forEach(function (e) {
      if (state.selection.has(e.id) && editable(e)) translateEntity(e, e, dx, dy);
    });
    redrawLive();
    renderProps();
    scheduleSave();
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(function () { nudgeSession = null; }, 700);
  }

  function loadSample() {
    var before = snapshot();
    var L = state.curLayer;
    state.entities = [
      { id: uid(), kind: 'rect', layer: L, x0: 0, y0: 0, x1: 240, y1: 150 },
      { id: uid(), kind: 'circle', layer: L, cx: 70, cy: 75, r: 42 },
      { id: uid(), kind: 'circle', layer: L, cx: 70, cy: 75, r: 14 },
      { id: uid(), kind: 'circle', layer: L, cx: 42, cy: 47, r: 6 },
      { id: uid(), kind: 'circle', layer: L, cx: 98, cy: 47, r: 6 },
      { id: uid(), kind: 'circle', layer: L, cx: 42, cy: 103, r: 6 },
      { id: uid(), kind: 'circle', layer: L, cx: 98, cy: 103, r: 6 },
      { id: uid(), kind: 'polyline', layer: L, pts: [{ x: 130, y: 30 }, { x: 210, y: 30 }, { x: 210, y: 120 }, { x: 130, y: 120 }], closed: true },
      { id: uid(), kind: 'line', layer: 'center', x0: 20, y0: 75, x1: 230, y1: 75 },
      { id: uid(), kind: 'line', layer: 'center', x0: 70, y0: 15, x1: 70, y1: 140 },
      { id: uid(), kind: 'arc', layer: L, cx: 170, cy: 120, r: 40, a0: Math.PI, a1: 0, dir: -1 }
    ];
    state.selection.clear();
    pushUndo(before, '载入示例');
    fit(true);
    afterChange();
    msg('已载入示例图（可撤销）');
  }

  /* ---------------- 鼠标交互 ---------------- */
  function clientToScreen(ev) {
    var r = els.svg.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  function onDown(ev) {
    if (!built) return;
    if (ev.target.closest && ev.target.closest('.cad-dialog, .cad-menu-pop, .cad-tabs, .cad-viewcube')) return;
    closeMenus();
    ev.preventDefault();
    if (els.cmdInput && document.activeElement === els.cmdInput) els.cmdInput.blur();
    var s = clientToScreen(ev);
    state.pointer.x = s.x; state.pointer.y = s.y;
    var w = s2w(s.x, s.y);
    state.pointer.wx = w.x; state.pointer.wy = w.y;

    if (ev.button === 1 || state.tool === 'pan' || spaceDown) {
      if (ev.button === 1 && ev.detail >= 2) { zoomExtents(); setCursor(); return; }
      drag = { mode: 'pan', start: s, tx: state.view.tx, ty: state.view.ty };
      setCursor();
      return;
    }
    if (ev.button === 2) { onRightClick(ev, s); return; }
    if (ev.button !== 0) return;
    if (state.space === 'layout') { msg('图纸空间只读预览，切回【模型】后可编辑'); return; }

    /* 夹点编辑 */
    if (!state.cmd && state.tool === 'select') {
      lastScreen = { x: s.x, y: s.y };
    var gp = gripAt(s.x, s.y);
      var cellHit = hitTest(w.x, w.y);
      if (cellHit && cellHit.kind === 'text' && cellHit._cell) {
        var nvCell = window.prompt('编辑单元格', cellHit.text || '');
        if (nvCell !== null) { cellHit.text = nvCell; afterChange(); }
        state.selection = new Set([cellHit.id]);
        return;
      }
      if (gp) {
        if (ev.ctrlKey) {
          var beforeCopy = snapshot();
          var cpCopy = deepClone(gp.e);
          cpCopy.id = uid();
          state.entities.push(cpCopy);
          state.selection = new Set([cpCopy.id]);
          gp = { e: cpCopy, grip: gp.grip };
          drag = { mode: 'grip', e: cpCopy, grip: gp.grip, before: beforeCopy, moved: false, copy: true };
          msg('Ctrl 拖动：复制并移动');
        } else {
          drag = { mode: 'grip', e: gp.e, grip: gp.grip, before: snapshot(), moved: false };
        }
        setCursor();
        return;
      }
    }

    var anchor = null;
    if (state.cmd) {
      anchor = state.cmd.base || state.cmd.pts[state.cmd.pts.length - 1] || null;
    }
    var cp = cursorPoint(s.x, s.y, anchor);
    state.snap = cp;

    if (state.cmd) {
      cmdPoint(cp);
      setCursor();
      return;
    }

    if (state.tool === 'select') {
      var hits = hitTestAll(cp.x, cp.y);
      var hit = hits.length ? hits[0] : null;
      var cycled = false;
      if (hits.length > 1 && !ev.shiftKey) {
        var now = Date.now();
        var sameSpot = now - cyclePick.t < 900 &&
          Math.abs(cp.x - cyclePick.x) * state.view.zoom < 8 &&
          Math.abs(cp.y - cyclePick.y) * state.view.zoom < 8 &&
          cyclePick.ids.length === hits.length;
        if (sameSpot) {
          cyclePick.idx = (cyclePick.idx + 1) % hits.length;
          hit = hits[cyclePick.idx];
          cycled = true;
          msg('选择循环 ' + (cyclePick.idx + 1) + '/' + hits.length + '：' + (KIND_NAME[hit.kind] || hit.kind));
        } else {
          cyclePick = { t: now, x: cp.x, y: cp.y, ids: hits.map(function (e2) { return e2.id; }), idx: 0 };
        }
      } else if (hits.length <= 1) {
        cyclePick = { t: 0, x: 0, y: 0, ids: [], idx: 0 };
      }
      if (hit) {
        if (ev.shiftKey) {
          if (state.selection.has(hit.id)) state.selection.delete(hit.id);
          else state.selection.add(hit.id);
        } else if (cycled) {
          state.selection = new Set([hit.id]);
        } else if (!state.selection.has(hit.id)) {
          state.selection = new Set([hit.id]);
        }
        drag = { mode: 'move', start: cp, before: snapshot(), moved: false, orig: {} };
        selectedEntities().forEach(function (e) { drag.orig[e.id] = deepClone(e); });
        redrawLive(); renderProps(); renderList(); updateHistoryButtons(); setCursor();
        return;
      }
      if (!ev.shiftKey) state.selection.clear();
      drag = {
        mode: 'marquee', start: cp, cur: cp,
        base: new Set(state.selection), shift: ev.shiftKey
      };
      redrawLive(); renderProps(); renderList(); updateHistoryButtons(); setCursor();
      return;
    }

    /* 绘图直接点 */
    startCmd(state.tool);
    if (state.cmd) cmdPoint(cp);
  }

  function onRightClick(ev, s) {
    if (state.cmd) { cmdEnter(); return; }
    showContext(s.x, s.y);
  }

  function onMove(ev) {
    if (!built || !isVisible()) return;
    var s = clientToScreen(ev);
    state.pointer.x = s.x; state.pointer.y = s.y;
    state.pointer.inside = true;
    var w = s2w(s.x, s.y);
    state.pointer.wx = w.x; state.pointer.wy = w.y;
    shiftDown = !!ev.shiftKey;

    if (drag && drag.mode === 'pan') {
      state.view.tx = drag.tx + (s.x - drag.start.x);
      state.view.ty = drag.ty + (s.y - drag.start.y);
      scheduleAll();
      return;
    }

    var anchor = null;
    if (state.cmd) anchor = state.cmd.base || state.cmd.pts[state.cmd.pts.length - 1] || null;
    var cp = cursorPoint(s.x, s.y, anchor);
    state.snap = cp;

    if (drag && drag.mode === 'grip') {
      var gp = cursorPoint(s.x, s.y, null);
      applyGrip(drag.e, drag.grip.role, gp);
      drag.moved = true;
      scheduleLive();
      return;
    }

    if (drag && drag.mode === 'move') {
      var dx = cp.x - drag.start.x, dy = cp.y - drag.start.y;
      if (state.snapOn && state.gridOn) {
        var g = state.grid;
        if (g > 0) { dx = Math.round(dx / g) * g; dy = Math.round(dy / g) * g; }
      }
      if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) drag.moved = true;
      state.entities.forEach(function (e) {
        var src = drag.orig[e.id];
        if (src) { var cur = e; translateEntity(cur, src, dx, dy); }
      });
      scheduleLive();
      return;
    }

    if (drag && drag.mode === 'marquee') {
      drag.cur = cp;
      scheduleLive();
      return;
    }

    if (state.cmd) {
      state.cmd.cursor = cp;
      scheduleLive();
      return;
    }

    if (state.tool === 'select') {
      var hits = hitTestAll(cp.x, cp.y);
      var h = hits.length ? hits[0] : null;
      var id = h ? h.id : null;
      if (id !== hoverId) {
        /* 只切换 hover 类，避免整幅重绘 */
        var prevEl = els.world ? els.world.querySelector('.cad-ent.is-hover') : null;
        if (prevEl) prevEl.classList.remove('is-hover');
        hoverId = id;
        if (id && els.world) {
          var nextEl = els.world.querySelector('.cad-ent[data-id="' + id + '"]');
          if (nextEl) nextEl.classList.add('is-hover');
        }
        setCursor();
      }
      updateCycleTag(hits.length);
    }
    scheduleLive();
  }

  function onUp() {
    if (!built) return;
    if (!drag) return;
    var d = drag;
    drag = null;

    if (d.mode === 'pan') { setCursor(); return; }

    if (d.mode === 'grip') {
      if (d.moved) { pushUndo(d.before, '夹点编辑'); afterChange(); msg('已修改对象'); }
      else redrawLive();
      setCursor();
      return;
    }

    if (d.mode === 'move') {
      if (d.moved) {
        pushUndo(d.before, '移动');
        afterChange();
        msg('已移动 ' + state.selection.size + ' 个对象');
      } else redrawLive();
      setCursor();
      return;
    }

    if (d.mode === 'marquee') {
      var dxs = (d.cur.x - d.start.x) * state.view.zoom;
      var dys = (d.cur.y - d.start.y) * state.view.zoom;
      if (Math.hypot(dxs, dys) < 4) {
        redrawLive(); renderProps(); renderList(); updateHistoryButtons(); setCursor();
        return;
      }
      var crossing = d.cur.x < d.start.x;
      var r = {
        x0: Math.min(d.start.x, d.cur.x), y0: Math.min(d.start.y, d.cur.y),
        x1: Math.max(d.start.x, d.cur.x), y1: Math.max(d.start.y, d.cur.y)
      };
      var picked = [];
      state.entities.forEach(function (e) {
        if (!editable(e)) return;
        var b = entityBounds(e);
        var ok = crossing ? (b.x0 <= r.x1 && b.x1 >= r.x0 && b.y0 <= r.y1 && b.y1 >= r.y0)
          : (b.x0 >= r.x0 && b.x1 <= r.x1 && b.y0 >= r.y0 && b.y1 <= r.y1);
        if (ok) picked.push(e.id);
      });
      if (d.shift) picked.forEach(function (id) { state.selection.add(id); });
      else state.selection = new Set(picked);
      redrawLive();
      renderProps(); renderList(); updateHistoryButtons(); setCursor();
      if (picked.length) msg((crossing ? '交叉窗口' : '窗口') + '选择 ' + state.selection.size + ' 个对象');
    }
  }

  function onWheel(ev) {
    ev.preventDefault();
    var s = clientToScreen(ev);
    /* 触控板/滚轮单次步长限幅，缩放更稳定 */
    var dy = clamp(ev.deltaY, -120, 120);
    var factor = Math.exp(-dy * 0.0015);
    zoomAt(s.x, s.y, factor);
    updateStatus();
    updateDim();
    updateSnapTag();
  }

  /* ---------------- 动态输入 ---------------- */
  function dynVal(i) {
    var raw = state.dyn.values[i];
    if (raw != null && raw !== '') {
      var v = parseFloat(raw);
      return isFinite(v) ? v : null;
    }
    return null;
  }

  function applyDyn() {
    var c = state.cmd;
    if (!c || !state.dyn.fields.length) return false;
    var f = state.dyn.fields;
    var p = c.cursor || state.snap || { x: 0, y: 0 };
    var name = c.name;
    if (name === 'line' || name === 'polyline') {
      var a = c.pts[c.pts.length - 1];
      if (!a) return false;
      var len = dynVal(0);
      var ang = dynVal(1);
      if (len == null && ang == null) return false;
      var dir = Math.atan2(p.y - a.y, p.x - a.x);
      var L = len != null ? len : dist(a.x, a.y, p.x, p.y);
      var th = ang != null ? rad(ang) : dir;
      cmdPoint({ x: a.x + Math.cos(th) * L, y: a.y - Math.sin(th) * L }, true);
      resetDynInput(false);
      renderDyn();
      return true;
    }
    if (name === 'rect') {
      var a0 = c.pts[0];
      if (!a0) return false;
      var w = dynVal(0), h = dynVal(1);
      if (w == null && h == null) return false;
      var sx = p.x >= a0.x ? 1 : -1, sy = p.y >= a0.y ? 1 : -1;
      var W = w != null ? Math.abs(w) : Math.abs(p.x - a0.x);
      var H = h != null ? Math.abs(h) : Math.abs(p.y - a0.y);
      cmdPoint({ x: a0.x + sx * W, y: a0.y + sy * H }, true);
      resetDynInput(false);
      renderDyn();
      return true;
    }
    if (name === 'circle') {
      var r = dynVal(0);
      if (r == null) return false;
      var cen = c.pts[0];
      var dir2 = Math.atan2(p.y - cen.y, p.x - cen.x);
      cmdPoint({ x: cen.x + Math.cos(dir2) * r, y: cen.y + Math.sin(dir2) * r }, true);
      resetDynInput(false);
      renderDyn();
      return true;
    }
    if (name === 'rotate') {
      var ang2 = dynVal(0);
      if (ang2 == null || !c.base) return false;
      commitRotate(c.base, ang2);
      return true;
    }
    if (name === 'scale') {
      var fac = dynVal(0);
      if (fac == null || !c.base) return false;
      commitScale(c.base, fac);
      return true;
    }
    return false;
  }

  /* ---------------- 键盘 ---------------- */
  function onKeyDown(ev) {
    if (!built || !isVisible()) return;
    if (isField(ev.target)) return;

    var k = ev.key;
    var mod = ev.ctrlKey || ev.metaKey;

    if (mod) {
      var low = k.toLowerCase();
      if (low === 'z') { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); return; }
      if (low === 'y') { ev.preventDefault(); redo(); return; }
      if (low === 's') { ev.preventDefault(); saveNow(); msg('草稿已保存到本机'); toast('草稿已保存'); return; }
      if (low === 'n') { ev.preventDefault(); clearAll(); return; }
      if (low === 'a') { ev.preventDefault(); selectAll(); return; }
      if (low === 'd') { ev.preventDefault(); duplicateSelection(); return; }
      if (low === 'o') { ev.preventDefault(); openOsnap(); return; }
      return;
    }

    if (k === 'F1') { ev.preventDefault(); toggleHelp(true); return; }

    if (k === 'Escape') {
      ev.preventDefault();
      if (els.aiPop && !els.aiPop.hidden) { els.aiPop.hidden = true; return; }
      if (menuOpen) { closeMenus(); return; }
      if (els.help && !els.help.hidden) { toggleHelp(false); return; }
      if (els.osnapDlg && !els.osnapDlg.hidden) { els.osnapDlg.hidden = true; return; }
      if (cancelCmd()) return;
      if (state.selection.size) {
        state.selection.clear();
        redrawLive(); renderProps(); renderList(); updateHistoryButtons(); setCursor();
        return;
      }
      return;
    }

    if (k === 'Delete' || k === 'Backspace') { ev.preventDefault(); deleteSelection(); return; }

    if (k === 'F2') { ev.preventDefault(); toggleCmdHeight(); return; }
    if (k === 'F3') { ev.preventDefault(); toggleSnap(); return; }
    if (k === 'F7') { ev.preventDefault(); toggleGrid(); return; }
    if (k === 'F8') { ev.preventDefault(); toggleOrtho(); return; }
    if (k === 'F9') { ev.preventDefault(); toggleGrid(); return; }
    if (k === 'F10') { ev.preventDefault(); togglePolar(); return; }
    if (k === 'F12') { ev.preventDefault(); toggleDyn(); return; }

    if (k === 'Tab' && state.cmd && state.dyn.fields.length && state.dynOn) {
      ev.preventDefault();
      state.dyn.idx = (state.dyn.idx + 1) % state.dyn.fields.length;
      state.dyn.buf = state.dyn.values[state.dyn.idx] || '';
      renderDyn();
      return;
    }

    if (k === 'Enter') {
      ev.preventDefault();
      if (applyDyn()) return;
      cmdEnter();
      return;
    }

    if (k === 'ArrowUp' || k === 'ArrowDown') {
      if (state.cmd && state.dyn.fields.length && state.dynOn) {
        ev.preventDefault();
        state.dyn.idx = (state.dyn.idx + (k === 'ArrowUp' ? 1 : -1) + state.dyn.fields.length) % state.dyn.fields.length;
        state.dyn.buf = state.dyn.values[state.dyn.idx] || '';
        renderDyn();
        return;
      }
    }

    if (k.indexOf('Arrow') === 0) {
      if (!state.selection.size || state.cmd) return;
      ev.preventDefault();
      var step = ev.shiftKey ? 1 : Math.max(state.grid, 0.1);
      var dx = k === 'ArrowLeft' ? -step : (k === 'ArrowRight' ? step : 0);
      var dy = k === 'ArrowUp' ? -step : (k === 'ArrowDown' ? step : 0);
      nudge(dx, dy);
      return;
    }

    if (k === ' ' && state.cmd) { ev.preventDefault(); cmdEnter(); return; }

    /* 动态输入优先接管数字与符号 */
    if (state.cmd && state.dyn.fields.length && state.dynOn) {
      if (/^[0-9.\-]$/.test(k)) {
        ev.preventDefault();
        state.dyn.buf += k;
        state.dyn.values[state.dyn.idx] = state.dyn.buf;
        renderDyn();
        updateDim();
        return;
      }
      if (k === ',' || k === '@' || k === '<') {
        ev.preventDefault();
        if (state.dyn.buf) { els.cmdInput.value = state.dyn.buf + k; resetDynInput(false); }
        else els.cmdInput.value = k;
        els.cmdInput.focus();
        renderDyn();
        return;
      }
    }

    /* 可打印字符：进入命令行 */
    if (k.length === 1) {
      ev.preventDefault();
      els.cmdInput.value += k;
      els.cmdInput.focus();
      updateCmdSuggest();
      return;
    }
  }

  function onKeyUp(ev) {
    if (ev.key === 'Shift') shiftDown = false;
  }

  /* ---------------- 命令行 ---------------- */
  function focusCmd() { if (els.cmdInput) els.cmdInput.focus(); }

  var sugList = [], sugIdx = -1;
  function hideSuggest() {
    sugList = []; sugIdx = -1;
    if (els.suggest) { els.suggest.hidden = true; els.suggest.innerHTML = ''; }
  }
  function cmdSuggestions(q) {
    q = String(q || '').toUpperCase();
    if (!q) return [];
    var out = [];
    CMD_LIST.forEach(function (c) {
      var keys = ALIAS_BY_CMD[c[0]] || [];
      var exact = keys.indexOf(q) >= 0;
      var hit = exact || c[0].toUpperCase().indexOf(q) === 0 ||
        keys.some(function (k) { return k.indexOf(q) === 0; }) ||
        (CMD_LABEL[c[0]] || '').indexOf(q) >= 0;
      if (hit) out.push({ cmd: c[0], alias: c[1], label: CMD_LABEL[c[0]] || c[0], exact: exact });
    });
    out.sort(function (a, b) {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      return a.alias.length - b.alias.length;
    });
    return out.slice(0, 7);
  }
  function updateCmdSuggest() {
    if (!els.suggest || !els.cmdInput) return;
    if (state.cmd) { hideSuggest(); return; }
    var q = els.cmdInput.value.trim();
    if (!q || !/^[^\s,<@0-9]+$/.test(q)) { hideSuggest(); return; }
    var list = cmdSuggestions(q);
    if (!list.length) { hideSuggest(); return; }
    sugList = list; sugIdx = 0;
    els.suggest.innerHTML = list.map(function (it, i) {
      return '<button type="button" class="cad-sug-item' + (i === 0 ? ' is-active' : '') + '" data-sug="' + i + '">' +
        '<span class="ak">' + escapeHtml(it.alias) + '</span>' +
        '<span class="an">' + escapeHtml(it.label) + '</span>' +
        '<span class="af">' + escapeHtml(it.cmd.toUpperCase()) + '</span></button>';
    }).join('');
    els.suggest.hidden = false;
  }
  function moveSuggest(dir) {
    if (!sugList.length || !els.suggest) return false;
    sugIdx = (sugIdx + dir + sugList.length) % sugList.length;
    Array.prototype.forEach.call(els.suggest.querySelectorAll('[data-sug]'), function (b, i) {
      b.classList.toggle('is-active', i === sugIdx);
    });
    return true;
  }
  function acceptSuggest(run) {
    if (sugIdx < 0 || !sugList.length) return false;
    var it = sugList[sugIdx];
    hideSuggest();
    if (run) { els.cmdInput.value = ''; runCmdLine(it.alias); }
    else { els.cmdInput.value = it.alias; els.cmdInput.focus(); }
    return true;
  }

  function cmdInputKey(ev) {
    if (ev.key === 'Tab' && els.suggest && !els.suggest.hidden) {
      ev.preventDefault();
      acceptSuggest(false);
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (els.suggest && !els.suggest.hidden && acceptSuggest(true)) return;
      var text = els.cmdInput.value.trim();
      els.cmdInput.value = '';
      hideSuggest();
      runCmdLine(text);
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (els.suggest && !els.suggest.hidden) { hideSuggest(); return; }
      els.cmdInput.value = '';
      els.cmdInput.blur();
      if (!cancelCmd()) { /* 无命令 */ }
      return;
    }
    if (ev.key === 'ArrowUp') {
      if (els.suggest && !els.suggest.hidden) { ev.preventDefault(); moveSuggest(-1); return; }
      ev.preventDefault();
      var iu = histStep(cmdHistIdx < 0 ? cmdHistory.length - 1 : cmdHistIdx - 1, -1);
      if (iu < 0) return;
      cmdHistIdx = iu;
      els.cmdInput.value = cmdHistory[iu].text.replace(/^命令:\s*/, '');
      return;
    }
    if (ev.key === 'ArrowDown') {
      if (els.suggest && !els.suggest.hidden) { ev.preventDefault(); moveSuggest(1); return; }
      ev.preventDefault();
      if (cmdHistIdx < 0) return;
      var id = histStep(cmdHistIdx + 1, 1);
      if (id < 0) { cmdHistIdx = -1; els.cmdInput.value = ''; return; }
      cmdHistIdx = id;
      els.cmdInput.value = cmdHistory[id].text.replace(/^命令:\s*/, '');
      return;
    }
  }

  /* 只在用户输入过的命令之间回溯，跳过提示输出 */
  function histStep(from, dir) {
    var i = from;
    while (i >= 0 && i < cmdHistory.length) {
      if (cmdHistory[i] && cmdHistory[i].cls === 'in') return i;
      i += dir;
    }
    return -1;
  }

  function anchorPoint() {
    var c = state.cmd;
    if (!c) return state.lastPoint;
    return c.base || c.pts[c.pts.length - 1] || state.lastPoint;
  }

  function parsePoint(text, base) {
    text = text.trim();
    if (text.charAt(0) === '#') text = text.slice(1);  /* #x,y = 绝对坐标 */
    var rel = text.charAt(0) === '@';
    if (rel) text = text.slice(1);
    var comma = text.split(',');
    if (comma.length >= 2) {
      var x = parseFloat(comma[0]), y = parseFloat(comma[1]);
      if (isFinite(x) && isFinite(y)) {
        if (rel && base) { x += base.x; y += base.y; }
        return { x: x, y: y };
      }
    }
    var polar = text.split('<');
    if (polar.length === 2) {
      var len = parseFloat(polar[0]), ang = parseFloat(polar[1]);
      if (isFinite(len) && isFinite(ang)) {
        var a = rad(ang);
        var pt = { x: Math.cos(a) * len, y: -Math.sin(a) * len };
        if (rel && base) { pt.x += base.x; pt.y += base.y; }
        return pt;
      }
    }
    return null;
  }

  function runCmdLine(text) {
    cmdHistIdx = -1;
    hideSuggest();
    if (!text) { cmdEnter(); return; }
    msg('命令: ' + text, 'in');
    var c = state.cmd;
    var up = text.toUpperCase();

    if (c) {
      if (c.pick) {
        if (up === 'ALL') { selectAll(); return; }
        msg('请选择对象后按回车');
        return;
      }
      if (c.name === 'mirror' && c.pts.length >= 2) {
        if (up === 'Y' || up === 'N') { commitMirror(up === 'Y'); return; }
        commitMirror(false); return;
      }
      if (c.name === 'textedit' && c.step === 1) {
        var beforeTe = snapshot();
        var nv = text.trim();
        c.target.forEach(function (t) { t.text = nv; });
        pushUndo(beforeTe, '文字编辑');
        msg('已更新 ' + c.target.length + ' 处文字');
        endCmd(true);
        afterChange();
        return;
      }
      if (c.name === 'table' && c.step === 1) {
        var rowsIn = text.split(';').map(function (r) { return r.split(','); });
        var zs = zoneSize();
        var cv = { x: (zs.w / 2 - state.view.tx) / state.view.zoom, y: (zs.h / 2 - state.view.ty) / state.view.zoom };
        if (createTable(rowsIn, cv.x - 40, cv.y + 20)) msg('已创建表格 ' + rowsIn.length + ' 行');
        else msg('表格内容为空');
        endCmd(true);
        afterChange();
        return;
      }
      if (c.name === 'attr' && c.step === 1) {
        var beforeA = snapshot();
        if (!Array.isArray(c.target.attrs)) c.target.attrs = [];
        c.target.attrs[c.idx] = text.trim() || '属性';
        pushUndo(beforeA, '块属性');
        c.idx++;
        if (c.idx < c.count) {
          setPrompt('属性 ' + (c.idx + 1) + '/' + c.count + '：输入文字');
          afterChange();
          return;
        }
        msg('块属性已设置 ' + c.count + ' 项');
        endCmd(true);
        afterChange();
        return;
      }
      if (c.name === 'block' && c.step === 1) {
        var bname = text.trim() || ('Block' + state.blockSeq);
        var bb = unionBounds(selectedEntities());
        var beforeB = snapshot();
        state.blocks[bname] = { base: { x: round4(bb.x0), y: round4(bb.y0) }, entities: deepClone(selectedEntities()) };
        state.lastBlock = bname;
        state.blockSeq++;
        pushUndo(beforeB, '块定义');
        msg('已定义块「' + bname + '」：' + selectedEntities().length + ' 个图元');
        endCmd(true);
        afterChange();
        return;
      }
      if (c.name === 'insert' && c.step === 0) {
        var iname = text.trim() || state.lastBlock || '';
        if (!iname || !state.blocks[iname]) { msg('没有这个块，请先「块定义」或用最近块'); return; }
        c.blockName = iname;
        c.step = 1;
        setPrompt('指定插入点（块「' + iname + '」）:');
        return;
      }
      if (c.name === 'leader' && c.step === 2) {
        createLeader(c.pts, text.trim() || '引线');
        return;
      }
      if (c.name === 'array') {
        var n = parseFloat(text);
        nextArrayStep(isFinite(n) ? n : null);
        return;
      }
      if (c.name === 'offset' && c.step === 0) {
        var dv = parseFloat(text);
        if (isFinite(dv) && dv > 0) { offsetSetDistance(dv); return; }
        if (text.trim()) { msg('请输入有效的偏移距离'); return; }
        offsetSetDistance(c.dist || 10);
        return;
      }
      if (c.name === 'offset' && c.step === 1 && !c.target) {
        var dv2 = parseFloat(text);
        if (isFinite(dv2) && dv2 > 0 && /^[0-9.]+$/.test(text.trim())) {
          c.dist = dv2;
          msg('偏移距离 = ' + fmt(dv2, 2));
          prompt('选择要偏移的对象（距离 ' + fmt(dv2, 1) + '）:');
          return;
        }
      }
      if ((c.name === 'zoom' || c.name === 'scale' || c.name === 'polyline') && cmdOption(up)) return;
      if (c.name === 'zoom' && (up === 'E' || up === 'A')) return;

      var pt = parsePoint(text, anchorPoint());
      if (pt) { cmdPoint(pt); return; }

      var num = parseFloat(text);
      if (isFinite(num)) {
        if (c.name === 'rotate' && c.base) { commitRotate(c.base, num); return; }
        if (c.name === 'scale' && c.base) { commitScale(c.base, num); return; }
        if (c.name === 'line' || c.name === 'polyline') {
          var a = anchorPoint();
          if (a) {
            var dir = state.snap ? Math.atan2(state.snap.y - a.y, state.snap.x - a.x) : 0;
            cmdPoint({ x: a.x + Math.cos(dir) * num, y: a.y + Math.sin(dir) * num });
            return;
          }
        }
        if (c.name === 'circle' && c.pts.length) {
          var cen = c.pts[0];
          cmdPoint({ x: cen.x + num, y: cen.y });
          return;
        }
        msg('数值已忽略：当前步骤需要点或选项');
        return;
      }
      if (state.lastCmd && !pt) { msg('无效输入'); }
      return;
    }

    var alias = ALIAS[up];
    if (alias) { startCmd(alias); return; }
    if (isFinite(parseFloat(text))) { msg('请输入命令或坐标，例如 L、REC、C'); return; }
    startCmd(text);
  }

  /* ---------------- 开关 ---------------- */
  function toggleGrid() {
    state.gridOn = !state.gridOn;
    msg('栅格 ' + (state.gridOn ? '开' : '关'));
    drawGrid(true); updateStatus(); scheduleSave();
  }
  function toggleOrtho() {
    state.orthoOn = !state.orthoOn;
    /* 与主流 CAD 一致：正交与极轴互斥 */
    if (state.orthoOn) state.polarOn = false;
    msg('正交 ' + (state.orthoOn ? '开' : '关'));
    updateStatus(); scheduleSave();
  }
  function togglePolar() {
    state.polarOn = !state.polarOn;
    if (state.polarOn) state.orthoOn = false;
    msg('极轴追踪 ' + (state.polarOn ? '开（15° 吸附）' : '关'));
    updateStatus(); scheduleSave();
  }
  function toggleSnap() {
    state.snapOn = !state.snapOn;
    msg('对象捕捉 ' + (state.snapOn ? '开' : '关'));
    updateStatus(); scheduleSave();
  }
  function toggleDyn() {
    state.dynOn = !state.dynOn;
    msg('动态输入 ' + (state.dynOn ? '开' : '关'));
    updateStatus(); syncDyn(); scheduleSave();
  }
  function toggleLw() {
    state.lwOn = !state.lwOn;
    msg('线宽显示 ' + (state.lwOn ? '开' : '关'));
    if (els.app) els.app.classList.toggle('no-lw', !state.lwOn);
    updateStatus(); scheduleSave();
  }

  function setCursor() {
    if (!els.svg) return;
    var c = 'crosshair';
    if (drag && drag.mode === 'pan') c = 'grabbing';
    else if (state.tool === 'pan' || spaceDown) c = 'grab';
    else if (state.tool === 'select') c = hoverId ? 'move' : 'default';
    else if (state.cmd) c = 'crosshair';
    els.svg.style.cursor = c;
  }

  /* ---------------- DXF 导出 ---------------- */
  function dxfNum(v) { return (Math.round(v * 1000) / 1000).toFixed(3); }
  function hexToAci(hex) {
    var h = String(hex || '#ffffff').replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    if (!isFinite(r)) return 7;
    if (r > 210 && g > 210 && b > 210) return 7;
    if (r > g && r > b) return g > 150 ? 30 : 1;
    if (g > r && g > b) return 3;
    if (b > r && b > g) return 5;
    if (Math.abs(r - g) < 25 && Math.abs(g - b) < 25) return 8;
    return 7;
  }

  function exportDXF() {
    var list = [];
    state.entities.filter(entityVisible).forEach(function (e) {
      if (e.kind !== 'insert') { list.push(e); return; }
      var bk = state.blocks[e.name];
      if (!bk) return;
      var dxi = e.x - bk.base.x, dyi = e.y - bk.base.y;
      bk.entities.forEach(function (ce) {
        var cc = deepClone(ce); cc.id = uid(); translateEntity(cc, ce, dxi, dyi);
        if (cc.kind === 'text' && e.attrs && e.attrs.length) {
          var ti3 = bk.entities.filter(function (x, i3) { return x.kind === 'text' && i3 < bk.entities.indexOf(ce); }).length;
          if (e.attrs[ti3]) cc.text = e.attrs[ti3];
        }
        list.push(cc);
      });
    });
    if (!list.length) { msg('画布为空，无法导出 DXF'); return; }
    var out = [];
    function g(code, val) { out.push(String(code)); out.push(String(val)); }
    var box = unionBounds(list);

    g(0, 'SECTION'); g(2, 'HEADER');
    g(9, '$ACADVER'); g(1, 'AC1015');
    g(9, '$INSUNITS'); g(70, 4);
    g(9, '$MEASUREMENT'); g(70, 1);
    g(9, '$DWGCODEPAGE'); g(3, 'ANSI_936');
    g(9, '$EXTMIN'); g(10, dxfNum(box.x0)); g(20, dxfNum(-box.y1)); g(30, '0.0');
    g(9, '$EXTMAX'); g(10, dxfNum(box.x1)); g(20, dxfNum(-box.y0)); g(30, '0.0');
    g(0, 'ENDSEC');

    /* 线型表 */
    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 3);
    [['CONTINUOUS', 'Solid line', []], ['DASHED', 'Dashed __ __ __', [0.6, 0.3, -0.2]], ['DASHDOT', 'Dash dot __ . __', [0.7, 0.3, -0.15, 0.05, -0.15]]].forEach(function (lt) {
      g(0, 'LTYPE'); g(2, lt[0]); g(70, 0); g(3, lt[1]); g(72, 65); g(73, lt[2].length);
      g(40, lt[2].reduce(function (a, b) { return a + Math.abs(b); }, 0) || 0.75);
      lt[2].forEach(function (v) { g(49, v); g(74, 0); });
    });
    g(0, 'ENDTAB');

    /* 图层表 */
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, state.layers.length);
    state.layers.forEach(function (L) {
      g(0, 'LAYER'); g(2, (L.id || '0').toUpperCase()); g(70, L.locked ? 4 : 0);
      g(62, hexToAci(L.color)); g(6, (L.ltype || 'continuous').toUpperCase());
    });
    g(0, 'ENDTAB');
    g(0, 'ENDSEC');

    g(0, 'SECTION'); g(2, 'ENTITIES');
    list.forEach(function (e) {
      var lname = (e.layer || '0').toUpperCase();
      var aci = hexToAci(entityColor(e));
      var lt = (layerOf(e).ltype || 'continuous').toUpperCase();
      if (e.kind === 'line') {
        g(0, 'LINE'); g(8, lname); g(62, aci); g(6, lt);
        g(100, 'AcDbEntity'); g(100, 'AcDbLine');
        g(10, dxfNum(e.x0)); g(20, dxfNum(-e.y0)); g(30, '0.0');
        g(11, dxfNum(e.x1)); g(21, dxfNum(-e.y1)); g(31, '0.0');
      } else if (e.kind === 'rect') {
        var x0 = Math.min(e.x0, e.x1), x1 = Math.max(e.x0, e.x1);
        var y0 = Math.min(e.y0, e.y1), y1 = Math.max(e.y0, e.y1);
        [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]].forEach(function (c) {
          g(0, 'LINE'); g(8, lname); g(62, aci); g(6, lt);
          g(100, 'AcDbEntity'); g(100, 'AcDbLine');
        g(100, 'AcDbEntity'); g(100, 'AcDbLine');
          g(10, dxfNum(c[0])); g(20, dxfNum(-c[1])); g(30, '0.0');
          g(11, dxfNum(c[2])); g(21, dxfNum(-c[3])); g(31, '0.0');
        });
      } else if (e.kind === 'polyline') {
        var n = e.pts.length;
        if (n < 2) return;
        g(0, 'LWPOLYLINE'); g(8, lname); g(62, aci); g(6, lt);
        g(100, 'AcDbEntity'); g(100, 'AcDbPolyline');
        g(90, n); g(70, e.closed ? 1 : 0);
        e.pts.forEach(function (p) {
          g(10, dxfNum(p.x)); g(20, dxfNum(-p.y));
        });
      } else if (e.kind === 'circle') {
        g(0, 'CIRCLE'); g(8, lname); g(62, aci); g(6, lt);
        g(100, 'AcDbEntity'); g(100, 'AcDbCircle');
        g(10, dxfNum(e.cx)); g(20, dxfNum(-e.cy)); g(30, '0.0');
        g(40, dxfNum(e.r));
      } else if (e.kind === 'arc') {
        var sA, eA;
        if (e.dir > 0) { sA = normDeg(-deg(e.a1)); eA = normDeg(-deg(e.a0)); }
        else { sA = normDeg(-deg(e.a0)); eA = normDeg(-deg(e.a1)); }
        g(0, 'ARC'); g(8, lname); g(62, aci); g(6, lt);
        g(100, 'AcDbEntity'); g(100, 'AcDbCircle');
        g(10, dxfNum(e.cx)); g(20, dxfNum(-e.cy)); g(30, '0.0');
        g(40, dxfNum(e.r));
        g(100, 'AcDbArc');
        g(50, dxfNum(sA)); g(51, dxfNum(eA));
      } else if (e.kind === 'hatch') {
        var hp = e.pts || [];
        if (hp.length >= 3 && (!e.pattern || e.pattern === 'solid')) {
          g(0, 'HATCH'); g(8, lname); g(62, aci);
          g(100, 'AcDbEntity'); g(100, 'AcDbHatch');
          g(10, '0.0'); g(20, '0.0'); g(30, '0.0');
          g(210, '0.0'); g(220, '0.0'); g(230, '1.0');
          g(2, 'SOLID'); g(70, '1'); g(71, '0');
          g(91, '1'); g(92, '1'); g(72, '0'); g(73, '1');
          g(93, String(hp.length));
          hp.forEach(function (q) { g(10, dxfNum(q.x)); g(20, dxfNum(-q.y)); });
          g(97, '0'); g(75, '1'); g(76, '1'); g(52, '0.0'); g(41, '1.0');
          g(77, '0'); g(78, '0'); g(47, '0.5'); g(98, '0');
          return;
        }
        if (e.pattern && e.pattern !== 'solid' && hp.length >= 3) {
          /* 图案填充：把剖面线裁剪后写成 LINE（AutoCAD 里可直接看到剖面线） */
          var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
          hp.forEach(function (q) { bx0 = Math.min(bx0, q.x); by0 = Math.min(by0, q.y); bx1 = Math.max(bx1, q.x); by1 = Math.max(by1, q.y); });
          var gap = Math.max(2, e.spacing || 6);
          var diagA = [[1, 1], [1, -1]];
          var dirs = e.pattern === 'cross' ? diagA : (e.pattern === 'ansi' ? [[1, 1]] : [[1, 1]]);
          dirs.forEach(function (dir) {
            var ux = dir[0] / Math.SQRT2, uy = dir[1] / Math.SQRT2;
            var nx2 = ux, ny2 = uy;
            var px2 = -uy, py2 = ux;
            var cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
            var rad = Math.max(bx1 - bx0, by1 - by0) * 0.75;
            for (var off2 = -rad; off2 <= rad; off2 += gap) {
              var ox = cx + px2 * off2;
              var oy = cy + py2 * off2;
              /* 直线：点 (ox,oy) 方向 (nx2,ny2) */
              var ts = [], i2;
              for (i2 = 0; i2 < hp.length; i2++) {
                var p1 = hp[i2], p2 = hp[(i2 + 1) % hp.length];
                var ex = p2.x - p1.x, ey = p2.y - p1.y;
                var den = nx2 * ey - ny2 * ex;
                if (Math.abs(den) < 1e-9) continue;
                var t = ((p1.x - ox) * ey - (p1.y - oy) * ex) / den;
                var uu = ((p1.x - ox) * ny2 - (p1.y - oy) * nx2) / den;
                if (uu >= -1e-6 && uu <= 1 + 1e-6) ts.push(t);
              }
              ts.sort(function (a, b) { return a - b; });
              for (var k2 = 0; k2 + 1 < ts.length; k2 += 2) {
                var t0 = ts[k2], t1 = ts[k2 + 1];
                if (t1 - t0 < 1e-6) continue;
                var ax = ox + nx2 * t0, ay = oy + ny2 * t0;
                var bx = ox + nx2 * t1, by = oy + ny2 * t1;
                g(0, 'LINE'); g(8, lname); g(62, aci); g(6, lt);
                g(100, 'AcDbEntity'); g(100, 'AcDbLine');
                g(10, dxfNum(ax)); g(20, dxfNum(-ay)); g(30, '0.0');
                g(11, dxfNum(bx)); g(21, dxfNum(-by)); g(31, '0.0');
              }
            }
          });
          return;
        }
        for (var hi = 1; hi + 1 < hp.length; hi++) {
          g(0, 'SOLID'); g(8, lname); g(62, aci); g(6, lt);
          g(100, 'AcDbEntity'); g(100, 'AcDbTrace');
          g(10, dxfNum(hp[0].x)); g(20, dxfNum(-hp[0].y)); g(30, '0.0');
          g(11, dxfNum(hp[hi].x)); g(21, dxfNum(-hp[hi].y)); g(31, '0.0');
          g(12, dxfNum(hp[hi + 1].x)); g(22, dxfNum(-hp[hi + 1].y)); g(32, '0.0');
          g(13, dxfNum(hp[hi + 1].x)); g(23, dxfNum(-hp[hi + 1].y)); g(33, '0.0');
        }
      } else if (e.kind === 'text') {
        g(0, 'TEXT'); g(8, lname); g(62, aci); g(7, 'STANDARD');
        g(100, 'AcDbEntity'); g(100, 'AcDbText');
        g(10, dxfNum(e.cx)); g(20, dxfNum(-e.cy)); g(30, '0.0');
        g(40, dxfNum(e.size || 3.5)); g(1, String(e.text || ''));
      }
    });
    g(0, 'ENDSEC'); g(0, 'EOF');

    lastDxfText = out.join('\r\n');
    var blob = new Blob([lastDxfText], { type: 'application/dxf;charset=utf-8' });
    var d = new Date();
    var name = 'drawing-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + '.dxf';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    msg('已导出 DXF · ' + list.length + ' 个对象 · ' + name, 'ok');
    toast('已导出 DXF（' + list.length + ' 个对象）');
  }

  /* ---------------- 持久化 ---------------- */
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 450);
  }
  function saveNow() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 3,
        entities: state.entities,
        layers: state.layers,
        curLayer: state.curLayer,
        space: state.space,
        grid: state.grid,
        gridOn: state.gridOn,
        snapOn: state.snapOn,
        orthoOn: state.orthoOn,
        polarOn: state.polarOn,
        lwOn: state.lwOn,
        dynOn: state.dynOn,
        crossPct: state.crossPct,
        pickPx: state.pickPx,
        polarStep: state.polarStep,
        osnap: state.osnap,
        tool: state.tool,
        blocks: state.blocks,
        lastBlock: state.lastBlock,
        blockSeq: state.blockSeq,
        dimSets: state.dimSets,
        sheet: state.sheet,
        layouts: state.layouts,
        curLayout: state.curLayout,
        printStyle: state.printStyle,
        printMap: state.printMap,
        cloudBump: state.cloudBump,
        lastBom: state.lastBom,
        snapshot: state.snapshot,
        snaps: state.snaps,
        tables: state.tables,
        layerStates: state.layerStates,
        tableAlign: state.tableAlign,
        dimTpls: state.dimTpls
      }));
    } catch (err) { /* 隐私模式 */ }
  }
  function loadDraft() {
    var raw;
    try { raw = localStorage.getItem(STORE_KEY); } catch (err) { return; }
    if (!raw) return;
    var d;
    try { d = JSON.parse(raw); } catch (err) { return; }
    if (!d || !Array.isArray(d.entities)) return;
    var good = d.entities.filter(function (e) {
      if (!e || !KIND_NAME[e.kind]) return false;
      if (e.kind === 'insert') return isFinite(e.x) && isFinite(e.y) && !!state.blocks[e.name];
      if (e.kind === 'line' || e.kind === 'rect') {
        return isFinite(e.x0) && isFinite(e.y0) && isFinite(e.x1) && isFinite(e.y1);
      }
      if (e.kind === 'polyline' || e.kind === 'hatch') {
        return Array.isArray(e.pts) && e.pts.length >= (e.kind === 'hatch' ? 3 : 2) && e.pts.every(function (p) { return p && isFinite(p.x) && isFinite(p.y); });
      }
      if (!isFinite(e.cx) || !isFinite(e.cy) || !isFinite(e.r)) return false;
      if (e.kind === 'arc' && (!isFinite(e.a0) || !isFinite(e.a1) || !e.dir)) return false;
      return true;
    });
    if (Array.isArray(d.layers) && d.layers.length) {
      state.layers = d.layers.filter(function (L) { return L && L.id && L.name; }).map(function (L) {
        return {
          id: String(L.id), name: String(L.name), color: L.color || '#e8eef8',
          ltype: LTYPES[L.ltype] ? L.ltype : 'continuous',
          visible: L.visible !== false, locked: !!L.locked
        };
      });
    }
    if (!state.layers.length) state.layers = deepClone(DEFAULT_LAYERS);
    good.forEach(function (e) {
      if (!e.id) e.id = uid();
      if (!e.layer || !layerById(e.layer).id) e.layer = state.layers[0].id;
    });
    state.entities = good;
    if (d.curLayer && state.layers.some(function (L) { return L.id === d.curLayer; })) state.curLayer = d.curLayer;
    if (isFinite(d.grid) && d.grid > 0) state.grid = d.grid;
    state.gridOn = d.gridOn !== false;
    state.snapOn = d.snapOn !== false;
    state.orthoOn = !!d.orthoOn;
    state.polarOn = !!d.polarOn;
    state.lwOn = d.lwOn !== false;
    state.dynOn = d.dynOn !== false;
    state.crossPct = isFinite(d.crossPct) ? clamp(d.crossPct, 5, 100) : 100;
    state.pickPx = isFinite(d.pickPx) ? clamp(d.pickPx, 4, 24) : 8;
    state.polarStep = isFinite(d.polarStep) && d.polarStep >= 5 ? d.polarStep : 15;
    if (d.osnap) Object.keys(state.osnap).forEach(function (k) { if (typeof d.osnap[k] === 'boolean') state.osnap[k] = d.osnap[k]; });
    if (d.space === 'layout') state.space = 'layout';
    if (d.tool && (KIND_NAME[d.tool] || d.tool === 'select' || d.tool === 'pan')) state.tool = d.tool;
    if (d.sheet && typeof d.sheet === 'object') state.sheet = d.sheet;
    if (Array.isArray(d.layouts)) state.layouts = d.layouts;
    if (isFinite(d.curLayout)) state.curLayout = d.curLayout;
    if (d.printStyle) state.printStyle = d.printStyle;
    if (d.printMap) state.printMap = d.printMap;
    if (isFinite(d.cloudBump)) state.cloudBump = d.cloudBump;
    if (d.lastBom) state.lastBom = d.lastBom;
    if (Array.isArray(d.snaps)) state.snaps = d.snaps;
    if (d.tables) state.tables = d.tables;
    if (Array.isArray(d.layerStates)) state.layerStates = d.layerStates;
    if (d.tableAlign) state.tableAlign = d.tableAlign;
    if (Array.isArray(d.dimTpls)) state.dimTpls = d.dimTpls;
    if (d.snapshot) state.snapshot = d.snapshot;
    if (Array.isArray(d.dimSets)) state.dimSets = d.dimSets;
    if (d.blocks && typeof d.blocks === 'object') state.blocks = d.blocks;
    if (d.lastBlock) state.lastBlock = d.lastBlock;
    if (isFinite(d.blockSeq)) state.blockSeq = d.blockSeq;
    if (good.length) state.restored = good.length;
  }

  /* ---------------- 菜单 / 右键 ---------------- */
  var MENUS = {
    file: [
      { label: '新建画布', hint: 'Ctrl+N', act: 'new' },
      { label: '载入示例图', act: 'sample' },
      { sep: true },
      { label: '保存草稿', hint: 'Ctrl+S', act: 'save' },
      { label: '导出 DXF', act: 'export' },
      { sep: true },
      { label: '打印 / 布局预览', act: 'layout' },
      { label: '打印 / 导出 PDF', hint: 'Ctrl+P', act: 'printpdf' },
      { label: '图框/标题栏设置…', act: 'sheetcfg' },
      { label: '打印样式（线宽/单色）…', act: 'printstyle' },
      { label: '打印样式表（颜色→线宽）…', act: 'printmaptbl' },
      { label: '返回工作台', act: 'home' }
    ],
    edit: [
      { label: '撤销', hint: 'Ctrl+Z', act: 'undo' },
      { label: '重做', hint: 'Ctrl+Y', act: 'redo' },
      { sep: true },
      { label: '复制对象', hint: 'Ctrl+D', act: 'copy' },
      { label: '全选', hint: 'Ctrl+A', act: 'all' },
      { label: '删除', hint: 'Delete', act: 'delete' }
    ],
    view: [
      { label: '缩放至范围', hint: 'Z → E', act: 'extents' },
      { label: '实际大小 1:1', act: 'zoom1' },
      { sep: true },
      { label: '显示栅格', hint: 'F7', act: 'grid', check: 'gridOn' },
      { label: '正交模式', hint: 'F8', act: 'ortho', check: 'orthoOn' },
      { label: '极轴追踪', hint: 'F10', act: 'polar', check: 'polarOn' },
      { label: '线宽显示', act: 'lw', check: 'lwOn' },
      { sep: true },
      { label: '保存图层状态…', act: 'layerssave' },
      { label: '恢复图层状态…', act: 'layersrestore' },
      { label: '图层状态列表…', act: 'layerlist' },
      { label: '导出图层状态…', act: 'layersexport' },
      { label: '导入图层状态…', act: 'layersimport' },
      { label: '隔离选中图层', act: 'isolate' },
      { label: '取消图层隔离', act: 'unisolate' },
      { label: '打印预览：黑白', act: 'printmono' },
      { label: '图层管理器', hint: 'LA', act: 'layers' },
      { label: '特性面板', hint: 'PR', act: 'props' }
    ],
    draw: [
      { label: '直线', hint: 'L', act: 'cmd:line' },
      { label: '填充 Hatch（实心）', hint: 'H', act: 'cmd:hatch' },
      { label: '表格…', hint: 'TB', act: 'cmd:table' },
      { label: '表格加行', act: 'trowadd' },
      { label: '表格删行', act: 'trowdel' },
      { label: '表格加列', act: 'tcoladd' },
      { label: '表格删列', act: 'tcoldel' },
      { label: '表格文字居中/左对齐', act: 'tablealign' },
      { label: '表格合并首行', act: 'trowmerge' },
      { label: '表格合并前 N 行…', act: 'trowmergen' },
      { label: '表格插入行…', act: 'trowins' },
      { label: '表格插入列…', act: 'tcolins' },
      { label: '表格导出 CSV…', act: 'tablecsv' },
      { label: '云线弧长…', act: 'cloudbump' },
      { label: '明细栏 BOM', hint: 'BOM', act: 'cmd:bom' },
      { label: '剖面线 45°', hint: 'HP', act: 'cmd:hatch45' },
      { label: '交叉剖面线', hint: 'HC', act: 'cmd:hatchcross' },
      { label: '多段线', hint: 'PL', act: 'cmd:polyline' },
      { label: '矩形', hint: 'REC', act: 'cmd:rect' },
      { label: '圆', hint: 'C', act: 'cmd:circle' },
      { label: '圆弧', hint: 'A', act: 'cmd:arc' }
    ],
    modify: [
      { label: '移动', hint: 'M', act: 'cmd:move' },
      { label: '复制', hint: 'CO', act: 'cmd:copy' },
      { label: '旋转', hint: 'RO', act: 'cmd:rotate' },
      { label: '镜像', hint: 'MI', act: 'cmd:mirror' },
      { label: '偏移', hint: 'O', act: 'cmd:offset' },
      { label: '矩形阵列', hint: 'AR', act: 'cmd:array' },
      { sep: true },
      { label: '块定义', hint: 'B', act: 'cmd:block' },
      { label: '插入块', hint: 'I', act: 'cmd:insert' },
      { label: '块属性', hint: 'AT', act: 'cmd:attr' },
      { label: '块库…', act: 'blocklib' },
      { label: '块编辑', hint: 'BE', act: 'cmd:bedit' },
      { label: '保存块编辑', hint: 'BC', act: 'cmd:bclose' },
      { label: '锁定对象', act: 'locko' },
      { label: '解锁对象', act: 'unlocko' },
      { label: '分解', hint: 'X', act: 'cmd:explode' },
      { label: '删除', hint: 'E', act: 'cmd:erase' }
    ],
    annotate: [
      { label: '引线标注', hint: 'LE', act: 'cmd:leader' },
      { label: '文字编辑', hint: 'TED', act: 'cmd:textedit' },
      { label: '修订云线', hint: 'RC', act: 'cmd:revcloud' },
      { label: '刷新明细栏', hint: 'BOMR', act: 'cmd:bomrefresh' },
      { label: '线性标注', hint: 'DIM', act: 'cmd:dim' },
      { label: '直径标注', hint: 'DIAD', act: 'cmd:dimdia' },
      { label: '自动标注（选中）', hint: 'AUTO', act: 'cmd:autodim' },
      { sep: true },
      { label: '标注样式…', act: 'dimstyle' },
      { label: '应用样式到选中标注', act: 'dimstyleapply' },
      { label: '尺寸公差…', act: 'dimtol' },
      { label: '公差样式…', act: 'tolstyle' },
      { label: '标注文字覆盖…', act: 'dimoverride' },
      { label: '标注箭头样式…', act: 'arrowstyle' },
      { label: '样式模板：机械', act: 'dimpresetMech' },
      { label: '样式模板：建筑', act: 'dimpresetArch' },
      { label: '样式模板：电气', act: 'dimpresetElec' },
      { label: '样式模板：轴网', act: 'dimpresetAxis' },
      { label: '样式模板列表…', act: 'dimtpllist' },
      { label: '保存当前样式为模板…', act: 'dimsavetpl' },
      { label: '导出标注模板…', act: 'dimtplexport' },
      { label: '导入标注模板…', act: 'dimtplimport' },
    ],
    tools: [
      { label: '对象捕捉设置…', hint: 'OS', act: 'osnap' },
      { label: '动态输入', hint: 'F12', act: 'dyn', check: 'dynOn' },
      { sep: true },
      { label: '绘图单位：毫米 (mm)', act: 'units' },
      { label: '栅格间距…', act: 'gridsize' }
    ],
    help: [
      { label: '快捷键与操作说明', hint: 'F1', act: 'help' },
      { label: '保存快照', act: 'snap' },
      { label: '对比快照', act: 'cmp' },
      { label: '修订记录…', act: 'revlib' },
      { label: '清除差异高亮', act: 'cleardiff' },
      { label: '导出差异报告…', act: 'diffreport' },
      { label: '差异列表…', act: 'difflist' },
      { label: '差异 HTML 报告…', act: 'diffhtml' },
      { label: '差异预览…', act: 'diffpreview' },
      { label: '关于本模块', act: 'about' }
    ]
  };

  var MENU_TITLES = { file: '文件', edit: '编辑', view: '视图', draw: '绘制', modify: '修改', annotate: '注释', tools: '工具', help: '帮助' };

  function renderMenu(name) {
    var pop = els.menuPop;
    var list = MENUS[name];
    if (!pop || !list) return;
    pop.innerHTML = list.map(function (it, i) {
      if (it.sep) return '<div class="cad-menu-sep"></div>';
      var checked = it.check ? !!state[it.check] : false;
      return '<button type="button" class="cad-menu-item" data-mi="' + i + '">' +
        '<span class="ck">' + (it.check ? (checked ? '✓' : '') : '') + '</span>' +
        '<span class="lb">' + it.label + '</span>' +
        '<span class="hk">' + (it.hint || '') + '</span></button>';
    }).join('');
    pop.hidden = false;
    pop.setAttribute('data-menu', name);
    var btn = document.querySelector('.cad-menu-btn[data-menu="' + name + '"]');
    if (btn) {
      var r = btn.getBoundingClientRect();
      pop.style.left = Math.round(r.left) + 'px';
      pop.style.top = Math.round(r.bottom + 2) + 'px';
    }
    menuOpen = name;
    Array.prototype.forEach.call(document.querySelectorAll('.cad-menu-btn'), function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-menu') === name);
    });
    pop.onclick = function (ev) {
      var item = ev.target.closest('.cad-menu-item');
      if (!item) return;
      var it = list[parseInt(item.getAttribute('data-mi'), 10)];
      closeMenus();
      if (it) runAction(it.act);
    };
  }

  function closeMenus() {
    if (els.menuPop) els.menuPop.hidden = true;
    menuOpen = null;
    Array.prototype.forEach.call(document.querySelectorAll('.cad-menu-btn'), function (b) { b.classList.remove('is-on'); });
    if (els.ctx) els.ctx.hidden = true;
  }

  function showContext(x, y) {
    var ctx = els.ctx;
    if (!ctx) return;
    var items = [];
    if (state.lastCmd) items.push({ label: '重复 ' + (CMD_LABEL[state.lastCmd] || state.lastCmd), act: 'repeat' });
    items.push({ sep: true });
    if (state.selection.size) {
      items.push({ label: '移动', act: 'cmd:move' });
      items.push({ label: '复制', act: 'copy' });
      items.push({ label: '旋转', act: 'cmd:rotate' });
      items.push({ label: '删除', act: 'delete' });
      items.push({ label: '特性 (PR)', act: 'props' });
      items.push({ label: '缩放到选中', act: 'zoomsel' });
      items.push({ label: '选择同类 (SS)', act: 'selsame' });
      items.push({ sep: true });
      items.push({ label: '缩放到对象', act: 'zoomsel' });
      items.push({ label: '特性', act: 'props' });
    } else {
      items.push({ label: '缩放至范围', act: 'extents' });
      items.push({ label: '全选', act: 'all' });
      items.push({ label: '对象捕捉设置…', act: 'osnap' });
    }
    ctx.innerHTML = items.map(function (it, i) {
      if (it.sep) return '<div class="cad-menu-sep"></div>';
      return '<button type="button" class="cad-menu-item" data-ci="' + i + '"><span class="lb">' + it.label + '</span></button>';
    }).join('');
    ctx.hidden = false;
    var appR = els.app.getBoundingClientRect();
    ctx.style.left = Math.round(clamp(x + appR.left, 4, window.innerWidth - 200)) + 'px';
    ctx.style.top = Math.round(clamp(y + appR.top, 4, window.innerHeight - 220)) + 'px';
    ctx.onclick = function (ev) {
      var b = ev.target.closest('.cad-menu-item');
      if (!b) return;
      var it = items[parseInt(b.getAttribute('data-ci'), 10)];
      closeMenus();
      if (it) runAction(it.act);
    };
  }

  function runAction(act) {
    if (!act) return;
    if (act.indexOf('cmd:') === 0) { startCmd(act.slice(4)); return; }
    switch (act) {
      case 'new': clearAll(); break;
      case 'sample': loadSample(); break;
      case 'save': saveNow(); msg('草稿已保存到本机'); toast('草稿已保存'); break;
      case 'dimstyle': {
        var ts = parseFloat(window.prompt('文字高度（mm）', String(dimStyle.textSize)));
        var ar = parseFloat(window.prompt('箭头长度（mm）', String(dimStyle.arrow)));
        var pr = parseInt(window.prompt('小数位数', String(dimStyle.precision)), 10);
        if (isFinite(ts) && ts > 0) dimStyle.textSize = ts;
        if (isFinite(ar) && ar > 0) dimStyle.arrow = ar;
        if (isFinite(pr) && pr >= 0 && pr <= 4) dimStyle.precision = pr;
        state.dimStyle = dimStyle;
    applyPrintStyle();
        try { localStorage.setItem('cad.dimStyle', JSON.stringify(dimStyle)); } catch (e2) {}
        msg('标注样式：字高 ' + dimStyle.textSize + ' / 箭头 ' + dimStyle.arrow + ' / 小数 ' + dimStyle.precision);
        afterChange();
        break;
      }
      case 'dimstyleapply': {
        var beforeD = snapshot();
        var nD = 0;
        (state.dimSets || []).forEach(function (ds) {
          var t = state.entities.find(function (x) { return x.id === ds.textId; });
          if (t) { t.size = dimStyle.textSize; nD++; }
        });
        syncDims();
        pushUndo(beforeD, '应用标注样式');
        msg('已把字高 ' + dimStyle.textSize + ' 应用到 ' + nD + ' 个标注');
        afterChange();
        break;
      }
      case 'isolate': {
        var iso = {};
        selectedEntities().forEach(function (e) { iso[String(e.layer)] = true; });
        if (!Object.keys(iso).length) { msg('先选中对象再隔离图层'); break; }
        state.layerIso = iso;
        msg('已隔离 ' + Object.keys(iso).length + ' 个图层');
        afterChange();
        break;
      }
      case 'layerssave': {
        var lsn = window.prompt('图层状态名称', '状态' + ((state.layerStates || []).length + 1));
        if (!lsn) break;
        state.layerStates = (state.layerStates || []).concat([{ name: lsn, layers: deepClone(state.layers) }]);
        msg('已保存图层状态「' + lsn + '」');
        scheduleSave();
        break;
      }
      case 'layersrestore': {
        var namesL = (state.layerStates || []).map(function (x) { return x.name; }).join(' / ');
        var lrn = window.prompt('恢复哪个图层状态？可选：' + namesL, (state.layerStates && state.layerStates[0] || {}).name || '');
        if (!lrn) break;
        var stL = (state.layerStates || []).find(function (x) { return x.name === lrn; });
        if (!stL) { msg('没有这个图层状态'); break; }
        state.layerStates.push({ name: '自动_' + (state.layerStates.length + 1), layers: deepClone(state.layers) });
        state.layers = deepClone(stL.layers);
        msg('已恢复图层状态「' + lrn + '」');
        afterChange();
        break;
      }
      case 'unisolate': {
        state.layerIso = null;
        msg('已取消图层隔离');
        afterChange();
        break;
      }
      case 'printmono': {
        if (els.app) els.app.classList.toggle('is-print-mono');
        msg('打印预览：' + (els.app.classList.contains('is-print-mono') ? '黑白' : '彩色'));
        break;
      }
      case 'tolstyle': {
        var mode = window.prompt('公差样式（none / sym / limits）', dimStyle.tolMode || 'none');
        if (mode === null) break;
        var t1 = parseFloat(window.prompt('上偏差', String(dimStyle.tol || 0.05)));
        var t2 = parseFloat(window.prompt('下偏差（limits 用，留空同上）', String(dimStyle.tol2 || 0.02)));
        dimStyle.tolMode = (mode === 'sym' || mode === 'limits') ? mode : 'none';
        if (isFinite(t1)) dimStyle.tol = t1;
        if (isFinite(t2)) dimStyle.tol2 = t2;
        state.dimStyle = dimStyle;
    applyPrintStyle();
        try { localStorage.setItem('cad.dimStyle', JSON.stringify(dimStyle)); } catch (e4) {}
        syncDims();
        msg('公差样式：' + dimStyle.tolMode);
        afterChange();
        break;
      }
      case 'locko': {
        var selL = editableSelection();
        if (!selL.length) { msg('先选中对象'); break; }
        selL.forEach(function (e) { e.locked = true; });
        msg('已锁定 ' + selL.length + ' 个对象');
        afterChange();
        break;
      }
      case 'unlocko': {
        var selU = selectedEntities();
        if (!selU.length) { msg('先选中对象'); break; }
        selU.forEach(function (e) { e.locked = false; });
        msg('已解锁 ' + selU.length + ' 个对象');
        afterChange();
        break;
      }
      case 'tablecsv': {
        var selC = selectedEntities().filter(function (x) { return x._tbl; })[0];
        if (!selC) { msg('先选中表格中的任意图元'); break; }
        var metaC = state.tables[selC._tbl];
        if (!metaC) { msg('表格数据缺失'); break; }
        var csv = metaC.rows.map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\r\n');
        var blobC = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        var aC = document.createElement('a');
        aC.href = URL.createObjectURL(blobC);
        aC.download = 'table-' + Date.now() + '.csv';
        document.body.appendChild(aC); aC.click(); aC.remove();
        msg('表格已导出 CSV：' + metaC.rows.length + ' 行');
        break;
      }
      case 'trowmergen': {
        var selMN = selectedEntities().filter(function (x) { return x._tbl; })[0];
        if (!selMN) { msg('先选中表格中的任意图元'); break; }
        var metaMN = state.tables[selMN._tbl];
        if (!metaMN) { msg('表格数据缺失'); break; }
        var nMN = parseInt(window.prompt('合并前几行（1–' + (metaMN.rows.length - 1) + '）', String(metaMN.mergeRows || 1)), 10);
        if (!isFinite(nMN) || nMN < 1 || nMN >= metaMN.rows.length) { msg('行数超出范围'); break; }
        var wasBomN = false;
        state.entities.forEach(function (x) { if (x._tbl === selMN._tbl && x._bom) wasBomN = true; });
        var beforeN = snapshot();
        state.entities = state.entities.filter(function (x) { return x._tbl !== selMN._tbl; });
        var startN = state.entities.length;
        createTable(metaMN.rows.map(function (r) { return r.slice(); }), metaMN.x, metaMN.y, { mergeRows: nMN });
        for (var kN = startN; kN < state.entities.length; kN++) if (wasBomN) state.entities[kN]._bom = true;
        pushUndo(beforeN, '合并前N行');
        msg('表格前 ' + nMN + ' 行已合并');
        afterChange();
        break;
      }
      case 'trowins': case 'tcolins': {
        var selTI = selectedEntities().filter(function (x) { return x._tbl; })[0];
        if (!selTI) { msg('先选中表格中的任意图元'); break; }
        var metaI = state.tables[selTI._tbl];
        if (!metaI) { msg('表格数据缺失'); break; }
        var posIdx = parseInt(window.prompt('插入位置（第几行/列，1 开始）', String(metaI.rows.length + 1)), 10);
        if (!isFinite(posIdx) || posIdx < 1) break;
        var rowsI = metaI.rows.map(function (r) { return r.slice(); });
        if (act === 'trowins') rowsI.splice(Math.min(posIdx - 1, rowsI.length), 0, new Array(rowsI[0].length).fill(''));
        else rowsI.forEach(function (r) { r.splice(Math.min(posIdx - 1, r.length), 0, ''); });
        var wasBomI = false;
        state.entities.forEach(function (x) { if (x._tbl === selTI._tbl && x._bom) wasBomI = true; });
        var beforeI2 = snapshot();
        state.entities = state.entities.filter(function (x) { return x._tbl !== selTI._tbl; });
        var startI = state.entities.length;
        createTable(rowsI, metaI.x, metaI.y, { mergeRows: metaI.mergeRows || (metaI.mergeTop ? 1 : 0) });
        for (var kI = startI; kI < state.entities.length; kI++) if (wasBomI) state.entities[kI]._bom = true;
        pushUndo(beforeI2, '表格插入');
        msg('表格已插入：' + (act === 'trowins' ? '行' : '列') + ' ' + posIdx);
        afterChange();
        break;
      }
      case 'trowmerge': {
        var selTM = selectedEntities().filter(function (x) { return x._tbl; })[0];
        if (!selTM) { msg('先选中表格中的任意图元'); break; }
        var metaM = state.tables[selTM._tbl];
        if (!metaM) { msg('表格数据缺失'); break; }
        var wasBomM = false;
        state.entities.forEach(function (x) { if (x._tbl === selTM._tbl && x._bom) wasBomM = true; });
        var beforeM = snapshot();
        var rowsM = metaM.rows.map(function (r) { return r.slice(); });
        state.entities = state.entities.filter(function (x) { return x._tbl !== selTM._tbl; });
        var startM = state.entities.length;
        var newMR = (metaM.mergeRows || (metaM.mergeTop ? 1 : 0)) > 0 ? 0 : Math.min(metaM.rows.length, 2);
        createTable(rowsM, metaM.x, metaM.y, { mergeRows: newMR });
        metaM.mergeRows = newMR; metaM.mergeTop = newMR > 0;
        for (var kM = startM; kM < state.entities.length; kM++) if (wasBomM) state.entities[kM]._bom = true;
        pushUndo(beforeM, '合并首行');
        msg('表格首行已' + (!metaM.mergeTop ? '合并' : '取消合并'));
        afterChange();
        break;
      }
      case 'tablealign': {
        state.tableAlign = state.tableAlign === 'center' ? 'left' : 'center';
        msg('表格文字：' + (state.tableAlign === 'center' ? '居中' : '左对齐') + '（重建表格生效）');
        scheduleSave();
        break;
      }
      case 'trowadd': case 'trowdel': case 'tcoladd': case 'tcoldel': {
        var selTbl = selectedEntities().filter(function (x) { return x._tbl; })[0];
        if (!selTbl) { msg('先选中表格中的任意图元'); break; }
        var tid3 = selTbl._tbl;
        var meta = state.tables[tid3];
        if (!meta) { msg('表格数据缺失'); break; }
        var rows3 = meta.rows.map(function (r) { return r.slice(); });
        if (act === 'trowadd') rows3.push(new Array(rows3[0].length).fill(''));
        else if (act === 'trowdel') { if (rows3.length <= 1) { msg('至少保留一行'); break; } rows3.pop(); }
        else if (act === 'tcoladd') rows3.forEach(function (r) { r.push(''); });
        else if (act === 'tcoldel') {
          if (rows3[0].length <= 1) { msg('至少保留一列'); break; }
          rows3.forEach(function (r) { r.pop(); });
        }
        var wasBom = false;
        state.entities.forEach(function (x) { if (x._tbl === tid3 && x._bom) wasBom = true; });
        var beforeT2 = snapshot();
        state.entities = state.entities.filter(function (x) { return x._tbl !== tid3; });
        var startT2 = state.entities.length;
        createTable(rows3, meta.x, meta.y, { mergeRows: meta.mergeRows || (meta.mergeTop ? 1 : 0) });
        for (var kT = startT2; kT < state.entities.length; kT++) {
          var eT = state.entities[kT];
          if (wasBom) eT._bom = true;
        }
        pushUndo(beforeT2, '表格行列');
        msg('表格已更新：' + rows3.length + ' 行 × ' + rows3[0].length + ' 列');
        afterChange();
        break;
      }
      case 'layersexport': {
        var jsonL = JSON.stringify(state.layerStates || [], null, 1);
        var blobL = new Blob([jsonL], { type: 'application/json;charset=utf-8' });
        var aL = document.createElement('a'); aL.href = URL.createObjectURL(blobL); aL.download = 'layerstates-' + Date.now() + '.json'; document.body.appendChild(aL); aL.click(); aL.remove();
        msg('已导出 ' + (state.layerStates || []).length + ' 个图层状态');
        break;
      }
      case 'layersimport': {
        var inpL = window.prompt('粘贴图层状态 JSON（覆盖式导入）', '');
        if (!inpL) break;
        try {
          var arrL = JSON.parse(inpL);
          if (Array.isArray(arrL)) { state.layerStates = arrL; msg('已导入 ' + arrL.length + ' 个图层状态'); scheduleSave(); }
          else msg('JSON 格式不对');
        } catch (eL) { msg('JSON 解析失败'); }
        break;
      }
      case 'layerlist': {
        if (window.__openLayerStatePanel) window.__openLayerStatePanel();
        break;
      }
      case 'difflist': {
        if (window.__openDiffPanel) window.__openDiffPanel();
        break;
      }
      case 'diffpreview': {
        if (window.__openDiffPreview) window.__openDiffPreview();
        break;
      }
      case 'diffhtml': {
        var oldH = {};
        if (state.snapshot) state.snapshot.entities.forEach(function (e) { oldH[e.id] = e; });
        var addH = [], chH = [];
        state.entities.forEach(function (e) {
          if (!oldH[e.id]) addH.push(e);
          else if (JSON.stringify(e) !== JSON.stringify(oldH[e.id])) chH.push(e);
        });
        var curH = {};
        state.entities.forEach(function (e) { curH[e.id] = 1; });
        var remH = Object.keys(oldH).filter(function (id) { return !curH[id]; });
        var rowsH = '';
        addH.forEach(function (e) { rowsH += '<tr><td>新增</td><td>' + e.kind + '</td><td>' + e.id + '</td><td>-</td></tr>'; });
        chH.forEach(function (e) {
          var ob = null, nb = null;
          try { ob = entityBounds(oldH[e.id]); nb = entityBounds(e); } catch (eH) {}
          var det = ob && nb ? ('宽 ' + (ob.x1 - ob.x0).toFixed(1) + '→' + (nb.x1 - nb.x0).toFixed(1) + ' / 高 ' + (ob.y1 - ob.y0).toFixed(1) + '→' + (nb.y1 - nb.y0).toFixed(1)) : '';
          rowsH += '<tr><td>修改</td><td>' + e.kind + '</td><td>' + e.id + '</td><td>' + det + '</td></tr>';
        });
        remH.forEach(function (id) { rowsH += '<tr><td>删除</td><td>-</td><td>' + id + '</td><td>-</td></tr>'; });
        var htmlH = '<!doctype html><meta charset="utf-8"><title>CAD 差异报告</title>' +
          '<style>body{font-family:Segoe UI,Microsoft YaHei;padding:24px;color:#1f2933}h2{margin:0 0 6px}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border:1px solid #d5dfe9;padding:6px 8px;font-size:13px;text-align:left}th{background:#eef4fa}</style>' +
          '<h2>CAD 图纸差异报告</h2><div>生成时间：' + new Date().toLocaleString() + '</div>' +
          '<div>新增 ' + addH.length + ' · 修改 ' + chH.length + ' · 删除 ' + remH.length + '</div>' +
          '<table><thead><tr><th>类型</th><th>图元</th><th>ID</th><th>变化</th></tr></thead><tbody>' + rowsH + '</tbody></table>';
        try {
          var svgEl2 = document.getElementById('mdSvg');
          if (svgEl2) {
            var svgStr = new XMLSerializer().serializeToString(svgEl2);
            var thumb = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
            htmlH += '<h3 style="margin-top:20px">当前图纸</h3><img src="' + thumb + '" style="max-width:100%;border:1px solid #d5dfe9;border-radius:6px">';
          }
        } catch (eTh) {}
        var blobH2 = new Blob([htmlH], { type: 'text/html;charset=utf-8' });
        var aH = document.createElement('a'); aH.href = URL.createObjectURL(blobH2); aH.download = 'diff-' + Date.now() + '.html'; document.body.appendChild(aH); aH.click(); aH.remove();
        msg('差异 HTML 报告已导出');
        break;
      }
      case 'diffreport': {
        var oldE2 = {};
        if (state.snapshot) state.snapshot.entities.forEach(function (e) { oldE2[e.id] = e; });
        var added2 = [], changed2 = [];
        state.entities.forEach(function (e) {
          if (!oldE2[e.id]) added2.push(e);
          else if (JSON.stringify(e) !== JSON.stringify(oldE2[e.id])) changed2.push(e);
        });
        var cur2 = {};
        state.entities.forEach(function (e) { cur2[e.id] = 1; });
        var removed2 = Object.keys(oldE2).filter(function (id) { return !cur2[id]; });
        var lines2 = ['CAD 图纸差异报告', '时间：' + new Date().toLocaleString(), '',
          '新增：' + added2.length, '修改：' + changed2.length, '删除：' + removed2.length, ''];
        added2.forEach(function (e) { lines2.push('  + ' + e.kind + ' ' + e.id); });
        changed2.forEach(function (e) {
          var ob = null;
          try { ob = entityBounds(oldE2[e.id]); } catch (err2) { ob = null; }
          var nb = null;
          try { nb = entityBounds(e); } catch (err3) { nb = null; }
          var det = '';
          if (ob && nb) {
            var ow = ob.x1 - ob.x0, oh = ob.y1 - ob.y0, nw = nb.x1 - nb.x0, nh = nb.y1 - nb.y0;
            if (Math.abs(ow - nw) > 0.01) det += ' 宽 ' + ow.toFixed(1) + '→' + nw.toFixed(1);
            if (Math.abs(oh - nh) > 0.01) det += ' 高 ' + oh.toFixed(1) + '→' + nh.toFixed(1);
            if (Math.abs(ob.x0 - nb.x0) > 0.01 || Math.abs(ob.y0 - nb.y0) > 0.01) det += ' 位置(' + ob.x0.toFixed(1) + ',' + ob.y0.toFixed(1) + ')→(' + nb.x0.toFixed(1) + ',' + nb.y0.toFixed(1) + ')';
          }
          lines2.push('  ~ ' + e.kind + ' ' + e.id + det);
        });
        removed2.forEach(function (id) { lines2.push('  - ' + id); });
        var blob2 = new Blob([lines2.join('\r\n')], { type: 'text/plain;charset=utf-8' });
        var a2 = document.createElement('a');
        a2.href = URL.createObjectURL(blob2);
        a2.download = 'diff-' + Date.now() + '.txt';
        document.body.appendChild(a2); a2.click(); a2.remove();
        msg('差异报告已导出：新增 ' + added2.length + ' / 修改 ' + changed2.length + ' / 删除 ' + removed2.length);
        break;
      }
      case 'cleardiff': {
        state.diffIds = null;
        afterChange();
        break;
      }
      case 'dimpresetMech': {
        dimStyle = { textSize: 3.5, arrow: 5, precision: 2, tolMode: 'none', tol: 0.05, tol2: 0.02, arrowStyle: 'hollow' };
        state.dimStyle = dimStyle;
        try { localStorage.setItem('cad.dimStyle', JSON.stringify(dimStyle)); } catch (e6) {}
        syncDims();
        msg('已应用机械标注模板（字高3.5 / 箭头5 / 2位小数）');
        afterChange();
        break;
      }
      case 'dimtplexport': {
        var tj = JSON.stringify(state.dimTpls || [], null, 1);
        var bj = new Blob([tj], { type: 'application/json;charset=utf-8' });
        var aj = document.createElement('a'); aj.href = URL.createObjectURL(bj); aj.download = 'dimtemplates-' + Date.now() + '.json'; document.body.appendChild(aj); aj.click(); aj.remove();
        msg('已导出 ' + (state.dimTpls || []).length + ' 个自定义模板');
        break;
      }
      case 'dimtplimport': {
        var tin = window.prompt('粘贴标注模板 JSON（数组）', '');
        if (!tin) break;
        try {
          var ta = JSON.parse(tin);
          if (Array.isArray(ta)) {
            state.dimTpls = (state.dimTpls || []).concat(ta.filter(function (x) { return x && x.name && x.style; }));
            msg('已导入 ' + ta.length + ' 个模板');
            scheduleSave();
          } else msg('JSON 需为数组');
        } catch (eT) { msg('JSON 解析失败'); }
        break;
      }
      case 'dimsavetpl': {
        var tn = window.prompt('模板名称', '自定义' + ((state.dimTpls || []).length + 1));
        if (!tn) break;
        state.dimTpls = (state.dimTpls || []).concat([{ name: tn, style: deepClone(dimStyle) }]);
        msg('已保存标注模板「' + tn + '」');
        scheduleSave();
        break;
      }
      case 'dimtpllist': {
        if (window.__openDimTplPanel) window.__openDimTplPanel();
        break;
      }
      case 'dimpresetElec': {
        dimStyle = { textSize: 3, arrow: 4, precision: 1, tolMode: 'none', tol: 0, tol2: 0, arrowStyle: 'hollow' };
        state.dimStyle = dimStyle;
        try { localStorage.setItem('cad.dimStyle', JSON.stringify(dimStyle)); } catch (e8) {}
        syncDims(); msg('已应用电气标注模板'); afterChange();
        break;
      }
      case 'dimpresetAxis': {
        dimStyle = { textSize: 5, arrow: 6, precision: 0, tolMode: 'none', tol: 0, tol2: 0, arrowStyle: 'none' };
        state.dimStyle = dimStyle;
        try { localStorage.setItem('cad.dimStyle', JSON.stringify(dimStyle)); } catch (e9) {}
        syncDims(); msg('已应用轴网标注模板'); afterChange();
        break;
      }
      case 'dimpresetArch': {
        dimStyle = { textSize: 4.5, arrow: 7, precision: 0, tolMode: 'none', tol: 0, tol2: 0, arrowStyle: 'none' };
        state.dimStyle = dimStyle;
        try { localStorage.setItem('cad.dimStyle', JSON.stringify(dimStyle)); } catch (e7) {}
        syncDims();
        msg('已应用建筑标注模板（字高4.5 / 箭头7 / 整数）');
        afterChange();
        break;
      }
      case 'arrowstyle': {
        var asv = window.prompt('箭头样式（hollow=空心线 / none=无箭头）', dimStyle.arrowStyle || 'hollow');
        if (asv === null) break;
        dimStyle.arrowStyle = (asv === 'none') ? 'none' : 'hollow';
        state.dimStyle = dimStyle;
        try { localStorage.setItem('cad.dimStyle', JSON.stringify(dimStyle)); } catch (e5) {}
        msg('标注箭头样式：' + dimStyle.arrowStyle + '（新标注生效）');
        break;
      }
      case 'dimoverride': {
        var ov = window.prompt('标注文字覆盖（留空恢复自动）', '');
        if (ov === null) break;
        var selT = {};
        state.selection.forEach(function (id) { selT[id] = 1; });
        var nO = 0;
        (state.dimSets || []).forEach(function (ds) {
          if (Object.keys(selT).length && !selT[ds.textId]) return;
          ds.override = ov.trim ? ov.trim() : ov;
          nO++;
        });
        syncDims();
        msg('标注文字覆盖已设置：' + nO + ' 个');
        afterChange();
        break;
      }
      case 'dimtol': {
        var tv = window.prompt('尺寸公差（如 ±0.05，留空取消）', '±0.05');
        if (tv === null) break;
        var beforeT = snapshot();
        var nT = 0;
        (state.dimSets || []).forEach(function (ds) {
          ds.tol = tv.trim();
          var t = state.entities.find(function (x) { return x.id === ds.textId; });
          if (t) { t.text = String(t.text).replace(/±[0-9.]+$/, '') + (ds.tol ? ' ' + ds.tol : ''); nT++; }
        });
        pushUndo(beforeT, '尺寸公差');
        msg(ds0msg());
        function ds0msg() { return tv ? ('公差 ' + tv + ' 已加到 ' + nT + ' 个标注') : '公差已清除'; }
        afterChange();
        break;
      }
      case 'cloudbump': {
        var cb = parseFloat(window.prompt('修订云线弧长（mm，2–30）', String(state.cloudBump || 5)));
        if (isFinite(cb) && cb >= 2 && cb <= 30) { state.cloudBump = cb; msg('云线弧长：' + cb + ' mm'); scheduleSave(); }
        break;
      }
      case 'printmaptbl': {
        if (window.__openPrintPanel) { window.__openPrintPanel(); break; }
        var curMap = state.printMap || {};
        var curMap = state.printMap || {};
        var str = Object.keys(curMap).map(function (c) { return c + ':' + curMap[c]; }).join(',');
        var inp = window.prompt('颜色:线宽（逗号分隔，如 #ff0000:0.5,#00ff00:0.25）', str);
        if (inp === null) break;
        var mp = {};
        inp.split(',').forEach(function (kv) {
          var p2 = kv.split(':');
          if (p2.length === 2) { var cc = p2[0].trim().toLowerCase(); var ww = parseFloat(p2[1]); if (cc && isFinite(ww)) mp[cc] = ww; }
        });
        state.printMap = mp;
        msg('打印样式表：' + Object.keys(mp).length + ' 条');
        redrawAll();
        scheduleSave();
        break;
      }
      case 'printstyle': {
        var ps = state.printStyle || { lw: 1, mono: false };
        var lwv = parseFloat(window.prompt('打印线宽倍数（0.5–3）', String(ps.lw || 1)));
        var mons = window.prompt('单色打印？(y/n)', ps.mono ? 'y' : 'n');
        state.printStyle = { lw: isFinite(lwv) && lwv > 0 ? lwv : 1, mono: String(mons || '').toLowerCase().indexOf('y') >= 0 };
        if (els.app) {
          els.app.style.setProperty('--cad-lw', String(state.printStyle.lw));
          els.app.classList.toggle('is-print-mono', state.printStyle.mono);
        }
        msg('打印样式：线宽 ×' + state.printStyle.lw + (state.printStyle.mono ? ' / 单色' : ''));
        redrawAll();
        scheduleSave();
        break;
      }
      case 'sheetcfg': {
        var sh0 = state.sheet || {};
        var t1v = window.prompt('图名', sh0.title || '手动绘图练习');
        if (t1v === null) break;
        var t2v = window.prompt('图号', sh0.code || 'A3-001');
        var t3v = window.prompt('比例', sh0.scale || '1 : 1');
        var t4v = window.prompt('设计者', sh0.designer || '—');
        state.sheet = { title: t1v || '手动绘图练习', code: t2v || 'A3-001', scale: t3v || '1 : 1', designer: t4v || '—', unit: (sh0.unit || 'mm') };
        if (state.layouts && state.layouts[state.curLayout]) state.layouts[state.curLayout].sheet = state.sheet;
        msg('图框/标题栏已更新');
        redrawAll();
        break;
      }
      case 'revlib': {
        if (window.__openRevPanel) window.__openRevPanel();
        break;
      }
      case 'blocklib': {
        if (window.__openBlockPanel) window.__openBlockPanel();
        break;
      }
      case 'snap': {
        var note = window.prompt('快照备注（可选）', '');
        state.snapshot = { at: Date.now(), note: note || '', entities: deepClone(state.entities) };
        state.snaps = (state.snaps || []).concat([state.snapshot]).slice(-5);
        msg('已保存快照：' + state.entities.length + ' 个图元（共 ' + state.snaps.length + ' 个）');
        scheduleSave();
        break;
      }
      case 'cmp': {
        if (!state.snapshot && state.snaps && state.snaps.length) state.snapshot = state.snaps[state.snaps.length - 1];
        if (!state.snapshot) { msg('还没有快照，先在「帮助 → 保存快照」保存'); break; }
        var oldE = {};
        state.snapshot.entities.forEach(function (e) { oldE[e.id] = e; });
        var curIds = {};
        var added = [], changed = [];
        state.entities.forEach(function (e) {
          curIds[e.id] = 1;
          if (!oldE[e.id]) { added.push(e.id); return; }
          if (JSON.stringify(e) !== JSON.stringify(oldE[e.id])) changed.push(e.id);
        });
        state.diffIds = {};
        added.concat(changed).forEach(function (id) { state.diffIds[id] = 1; });
        var removed = Object.keys(oldE).filter(function (id) { return !curIds[id]; }).length;
        state.selection = new Set(added.concat(changed));
        msg('对比快照：新增 ' + added.length + ' / 修改 ' + changed.length + ' / 删除 ' + removed + '（已选中变化项）');
        afterChange();
        break;
      }
      case 'printpdf': {
        setSpace('layout');
        setTimeout(function () { window.print(); }, 350);
        msg('打印预览：选择「另存为 PDF」即可导出');
        break;
      }
      case 'export': exportDXF(); break;
      case 'layout': setSpace('layout'); break;
      case 'home': if (window.Portal && window.Portal.goHome) window.Portal.goHome(); else hide(); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'copy': duplicateSelection(); break;
      case 'selsame': selectSimilar(); break;
      case 'all': selectAll(); break;
      case 'delete': deleteSelection(); break;
      case 'clearsel': clearSelection(); break;
      case 'extents': if (state.space === 'layout') fitLayout(); else fit(); break;
      case 'zoom1': {
        var s = zoneSize();
        var c0 = s2w(s.w / 2, s.h / 2);
        state.view.zoom = 1;
        state.view.tx = s.w / 2 - c0.x;
        state.view.ty = s.h / 2 - c0.y;
        redrawAll();
        msg('缩放 1:1');
        break;
      }
      case 'grid': toggleGrid(); break;
      case 'ortho': toggleOrtho(); break;
      case 'polar': togglePolar(); break;
      case 'lw': toggleLw(); break;
      case 'layers': setSideTab('layers'); break;
      case 'props': setSideTab('props'); break;
      case 'osnap': openOsnap(); break;
      case 'dyn': toggleDyn(); break;
      case 'units': msg('图形单位：毫米 (mm) · 1 绘图单位 = 1 mm'); toast('单位：毫米 mm'); break;
      case 'gridsize': {
        var v = window.prompt('栅格间距 (mm)', String(state.grid));
        v = parseFloat(v);
        if (isFinite(v) && v > 0) { state.grid = v; drawGrid(true); updateStatus(); scheduleSave(); msg('栅格间距 = ' + v + ' mm'); }
        break;
      }
      case 'help': toggleHelp(true); break;
      case 'about': msg('CAD 绘图工作区 · 2D 手动绘图模块 · 支持 DXF 导出与 3D 拉伸'); toast('CAD 绘图工作区 v3'); break;
      case 'repeat': if (state.lastCmd) startCmd(state.lastCmd); break;
      case 'zoomsel': {
        var list = selectedEntities();
        if (!list.length) break;
        var b = unionBounds(list);
        zoomWindow(b);
        break;
      }
      case 'flip':
        break;
    }
  }

  /* ---------------- 对话框 ---------------- */
  function openOsnap() {
    if (!els.osnapDlg) return;
    var box = els.osnapDlg.querySelector('.cad-osnap-list');
    var labels = {
      endpoint: '端点', midpoint: '中点', center: '圆心', quadrant: '象限点',
      intersection: '交点', perpendicular: '垂足', nearest: '最近点'
    };
    box.innerHTML = Object.keys(labels).map(function (k) {
      return '<label class="cad-check"><input type="checkbox" data-os="' + k + '"' + (state.osnap[k] ? ' checked' : '') + '><span>' + labels[k] + '</span></label>';
    }).join('');
    var rng = els.osnapDlg.querySelector('#mdCrossRange');
    var val = els.osnapDlg.querySelector('#mdCrossVal');
    if (rng) rng.value = String(state.crossPct);
    if (val) val.textContent = state.crossPct + '%';
    var pr = els.osnapDlg.querySelector('#mdPickRange');
    var pv = els.osnapDlg.querySelector('#mdPickVal');
    if (pr) pr.value = String(state.pickPx);
    if (pv) pv.textContent = state.pickPx + ' px';
    var ps = els.osnapDlg.querySelector('#mdPolarStep');
    if (ps) ps.value = String(state.polarStep);
    els.osnapDlg.hidden = false;
  }
  function applyOsnap() {
    if (!els.osnapDlg) return;
    Array.prototype.forEach.call(els.osnapDlg.querySelectorAll('input[data-os]'), function (inp) {
      state.osnap[inp.getAttribute('data-os')] = inp.checked;
    });
    var rng = els.osnapDlg.querySelector('#mdCrossRange');
    if (rng) state.crossPct = clamp(parseFloat(rng.value) || 100, 5, 100);
    var pr = els.osnapDlg.querySelector('#mdPickRange');
    if (pr) state.pickPx = clamp(parseFloat(pr.value) || 8, 4, 24);
    var ps = els.osnapDlg.querySelector('#mdPolarStep');
    if (ps) state.polarStep = parseFloat(ps.value) || 15;
    updateStatus();
    scheduleSave();
    msg('对象捕捉设置已更新');
    toast('对象捕捉已更新');
  }

  function toggleHelp(force) {
    if (!els.help) return;
    var show = typeof force === 'boolean' ? force : els.help.hidden;
    els.help.hidden = !show;
  }

  function toggleCmdHeight() {
    if (!els.cmdWrap) return;
    els.cmdWrap.classList.toggle('is-expanded');
  }

  function renderLayoutTabs() {
    var host = document.getElementById('mdLayoutTabs');
    if (!host) return;
    host.innerHTML = '';
    state.layouts.forEach(function (L, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cad-tab' + (state.space === 'layout' && state.curLayout === i ? ' is-on' : '');
      b.textContent = L.name;
      b.addEventListener('click', function () {
        state.curLayout = i;
        state.sheet = state.layouts[i].sheet;
        setSpace('layout');
        renderLayoutTabs();
      });
      host.appendChild(b);
    });
  }

  function setSpace(space) {
    if (state.space === space) return;
    state.space = space;
    cancelCmd(true);
    if (space === 'layout') {
      state.modelView = { tx: state.view.tx, ty: state.view.ty, zoom: state.view.zoom };
      fitLayout();
      msg('切换到【布局1】：A3 图框预览（只读）');
    } else {
      if (state.modelView) {
        state.view.tx = state.modelView.tx;
        state.view.ty = state.modelView.ty;
        state.view.zoom = state.modelView.zoom;
      }
      redrawAll();
      msg('切换到【模型】空间');
    }
    updateStatus();
    scheduleSave();
  }

  /* ---------------- 图标 ---------------- */
  var ICONS = {
    line: '<path d="M3 13 13 3"/><circle cx="3" cy="13" r="1.3"/><circle cx="13" cy="3" r="1.3"/>',
    polyline: '<path d="M2.5 13 6 4.5 10 10.5 13.5 3"/>',
    rect: '<rect x="2.5" y="4" width="11" height="8"/>',
    circle: '<circle cx="8" cy="8" r="5.6"/>',
    arc: '<path d="M3 12.5A6.2 6.2 0 0 1 12.6 5.2"/>',
    move: '<path d="M8 2v12M2 8h12"/><path d="M5.5 4.5 8 2l2.5 2.5M5.5 11.5 8 14l2.5-2.5M4.5 5.5 2 8l2.5 2.5M11.5 5.5 14 8l-2.5 2.5"/>',
    copy: '<rect x="2.5" y="2.5" width="8" height="8"/><rect x="5.5" y="5.5" width="8" height="8"/>',
    rotate: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13.2 2.6v3.2h-3.2"/>',
    mirror: '<path d="M8 2v12" stroke-dasharray="2 2"/><path d="M6 3 2.5 8 6 13z"/><path d="M10 3l3.5 5L10 13z"/>',
    offset: '<path d="M2 12V6l4-3 4 3v6"/><path d="M4.5 12.5V7l1.5-1.1L7.5 7v5.5"/>',
    array: '<rect x="2" y="2" width="3.4" height="3.4"/><rect x="6.3" y="2" width="3.4" height="3.4"/><rect x="10.6" y="2" width="3.4" height="3.4"/><rect x="2" y="6.3" width="3.4" height="3.4"/><rect x="6.3" y="6.3" width="3.4" height="3.4"/><rect x="10.6" y="6.3" width="3.4" height="3.4"/><rect x="2" y="10.6" width="3.4" height="3.4"/><rect x="6.3" y="10.6" width="3.4" height="3.4"/><rect x="10.6" y="10.6" width="3.4" height="3.4"/>',
    explode: '<path d="M8 8 3 3M8 8l5-5M8 8 3 13M8 8l5 5M8 8V2M8 8v6M8 8H2M8 8h6"/>',
    erase: '<path d="M3 12h4l6-6-4-4-6 6z"/><path d="M6 13h7"/>',
    undo: '<path d="M3 7h7a4 4 0 0 1 0 8H6"/><path d="M6 3.5 2.5 7 6 10.5"/>',
    redo: '<path d="M13 7H6a4 4 0 0 0 0 8h4"/><path d="M10 3.5 13.5 7 10 10.5"/>',
    layers: '<path d="M8 2 2.5 5 8 8l5.5-3z"/><path d="M2.5 8 8 11l5.5-3"/><path d="M2.5 11 8 14l5.5-3"/>',
    props: '<path d="M2 4h12M2 8h12M2 12h12"/><circle cx="6" cy="4" r="1.7" fill="currentColor" stroke="none"/><circle cx="10" cy="8" r="1.7" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none"/>',
    grid: '<path d="M2 6h12M2 10h12M6 2v12M10 2v12"/>',
    ortho: '<path d="M3 13V4h9"/><path d="M8 4v4H3"/>',
    osnap: '<rect x="2.5" y="2.5" width="6" height="6"/><path d="M8.5 8.5 13 13"/><path d="M10.5 2v3M9 3.5h3"/>',
    dyn: '<rect x="2" y="8" width="7" height="4" rx="1"/><path d="M6 8V3h7"/>',
    export: '<path d="M8 2v8M5 7l3 3 3-3M3 12v2h10v-2"/>',
    save: '<path d="M3 3h8l2 2v8H3z"/><path d="M5.5 3v4h5V3M5.5 13v-4h5v4"/>',
    extents: '<circle cx="6.5" cy="6.5" r="4.2"/><path d="M9.6 9.6 14 14"/><path d="M2 2h2.5M2 2v2.5M11 2h3v3"/>',
    pan: '<path d="M8 2v12M2 8h12"/><path d="M6 4l2-2 2 2M6 12l2 2 2-2M4 6 2 8l2 2M12 6l2 2-2 2"/>',
    home: '<path d="M2.5 7.5 8 3l5.5 4.5"/><path d="M4 7v6h8V7"/>',
    select: '<path d="M3.2 2.6l4.1 10.2 1.9-4.1 4.1-1.7z" fill="currentColor" stroke="none"/>',
    ai: '<path d="M8 2l1.5 3.5L13 7l-3.5 1.5L8 12l-1.5-3.5L3 7l3.5-1.5z"/><circle cx="12.6" cy="12.4" r="1.1"/>',
    trim: '<path d="M3 3l10 10M13 3 3 13"/><path d="M2.5 13.5h4.5"/>',
    extend: '<path d="M2.5 8h8"/><path d="M7.5 5 11 8l-3.5 3"/><path d="M13.5 2.5v11"/>',
    leader: '<path d="M3 13 9 6h4"/><path d="M3 13l1.5-3.5L8 8z" fill="currentColor"/>',
    hatch: '<path d="M2.5 12.5v-9h11v9z"/><path d="M5 6.5l6 5M5 9l4 3.4M8.5 5.5l3 2.6" stroke-width="1"/>',
    block: '<rect x="3" y="3" width="10" height="10"/><path d="M3 7h10M7 3v10"/>',
    insert: '<rect x="2.5" y="8" width="7" height="5"/><path d="M9 4h4v4M13 4 8 9"/>'
  };
  function ico(name) {
    return '<svg class="cad-i" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">' +
      (ICONS[name] || '') + '</svg>';
  }

  function rb(act, icon, label, title, extra) {
    return '<button type="button" class="cad-rb' + (extra || '') + '" data-act="' + act + '" title="' + title + '">' +
      '<i>' + ico(icon) + '</i><span>' + label + '</span></button>';
  }

  /* 左侧常驻工具条（FreeCAD/Draft 风格：工具常在，不用翻功能区） */
  var PALETTE = [
    { title: '绘图', items: [
      { tool: 'select', icon: 'select', label: '选择', kbd: 'V' },
      { act: 'cmd:line', icon: 'line', label: '直线', kbd: 'L' },
      { act: 'cmd:polyline', icon: 'polyline', label: '多段线', kbd: 'PL' },
      { act: 'cmd:rect', icon: 'rect', label: '矩形', kbd: 'REC' },
      { act: 'cmd:circle', icon: 'circle', label: '圆', kbd: 'C' },
      { act: 'cmd:arc', icon: 'arc', label: '圆弧', kbd: 'A' },
      { act: 'cmd:hatch', icon: 'hatch', label: '填充', kbd: 'H' }
    ] },
    { title: '修改', items: [
      { act: 'cmd:move', icon: 'move', label: '移动', kbd: 'M' },
      { act: 'cmd:copy', icon: 'copy', label: '复制', kbd: 'CO' },
      { act: 'cmd:rotate', icon: 'rotate', label: '旋转', kbd: 'RO' },
      { act: 'cmd:mirror', icon: 'mirror', label: '镜像', kbd: 'MI' },
      { act: 'cmd:dim', icon: 'extents', label: '标注', kbd: 'DIM' },
      { act: 'cmd:dimdia', icon: 'circle', label: '直径', kbd: 'DIAD' },
      { act: 'cmd:autodim', icon: 'extents', label: '自标', kbd: 'AUTO' },
      { act: 'cmd:leader', icon: 'leader', label: '引线', kbd: 'LE' },
      { act: 'cmd:bom', icon: 'block', label: '明细栏', kbd: 'BOM' },
      { act: 'cmd:block', icon: 'block', label: '块定义', kbd: 'B' },
      { act: 'cmd:insert', icon: 'insert', label: '插入块', kbd: 'I' },
      { act: 'blocklib', icon: 'block', label: '块库', kbd: 'BL' },
      { act: 'cmd:attr', icon: 'block', label: '块属性', kbd: 'AT' },
      { act: 'cmd:trim', icon: 'trim', label: '修剪', kbd: 'TR' },
      { act: 'cmd:extend', icon: 'extend', label: '延伸', kbd: 'EX' },
      { act: 'delete', icon: 'erase', label: '删除', kbd: 'E' }
    ] },
    { title: '视图', items: [
      { act: 'cmd:pan', icon: 'pan', label: '平移', kbd: 'P' },
      { act: 'cmd:zoom', icon: 'extents', label: '框缩', kbd: 'Z' },
      { act: 'extents', icon: 'extents', label: '范围', kbd: 'ZE' }
    ] }
  ];

  function palBtn(item) {
    var attr = item.tool ? ' data-tool="' + item.tool + '"' : ' data-act="' + item.act + '"';
    return '<button type="button" class="pal-btn"' + attr + ' title="' + (item.title || item.label + ' (' + item.kbd + ')') + '">' +
      '<i>' + ico(item.icon) + '</i><span>' + item.label + '</span><em>' + item.kbd + '</em></button>';
  }

  function applyPrintStyle() {
    if (!els.app) return;
    var ps = state.printStyle || { lw: 1, mono: false };
    els.app.style.setProperty('--cad-lw', String(ps.lw || 1));
    els.app.classList.toggle('is-print-mono', !!ps.mono);
  }

  function build() {
    try {
      var ds = JSON.parse(localStorage.getItem('cad.dimStyle') || 'null');
      if (ds && isFinite(ds.textSize) && isFinite(ds.arrow)) dimStyle = { textSize: ds.textSize, arrow: ds.arrow, precision: ds.precision || 2 };
    } catch (e3) {}
    state.dimStyle = dimStyle;
    applyPrintStyle();
    if (built) return els.app;
    var app = document.createElement('div');
    app.id = 'cadApp';
    app.className = 'cad-app';
    app.hidden = true;
    app.innerHTML = [
      '<div class="cad-menubar">',
      '  <div class="cad-logo"><b>CAD</b><span>绘图工作区</span></div>',
      '  <div class="cad-menus" id="mdMenus">',
      Object.keys(MENU_TITLES).map(function (k) {
        return '<button type="button" class="cad-menu-btn" data-menu="' + k + '">' + MENU_TITLES[k] + '</button>';
      }).join(''),
      '  </div>',
      '  <div class="cad-quick">',
      '    <button type="button" class="cad-qb" id="mdRibbonToggle" title="收起 / 展开功能区，给画布让空间">' + ico('grid') + '<b>功能区</b></button>',
      '    <button type="button" class="cad-qb" id="mdSideToggle" title="显示 / 隐藏右侧面板（特性 / 图层）">' + ico('props') + '<b>面板</b></button>',
      '    <button type="button" class="cad-qb" id="mdPaletteToggle" title="工具条：图标 / 带文字">' + ico('select') + '<b>工具条</b></button>',
      '    <button type="button" class="cad-qb" id="mdFocusToggle" title="专注画布：隐藏命令行与状态栏">' + ico('extents') + '<b>专注</b></button>',
      '    <button type="button" class="cad-qb" id="mdCanvasBtn" title="画布大小：预设或自定义宽/高占比">' + ico('grid') + '<b>画布</b></button>',
      '    <button type="button" class="cad-qb" id="mdColorBtnQ" title="当前颜色（ByLayer / 调色板）"><i class="cad-color-dot" id="mdColorDot"></i><b>颜色</b></button>',
      '    <button type="button" class="cad-qb" id="mdBgBtn" title="白色 / 深色背景（浅底时近白色线自动转深灰）"><i class="cad-bg-dot" id="mdBgDot"></i><b>背景</b></button>',
      '    <button type="button" class="cad-qb" id="mdUndo"  title="撤销 (Ctrl+Z)">' + ico('undo') + '</button>',
      '    <button type="button" class="cad-qb" id="mdRedo" title="重做 (Ctrl+Y)">' + ico('redo') + '</button>',
      '    <span class="cad-qsep"></span>',
      '    <button type="button" class="cad-qb" id="mdExport" title="导出 DXF">' + ico('export') + '<b>DXF</b></button>',
      '    <button type="button" class="cad-qb" id="mdToSketch" title="切到参数化草图（约束 / 尺寸驱动 / AI 建模）"><b>草图</b></button>',
      '    <button type="button" class="cad-qb" id="mdTo3d" title="发送到 3D 预览">3D</button>',
      '    <button type="button" class="cad-qb cad-home" id="mdHome" title="返回工作台">' + ico('home') + '</button>',
      '  </div>',
      '</div>',
      '<div class="cad-ribbon">',
      '  <div class="cad-rg">',
      '    <div class="cad-rbs">',
      rb('cmd:line', 'line', '直线', '直线 (L)'),
      rb('cmd:polyline', 'polyline', '多段线', '多段线 (PL)'),
      rb('cmd:rect', 'rect', '矩形', '矩形 (REC)'),
      rb('cmd:circle', 'circle', '圆', '圆 (C)'),
      rb('cmd:arc', 'arc', '圆弧', '圆弧 (A)'),
      '    </div><div class="cad-rgl">绘图</div>',
      '  </div>',
      '  <div class="cad-rg">',
      '    <div class="cad-rbs">',
      rb('cmd:move', 'move', '移动', '移动 (M)'),
      rb('cmd:copy', 'copy', '复制', '复制 (CO)'),
      rb('cmd:rotate', 'rotate', '旋转', '旋转 (RO)'),
      rb('cmd:mirror', 'mirror', '镜像', '镜像 (MI)'),
      rb('cmd:offset', 'offset', '偏移', '偏移 (O)'),
      rb('cmd:array', 'array', '阵列', '矩形阵列 (AR)'),
      rb('cmd:explode', 'explode', '分解', '分解 (X)'),
      '<button type="button" class="cad-rb" id="mdDeleteBtn" data-act="delete" title="删除 (E)"><i>' + ico('erase') + '</i><span>删除</span></button>',
      '    </div><div class="cad-rgl">修改</div>',
      '  </div>',
      '  <div class="cad-rg">',
      '    <div class="cad-rbs">',
      '<button type="button" class="cad-rb" data-act="layers" title="图层管理器 (LA)"><i>' + ico('layers') + '</i><span>图层</span></button>',
      '<button type="button" class="cad-rb" data-act="props" title="特性面板 (PR)"><i>' + ico('props') + '</i><span>特性</span></button>',
      '      <button type="button" class="cad-rb cad-color-btn" id="mdColorBtn" title="当前颜色：ByLayer 或调色板"><i class="cad-color-dot" id="mdColorDot"></i><span>颜色</span></button>',
      '      <label class="cad-rsel"><span>当前图层</span><select id="mdCurLayer"></select></label>',
      '    </div><div class="cad-rgl">图层</div>',
      '  </div>',
      '  <div class="cad-rg">',
      '    <div class="cad-rbs">',
      '<button type="button" class="cad-rb" data-act="extents" title="缩放至范围"><i>' + ico('extents') + '</i><span>范围</span></button>',
      '<button type="button" class="cad-rb" data-act="cmd:pan" title="平移 (P)"><i>' + ico('pan') + '</i><span>平移</span></button>',
      '<button type="button" class="cad-rb" id="mdRGrid" data-act="grid" title="栅格 (F7)"><i>' + ico('grid') + '</i><span>栅格</span></button>',
      '<button type="button" class="cad-rb" id="mdROrtho" data-act="ortho" title="正交 (F8)"><i>' + ico('ortho') + '</i><span>正交</span></button>',
      '<button type="button" class="cad-rb" id="mdROsnap" data-act="osnap" title="对象捕捉设置 (OS)"><i>' + ico('osnap') + '</i><span>捕捉</span></button>',
      '<button type="button" class="cad-rb" id="mdRDyn" data-act="dyn" title="动态输入 (F12)"><i>' + ico('dyn') + '</i><span>动态</span></button>',
      '    </div><div class="cad-rgl">视图</div>',
      '  </div>',
      '</div>',
      '<div class="cad-body">',
      '      <div class="cad-palette is-docked" id="mdPalette"><div class="pal-head"><b>工具</b><button type="button" class="pal-head-btn" id="mdPalettePin" title="展开 / 收起工具名称">&#9776;</button></div>',
      PALETTE.map(function (g) {
        return '<div class="pal-group"><b>' + g.title + '</b>' + g.items.map(palBtn).join('') + '</div>';
      }).join(''),
      '        <div class="pal-group pal-ai"><b>AI</b>',
      '          <button type="button" class="pal-btn" id="mdAiBtn" title="不用图片：描述一句话，AI 直接画出零件/改尺寸">',
      '            <i>' + ico('ai') + '</i><span>AI 制图</span><em>AI</em></button>',
      '        </div>',
      '      </div>',
      '  <div class="cad-dwg">',
      '    <div class="cad-vp" id="mdZone">',
      '      <svg class="cad-svg" id="mdSvg" xmlns="http://www.w3.org/2000/svg" aria-label="CAD 绘图区">',
      '        <defs id="mdDefs"></defs>',
      '        <g id="mdView"><g id="mdSheet"></g><g id="mdGrid"></g><g id="mdWorld"></g><g id="mdPreview"></g></g><g id="mdOverlay"></g>',
      '      </svg>',
      '      <div class="cad-dyn" id="mdDyn" hidden></div>',
      '      <div class="cad-snap-tag" id="mdSnapTag" hidden></div>',
      '      <div class="cad-cycle-tag" id="mdCycleTag" hidden></div>',
      '      <div class="cad-dimtip" id="mdDim" hidden></div>',
      '      <div class="cad-empty" id="mdEmpty">',
      '        <div class="t">开始绘制</div>',
      '        <div>从功能区选择命令，或使用命令行输入 L / REC / C / A</div>',
      '        <div>单击起点 → 移动 → 单击终点；滚轮缩放 · 中键拖动平移</div>',
      '        <div class="acts"><button type="button" class="cad-btn" data-act="sample">载入示例</button>',
      '        <button type="button" class="cad-btn" data-act="help">操作说明</button></div>',
      '      </div>',
      '      <div class="cad-tabs" id="mdTabs">',
      '        <button type="button" class="cad-tab is-on" id="mdTabModel">模型</button>',
      '        <span class="cad-layout-tabs" id="mdLayoutTabs"></span>',
      '        <button type="button" class="cad-tab cad-tab-add" id="mdTabAddLayout" title="新建布局">+</button>',
      '      </div>',
      '      <div class="cad-ucs" title="世界坐标系"><svg viewBox="0 0 46 46"><path d="M8 38V12M8 38h28" stroke="#8ecbff" fill="none"/><path d="M8 12l-3 5h6zM36 38l-5-3v6z" fill="#8ecbff"/><text x="12" y="14" fill="#8ecbff" font-size="9">Y</text><text x="36" y="34" fill="#8ecbff" font-size="9">X</text></svg></div>',
      '      <div class="cad-viewnav">',
      '        <button type="button" id="mdViewFit" title="缩放至范围 (Z→E)">适应</button>',
      '        <button type="button" id="mdView100" title="回到 100%">1:1</button>',
      '        <button type="button" id="mdViewReset" title="复位视图">复位</button>',
      '      </div>',
      '      <div class="cad-zoomctl">',
      '        <button type="button" id="mdZoomOut" title="缩小">−</button>',
      '        <button type="button" id="mdZoomBtn" title="重置为 100%">100%</button>',
      '        <button type="button" id="mdZoomIn" title="放大">+</button>',
      '        <button type="button" id="mdFit" title="缩放至范围 (Z→E)">范围</button>',
      '      </div>',
      '      <div class="cad-canvas-pop" id="mdDiffPreview" hidden>',
      '        <div class="pop-head"><b>差异预览</b><span id="mdDiffPrevSum"></span></div>',
      '        <div class="cad-block-list" id="mdDiffPrevBody"></div>',
      '        <div class="pop-actions"><button type="button" class="cad-btn" id="mdDiffPrevTxt">导出 TXT</button><button type="button" class="cad-btn is-primary" id="mdDiffPrevHtml">导出 HTML</button></div>',
      '      </div>',
      '      <div class="cad-canvas-pop" id="mdDimTplPop" hidden>',
      '        <div class="pop-head"><b>标注样式模板</b><span>点击应用</span></div>',
      '        <div class="cad-block-list" id="mdDimTplList"></div>',
      '      </div>',
      '      <div class="cad-canvas-pop" id="mdDiffPop" hidden>',
      '        <div class="pop-head"><b>差异列表</b><span>点击定位</span></div>',
      '        <div class="cad-block-list" id="mdDiffList"></div>',
      '      </div>',
      '      <div class="cad-canvas-pop" id="mdLayerStatePop" hidden>',
      '        <div class="pop-head"><b>图层状态</b><span>恢复 / 删除</span></div>',
      '        <div class="cad-block-list" id="mdLayerStateList"></div>',
      '      </div>',
      '      <div class="cad-canvas-pop" id="mdRevPop" hidden>',
      '        <div class="pop-head"><b>修订记录</b><span>恢复 / 删除</span></div>',
      '        <div class="cad-block-list" id="mdRevList"></div>',
      '      </div>',
      '      <div class="cad-canvas-pop" id="mdBlockPop" hidden>',
      '        <div class="pop-head"><b>块库</b><span>插入 / 重命名 / 删除</span></div>',
      '        <div class="cad-block-search"><input id="mdBlockSearch" placeholder="搜索块名…"></div>',
      '        <div class="cad-block-list" id="mdBlockList"></div>',
      '      </div>',
      '      <div class="cad-canvas-pop" id="mdPrintPop" hidden>',
      '        <div class="pop-head"><b>打印样式表</b><span>颜色 → 线宽(mm)</span></div>',
      '        <div class="cad-print-rows" id="mdPrintRows"></div>',
      '        <div class="pop-actions"><button type="button" class="cad-btn" id="mdPrintAdd">+ 颜色</button><button type="button" class="cad-btn is-primary" id="mdPrintSave">应用</button></div>',
      '      </div>',
      '      <div class="cad-canvas-pop" id="mdCanvasPop" hidden>',
      '        <div class="ai-pop-head"><b>画布大小</b><span>拖分隔条也能调面板宽度</span>',
      '          <button type="button" class="cad-x" id="mdCanvasClose" title="关闭">×</button></div>',
      '        <div class="canvas-presets">',
      '          <button type="button" data-canvas="100,100">铺满</button>',
      '          <button type="button" data-canvas="92,90">大</button>',
      '          <button type="button" data-canvas="82,78">中</button>',
      '          <button type="button" data-canvas="70,65">小</button>',
      '        </div>',
      '        <div class="canvas-custom">',
      '          <label>宽 <input id="mdCanvasW" type="range" min="40" max="100" step="1" value="100"><b id="mdCanvasWV">100%</b></label>',
      '          <label>高 <input id="mdCanvasH" type="range" min="40" max="100" step="1" value="100"><b id="mdCanvasHV">100%</b></label>',
      '        </div>',
      '        <div class="canvas-hint">画布按可用区域百分比缩放；100% 即铺满。居中留边便于截图/排版。</div>',
      '      </div>',
      '      <div class="cad-selbar" id="mdSelBar" hidden>',
      '        <span class="selbar-count" id="mdSelBarCount">已选 0</span>',
      '        <button type="button" class="selbar-btn" data-act="props">特性</button>',
      '        <button type="button" class="selbar-btn" data-act="cmd:move">移动</button>',
      '        <button type="button" class="selbar-btn" data-act="cmd:copy">复制</button>',
      '        <button type="button" class="selbar-btn" data-act="cmd:rotate">旋转</button>',
      '        <button type="button" class="selbar-btn" data-act="delete">删除</button>',
      '        <button type="button" class="selbar-btn" data-act="zoomsel">缩放到</button>',
      '        <button type="button" class="selbar-btn" data-act="clearsel">取消选择</button>',
      '      </div>',
      '      <div class="cad-ai-pop" id="mdAiPop" hidden>',
      '        <div class="ai-pop-head"><b>AI 制图（不用识图）</b><span>描述零件或改选中图形，直接落到画布</span>',
      '          <button type="button" class="cad-x" id="mdAiClose" title="关闭">×</button></div>',
      '        <div class="ai-pop-row">',
      '          <input id="mdAiInput" autocomplete="off" spellcheck="false" placeholder="例：法兰 外圆120 内孔60 6个直径10的孔 均布直径100">',
      '          <button type="button" class="cad-btn primary" id="mdAiRun">执行</button>',
      '        </div>',
      '        <div class="ai-pop-chips">',
      '          <button type="button" data-ai="法兰 外圆120 内孔60 6个直径10的孔 均布直径100">法兰 ⌀120/6孔</button>',
      '          <button type="button" data-ai="板120x80 中心孔直径30">板 120×80 + 中心孔</button>',
      '          <button type="button" data-ai="板120x80 四角孔直径10">板 + 四角孔</button>',
      '          <button type="button" data-ai="轴 长200 直径40">轴 ⌀40×200</button>',
      '          <button type="button" data-ai="6个直径10的孔均布在直径100的圆上">6 孔均布 ⌀100</button>',
      '          <button type="button" data-ai="把选中的圆半径改成50">选中圆 → R50</button>',
      '        </div>',
      '        <div class="ai-pop-reply" id="mdAiReply">不用传图：直接说「法兰 外圆120 内孔60 6个直径10的孔 均布直径100」</div>',
      '      </div>',
      '    </div>',
      '  </div>',
      '  <div class="cad-split" id="mdSplit" title="拖动调整面板宽度" hidden></div>',
  '  <aside class="cad-side">',
  '    <div class="side-head"><b>检查器</b><span class="side-head-actions"><button type="button" class="side-collapse" id="mdSideFloat" title="浮动 / 停靠">&#9724;</button><button type="button" class="side-collapse" id="mdSideCollapse" title="收起面板">&#9001;</button></span></div>',
      '    <div class="cad-sidetabs" id="mdSideTabs">',
      '      <button type="button" class="is-on" data-side="props">特性</button>',
      '      <button type="button" data-side="layers">图层</button>',
      '    </div>',
      '    <div class="cad-sidebody" id="mdPropsPane">',
      '      <div class="cad-sidehead"><span>对象</span><em id="mdCount">0</em></div>',
      '      <div class="cad-list" id="mdList"></div>',
      '      <div class="cad-props" id="mdProps"></div>',
      '    </div>',
      '    <div class="cad-sidebody" id="mdLayers" hidden><div class="cad-layer-filter"><input id="mdLayerFilter" placeholder="过滤图层…"></div><div id="mdLayersList"></div></div>',
      '    <div class="cad-sidefoot">空格 / 回车 = 确认<br>Esc = 取消 · F2 = 命令历史</div>',
      '  </aside>',
      '</div>',
      '<div class="cad-cmdwrap" id="mdCmdWrap">',
      '  <div class="cad-cmdhist" id="mdCmdHist"></div>',
      '  <div class="cad-cmdrow">',
      '    <span class="cad-cmdprompt" id="mdCmdPrompt">命令:</span>',
      '    <input id="mdCmdInput" autocomplete="off" spellcheck="false" placeholder="输入命令或坐标，例如 L、REC、100,50、@50&lt;30">',
      '    <button type="button" class="cad-cmdexp" id="mdCmdExpand" title="展开/收起命令历史 (F2)">⌃</button>',
      '  </div>',
      '  <div class="cad-cmd-suggest" id="mdCmdSuggest" hidden></div>',
      '</div>',
      '<div class="cad-status">',
      '  <span class="cad-coord" id="mdCoord">X 0.00   Y 0.00</span>',
      '  <button type="button" class="cad-st cad-selcount" id="mdSelCount" hidden title="单击取消选择">已选 0</button>',
      '  <span class="cad-vsep"></span>',
      '  <button type="button" class="cad-st" id="mdStGrid" title="栅格 (F7)">栅格</button>',
      '  <button type="button" class="cad-st" id="mdStOrtho" title="正交 (F8)">正交</button>',
      '  <button type="button" class="cad-st" id="mdStPolar" title="极轴 (F10)">极轴</button>',
      '  <button type="button" class="cad-st" id="mdStOsnap" title="对象捕捉 (F3)">对象捕捉</button>',
      '  <button type="button" class="cad-st" id="mdStDyn" title="动态输入 (F12)">动态输入</button>',
      '  <button type="button" class="cad-st" id="mdStLw" title="线宽显示">线宽</button>',
      '  <span class="cad-vsep"></span>',
      '  <span class="cad-layerbox">图层 <select id="mdCurLayer2"></select></span>',
      '  <span class="cad-vsep"></span>',
      '  <span id="mdCount2">0 对象</span>',
      '  <span class="cad-vsep"></span>',
      '  <span class="cad-zoomtxt" id="mdZoomTxt">100%</span>',
      '  <span class="cad-space-tag" id="mdSpaceTag">模型</span>',
      '</div>',
      '<div class="cad-menu-pop" id="mdMenuPop" hidden></div>',
      '<div class="cad-menu-pop cad-ctx" id="mdCtx" hidden></div>',
      '<div class="cad-color-pop" id="mdColorPop" hidden>',
      '  <div class="cad-dialog-head"><b>颜色</b><button type="button" class="cad-x" id="mdColorClose">×</button></div>',
      '  <div class="cad-color-grid" id="mdColorGrid"></div>',
      '  <div class="cad-color-custom">',
      '    <label>自定义 <input type="color" id="mdColorCustom" value="#8ecbff"></label>',
      '    <button type="button" class="cad-btn" id="mdColorApplySel">应用到选中</button>',
      '    <button type="button" class="cad-btn" id="mdColorResetSel">选中改回 ByLayer</button>',
      '  </div>',
      '  <div class="cad-dialog-hint">ByLayer = 跟随图层颜色；导出 DXF 时按最接近的 ACI 索引写 62 组码（借鉴 LibreCAD 的 ACI 色表思路，JS 重写）。</div>',
      '</div>',
      '<div class="cad-dialog" id="mdOsnapDlg" hidden>',
      '  <div class="cad-dialog-card">',
      '    <div class="cad-dialog-head"><b>对象捕捉设置</b><button type="button" class="cad-x" data-dlg="close">×</button></div>',
      '    <div class="cad-osnap-list"></div>',
      '    <div class="cad-dialog-sec">光标与追踪</div>',
      '    <div class="cad-dialog-row">',
      '      <span class="cad-dialog-lb">十字光标</span>',
      '      <input type="range" id="mdCrossRange" min="5" max="100" step="5" value="100">',
      '      <span class="cad-dialog-val" id="mdCrossVal">100%</span>',
      '    </div>',
      '    <div class="cad-dialog-row">',
      '      <span class="cad-dialog-lb">拾取框</span>',
      '      <input type="range" id="mdPickRange" min="4" max="24" step="1" value="8">',
      '      <span class="cad-dialog-val" id="mdPickVal">8 px</span>',
      '    </div>',
      '    <div class="cad-dialog-row">',
      '      <span class="cad-dialog-lb">极轴增量</span>',
      '      <select id="mdPolarStep" class="cad-dialog-sel">',
      '        <option value="5">5°</option><option value="10">10°</option>',
      '        <option value="15" selected>15°</option><option value="22.5">22.5°</option>',
      '        <option value="30">30°</option><option value="45">45°</option><option value="90">90°</option>',
      '      </select>',
      '    </div>',
      '    <div class="cad-dialog-hint">绘图时自动吸附到对象的特征点；F3 可快速开关。光标 5%–100%，100% 为全屏十字。</div>',
      '    <div class="cad-dialog-foot">',
      '      <button type="button" class="cad-btn" data-dlg="osall">全部选择</button>',
      '      <button type="button" class="cad-btn" data-dlg="osnone">全部清除</button>',
      '      <button type="button" class="cad-btn primary" data-dlg="osok">确定</button>',
      '    </div>',
      '  </div>',
      '</div>',
      '<div class="cad-help" id="mdHelp" hidden>',
      '  <div class="cad-help-card">',
      '    <div class="cad-dialog-head"><b>CAD 绘图工作区 · 操作说明</b><button type="button" class="cad-x" data-help="close">×</button></div>',
      '    <div class="cad-help-cols">',
      '      <div><h4>绘图</h4><ul>',
      '        <li><kbd>L</kbd> 直线 · <kbd>PL</kbd> 多段线 · <kbd>REC</kbd> 矩形</li>',
      '        <li><kbd>C</kbd> 圆 · <kbd>A</kbd> 圆弧（起点→端点→弧上点）</li>',
      '        <li>单击起点 → 移动 → 单击终点</li>',
      '        <li>动态输入：直接键入长度，<kbd>Tab</kbd> 切角度，<kbd>Enter</kbd> 确认</li>',
      '        <li>窗口框选（左→右）全包含；交叉框选（右→左）碰选</li>',
      '        <li>输入命令时自动弹出候选：<kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Tab</kbd> 补全 · <kbd>Enter</kbd> 执行</li>',
      '      </ul></div>',
      '      <div><h4>修改与视图</h4><ul>',
      '        <li><kbd>M</kbd> 移动 · <kbd>CO</kbd> 复制 · <kbd>RO</kbd> 旋转</li>',
      '        <li><kbd>MI</kbd> 镜像 · <kbd>O</kbd> 偏移 · <kbd>AR</kbd> 阵列</li>',
      '        <li><kbd>E</kbd> 删除 · <kbd>X</kbd> 分解 · <kbd>DI</kbd> 距离</li>',
      '        <li><kbd>F3</kbd> 捕捉 · <kbd>F7</kbd> 栅格 · <kbd>F8</kbd> 正交</li>',
      '        <li><kbd>F10</kbd> 极轴 · <kbd>F12</kbd> 动态输入 · <kbd>F2</kbd> 历史</li>',
      '        <li><kbd>Esc</kbd> 取消 · <kbd>Delete</kbd> 删除 · <kbd>Ctrl+Z/Y</kbd> 撤销</li>',
      '        <li>滚轮缩放 · 中键拖动平移 · 双击中键或空白处缩放至范围</li>',
      '      </ul></div>',
      '      <div><h4>选择与捕捉</h4><ul>',
      '        <li>重叠对象处连续单击循环选择，光标旁提示“重叠 n 个”</li>',
      '        <li><kbd>Shift</kbd> 加选 · <kbd>Ctrl+A</kbd> 全选 · <kbd>SS</kbd> 选择同类（同类型+同图层）</li>',
      '        <li>状态栏“已选 n”单击取消选择；对象很多时可先选一个再按 <kbd>SS</kbd></li>',
      '        <li>捕捉标记随类型变化（端点方框 / 中点三角 / 圆心圆 / 象限菱形…）</li>',
      '        <li>极轴吸附默认 15°，可在【捕捉设置】改为 5 / 10 / 22.5 / 30 / 45 / 90°</li>',
      '        <li>【捕捉设置】可调十字光标大小与拾取框大小（4–24 px）</li>',
      '        <li>对象捕捉优先于正交 / 极轴，<kbd>Shift</kbd> 临时正交</li>',
      '      </ul></div>',
      '    </div>',
      '    <div class="cad-dialog-hint">命令行支持绝对坐标 100,50、相对坐标 @50,0、极坐标 @50&lt;30；<kbd>↑</kbd><kbd>↓</kbd> 只回溯输入过的命令。右键可重复上一条命令。</div>',
      '  </div>',
      '</div>',
      '<div class="cad-toast" id="mdToast" hidden></div>'
    ].join('');

    document.body.appendChild(app);

    els.app = app;
    els.zone = app.querySelector('#mdZone');
    els.svg = app.querySelector('#mdSvg');
    els.sheet = app.querySelector('#mdSheet');
    els.grid = app.querySelector('#mdGrid');
    els.world = app.querySelector('#mdWorld');
    els.viewG = app.querySelector('#mdView');
    els.defs = app.querySelector('#mdDefs');
    els.preview = app.querySelector('#mdPreview');
    els.overlay = app.querySelector('#mdOverlay');
    els.dyn = app.querySelector('#mdDyn');
    els.snapTag = app.querySelector('#mdSnapTag');
    els.cycleTag = app.querySelector('#mdCycleTag');
    els.dim = app.querySelector('#mdDim');
    els.side = app.querySelector('.cad-side');
    els.dwg = app.querySelector('.cad-dwg');
    els.split = app.querySelector('#mdSplit');
    els.palette = app.querySelector('#mdPalette');
    /* 默认最大化画布：功能区收起、右侧面板隐藏（顶部「功能区 / 面板」可随时打开） */
    var rib0 = app.querySelector('.cad-ribbon');
    if (rib0) rib0.hidden = true;
    if (els.side) els.side.hidden = true;
    if (els.palette) els.palette.classList.add('is-mini');
    els.selBar = app.querySelector('#mdSelBar');
    els.selBarCount = app.querySelector('#mdSelBarCount');
    els.aiPop = app.querySelector('#mdAiPop');
    els.aiInput = app.querySelector('#mdAiInput');
    els.aiReply = app.querySelector('#mdAiReply');
    els.empty = app.querySelector('#mdEmpty');
    els.coord = app.querySelector('#mdCoord');
    els.countTxt = app.querySelector('#mdCount2');
    els.count = app.querySelector('#mdCount');
    els.zoomTxt = app.querySelector('#mdZoomTxt');
    els.zoomBtn = app.querySelector('#mdZoomBtn');
    els.spaceTag = app.querySelector('#mdSpaceTag');
    els.props = app.querySelector('#mdProps');
    els.propsPane = app.querySelector('#mdPropsPane');
    els.list = app.querySelector('#mdList');
    els.layers = app.querySelector('#mdLayers');
    var layerFilter = app.querySelector('#mdLayerFilter');
    if (layerFilter) layerFilter.addEventListener('input', function () { renderLayers(); });
    els.sideTabs = app.querySelector('#mdSideTabs');
    els.cmdWrap = app.querySelector('#mdCmdWrap');
    els.cmdHist = app.querySelector('#mdCmdHist');
    els.cmdPrompt = app.querySelector('#mdCmdPrompt');
    els.cmdInput = app.querySelector('#mdCmdInput');
    els.suggest = app.querySelector('#mdCmdSuggest');
    els.selCount = app.querySelector('#mdSelCount');
    els.menuPop = app.querySelector('#mdMenuPop');
    els.ctx = app.querySelector('#mdCtx');
    els.osnapDlg = app.querySelector('#mdOsnapDlg');
    els.help = app.querySelector('#mdHelp');
    els.toast = app.querySelector('#mdToast');
    els.undoBtn = app.querySelector('#mdUndo');
    els.redoBtn = app.querySelector('#mdRedo');
    els.delBtn = app.querySelector('#mdDeleteBtn');
    els.curLayerSel = app.querySelector('#mdCurLayer');
    els.curLayerSel2 = app.querySelector('#mdCurLayer2');
    els.stGrid = app.querySelector('#mdStGrid');
    els.stOrtho = app.querySelector('#mdStOrtho');
    els.stPolar = app.querySelector('#mdStPolar');
    els.stOsnap = app.querySelector('#mdStOsnap');
    els.stDyn = app.querySelector('#mdStDyn');
    els.stLw = app.querySelector('#mdStLw');
    els.rGrid = app.querySelector('#mdRGrid');
    els.rOrtho = app.querySelector('#mdROrtho');
    els.rOsnap = app.querySelector('#mdROsnap');
    els.rDyn = app.querySelector('#mdRDyn');
    els.tabModel = app.querySelector('#mdTabModel');
    els.tabLayout = app.querySelector('#mdTabLayout');

    built = true;
    loadDraft();
    wire(app);
    renderLayers();
    renderList();
    renderProps();
    updateHistoryButtons();
    updateStatus();
    return app;
  }

  var spaceDown = false;

  function wire(app) {
    /* 菜单 */
    var menuBar = app.querySelector('#mdMenus');
    menuBar.addEventListener('click', function (ev) {
      var b = ev.target.closest('.cad-menu-btn');
      if (!b) return;
      ev.stopPropagation();
      var name = b.getAttribute('data-menu');
      if (menuOpen === name) { closeMenus(); return; }
      renderMenu(name);
    });
    Array.prototype.forEach.call(app.querySelectorAll('.cad-menu-btn'), function (b) {
      b.addEventListener('mouseenter', function () {
        if (menuOpen) renderMenu(b.getAttribute('data-menu'));
      });
    });
    document.addEventListener('click', function (ev) {
      if (!ev.target.closest) return;
      if (!ev.target.closest('#mdCmdWrap')) hideSuggest();
      if (ev.target.closest('.cad-menu-pop') || ev.target.closest('.cad-menu-btn')) return;
      closeMenus();
    });

    /* 功能区 / 空状态按钮 */
    app.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-act]');
      if (b) { runAction(b.getAttribute('data-act')); return; }
    });

    /* 顶部快捷按钮 */
    if (els.undoBtn) els.undoBtn.addEventListener('click', undo);
    if (els.redoBtn) els.redoBtn.addEventListener('click', redo);
    var qExp = app.querySelector('#mdExport');
    if (qExp) qExp.addEventListener('click', exportDXF);
    var qTo3d = app.querySelector('#mdTo3d');
    if (qTo3d) qTo3d.addEventListener('click', function () {
      if (window.Portal && window.Portal.enterModule) window.Portal.enterModule('view3d');
      else toast('3D 预览不可用');
    });
    var qToSketch = app.querySelector('#mdToSketch');
    if (qToSketch) qToSketch.addEventListener('click', function () {
      window.location.assign('/static/sketch/index.html');
    });
    var qHome = app.querySelector('#mdHome');
    if (qHome) qHome.addEventListener('click', function () {
      if (window.Portal && window.Portal.goHome) window.Portal.goHome();
      else hide();
    });

    /* 左侧工具条：只有选择/平移这类工具走 setTool，命令类按钮由全局 [data-act] 处理 */
    (function bindDiffPreview() {
      var pop = app.querySelector('#mdDiffPreview');
      var body = app.querySelector('#mdDiffPrevBody');
      var sum = app.querySelector('#mdDiffPrevSum');
      if (!pop || !body) return;
      function compute() {
        var oldE = {};
        if (state.snapshot) state.snapshot.entities.forEach(function (e) { oldE[e.id] = e; });
        var add = [], ch = [], rem = [];
        state.entities.forEach(function (e) {
          if (!oldE[e.id]) add.push(e);
          else if (JSON.stringify(e) !== JSON.stringify(oldE[e.id])) ch.push(e);
        });
        var cur = {};
        state.entities.forEach(function (e) { cur[e.id] = 1; });
        rem = Object.keys(oldE).filter(function (id) { return !cur[id]; });
        return { add: add, ch: ch, rem: rem };
      }
      window.__openDiffPreview = function () {
        var d = compute();
        if (sum) sum.textContent = '新增 ' + d.add.length + ' · 修改 ' + d.ch.length + ' · 删除 ' + d.rem.length;
        body.innerHTML = '';
        d.add.forEach(function (e) { body.innerHTML += '<div class="cad-block-row"><b>+ ' + e.kind + '</b><span>' + e.id + '</span></div>'; });
        d.ch.forEach(function (e) { body.innerHTML += '<div class="cad-block-row"><b>~ ' + e.kind + '</b><span>' + e.id + '</span></div>'; });
        d.rem.forEach(function (id) { body.innerHTML += '<div class="cad-block-row"><b>- 删除</b><span>' + id + '</span></div>'; });
        if (!d.add.length && !d.ch.length && !d.rem.length) body.innerHTML = '<div class="cad-prop-empty">没有差异</div>';
        pop.hidden = false;
      };
      var bt = app.querySelector('#mdDiffPrevTxt');
      if (bt) bt.addEventListener('click', function () { pop.hidden = true; runAction('diffreport'); });
      var bh = app.querySelector('#mdDiffPrevHtml');
      if (bh) bh.addEventListener('click', function () { pop.hidden = true; runAction('diffhtml'); });
    })();
    (function bindDimTplPanel() {
      var pop = app.querySelector('#mdDimTplPop');
      var list = app.querySelector('#mdDimTplList');
      if (!pop || !list) return;
      var TPLS = [
        { name: '机械', act: 'dimpresetMech', d: '字高3.5 / 箭头5 / 2位 / 空心' },
        { name: '建筑', act: 'dimpresetArch', d: '字高4.5 / 箭头7 / 整数 / 无箭头' },
        { name: '电气', act: 'dimpresetElec', d: '字高3 / 箭头4 / 1位 / 空心' },
        { name: '轴网', act: 'dimpresetAxis', d: '字高5 / 箭头6 / 整数 / 无箭头' }
      ];
      function render() {
        list.innerHTML = '';
        var cur = state.dimStyle || {};
        var curRow = document.createElement('div');
        curRow.className = 'cad-block-row';
        curRow.innerHTML = '<b>当前样式</b><span>字高' + cur.textSize + ' / 箭头' + cur.arrow + ' / ' + cur.precision + '位 / ' + (cur.arrowStyle || 'hollow') + '</span>';
        list.appendChild(curRow);
        (state.dimTpls || []).forEach(function (ct, ci) {
          var rowC = document.createElement('div');
          rowC.className = 'cad-block-row';
          rowC.innerHTML = '<b>' + ct.name + '</b><span>自定义 · 字高' + ct.style.textSize + '</span>' +
            '<button type="button" class="cad-btn" data-ctpl="apply" data-ci="' + ci + '">应用</button>' +
            '<button type="button" class="cad-btn" data-ctpl="del" data-ci="' + ci + '">删除</button>';
          list.appendChild(rowC);
        });
        TPLS.forEach(function (t) {
          var row = document.createElement('div');
          row.className = 'cad-block-row';
          row.innerHTML = '<b>' + t.name + '</b><span>' + t.d + '</span><button type="button" class="cad-btn" data-tpl="' + t.act + '">应用</button>';
          list.appendChild(row);
        });
      }
      window.__openDimTplPanel = function () { render(); pop.hidden = false; };
      list.addEventListener('click', function (ev) {
        var ct = ev.target.closest('[data-ctpl]');
        if (ct) {
          var ci2 = parseInt(ct.getAttribute('data-ci'), 10);
          if (ct.getAttribute('data-ctpl') === 'apply') {
            var stpl = (state.dimTpls || [])[ci2];
            if (stpl) { dimStyle = deepClone(stpl.style); state.dimStyle = dimStyle; syncDims(); msg('已应用模板「' + stpl.name + '」'); afterChange(); }
          } else {
            state.dimTpls.splice(ci2, 1);
            render(); scheduleSave();
          }
          pop.hidden = true;
          return;
        }
        var b = ev.target.closest('[data-tpl]');
        if (!b) return;
        runAction(b.getAttribute('data-tpl'));
        pop.hidden = true;
      });
    })();
    (function bindDiffPanel() {
      var pop = app.querySelector('#mdDiffPop');
      var list = app.querySelector('#mdDiffList');
      if (!pop || !list) return;
      function render() {
        list.innerHTML = '';
        var ids = Object.keys(state.diffIds || {});
        if (!ids.length) { list.innerHTML = '<div class="cad-prop-empty">没有差异，先对比快照</div>'; return; }
        ids.forEach(function (id) {
          var e = state.entities.find(function (x) { return x.id === id; });
          var row = document.createElement('div');
          row.className = 'cad-block-row';
          row.innerHTML = '<b>' + (e ? (KIND_NAME ? '' : '') : '') + id + '</b><span>' + (e ? (e.kind || '') : '已删除') + '</span>' +
            '<button type="button" class="cad-btn" data-diff="sel">选中</button>';
          row.setAttribute('data-id', id);
          list.appendChild(row);
        });
      }
      window.__openDiffPanel = function () { render(); pop.hidden = false; };
      list.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-diff]');
        if (!b) return;
        var id = b.closest('.cad-block-row').getAttribute('data-id');
        state.selection = new Set([id]);
        var e4 = state.entities.find(function (x) { return x.id === id; });
        if (e4) zoomToBounds(entityBounds(e4));
        afterChange();
      });
    })();
    (function bindLayerStatePanel() {
      var pop = app.querySelector('#mdLayerStatePop');
      var list = app.querySelector('#mdLayerStateList');
      if (!pop || !list) return;
      function render() {
        list.innerHTML = '';
        var arr = state.layerStates || [];
        if (!arr.length) { list.innerHTML = '<div class="cad-prop-empty">还没有图层状态，视图菜单保存</div>'; return; }
        arr.forEach(function (st2, i) {
          var row = document.createElement('div');
          row.className = 'cad-block-row';
          var diffs = 0;
          (st2.layers || []).forEach(function (L3) {
            var curL = state.layers.find(function (x) { return x.id === L3.id || x.name === L3.name; });
            if (!curL) { diffs++; return; }
            if (curL.color !== L3.color || curL.ltype !== L3.ltype || curL.visible !== L3.visible || curL.locked !== L3.locked) diffs++;
          });
          row.innerHTML = '<b>' + st2.name + '</b><span>' + (st2.layers || []).length + ' 图层 · 差异 ' + diffs + '</span>' +
            '<button type="button" class="cad-btn" data-ls="res">恢复</button>' +
            '<button type="button" class="cad-btn" data-ls="upd">更新</button>' +
            '<button type="button" class="cad-btn" data-ls="dif">差异</button>' +
            '<button type="button" class="cad-btn" data-ls="ren">改名</button>' +
            '<button type="button" class="cad-btn" data-ls="del">删除</button>';
          row.setAttribute('data-idx', String(i));
          list.appendChild(row);
        });
      }
      window.__openLayerStatePanel = function () { render(); pop.hidden = false; };
      list.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-ls]');
        if (!b) return;
        var idx = parseInt(b.closest('.cad-block-row').getAttribute('data-idx'), 10);
        if (b.getAttribute('data-ls') === 'res') {
          if (!state.layerStates[idx]) return;
          state.layerStates.push({ name: '自动_' + (state.layerStates.length + 1), layers: deepClone(state.layers) });
          state.layers = deepClone(state.layerStates[idx].layers);
          msg('已恢复图层状态「' + state.layerStates[idx].name + '」');
          pop.hidden = true;
          afterChange();
        } else if (b.getAttribute('data-ls') === 'upd') {
          state.layerStates[idx].layers = deepClone(state.layers);
          msg('已用当前图层更新「' + state.layerStates[idx].name + '」');
          render(); scheduleSave();
        } else if (b.getAttribute('data-ls') === 'dif') {
          var stD = state.layerStates[idx];
          var diffsD = [];
          (stD.layers || []).forEach(function (L4) {
            var curL2 = state.layers.find(function (x) { return x.id === L4.id || x.name === L4.name; });
            if (!curL2) { diffsD.push(L4.name + '（当前不存在）'); return; }
            var parts = [];
            if (curL2.color !== L4.color) parts.push('颜色');
            if (curL2.ltype !== L4.ltype) parts.push('线型');
            if (curL2.visible !== L4.visible) parts.push('显隐');
            if (curL2.locked !== L4.locked) parts.push('锁定');
            if (parts.length) diffsD.push(L4.name + '（' + parts.join('/') + '）');
          });
          msg(diffsD.length ? ('差异：' + diffsD.join('；')) : '当前图层与状态一致');
        } else if (b.getAttribute('data-ls') === 'ren') {
          var nnL = window.prompt('状态名称', state.layerStates[idx].name);
          if (nnL) { state.layerStates[idx].name = nnL; render(); scheduleSave(); }
        } else {
          state.layerStates.splice(idx, 1);
          render(); scheduleSave();
        }
      });
    })();
    (function bindRevPanel() {
      var pop = app.querySelector('#mdRevPop');
      var list = app.querySelector('#mdRevList');
      if (!pop || !list) return;
      function render() {
        list.innerHTML = '';
        var snaps = state.snaps || [];
        if (!snaps.length) { list.innerHTML = '<div class="cad-prop-empty">还没有修订记录，帮助菜单保存快照</div>'; return; }
        snaps.forEach(function (sp, i) {
          var d = new Date(sp.at || Date.now());
          var tstr = d.getMonth() + 1 + '-' + d.getDate() + ' ' + d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
          var row = document.createElement('div');
          row.className = 'cad-block-row';
          row.innerHTML = '<b>#' + (i + 1) + ' ' + (sp.note || '快照') + '</b><span>' + tstr + ' · ' + (sp.entities || []).length + ' 图元</span>' +
            '<button type="button" class="cad-btn" data-rev="res">恢复</button>' +
            '<button type="button" class="cad-btn" data-rev="del">删除</button>';
          row.setAttribute('data-idx', String(i));
          list.appendChild(row);
        });
      }
      window.__openRevPanel = function () { render(); pop.hidden = false; };
      list.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-rev]');
        if (!b) return;
        var row = b.closest('.cad-block-row');
        var idx = parseInt(row.getAttribute('data-idx'), 10);
        if (b.getAttribute('data-rev') === 'res') {
          if (!state.snaps[idx]) return;
          var before = snapshot();
          state.entities = deepClone(state.snaps[idx].entities || []);
          pushUndo(before, '恢复修订');
          msg('已恢复到快照 #' + (idx + 1));
          pop.hidden = true;
          afterChange();
        } else {
          state.snaps.splice(idx, 1);
          render();
          scheduleSave();
        }
      });
    })();
    (function bindBlockPanel() {
      var pop = app.querySelector('#mdBlockPop');
      var list = app.querySelector('#mdBlockList');
      if (!pop || !list) return;
      function render() {
        list.innerHTML = '';
        var q = (document.getElementById('mdBlockSearch') || {}).value || '';
        var names = Object.keys(state.blocks || {}).filter(function (n) { return !q || n.toLowerCase().indexOf(q.toLowerCase()) >= 0; }).sort();
        if (!names.length) { list.innerHTML = '<div class="cad-prop-empty">还没有块，用 B 定义块</div>'; return; }
        names.forEach(function (nm) {
          var row = document.createElement('div');
          row.className = 'cad-block-row';
          row.innerHTML = '<b>' + nm + '</b><span>' + (state.blocks[nm].entities || []).length + ' 图元</span>' +
            '<button type="button" class="cad-btn" data-blk="ins">插入</button>' +
            '<button type="button" class="cad-btn" data-blk="ren">重命名</button>' +
            '<button type="button" class="cad-btn" data-blk="del">删除</button>';
          row.setAttribute('data-name', nm);
          list.appendChild(row);
        });
      }
      window.__openBlockPanel = function () { render(); pop.hidden = false; };
      var bs = document.getElementById('mdBlockSearch');
      if (bs) bs.addEventListener('input', function () { render(); });
      list.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-blk]');
        if (!b) return;
        var row = b.closest('.cad-block-row');
        var nm = row.getAttribute('data-name');
        var act2 = b.getAttribute('data-blk');
        if (act2 === 'ins') {
          state.lastBlock = nm;
          pop.hidden = true;
          msg('已选中块「' + nm + '」，输入 I 后回车插入');
        } else if (act2 === 'ren') {
          var nn = window.prompt('块名', nm);
          if (nn && nn !== nm && !state.blocks[nn]) {
            state.blocks[nn] = state.blocks[nm];
            delete state.blocks[nm];
            state.entities.forEach(function (x) { if (x.kind === 'insert' && x.name === nm) x.name = nn; });
            if (state.lastBlock === nm) state.lastBlock = nn;
            render(); afterChange();
          }
        } else if (act2 === 'del') {
          delete state.blocks[nm];
          state.entities = state.entities.filter(function (x) { return !(x.kind === 'insert' && x.name === nm); });
          render(); afterChange();
          msg('已删除块「' + nm + '」及其引用');
        }
      });
    })();
    (function bindPrintPanel() {
      var pop = app.querySelector('#mdPrintPop');
      var rows = app.querySelector('#mdPrintRows');
      if (!pop || !rows) return;
      function addRow(color, width) {
        var row = document.createElement('div');
        row.className = 'cad-print-row';
        row.innerHTML = '<input type="color" class="pcolor" value="' + (color || '#ffffff') + '">' +
          '<input type="number" class="pwidth" step="0.05" min="0.05" max="3" value="' + (width || 0.25) + '">';
        rows.appendChild(row);
      }
      function openPanel() {
        rows.innerHTML = '';
        var mp = state.printMap || {};
        var keys = Object.keys(mp);
        if (!keys.length) { addRow('#ffffff', 0.25); addRow('#ff0000', 0.5); }
        else keys.forEach(function (c) { addRow(c, mp[c]); });
        pop.hidden = false;
      }
      window.__openPrintPanel = openPanel;
      var addBtn = app.querySelector('#mdPrintAdd');
      if (addBtn) addBtn.addEventListener('click', function () { addRow('#00ff00', 0.25); });
      var saveBtn = app.querySelector('#mdPrintSave');
      if (saveBtn) saveBtn.addEventListener('click', function () {
        var mp = {};
        Array.prototype.forEach.call(rows.querySelectorAll('.cad-print-row'), function (r) {
          var c = r.querySelector('.pcolor').value.toLowerCase();
          var w = parseFloat(r.querySelector('.pwidth').value);
          if (c && isFinite(w) && w > 0) mp[c] = w;
        });
        state.printMap = mp;
        pop.hidden = true;
        msg('打印样式表已应用：' + Object.keys(mp).length + ' 条');
        redrawAll();
        scheduleSave();
      });
    })();
    var pal = app.querySelector('#mdPalette');
    if (pal) pal.addEventListener('click', function (ev) {
      var t = ev.target.closest('button[data-tool]');
      if (t) setTool(t.getAttribute('data-tool'));
    });

    /* AI 指令：一句话生成 / 修改图形 */
    var aiBtn = app.querySelector('#mdAiBtn');
    function openAi(force) {
      if (!els.aiPop) return;
      var show = typeof force === 'boolean' ? force : els.aiPop.hidden;
      els.aiPop.hidden = !show;
      if (show && els.aiInput) setTimeout(function () { els.aiInput.focus(); }, 30);
    }
    function runAi(text) {
      var t = (typeof text === 'string' ? text : (els.aiInput ? els.aiInput.value : '')).trim();
      if (!t) { aiReplyText('写一句话，例如：画一条长120的线'); return; }
      aiApply(t);
      if (els.aiInput) els.aiInput.value = '';
    }
    if (aiBtn) aiBtn.addEventListener('click', function () { openAi(); });
    var aiClose = app.querySelector('#mdAiClose');
    if (aiClose) aiClose.addEventListener('click', function () { openAi(false); });
    var aiRunBtn = app.querySelector('#mdAiRun');
    if (aiRunBtn) aiRunBtn.addEventListener('click', function () { runAi(); });
    if (els.aiInput) els.aiInput.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); runAi(); }
    });
    var aiChips = app.querySelector('.ai-pop-chips');
    if (aiChips) aiChips.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-ai]');
      if (b) runAi(b.getAttribute('data-ai'));
    });

    /* 画布大小：预设 / 自定义宽高（按可用区域百分比） */
    function applyCanvas(w, h) {
      if (!els.dwg) return;
      var body = els.dwg.parentNode;
      w = clamp(Math.round(w || 100), 40, 100);
      h = clamp(Math.round(h || 100), 40, 100);
      if (w >= 100 && h >= 100) {
        els.dwg.style.flex = '';
        els.dwg.style.height = '';
        body.classList.remove('is-sized');
      } else {
        body.classList.add('is-sized');
        els.dwg.style.flex = '0 0 ' + w + '%';
        els.dwg.style.height = h + '%';
      }
      var rw = document.getElementById('mdCanvasW');
      var rh = document.getElementById('mdCanvasH');
      if (rw) rw.value = String(w);
      if (rh) rh.value = String(h);
      var wv = document.getElementById('mdCanvasWV');
      var hv = document.getElementById('mdCanvasHV');
      if (wv) wv.textContent = w + '%';
      if (hv) hv.textContent = h + '%';
      try { localStorage.setItem('cad.canvas', JSON.stringify({ w: w, h: h })); } catch (e) {}
      refreshViewport();
    }
    var pop = app.querySelector('#mdCanvasPop');
    var canvasBtn = app.querySelector('#mdCanvasBtn');
    function toggleCanvasPop(force) {
      if (!pop) return;
      var show = typeof force === 'boolean' ? force : pop.hidden;
      pop.hidden = !show;
    }
    if (canvasBtn) canvasBtn.addEventListener('click', function () { toggleCanvasPop(); });
    var canvasClose = app.querySelector('#mdCanvasClose');
    if (canvasClose) canvasClose.addEventListener('click', function () { toggleCanvasPop(false); });
    if (pop) {
      pop.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-canvas]');
        if (!b) return;
        var pair = b.getAttribute('data-canvas').split(',');
        applyCanvas(parseFloat(pair[0]), parseFloat(pair[1]));
      });
      var rw2 = app.querySelector('#mdCanvasW');
      var rh2 = app.querySelector('#mdCanvasH');
      function custom() {
        applyCanvas(parseFloat(rw2 && rw2.value) || 100, parseFloat(rh2 && rh2.value) || 100);
      }
      if (rw2) rw2.addEventListener('input', custom);
      if (rh2) rh2.addEventListener('input', custom);
    }
    try {
      var saved = JSON.parse(localStorage.getItem('cad.canvas') || 'null');
      if (saved && saved.w && saved.h) {
        var w0 = parseFloat(saved.w), h0 = parseFloat(saved.h);
        if (w0 < 100 || h0 < 100) setTimeout(function () { applyCanvas(w0, h0); }, 0);
      } else {
        var rw0 = app.querySelector('#mdCanvasW'), rh0 = app.querySelector('#mdCanvasH');
        if (rw0) rw0.value = '100';
        if (rh0) rh0.value = '100';
      }
    } catch (e) {}

    /* 分隔条：拖动调右侧面板宽度（从而改变画布宽度） */
    if (els.split) {
      var splitDrag = null;
      els.split.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        splitDrag = { x: ev.clientX, w: els.side ? els.side.getBoundingClientRect().width : 296 };
        document.body.style.cursor = 'col-resize';
      });
      window.addEventListener('mousemove', function (ev) {
        if (!splitDrag) return;
        var dw = splitDrag.x - ev.clientX;
        var w = clamp(splitDrag.w + dw, 180, Math.min(560, zoneSize().w - 260));
        if (els.side) els.side.style.flex = '0 0 ' + Math.round(w) + 'px';
        if (els.side) els.side.style.width = Math.round(w) + 'px';
      });
      window.addEventListener('mouseup', function () {
        if (!splitDrag) return;
        splitDrag = null;
        document.body.style.cursor = '';
        if (els.side) {
          try { localStorage.setItem('cad.sideW', String(Math.round(els.side.getBoundingClientRect().width))); } catch (e) {}
        }
        refreshViewport();
      });
      try {
        var sw = parseFloat(localStorage.getItem('cad.sideW') || '0');
        if (sw > 0) { els.side.style.flex = '0 0 ' + Math.round(sw) + 'px'; els.side.style.width = Math.round(sw) + 'px'; }
      } catch (e) {}
    }

    /* 颜色：当前颜色 + 应用到选中 */
    var COLOR_PALETTE = [
      '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ffffff', '#9aa7b8',
      '#c0c0c0', '#800000', '#808000', '#008000', '#008080', '#000080', '#800080', '#111418'
    ];
    function syncColorDot() {
      var dots = app.querySelectorAll('.cad-color-dot');
      if (!dots.length) return;
      Array.prototype.forEach.call(dots, function (dot) {
      var c = state.curColor || layerById(state.curLayer).color;
        dot.style.background = c;
        dot.classList.toggle('is-bylayer', !state.curColor);
        dot.title = state.curColor ? state.curColor : 'ByLayer（跟随图层）';
      });
    }
    function paintGrid() {
      var grid = app.querySelector('#mdColorGrid');
      if (!grid) return;
      var html = '<button type="button" class="cad-color-cell is-bylayer' + (state.curColor ? '' : ' is-on') +
        '" data-color="bylayer" title="ByLayer">BL</button>';
      html += COLOR_PALETTE.map(function (c) {
        return '<button type="button" class="cad-color-cell' + (state.curColor === c ? ' is-on' : '') +
          '" data-color="' + c + '" style="background:' + c + '" title="' + c + '"></button>';
      }).join('');
      grid.innerHTML = html;
    }
    function openColorPop(force) {
      var pop = app.querySelector('#mdColorPop');
      if (!pop) return;
      var show = typeof force === 'boolean' ? force : pop.hidden;
      pop.hidden = !show;
      if (!show) return;
      paintGrid();
      var anchor = app.querySelector('#mdColorBtnQ') || app.querySelector('#mdColorBtn');
      if (anchor) {
        var r = anchor.getBoundingClientRect();
        var left = Math.max(8, Math.min(window.innerWidth - 306, r.left));
        var top = Math.min(window.innerHeight - 260, r.bottom + 6);
        pop.style.left = Math.round(left) + 'px';
        pop.style.top = Math.round(Math.max(8, top)) + 'px';
      }
    }
    var colorBtnQ = app.querySelector('#mdColorBtnQ');
    if (colorBtnQ) colorBtnQ.addEventListener('click', function () { openColorPop(); });
    var colorBtn = app.querySelector('#mdColorBtn');
    if (colorBtn) colorBtn.addEventListener('click', function () { openColorPop(); });
    var colorClose = app.querySelector('#mdColorClose');
    if (colorClose) colorClose.addEventListener('click', function () { openColorPop(false); });
    var colorGrid = app.querySelector('#mdColorGrid');
    if (colorGrid) colorGrid.addEventListener('click', function (ev) {
      var cell = ev.target.closest('[data-color]');
      if (!cell) return;
      var v = cell.getAttribute('data-color');
      state.curColor = v === 'bylayer' ? null : v;
      syncColorDot();
      paintGrid();
      msg(state.curColor ? ('当前颜色 ' + state.curColor) : '当前颜色：ByLayer（跟随图层）');
    });
    var colorCustom = app.querySelector('#mdColorCustom');
    if (colorCustom) colorCustom.addEventListener('input', function () {
      state.curColor = colorCustom.value;
      syncColorDot();
      paintGrid();
    });
    function applyColorToSel(val) {
      var list = editableSelection();
      if (!list.length) { msg('先选中对象，再点「应用到选中」'); return; }
      var before = snapshot();
      list.forEach(function (e) {
        if (val) e.color = val;
        else delete e.color;
      });
      pushUndo(before, '改颜色');
      afterChange();
      msg('已改 ' + list.length + ' 个对象的颜色：' + (val || 'ByLayer'));
      scheduleSave();
    }
    var applySel = app.querySelector('#mdColorApplySel');
    if (applySel) applySel.addEventListener('click', function () { applyColorToSel(state.curColor); });
    var resetSel = app.querySelector('#mdColorResetSel');
    if (resetSel) resetSel.addEventListener('click', function () { applyColorToSel(null); });
    syncColorDot();

    /* 背景：白色浅色 / 深色 */
    function syncBgDot() {
      var dot = app.querySelector('#mdBgDot');
      if (dot) dot.classList.toggle('is-light', state.bg === 'light');
      var btn = app.querySelector('#mdBgBtn');
      if (btn) btn.title = state.bg === 'light' ? '当前：白色浅色背景（点击切回深色）' : '当前：深色背景（点击切到白色浅色）';
    }
    function setBg(bg, silent) {
      state.bg = bg === 'light' ? 'light' : 'dark';
      app.classList.toggle('is-light', state.bg === 'light');
      document.body.classList.toggle('cad-light', state.bg === 'light');
      syncBgDot();
      gridSig = '';
      drawGrid(true);
      redrawAll();
      try { localStorage.setItem('cad.bg', state.bg); } catch (e) {}
      if (!silent) {
        msg(state.bg === 'light' ? '背景：白色浅色（近白线自动显示为深灰）' : '背景：深色');
        scheduleSave();
      }
    }
    var bgBtn = app.querySelector('#mdBgBtn');
    if (bgBtn) bgBtn.addEventListener('click', function () {
      setBg(state.bg === 'light' ? 'dark' : 'light');
    });
    try {
      var bgSaved = localStorage.getItem('cad.bg');
      /* 默认浅色；只有用户显式切过深色才恢复深色 */
      if (bgSaved === 'dark') setTimeout(function () { setBg('dark', true); }, 0);
      else app.classList.add('is-light');
    } catch (e) { app.classList.add('is-light'); }
    syncBgDot();

    /* 功能区收起 / 展开 */
    var ribToggle = app.querySelector('#mdRibbonToggle');
    if (ribToggle) ribToggle.addEventListener('click', function () {
      var rib = app.querySelector('.cad-ribbon');
      if (!rib) return;
      rib.hidden = !rib.hidden;
      ribToggle.classList.toggle('is-on', !rib.hidden);
      refreshViewport();
    });

    /* 右侧面板 / 工具条形态 / 专注画布 */
    function refreshViewport() {
      drawGrid(true);
      redrawAll();
      updateStatus();
    }
    var sideToggle = app.querySelector('#mdSideToggle');
    if (sideToggle) sideToggle.addEventListener('click', function () {
      if (!els.side) return;
      els.side.hidden = !els.side.hidden;
      if (els.split) els.split.hidden = els.side.hidden;
      sideToggle.classList.toggle('is-on', !els.side.hidden);
      refreshViewport();
    });
    /* 工具选项板：拖标题栏浮动；双击标题栏停靠/浮动；拖回左侧自动停靠 */
    (function () {
      var pal = els.palette;
      var head = pal ? pal.querySelector('.pal-head') : null;
      if (!pal || !head) return;
      var pd = null;
      head.addEventListener('mousedown', function (ev) {
        if (ev.target.closest('button')) return;
        ev.preventDefault();
        var r = pal.getBoundingClientRect();
        pd = { dx: ev.clientX - r.left, dy: ev.clientY - r.top, moved: false };
      });
      window.addEventListener('mousemove', function (ev) {
        if (!pd) return;
        pd.moved = true;
        pal.classList.add('is-floating');
        pal.style.left = Math.max(0, ev.clientX - pd.dx) + 'px';
        pal.style.top = Math.max(0, ev.clientY - pd.dy) + 'px';
      });
      window.addEventListener('mouseup', function () {
        if (!pd) return;
        var wasMoved = pd.moved;
        pd = null;
        if (!wasMoved) return;
        var r = pal.getBoundingClientRect();
        if (r.left < 150) dockPalette();
        refreshViewport();
      });
      head.addEventListener('dblclick', function () {
        if (pal.classList.contains('is-floating')) dockPalette();
        else floatPalette();
      });
      function dockPalette() {
        pal.classList.remove('is-floating');
        pal.style.left = '';
        pal.style.top = '';
      }
      function floatPalette() {
        var r = pal.getBoundingClientRect();
        pal.classList.add('is-floating');
        pal.style.left = Math.max(24, r.left + 60) + 'px';
        pal.style.top = Math.max(60, r.top + 40) + 'px';
      }
    })();
    var pinBtn = app.querySelector('#mdPalettePin');
    if (pinBtn && els.palette) pinBtn.addEventListener('click', function () {
      var mini = els.palette.classList.toggle('is-mini');
      pinBtn.classList.toggle('is-on', !mini);
    });
    var sideFloat = app.querySelector('#mdSideFloat');
    if (sideFloat && els.side) sideFloat.addEventListener('click', function () {
      var floating = els.side.classList.toggle('is-floating');
      els.side.style.width = floating ? '296px' : '';
      if (floating) { els.side.style.left = 'calc(50% - 148px)'; els.side.style.top = '90px'; }
      else { els.side.style.left = ''; els.side.style.top = ''; }
      refreshViewport();
    });
    var sideCollapse = app.querySelector('#mdSideCollapse');
    if (sideCollapse) sideCollapse.addEventListener('click', function () {
      if (els.side) { els.side.hidden = true; if (els.split) els.split.hidden = true; }
      refreshViewport();
    });
    var vFit = app.querySelector('#mdViewFit');
    if (vFit) vFit.addEventListener('click', function () { fit(); });
    var v100 = app.querySelector('#mdView100');
    if (v100) v100.addEventListener('click', function () { runAction('zoom1'); });
    var vReset = app.querySelector('#mdViewReset');
    if (vReset) vReset.addEventListener('click', function () { resetView(); redrawAll(); updateStatus(); });
    var palToggle = app.querySelector('#mdPaletteToggle');
    if (palToggle && els.palette) palToggle.addEventListener('click', function () {
      var mini = els.palette.classList.toggle('is-mini');
      palToggle.classList.toggle('is-on', !mini);
    });
    var focusToggle = app.querySelector('#mdFocusToggle');
    if (focusToggle) focusToggle.addEventListener('click', function () {
      var on = document.getElementById('cadApp').classList.toggle('is-focus');
      focusToggle.classList.toggle('is-on', on);
      refreshViewport();
    });

    /* 侧栏标签 */
    els.sideTabs.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-side]');
      if (b) setSideTab(b.getAttribute('data-side'));
    });

    /* 对象列表 */
    els.list.addEventListener('click', function (ev) {
      var row = ev.target.closest('.cad-row');
      if (!row) return;
      var id = row.getAttribute('data-id');
      if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
        if (state.selection.has(id)) state.selection.delete(id);
        else state.selection.add(id);
      } else {
        state.selection = new Set([id]);
      }
      redrawLive(); renderProps(); renderList(); updateHistoryButtons(); setCursor();
    });
    els.list.addEventListener('dblclick', function (ev) {
      var row = ev.target.closest('.cad-row');
      if (!row) return;
      var id = row.getAttribute('data-id');
      var e = state.entities.filter(function (it) { return it.id === id; })[0];
      if (!e) return;
      state.selection = new Set([id]);
      zoomWindow(entityBounds(e));
      redrawLive(); renderProps(); renderList(); updateHistoryButtons();
    });

    /* 特性面板 */
    els.props.addEventListener('change', function (ev) {
      if (ev.target.matches && ev.target.matches('[data-bmeta]')) {
        var bk2 = ev.target.getAttribute('data-bmeta');
        var bv2 = ev.target.value;
        selectedEntities().forEach(function (e3) {
          if (bk2 === 'layer') e3.layer = bv2;
          else if (bk2 === 'color') e3.color = bv2;
          else if (bk2 === 'ltype') e3.ltype = bv2 || null;
        });
        afterChange();
        return;
      }
      if (ev.target.matches && ev.target.matches('[data-batch]')) {
        var fld = ev.target.getAttribute('data-batch');
        var val = parseFloat(ev.target.value);
        if (isFinite(val)) {
          selectedEntities().forEach(function (e2) { if (e2[fld] !== undefined) e2[fld] = val; });
          syncDims();
          afterChange();
        }
        return;
      }
      var t = ev.target;
      if (t.matches('select[data-p="layer"]')) {
        var e = selectedEntities()[0];
        if (!e) return;
        var before = snapshot();
        e.layer = t.value;
        pushUndo(before, '修改图层');
        afterChange();
        msg('对象已移至图层「' + layerName(t.value) + '」');
        return;
      }
      if (t.matches('input[data-p="closed"]')) {
        var e2 = selectedEntities()[0];
        if (!e2) return;
        var before2 = snapshot();
        e2.closed = t.checked;
        pushUndo(before2, '修改多段线');
        afterChange();
        return;
      }
      if (t.matches('input[data-f]')) {
        var e3 = selectedEntities()[0];
        if (!e3) return;
        var f = t.getAttribute('data-f');
        var v = parseFloat(t.value);
        if (!isFinite(v)) { renderProps(); return; }
        var before3 = snapshot();
        if (f === 'a0d') e3.a0 = rad(v);
        else if (f === 'a1d') e3.a1 = rad(v);
        else {
          if (f === 'r' && v < 0.05) v = 0.05;
          e3[f] = v;
        }
        pushUndo(before3, '修改特性');
        afterChange();
        return;
      }
    });
    els.props.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') { ev.preventDefault(); ev.target.blur(); }
    });
    els.props.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-act="flip"]');
      if (!b) return;
      var e = selectedEntities()[0];
      if (!e || e.kind !== 'arc') return;
      var before = snapshot();
      var t = e.a0; e.a0 = e.a1; e.a1 = t; e.dir = -e.dir;
      pushUndo(before, '圆弧反向');
      afterChange();
      msg('圆弧已反向');
    });

    /* 图层 */
    els.layers.addEventListener('click', function (ev) {
      var act = ev.target.closest('[data-act]');
      if (act) {
        var row = act.closest('.cad-layer');
        if (act.getAttribute('data-act') === 'add') { addLayer(); return; }
        if (act.getAttribute('data-act') === 'setcur') {
          var cur = state.entities.filter(function (e) { return state.selection.has(e.id); })[0];
          if (cur) { /* 无选中时保持 */ }
          msg('当前图层：' + layerById(state.curLayer).name);
          return;
        }
        if (!row) return;
        var L = layerById(row.getAttribute('data-layer'));
        if (act.getAttribute('data-act') === 'vis') {
          L.visible = !L.visible;
          if (!L.visible) {
            state.entities.forEach(function (e) { if (e.layer === L.id) state.selection.delete(e.id); });
          }
          msg('图层「' + L.name + '」' + (L.visible ? '显示' : '隐藏'));
          redrawLive(); renderLayers(); scheduleSave();
          return;
        }
        if (act.getAttribute('data-act') === 'ltype') {
          var order = ['continuous', 'dashed', 'dashdot'];
          L.ltype = order[(order.indexOf(L.ltype) + 1) % order.length];
          msg('图层「' + L.name + '」线型：' + LTYPES[L.ltype].name);
          renderLayers(); redrawLive(); scheduleSave();
          return;
        }
        if (act.getAttribute('data-act') === 'lock') {
          L.locked = !L.locked;
          msg('图层「' + L.name + '」' + (L.locked ? '已锁定' : '已解锁'));
          renderLayers(); redrawLive(); scheduleSave();
          return;
        }
        return;
      }
      var row2 = ev.target.closest('.cad-layer');
      if (row2) {
        var L2 = layerById(row2.getAttribute('data-layer'));
        state.curLayer = L2.id;
        renderLayers();
        renderProps();
        updateStatus();
        scheduleSave();
        msg('当前图层：' + L2.name);
      }
    });
    els.layers.addEventListener('change', function (ev) {
      if (!ev.target.matches('input[type="color"]')) return;
      var row = ev.target.closest('.cad-layer');
      if (!row) return;
      var L = layerById(row.getAttribute('data-layer'));
      L.color = ev.target.value;
      redrawLive(); renderLayers(); scheduleSave();
      msg('图层「' + L.name + '」颜色已更新');
    });
    els.layers.addEventListener('dblclick', function (ev) {
      var row = ev.target.closest('.cad-layer');
      if (!row) return;
      var L = layerById(row.getAttribute('data-layer'));
      if (L.id === '0') { msg('默认图层 0 不能重命名'); return; }
      var name = window.prompt('图层名称', L.name);
      if (!name) return;
      name = name.trim().slice(0, 24);
      if (!name) return;
      L.name = name;
      renderLayers(); renderProps(); redrawLive(); scheduleSave();
    });

    /* 状态栏 / 功能区开关 */
    function bindToggle(el, fn) {
      if (!el) return;
      el.addEventListener('click', function (ev) { ev.stopPropagation(); fn(); });
    }
    bindToggle(els.stGrid, toggleGrid);
    bindToggle(els.stOrtho, toggleOrtho);
    bindToggle(els.stPolar, togglePolar);
    bindToggle(els.stDyn, toggleDyn);
    bindToggle(els.stLw, toggleLw);
    if (els.stOsnap) els.stOsnap.addEventListener('click', function () { toggleSnap(); });
    if (els.rOsnap) els.rOsnap.addEventListener('click', function () { openOsnap(); });
    if (els.selCount) els.selCount.addEventListener('click', function () {
      state.selection.clear();
      redrawLive(); renderProps(); renderList(); updateHistoryButtons(); setCursor();
    });

    function bindLayerSel(sel) {
      if (!sel) return;
      sel.addEventListener('change', function () {
        state.curLayer = sel.value;
        renderLayers();
        updateStatus();
        msg('当前图层：' + layerById(sel.value).name);
        scheduleSave();
      });
    }
    bindLayerSel(els.curLayerSel);
    bindLayerSel(els.curLayerSel2);

    /* 空间页签 */
    els.tabModel.addEventListener('click', function () { setSpace('model'); });
    var addLayoutBtn = document.getElementById('mdTabAddLayout');
    if (addLayoutBtn) addLayoutBtn.addEventListener('click', function () {
      var n = state.layouts.length + 1;
      state.layouts.push({ name: '布局' + n, sheet: { title: '图纸' + n, code: 'A3-00' + n, scale: '1 : 1', designer: '—', unit: 'mm' } });
      state.curLayout = state.layouts.length - 1;
      state.sheet = state.layouts[state.curLayout].sheet;
      renderLayoutTabs();
      setSpace('layout');
      scheduleSave();
      msg('已新建「' + state.layouts[state.curLayout].name + '」');
    });
    renderLayoutTabs();

    /* 命令行 */
    els.cmdInput.addEventListener('keydown', cmdInputKey);
    els.cmdInput.addEventListener('input', updateCmdSuggest);
    els.cmdInput.addEventListener('blur', function () { setTimeout(hideSuggest, 80); });
    els.suggest.addEventListener('mousedown', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-sug]') : null;
      if (!b) return;
      ev.preventDefault();
      var it = sugList[parseInt(b.getAttribute('data-sug'), 10)];
      if (!it) return;
      hideSuggest();
      els.cmdInput.value = '';
      els.cmdInput.focus();
      runCmdLine(it.alias);
    });
    els.cmdWrap.addEventListener('mousedown', function (ev) {
      if (ev.target.closest('#mdCmdExpand')) return;
      if (ev.target === els.cmdInput) return;
      setTimeout(focusCmd, 0);
    });
    app.querySelector('#mdCmdExpand').addEventListener('click', function (ev) {
      ev.stopPropagation();
      toggleCmdHeight();
    });

    /* 缩放控件 */
    app.querySelector('#mdZoomIn').addEventListener('click', function () { zoomStep(1.25); });
    app.querySelector('#mdZoomOut').addEventListener('click', function () { zoomStep(0.8); });
    els.zoomBtn.addEventListener('click', function () {
      var s = zoneSize();
      var c = s2w(s.w / 2, s.h / 2);
      state.view.zoom = 1;
      state.view.tx = s.w / 2 - c.x;
      state.view.ty = s.h / 2 - c.y;
      redrawAll();
    });
    app.querySelector('#mdFit').addEventListener('click', function () {
      if (state.space === 'layout') fitLayout(); else fit();
    });

    /* 画布 */
    els.svg.addEventListener('mousedown', onDown);
    els.svg.addEventListener('wheel', onWheel, { passive: false });
    els.svg.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    window.addEventListener('keydown', function (ev) {
      var tagT = (ev.target && ev.target.tagName || '').toLowerCase();
      if (ev.key === 'Enter' && !state.cmd && state.selection.size && tagT !== 'input' && tagT !== 'textarea') {
        var tsel2 = selectedEntities().filter(function (x) { return x.kind === 'text'; });
        if (tsel2.length) {
          ev.preventDefault();
          var nv2 = window.prompt('编辑文字（' + tsel2.length + ' 处）', tsel2[0].text || '');
          if (nv2 !== null) { tsel2.forEach(function (t) { t.text = nv2; }); afterChange(); }
          return;
        }
      }
      if (ev.code === 'Space' && !state.cmd && state.selection.size) {
        ev.preventDefault();
        showContext(lastScreen.x, lastScreen.y);
      }
    });
    els.svg.addEventListener('dblclick', function (ev) {
      if (state.space !== 'model') return;
      /* 双击对象：选中并跳到特性页签（顺手改参数）；双击空白：缩放至范围 */
      var s = clientToScreen(ev);
      var w = s2w(s.x, s.y);
      var hit = hitTest(w.x, w.y);
      if (hit) {
        state.selection = new Set([hit.id]);
        setSideTab('props');
        if (hit.kind === 'text') {
          var nvT = window.prompt('编辑文字', hit.text || '');
          if (nvT !== null) { hit.text = nvT; afterChange(); }
          return;
        }
        afterChange();
        return;
      }
      fit();
    });
    els.svg.addEventListener('mouseenter', function () { state.pointer.inside = true; });
    els.svg.addEventListener('mouseleave', function () {
      state.pointer.inside = false;
      updateDim(); updateSnapTag();
      if (els.cycleTag) els.cycleTag.hidden = true;
      drawOverlay();
    });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', function () { shiftDown = false; spaceDown = false; setCursor(); });
    window.addEventListener('beforeunload', saveNow);

    /* 对话框 */
    els.osnapDlg.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t === els.osnapDlg) { els.osnapDlg.hidden = true; return; }
      var act = t.getAttribute('data-dlg');
      if (act === 'close') { els.osnapDlg.hidden = true; return; }
      if (act === 'osall' || act === 'osnone') {
        var on = act === 'osall';
        Array.prototype.forEach.call(els.osnapDlg.querySelectorAll('input[data-os]'), function (inp) { inp.checked = on; });
        applyOsnap();
        return;
      }
      if (act === 'osok') { applyOsnap(); els.osnapDlg.hidden = true; }
    });

    /* 光标 / 拾取框 / 极轴增量实时预览 */
    var onDlgField = function (ev) {
      var t = ev.target;
      if (!t) return;
      if (t.id === 'mdCrossRange') {
        state.crossPct = clamp(parseFloat(t.value) || 100, 5, 100);
        var lab = els.osnapDlg.querySelector('#mdCrossVal');
        if (lab) lab.textContent = state.crossPct + '%';
        redrawLive();
        scheduleSave();
      } else if (t.id === 'mdPickRange') {
        state.pickPx = clamp(parseFloat(t.value) || 8, 4, 24);
        var pl = els.osnapDlg.querySelector('#mdPickVal');
        if (pl) pl.textContent = state.pickPx + ' px';
        redrawLive();
        scheduleSave();
      } else if (t.id === 'mdPolarStep') {
        state.polarStep = parseFloat(t.value) || 15;
        scheduleSave();
      }
    };
    els.osnapDlg.addEventListener('input', onDlgField);
    els.osnapDlg.addEventListener('change', onDlgField);

    els.help.addEventListener('click', function (ev) {
      if (ev.target === els.help || ev.target.getAttribute('data-help') === 'close') toggleHelp(false);
    });

    /* 尺寸变化 */
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () {
        if (!isVisible()) return;
        redrawAll();
      });
      ro.observe(els.zone);
    } else {
      window.addEventListener('resize', function () { if (isVisible()) redrawAll(); });
    }
  }

  function isVisible() {
    return !!(built && els.app && !els.app.hidden);
  }

  function show() {
    build();
    els.app.hidden = false;
    document.body.classList.add('cad-active');
    if (state.space === 'layout') fitLayout(true);
    else if (!state.viewInit) {
      state.viewInit = true;
      if (state.entities.length) fit(true);
      else resetView();
    }
    syncStatusToggles();
    if (els.app) els.app.classList.toggle('no-lw', !state.lwOn);
    renderLayers();
    renderList();
    renderProps();
    updateHistoryButtons();
    updateStatus();
    redrawAll();
    requestAnimationFrame(function () { if (isVisible()) redrawAll(); });
    if (!cmdHistory.length) {
      msg('CAD 绘图工作区已就绪 · 输入 L 画直线，REC 矩形，C 圆，A 圆弧', 'ok');
      msg('提示：F3 对象捕捉 · F8 正交 · F12 动态输入 · 右键重复命令');
    }
    if (state.restored) {
      toast('已恢复上次草稿 · ' + state.restored + ' 个对象');
      state.restored = 0;
    }
    setTimeout(function () { if (isVisible()) els.cmdInput.focus(); }, 60);
  }

  function hide() {
    if (!built) return;
    saveNow();
    cancelCmd(true);
    drag = null;
    hoverId = null;
    state.pointer.inside = false;
    if (els.help) els.help.hidden = true;
    if (els.osnapDlg) els.osnapDlg.hidden = true;
    closeMenus();
    els.app.hidden = true;
    document.body.classList.remove('cad-active');
  }

  function setTool(t) {
    if (KIND_NAME[t]) { startCmd(t); return; }
    cancelCmd(true);
    state.tool = t === 'pan' ? 'pan' : 'select';
    if (els.cycleTag) els.cycleTag.hidden = true;
    setCursor();
    redrawLive();
  }

  /* ---------------- 中心线 / 自动标注 ---------------- */
  function addCenterLines(cx, cy, r, layerId) {
    var L = layerId || (state.layers.some(function (l) { return l.id === 'center'; }) ? 'center' : state.curLayer);
    var ext = r * 1.18;
    state.entities.push({ id: uid(), kind: 'line', layer: L, ltype: 'dashdot',
      x0: round4(cx - ext), y0: round4(cy), x1: round4(cx + ext), y1: round4(cy) });
    state.entities.push({ id: uid(), kind: 'line', layer: L, ltype: 'dashdot',
      x0: round4(cx), y0: round4(cy - ext), x1: round4(cx), y1: round4(cy + ext) });
  }

  /* 自动标注：对选中对象的外包尺寸标长和宽（一键出尺寸） */
  function autoDimSelection() {
    var list = editableSelection();
    if (!list.length) { msg('先选中对象，再点「自标」'); return; }
    var b = unionBounds(list);
    var w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (w < 0.01 && h < 0.01) { msg('选中对象尺寸为零，无法标注'); return; }
    var before = snapshot();
    var off = 14;
    /* 宽度（下方） */
    var a1 = { x: b.x0, y: b.y0 }, b1 = { x: b.x1, y: b.y0 }, p1 = { x: (b.x0 + b.x1) / 2, y: b.y0 - off };
    var dx = b1.x - a1.x, dy = b1.y - a1.y, len1 = Math.hypot(dx, dy) || 1;
    var n1 = { x: -dy / len1, y: dx / len1 };
    var o1 = (p1.x - a1.x) * n1.x + (p1.y - a1.y) * n1.y;
    if (Math.abs(o1) < 0.5) o1 = -off;
    var e1 = { x: a1.x + n1.x * o1, y: a1.y + n1.y * o1 };
    var f1 = { x: b1.x + n1.x * o1, y: b1.y + n1.y * o1 };
    addDimLine(a1.x, a1.y, e1.x + n1.x * 3, e1.y + n1.y * 3, state.curLayer);
    addDimLine(b1.x, b1.y, f1.x + n1.x * 3, f1.y + n1.y * 3, state.curLayer);
    addDimLine(e1.x, e1.y, f1.x, f1.y, state.curLayer);
    addDimText((e1.x + f1.x) / 2 + n1.x * 1.8, (e1.y + f1.y) / 2 + n1.y * 1.8, fmt(w, 2), state.curLayer, 3.5);
    /* 高度（左侧） */
    if (h > 0.01) {
      var a2 = { x: b.x0, y: b.y0 }, b2 = { x: b.x0, y: b.y1 }, p2 = { x: b.x0 - off, y: (b.y0 + b.y1) / 2 };
      var dx2 = b2.x - a2.x, dy2 = b2.y - a2.y, len2 = Math.hypot(dx2, dy2) || 1;
      var n2 = { x: -dy2 / len2, y: dx2 / len2 };
      var o2 = (p2.x - a2.x) * n2.x + (p2.y - a2.y) * n2.y;
      if (Math.abs(o2) < 0.5) o2 = -off;
      var e2 = { x: a2.x + n2.x * o2, y: a2.y + n2.y * o2 };
      var f2 = { x: b2.x + n2.x * o2, y: b2.y + n2.y * o2 };
      addDimLine(a2.x, a2.y, e2.x + n2.x * 3, e2.y + n2.y * 3, state.curLayer);
      addDimLine(b2.x, b2.y, f2.x + n2.x * 3, f2.y + n2.y * 3, state.curLayer);
      addDimLine(e2.x, e2.y, f2.x, f2.y, state.curLayer);
      addDimText((e2.x + f2.x) / 2 + n2.x * 1.8, (e2.y + f2.y) / 2 + n2.y * 1.8, fmt(h, 2), state.curLayer, 3.5);
    }
    pushUndo(before, '自动标注');
    msg('已自动标注：' + fmt(w, 2) + ' × ' + fmt(h, 2));
    afterChange();
  }

  /* ---------------- 填充图案 ---------------- */
  var patSeen = {};
  function ensureHatchPattern(style, spacing, color) {
    if (!els.defs) return null;
    spacing = Math.max(2, spacing || 6);
    var cid = String(color || '#7be0a6').replace('#', '');
    var id = 'hp-' + style + '-' + Math.round(spacing) + '-' + cid;
    if (patSeen[id]) return id;
    patSeen[id] = 1;
    var pat = document.createElementNS(SVG_NS, 'pattern');
    pat.setAttribute('id', id);
    pat.setAttribute('patternUnits', 'userSpaceOnUse');
    pat.setAttribute('width', String(spacing));
    pat.setAttribute('height', String(spacing));
    function ln(x1, y1, x2, y2) {
      var l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('x1', x1); l.setAttribute('y1', y1);
      l.setAttribute('x2', x2); l.setAttribute('y2', y2);
      l.setAttribute('stroke', color || '#7be0a6');
      l.setAttribute('stroke-width', '0.55');
      pat.appendChild(l);
    }
    if (style === 'diag') ln(0, spacing, spacing, 0);
    else if (style === 'cross') { ln(0, spacing, spacing, 0); ln(0, 0, spacing, spacing); }
    else if (style === 'ansi') { ln(0, spacing, spacing, 0); ln(-spacing / 2, spacing / 2, spacing / 2, -spacing / 2); }
    els.defs.appendChild(pat);
    return id;
  }

  /* 关联填充：边界图元变化后重新取点 */
  function syncHatches() {
    state.entities.forEach(function (e) {
      if (e.kind !== 'hatch' || !e.boundaryRef) return;
      var b = state.entities.find(function (x) { return x.id === e.boundaryRef.id; });
      if (!b) return;
      var pts = boundaryPts(b);
      if (pts && pts.length >= 3) e.pts = pts;
    });
  }

  /* ---------------- 填充边界 / 块辅助 ---------------- */
  function createCloud(pts, bump) {
    if (pts.length < 3) return false;
    var beforeC = snapshot();
    bump = Math.max(2, bump || 5);
    var closed = pts.concat([pts[0]]);
    for (var si = 0; si + 1 < closed.length; si++) {
      var A = closed[si], B = closed[si + 1];
      var L = Math.hypot(B.x - A.x, B.y - A.y);
      if (L < 1e-6) continue;
      var n = Math.max(2, Math.round(L / bump));
      var step = L / n;
      var ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
      var base = Math.atan2(uy, ux);
      for (var bi = 0; bi < n; bi++) {
        var x1 = A.x + ux * step * bi, y1 = A.y + uy * step * bi;
        var cx = x1 + ux * step / 2, cy = y1 + uy * step / 2;
        var r = step / 2;
        state.entities.push({ id: uid(), kind: 'arc', layer: state.curLayer, cx: round4(cx), cy: round4(cy), r: round4(r), a0: base, a1: base + Math.PI, dir: 1 });
      }
    }
    pushUndo(beforeC, '修订云线');
    msg('已创建修订云线（' + pts.length + ' 个控制点）');
    return true;
  }

  function refreshBom() {
    if (!state.lastBom) { msg('还没有明细栏可刷新'); return; }
    var beforeB = snapshot();
    state.entities = state.entities.filter(function (x) { return !x._bom; });
    var insAll = state.entities.filter(function (x) { return x.kind === 'insert'; });
    var rows = [['序号', '名称', '数量', '材料']];
    if (insAll.length) {
      var cnt = {};
      insAll.forEach(function (x) { var nm = (x.attrs && x.attrs[0]) || x.name; cnt[nm] = (cnt[nm] || 0) + 1; });
      var i2 = 1;
      Object.keys(cnt).forEach(function (nm) { rows.push([String(i2++), nm, String(cnt[nm]), '—']); });
    } else {
      rows = [['序号', '名称', '数量', '材料'], ['1', '底板', '1', 'Q235']];
    }
    var startId = state.entities.length;
    createTable(rows, state.lastBom.x, state.lastBom.y);
    for (var k = startId; k < state.entities.length; k++) state.entities[k]._bom = true;
    pushUndo(beforeB, '刷新明细栏');
    afterChange();
    msg('明细栏已刷新：' + (rows.length - 1) + ' 项');
  }

  function createTable(rows, ox, oy, opts) {
    opts = opts || {};
    var mergeRows = Math.max(0, parseInt(opts.mergeRows || (opts.mergeTop ? 1 : 0), 10));
    var mergeTop = mergeRows > 0;
    rows = rows.filter(function (r) { return r && r.length; });
    if (!rows.length) return null;
    var cols = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    var colW = [];
    for (var ci = 0; ci < cols; ci++) {
      var wmax = 0;
      rows.forEach(function (r) { wmax = Math.max(wmax, String(r[ci] || '').length); });
      colW.push(Math.max(18, wmax * 2.4 + 8));
    }
    var rowH = 8, totalW = colW.reduce(function (a, b) { return a + b; }, 0);
    var topStartY = y0 - mergeRows * rowH;
    var before = snapshot(), ids = [];
    var tblId = 'T' + Date.now().toString(36);
    var startIdx = state.entities.length;
    var x0 = ox, y0 = oy;
    rows.forEach(function (r, ri) {
      ids.push(addDimLine(x0, y0 - ri * rowH, x0 + totalW, y0 - ri * rowH, state.curLayer));
    });
    ids.push(addDimLine(x0, y0 - rows.length * rowH, x0 + totalW, y0 - rows.length * rowH, state.curLayer));
    var xc = x0;
    colW.forEach(function (w) {
      ids.push(addDimLine(xc, topStartY, xc, y0 - rows.length * rowH, state.curLayer));
      xc += w;
    });
    ids.push(addDimLine(x0 + totalW, topStartY, x0 + totalW, y0 - rows.length * rowH, state.curLayer));
    if (mergeTop) {
      var mtxt = (rows[0] || []).join('   ');
      var mtw = mtxt.length * 2.4;
      addDimText(x0 + Math.max(2, (totalW - mtw) / 2), y0 - (mergeRows * rowH) / 2 - 1.2, mtxt, state.curLayer, 3.2);
    }
    rows.forEach(function (r, ri) {
      if (mergeRows && ri < mergeRows) return;
      var cx2 = x0;
      for (var ci2 = 0; ci2 < cols; ci2++) {
        var txt = String(r[ci2] || '');
        var cellW = colW[ci2];
        var tw2 = txt.length * 2.4;
        var tx2 = state.tableAlign === 'center' ? (cx2 + (cellW - tw2) / 2) : (cx2 + 2);
        if (txt) {
          var tid2 = addDimText(Math.max(cx2 + 1, tx2), y0 - ri * rowH - rowH / 2 - 1.2, txt, state.curLayer, 3.2);
          var te2 = state.entities.find(function (x) { return x.id === tid2; });
          if (te2) te2._cell = true;
        }
        cx2 += colW[ci2];
      }
    });
    for (var ti = startIdx; ti < state.entities.length; ti++) state.entities[ti]._tbl = tblId;
    state.tables[tblId] = { x: x0, y: y0, rows: rows.map(function (r) { return r.slice(); }), rowH: rowH, mergeTop: mergeRows > 0, mergeRows: mergeRows };
    pushUndo(before, '表格');
    return tblId;
  }

  function boundaryPts(e) {
    if (!e) return null;
    if (e.kind === 'rect') {
      var b = entityBounds(e);
      return [{ x: round4(b.x0), y: round4(b.y0) }, { x: round4(b.x1), y: round4(b.y0) },
              { x: round4(b.x1), y: round4(b.y1) }, { x: round4(b.x0), y: round4(b.y1) }];
    }
    if (e.kind === 'polyline' && e.closed && e.pts.length >= 3) {
      return e.pts.map(function (p) { return { x: round4(p.x), y: round4(p.y) }; });
    }
    if (e.kind === 'circle') {
      var pts = [];
      for (var i = 0; i < 64; i++) {
        var a = i * Math.PI * 2 / 64;
        pts.push({ x: round4(e.cx + Math.cos(a) * e.r), y: round4(e.cy + Math.sin(a) * e.r) });
      }
      return pts;
    }
    return null;
  }

  /* ---------------- 引线标注（箭头 + 折线 + 文字） ---------------- */
  function createLeader(pts, text) {
    var p0 = pts[0], p1 = pts[pts.length - 1];
    var before = snapshot();
    for (var li = 0; li + 1 < pts.length; li++) addDimLine(pts[li].x, pts[li].y, pts[li + 1].x, pts[li + 1].y, state.curLayer);
    /* 箭头：在 p0 端画两条短线 */
    var ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    var aLen = 4.5;
    addDimLine(p0.x, p0.y, p0.x + Math.cos(ang + 0.35) * aLen, p0.y + Math.sin(ang + 0.35) * aLen, state.curLayer);
    addDimLine(p0.x, p0.y, p0.x + Math.cos(ang - 0.35) * aLen, p0.y + Math.sin(ang - 0.35) * aLen, state.curLayer);
    var dx = p1.x - p0.x, dy = p1.y - p0.y, L = Math.hypot(dx, dy) || 1;
    var tx = p1.x + dx / L * 2, ty = p1.y + dy / L * 2;
    addDimText(tx, ty, text || '引线', state.curLayer, 3.5);
    pushUndo(before, '引线标注');
    msg('已添加引线：' + (text || '引线'));
    endCmd(true);
    afterChange();
  }

  /* ---------------- 尺寸标注（文字 + 引出线，导出为 LINE/TEXT） ---------------- */
  function addDimLine(ax, ay, bx, by, layer) {
    var lid = uid();
    state.entities.push({ id: lid, kind: 'line', layer: layer, x0: round4(ax), y0: round4(ay), x1: round4(bx), y1: round4(by) });
    return lid;
  }
  function dimTextFor(len) {
    var base = fmt(len, (state.dimStyle && state.dimStyle.precision) || 2);
    var ds2 = state.dimStyle || {};
    if (ds2.tolMode === 'sym') return base + ' ±' + fmt(ds2.tol || 0, 2);
    if (ds2.tolMode === 'limits') return base + ' +' + fmt(ds2.tol || 0, 2) + '\n' + base + ' -' + fmt(ds2.tol2 || 0, 2);
    return base;
  }
  function addDimText(x, y, text, layer, size) {
    var tid = uid();
    state.entities.push({ id: tid, kind: 'text', layer: layer, cx: round4(x), cy: round4(y), size: size || 3.5, text: String(text) });
    return tid;
  }

  /* 取点附近的图元与夹点角色（用于关联标注） */
  function zoomToBounds(b) {
    var zs = zoneSize();
    var w = Math.max(1, b.x1 - b.x0), h = Math.max(1, b.y1 - b.y0);
    var z = Math.min((zs.w * 0.6) / w, (zs.h * 0.6) / h);
    z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    state.view.zoom = z;
    state.view.tx = zs.w / 2 - ((b.x0 + b.x1) / 2) * z;
    state.view.ty = zs.h / 2 + ((b.y0 + b.y1) / 2) * z;
    redrawAll();
  }

  function entityRefAt(p) {
    var e = hitTest(p.x, p.y);
    if (!e) return null;
    if (e.kind === 'line') {
      var d0 = Math.hypot(p.x - e.x0, p.y - e.y0), d1 = Math.hypot(p.x - e.x1, p.y - e.y1);
      return { id: e.id, role: d0 <= d1 ? 'p0' : 'p1' };
    }
    if (e.kind === 'rect') {
      var cs = [[e.x0, e.y0, 'c0'], [e.x1, e.y0, 'c1'], [e.x1, e.y1, 'c2'], [e.x0, e.y1, 'c3']];
      var bstd = null, bd = Infinity;
      cs.forEach(function (c) { var d = Math.hypot(p.x - c[0], p.y - c[1]); if (d < bd) { bd = d; bstd = c[2]; } });
      return { id: e.id, role: bstd };
    }
    if (e.kind === 'circle') return { id: e.id, role: 'c' };
    if (e.kind === 'polyline') {
      var bi = 0, bdd = Infinity;
      e.pts.forEach(function (q, i) { var d = Math.hypot(p.x - q.x, p.y - q.y); if (d < bdd) { bdd = d; bi = i; } });
      return { id: e.id, role: 'v' + bi };
    }
    if (e.kind === 'arc') return { id: e.id, role: 'p0' };
    return { id: e.id, role: 'c' };
  }

  function refPoint(ref) {
    if (!ref) return null;
    var e = state.entities.find(function (x) { return x.id === ref.id; });
    if (!e) return null;
    if (e.kind === 'line') return ref.role === 'p0' ? { x: e.x0, y: e.y0 } : { x: e.x1, y: e.y1 };
    if (e.kind === 'rect') {
      var m = { c0: [e.x0, e.y0], c1: [e.x1, e.y0], c2: [e.x1, e.y1], c3: [e.x0, e.y1] }[ref.role];
      return m ? { x: m[0], y: m[1] } : null;
    }
    if (e.kind === 'circle') return ref.role === 'r' ? { x: e.cx + e.r, y: e.cy } : { x: e.cx, y: e.cy };
    if (e.kind === 'polyline') {
      var i = parseInt(String(ref.role).slice(1), 10);
      return e.pts[i] ? { x: e.pts[i].x, y: e.pts[i].y } : null;
    }
    if (e.kind === 'arc') {
      var q = ref.role === 'p1' ? e.a1 : e.a0;
      return { x: e.cx + Math.cos(q) * e.r, y: e.cy + Math.sin(q) * e.r };
    }
    return { x: e.x || e.cx || 0, y: e.y || e.cy || 0 };
  }

  function syncDims() {
    var idsAll = {};
    state.entities.forEach(function (e) { idsAll[e.id] = 1; });
    state.dimSets = (state.dimSets || []).filter(function (ds) {
      if (!idsAll[ds.textId]) return false;
      if (ds.type === 'linear') return !!idsAll[ds.refA && ds.refA.id] && !!idsAll[ds.refB && ds.refB.id];
      if (ds.type === 'dia') return !!idsAll[ds.ref];
      return true;
    });
    (state.dimSets || []).forEach(function (ds) {
      if (ds.type === 'linear') {
        var a = refPoint(ds.refA), b = refPoint(ds.refB);
        if (!a || !b) return;
        var dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
        if (len < 0.01) return;
        var nx = -dy / len, ny = dx / len, off = ds.offset || 12;
        var A = { x: a.x + nx * off, y: a.y + ny * off }, B = { x: b.x + nx * off, y: b.y + ny * off };
        var over = Math.sign(off) * 3;
        var ids = ds.ids || [];
        function setLine(id, ax, ay, bx, by) {
          var e = state.entities.find(function (x) { return x.id === id; });
          if (e) { e.x0 = round4(ax); e.y0 = round4(ay); e.x1 = round4(bx); e.y1 = round4(by); }
        }
        setLine(ids[0], a.x, a.y, A.x + nx * over, A.y + ny * over);
        setLine(ids[1], b.x, b.y, B.x + nx * over, B.y + ny * over);
        setLine(ids[2], A.x, A.y, B.x, B.y);
        var th = Math.atan2(dy, dx), arr = (state.dimStyle && state.dimStyle.arrow) || 5;
        setLine(ids[3], A.x, A.y, A.x + Math.cos(th + 0.32) * arr, A.y + Math.sin(th + 0.32) * arr);
        setLine(ids[4], A.x, A.y, A.x + Math.cos(th - 0.32) * arr, A.y + Math.sin(th - 0.32) * arr);
        setLine(ids[5], B.x, B.y, B.x + Math.cos(th + Math.PI + 0.32) * arr, B.y + Math.sin(th + Math.PI + 0.32) * arr);
        setLine(ids[6], B.x, B.y, B.x + Math.cos(th + Math.PI - 0.32) * arr, B.y + Math.sin(th + Math.PI - 0.32) * arr);
        var txt = state.entities.find(function (x) { return x.id === ds.textId; });
        if (txt) {
          txt.text = (ds.override ? ds.override : dimTextFor(len)) + (ds.tol ? ' ' + ds.tol : '');
          txt.cx = round4((A.x + B.x) / 2 + nx * 1.8);
          txt.cy = round4((A.y + B.y) / 2 + ny * 1.8);
        }
      } else if (ds.type === 'dia') {
        var c = state.entities.find(function (x) { return x.id === ds.ref; });
        if (!c || c.kind !== 'circle') return;
        var ang = ds.ang || 0;
        var edge = { x: c.cx + Math.cos(ang) * c.r, y: c.cy + Math.sin(ang) * c.r };
        setLns(ds.ids, c, edge, ds.pos);
        var t2 = state.entities.find(function (x) { return x.id === ds.textId; });
        if (t2) t2.text = (ds.override ? ds.override : ('\u2300' + fmt(c.r * 2, (state.dimStyle && state.dimStyle.precision) || 2))) + (ds.tol ? ' ' + ds.tol : '');
      }
    });
    function setLns(ids, c, edge, pos) {
      if (!pos) return;
      var e1 = state.entities.find(function (x) { return x.id === (ids && ids[0]); });
      var e2 = state.entities.find(function (x) { return x.id === (ids && ids[1]); });
      if (e1) { e1.x0 = round4(edge.x); e1.y0 = round4(edge.y); e1.x1 = round4(pos.x); e1.y1 = round4(pos.y); }
      if (e2) { e2.x0 = round4(c.cx); e2.y0 = round4(c.cy); e2.x1 = round4(edge.x); e2.y1 = round4(edge.y); }
    }
  }
  function buildLinearDim(p1, p2, pos) {
    var before = snapshot();
    var dx = p2.x - p1.x, dy = p2.y - p1.y;
    var len = Math.hypot(dx, dy);
    if (len < 0.01) { msg('两点重合，无法标注'); return; }
    var nx = -dy / len, ny = dx / len;
    var off = (pos.x - p1.x) * nx + (pos.y - p1.y) * ny;
    if (Math.abs(off) < 0.5) off = 12;
    /* 尺寸线端点 */
    var a = { x: p1.x + nx * off, y: p1.y + ny * off };
    var b = { x: p2.x + nx * off, y: p2.y + ny * off };
    var over = Math.sign(off) * 3;
    var refA = entityRefAt(p1), refB = entityRefAt(p2);
    var dimIds = [];
    /* 尺寸界线（含小出头） */
    dimIds.push(addDimLine(p1.x, p1.y, a.x + nx * over, a.y + ny * over, state.curLayer));
    dimIds.push(addDimLine(p2.x, p2.y, b.x + nx * over, b.y + ny * over, state.curLayer));
    /* 尺寸线 */
    dimIds.push(addDimLine(a.x, a.y, b.x, b.y, state.curLayer));
    /* 箭头（两条短线） */
    var arrow = (state.dimStyle && state.dimStyle.arrow) || 5, th = Math.atan2(dy, dx);
    if ((state.dimStyle && state.dimStyle.arrowStyle) !== 'none') [[a, th], [b, th + Math.PI]].forEach(function (pair) {
      var pt = pair[0], ang = pair[1];
      dimIds.push(addDimLine(pt.x, pt.y, pt.x + Math.cos(ang + 0.32) * arrow, pt.y + Math.sin(ang + 0.32) * arrow, state.curLayer));
      dimIds.push(addDimLine(pt.x, pt.y, pt.x + Math.cos(ang - 0.32) * arrow, pt.y + Math.sin(ang - 0.32) * arrow, state.curLayer));
    });
    /* 文字：数字 + mm */
    var mid = { x: (a.x + b.x) / 2 + nx * 1.8, y: (a.y + b.y) / 2 + ny * 1.8 };
    var angDeg = deg(th);
    var txt = dimTextFor(len);
    var textId = addDimText(mid.x, mid.y, txt, state.curLayer, (state.dimStyle && state.dimStyle.textSize) || 3.5);
    if (refA && refB) state.dimSets.push({ type: 'linear', refA: refA, refB: refB, offset: off, ids: dimIds, textId: textId });
    pushUndo(before, '线性标注');
    msg('标注 ' + txt + ' mm' + (Math.abs(angDeg % 90) < 1 ? '' : '（角度 ' + fmt(angDeg, 1) + '°）'));
    endCmd(true);
    afterChange();
  }
  function buildDiaDim(circle, pos) {
    if (!circle || circle.kind !== 'circle') { msg('请选择一个圆'); return; }
    var before = snapshot();
    var ang = Math.atan2(pos.y - circle.cy, pos.x - circle.cx);
    var edge = { x: circle.cx + Math.cos(ang) * circle.r, y: circle.cy + Math.sin(ang) * circle.r };
    var dIds = [addDimLine(edge.x, edge.y, pos.x, pos.y, state.curLayer), addDimLine(circle.cx, circle.cy, edge.x, edge.y, state.curLayer)];
    var txt = '\u2300' + fmt(circle.r * 2, (state.dimStyle && state.dimStyle.precision) || 2);
    var dtid = addDimText(pos.x, pos.y - 1.5, txt, state.curLayer, (state.dimStyle && state.dimStyle.textSize) || 3.5);
    state.dimSets.push({ type: 'dia', ref: circle.id, ang: ang, ids: dIds, textId: dtid, pos: { x: pos.x, y: pos.y } });
    pushUndo(before, '直径标注');
    msg('直径标注 ' + txt);
    endCmd(true);
    afterChange();
  }

  /* ---------------- 快速修剪 / 延伸（LibreCAD 风格：全部对象作边界，一次点击生效） ---------------- */
  function segsAndArcsOf(entitiesExceptId) {
    var list = state.entities.filter(function (e) { return e.id !== entitiesExceptId && entityVisible(e); });
    return { segs: segList(list), arcs: list.filter(function (e) { return e.kind === 'circle' || e.kind === 'arc'; }) };
  }

  /* 直线与另一段/圆的交点参数 t（0..1 沿本段） */
  function lineCutParams(line) {
    var ge = segsAndArcsOf(line.id);
    var ax = line.x0, ay = line.y0, bx = line.x1, by = line.y1;
    var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    var out = [];
    if (L2 < 1e-9) return out;
    ge.segs.forEach(function (s) {
      var p = segSegX([ax, ay, bx, by, line], s);
      if (!p) return;
      var t = ((p.x - ax) * dx + (p.y - ay) * dy) / L2;
      if (t > 1e-4 && t < 1 - 1e-4) out.push({ t: t, p: p });
    });
    ge.arcs.forEach(function (arc) {
      segCircleX([ax, ay, bx, by, line], arc).forEach(function (p) {
        var t = ((p.x - ax) * dx + (p.y - ay) * dy) / L2;
        if (t > 1e-4 && t < 1 - 1e-4) out.push({ t: t, p: p });
      });
    });
    return out;
  }

  /* 矩形/多段线不支持直接修剪时，先把矩形炸成 4 条线，再挑离光标最近的那条 */
  function explodeRectForEdit(target, pt) {
    if (!target || target.kind !== 'rect') return null;
    var xe0 = Math.min(target.x0, target.x1), xe1 = Math.max(target.x0, target.x1);
    var ye0 = Math.min(target.y0, target.y1), ye1 = Math.max(target.y0, target.y1);
    var lines = [
      { x0: xe0, y0: ye0, x1: xe1, y1: ye0 },
      { x0: xe1, y0: ye0, x1: xe1, y1: ye1 },
      { x0: xe1, y0: ye1, x1: xe0, y1: ye1 },
      { x0: xe0, y0: ye1, x1: xe0, y1: ye0 }
    ];
    var before = snapshot();
    state.entities = state.entities.filter(function (e) { return e.id !== target.id; });
    var made = lines.map(function (s) {
      var e = { id: uid(), kind: 'line', layer: target.layer, x0: round4(s.x0), y0: round4(s.y0), x1: round4(s.x1), y1: round4(s.y1) };
      state.entities.push(e);
      return e;
    });
    pushUndo(before, '分解矩形');
    var best = null, bd = Infinity;
    made.forEach(function (e) {
      var p = closestOnEntity(pt.x, pt.y, e);
      var d = p ? dist(pt.x, pt.y, p.x, p.y) : Infinity;
      if (d < bd) { bd = d; best = e; }
    });
    return best;
  }

  function quickTrim(target, pt) {
    if (target && target.kind === 'rect') {
      var one = explodeRectForEdit(target, pt);
      if (!one) { msg('矩形分解失败'); return; }
      target = one;
    }
    if (target.kind !== 'line') {
      msg('修剪目前只对直线生效（矩形/多段线/圆请先分解或用延伸）');
      toast('修剪：仅直线');
      return;
    }
    var cuts = lineCutParams(target);
    if (!cuts.length) { msg('未找到边界交点，无法修剪'); return; }
    var len2 = Math.pow(target.x1 - target.x0, 2) + Math.pow(target.y1 - target.y0, 2);
    var tClick = ((pt.x - target.x0) * (target.x1 - target.x0) + (pt.y - target.y0) * (target.y1 - target.y0)) / len2;
    cuts.sort(function (a, b) { return Math.abs(a.t - tClick) - Math.abs(b.t - tClick); });
    var cut = cuts[0];
    var before = snapshot();
    if (cut.t < tClick) {
      /* 点击在交点之后：剪掉点击那一侧，保留 [0, cut] */
      target.x1 = round4(cut.p.x);
      target.y1 = round4(cut.p.y);
    } else {
      /* 点击在交点之前：剪掉点击那一侧，保留 [cut, 1] */
      target.x0 = round4(cut.p.x);
      target.y0 = round4(cut.p.y);
    }
    pushUndo(before, '修剪');
    msg('已修剪：新的长度为 ' + fmt(dist(target.x0, target.y0, target.x1, target.y1), 2) + ' mm');
    afterChange();
  }

  /* 射线与线段 / 圆的交点（用于延伸） */
  function raySegX(px, py, dx, dy, s) {
    var sdx = s[2] - s[0], sdy = s[3] - s[1];
    var den = dx * sdy - dy * sdx;
    if (Math.abs(den) < 1e-12) return null;
    var t = ((s[0] - px) * sdy - (s[1] - py) * sdx) / den;
    var u = ((s[0] - px) * dy - (s[1] - py) * dx) / den;
    if (t <= 0 || u < -1e-6 || u > 1 + 1e-6) return null;
    return { x: px + dx * t, y: py + dy * t, d: t };
  }
  function rayCircleX(px, py, dx, dy, arc) {
    var fx = px - arc.cx, fy = py - arc.cy, r = arc.r;
    var a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - r * r;
    var disc = b * b - 4 * a * c;
    if (disc < 0) return [];
    var sq = Math.sqrt(disc), out = [];
    [(-b - sq) / (2 * a), (-b + sq) / (2 * a)].forEach(function (t) {
      if (t <= 1e-6) return;
      var p = { x: px + dx * t, y: py + dy * t, d: t };
      if (arc.kind === 'arc' && !arcContainsAngle(arc, Math.atan2(p.y - arc.cy, p.x - arc.cx))) return;
      out.push(p);
    });
    return out;
  }

  function quickExtend(target, pt) {
    if (target && target.kind === 'rect') {
      var oneE = explodeRectForEdit(target, pt);
      if (!oneE) { msg('矩形分解失败'); return; }
      target = oneE;
    }
    if (target.kind !== 'line') {
      msg('延伸目前只对直线生效');
      toast('延伸：仅直线');
      return;
    }
    var d0 = dist(pt.x, pt.y, target.x0, target.y0);
    var d1 = dist(pt.x, pt.y, target.x1, target.y1);
    var pickEnd = d0 <= d1 ? 0 : 1;
    var px = pickEnd === 0 ? target.x0 : target.x1;
    var py = pickEnd === 0 ? target.y0 : target.y1;
    var qx = pickEnd === 0 ? target.x1 : target.x0;
    var qy = pickEnd === 0 ? target.y1 : target.y0;
    var dx = px - qx, dy = py - qy;       /* 从另一端指向要延伸的一端 */
    var ge = segsAndArcsOf(target.id);
    var best = null;
    ge.segs.forEach(function (s) {
      var p = raySegX(px, py, dx, dy, s);
      if (p && (!best || p.d < best.d)) best = p;
    });
    ge.arcs.forEach(function (arc) {
      rayCircleX(px, py, dx, dy, arc).forEach(function (p) {
        if (!best || p.d < best.d) best = p;
      });
    });
    if (!best) { msg('这个方向上没有边界可延伸'); return; }
    var before = snapshot();
    if (pickEnd === 0) { target.x0 = round4(best.x); target.y0 = round4(best.y); }
    else { target.x1 = round4(best.x); target.y1 = round4(best.y); }
    pushUndo(before, '延伸');
    msg('已延伸 ' + fmt(best.d, 2) + ' mm');
    afterChange();
  }

  /* ---------------- 工具条同步 / 选区浮动条 ---------------- */
  function syncPalette() {
    if (!els.palette) return;
    var active = state.cmd ? ('cmd:' + state.cmd.name) : (state.tool === 'pan' ? 'tool:pan' : 'tool:select');
    Array.prototype.forEach.call(els.palette.querySelectorAll('.pal-btn'), function (b) {
      var key = b.getAttribute('data-act') || ('tool:' + b.getAttribute('data-tool'));
      b.classList.toggle('is-on', key === active);
    });
  }

  function syncSelBar() {
    if (!els.selBar) return;
    var n = state.selection.size;
    els.selBar.hidden = n === 0;
    if (els.selBarCount) els.selBarCount.textContent = '已选 ' + n;
  }

  function clearSelection() {
    if (!state.selection.size) return;
    state.selection = new Set();
    afterChange();
    msg('已取消选择');
  }

  /* ---------------- AI 指令：自然语言 → 图形 ----------------
     规则解析（与参数化草图的 AI 建模同一思路，但只覆盖手动绘图常用操作）：
       画一条长120角度30的线 / 画矩形120x80 / 画圆半径30 / 画圆弧半径40角度90
       把选中的圆半径改成50 / 把选中的线长度改成200 / 把矩形宽度改成150 / 删除选中的
  */
  function aiReplyText(t) {
    if (els.aiReply) els.aiReply.textContent = t;
    return t;
  }
  function viewCenterWorld() {
    var s = zoneSize();
    return s2w(s.w / 2, s.h / 2);
  }
  function aiNum(text, re) {
    var m = text.match(re);
    if (!m) return null;
    var v = parseFloat(m[m.length - 1]);
    return isFinite(v) ? v : null;
  }
  function aiCreate(kind, layer, fields, label) {
    var before = snapshot();
    var e = { id: uid(), kind: kind, layer: layer || state.curLayer };
    if (state.curColor) e.color = state.curColor;
    for (var k in fields) if (fields.hasOwnProperty(k)) e[k] = fields[k];
    state.entities.push(e);
    pushUndo(before, label || 'AI 绘制');
    afterChange();
    return e;
  }
  /* AI 自绘（不含识图）：把一句话拆成一组图形，直接落在画布中心 */
  function aiDraw(t) {
    var c0 = viewCenterWorld();
    var layer = state.curLayer;
    var made = [];
    function put(kind, fields) {
      var e = aiCreate(kind, layer, fields, 'AI 自绘');
      made.push(e);
      return e;
    }
    function num(re) { return aiNum(t, re); }

    /* --- 均布孔（可单独说，也可配合法兰/板） --- */
    var mBolt = t.match(/(\d+)\s*(?:个|只|处)\s*(?:直径|φ)\s*([\d.]+)/);
    var boltCount = mBolt ? parseFloat(mBolt[1]) : null;
    var boltDia = mBolt ? parseFloat(mBolt[2]) : num(/(?:螺栓|安装)孔.*?(?:直径|φ)\s*([\d.]+)/);
    var boltPcd = num(/(?:均布|分布|节圆).*?(?:直径|φ)\s*([\d.]+)/) || num(/(?:直径|φ)\s*([\d.]+)\s*(?:的)?(?:圆上|圆周上)/);

    /* --- 法兰 --- */
    if (/法兰/.test(t)) {
      var od = num(/外[圆径].*?(?:直径|φ)?\s*([\d.]+)/) || num(/(?:直径|φ)\s*([\d.]+)[^。]*外/);
      var idia = num(/内[圆孔径].*?(?:直径|φ)?\s*([\d.]+)/);
      /* 只有「法兰 120」这种单个裸尺寸才把第一个直径当外径；
         一旦已经说了内孔/螺栓孔，就不能再把孔直径误当外径。 */
      var hasHoleWords = /内[圆孔径]|孔|均布|分布|节圆/.test(t);
      if (!od && !hasHoleWords) {
        od = num(/法兰\s*(?:外径|外圆|直径|φ|⌀)?\s*([\d.]+)/) || num(/(?:直径|φ)\s*([\d.]+)/);
      }
      if (!od && !idia && !boltPcd && !boltDia) {
        return aiReplyText('法兰要尺寸，试试「法兰 外圆120 内孔60 6个直径10的孔 均布直径100」');
      }
      if (od) put('circle', { cx: round4(c0.x), cy: round4(c0.y), r: round4(od / 2) });
      if (idia) put('circle', { cx: round4(c0.x), cy: round4(c0.y), r: round4(idia / 2) });
      var bc = (boltCount && boltCount >= 1) ? Math.round(boltCount) : (boltDia ? 6 : 0);
      var bd = boltDia || 10, pcd = boltPcd || (od ? od * 0.75 : 0);
      if (bc && pcd) {
        for (var i = 0; i < bc; i++) {
          var a = i * Math.PI * 2 / bc;
          put('circle', {
            cx: round4(c0.x + Math.cos(a) * pcd / 2),
            cy: round4(c0.y + Math.sin(a) * pcd / 2),
            r: round4(bd / 2)
          });
        }
      }
      if (od) addCenterLines(c0.x, c0.y, od / 2);
      return 'AI 自绘：法兰 ' + (od ? '外径 ' + fmt(od, 1) : '') + (idia ? ' / 内孔 ' + fmt(idia, 1) : '') +
        (bc && pcd ? ' / ' + bc + '×⌀' + fmt(bd, 1) + ' 均布 ⌀' + fmt(pcd, 1) : '') + '（圆心在视图中心）';
    }

    /* --- 带孔板 / 矩形板 --- */
    if (/板|矩形|长方形|方板|方块|块/.test(t) && /孔|x|×|\*|长|宽/.test(t)) {
      var mR = t.match(/([\d.]+)\s*[x×*]\s*([\d.]+)/) || t.match(/(?:长|宽)\s*([\d.]+)[^\d]*(?:宽|高)\s*([\d.]+)/);
      if (mR) {
        var W = parseFloat(mR[1]), H = parseFloat(mR[2]);
        if (W && H) {
          var rx = c0.x - W / 2, ry = c0.y - H / 2;
          var holeNote = [];
          var cenDia = num(/中心孔.*?(?:直径|φ)\s*([\d.]+)/) || num(/中心.*?(?:直径|φ)\s*([\d.]+)/);
          var cornerDia = num(/(?:四角|角上|四周).*?(?:直径|φ)\s*([\d.]+)/) || num(/(?:直径|φ)\s*([\d.]+)\s*(?:的)?(?:四角|角)/);
          var filletR = num(/圆角\s*([\d.]+)/);
          if (filletR && filletR > 0) {
            /* 圆角矩形 = 4 条缩进直边 + 4 段四分之一圆弧；
               不能再画完整矩形，否则直边会从圆弧里穿出去。 */
            var fr = Math.min(filletR, Math.min(W, H) / 2 - 0.1);
            put('line', { x0: round4(rx + fr), y0: round4(ry), x1: round4(rx + W - fr), y1: round4(ry) });
            put('line', { x0: round4(rx + W), y0: round4(ry + fr), x1: round4(rx + W), y1: round4(ry + H - fr) });
            put('line', { x0: round4(rx + W - fr), y0: round4(ry + H), x1: round4(rx + fr), y1: round4(ry + H) });
            put('line', { x0: round4(rx), y0: round4(ry + H - fr), x1: round4(rx), y1: round4(ry + fr) });
            put('arc', { cx: round4(rx + fr), cy: round4(ry + fr), r: round4(fr), a0: Math.PI, a1: Math.PI * 1.5, dir: 1 });
            put('arc', { cx: round4(rx + W - fr), cy: round4(ry + fr), r: round4(fr), a0: Math.PI * 1.5, a1: Math.PI * 2, dir: 1 });
            put('arc', { cx: round4(rx + W - fr), cy: round4(ry + H - fr), r: round4(fr), a0: 0, a1: Math.PI / 2, dir: 1 });
            put('arc', { cx: round4(rx + fr), cy: round4(ry + H - fr), r: round4(fr), a0: Math.PI / 2, a1: Math.PI, dir: 1 });
            holeNote.push('圆角 R' + fmt(fr, 1));
          } else {
            put('rect', { x0: round4(rx), y0: round4(ry), x1: round4(rx + W), y1: round4(ry + H) });
          }
          if (cenDia) {
            put('circle', { cx: round4(c0.x), cy: round4(c0.y), r: round4(cenDia / 2) });
            holeNote.push('中心孔 ⌀' + fmt(cenDia, 1));
          }
          if (cornerDia) {
            var inset = cornerDia / 2 + 5;
            [[rx + inset, ry + inset], [rx + W - inset, ry + inset], [rx + W - inset, ry + H - inset], [rx + inset, ry + H - inset]]
              .forEach(function (p) { put('circle', { cx: round4(p[0]), cy: round4(p[1]), r: round4(cornerDia / 2) }); });
            holeNote.push('四角孔 4×⌀' + fmt(cornerDia, 1));
          }
          /* 阵列孔：3x4 个孔 间距20 直径8 */
          var arr = t.match(/(\d+)\s*[x×*]\s*(\d+)\s*(?:个|处)?\s*孔/);
          if (arr && !cornerDia) {
            var nx = parseInt(arr[1], 10), ny = parseInt(arr[2], 10);
            var gap = num(/间距\s*([\d.]+)/) || 20;
            /* 孔径只在「阵列孔」这一句里找，避免把前面的中心孔直径当孔径 */
            var arrTail = t.slice(arr.index);
            var adia = num(/间距\s*[\d.]+\s*(?:mm|毫米)?\s*(?:直径|φ|⌀)\s*([\d.]+)/) ||
              num(/孔\s*(?:直径|φ|⌀)\s*([\d.]+)/) ||
              num(/(?:直径|φ|⌀)\s*([\d.]+)/) ||
              num(/孔.*?(?:直径|φ|⌀)\s*([\d.]+)/) || 8;
            if (!adia || adia === cenDia) adia = aiNum(arrTail, /(?:直径|φ|⌀)\s*([\d.]+)/) || adia || 8;
            var ox = (nx - 1) * gap / 2, oy = (ny - 1) * gap / 2;
            for (var gx = 0; gx < nx; gx++) {
              for (var gy = 0; gy < ny; gy++) {
                put('circle', {
                  cx: round4(c0.x - ox + gx * gap),
                  cy: round4(c0.y - oy + gy * gap),
                  r: round4(adia / 2)
                });
              }
            }
            holeNote.push(nx + '×' + ny + ' 阵列孔 ⌀' + fmt(adia, 1) + ' 间距 ' + fmt(gap, 1));
          }
          return 'AI 自绘：板 ' + fmt(W, 1) + ' × ' + fmt(H, 1) +
            (holeNote.length ? '，' + holeNote.join(' + ') : '') + '（视图中心）';
        }
      }
    }

    /* --- 轴（长条 + 两端中心孔可选） --- */
    if (/轴/.test(t) && /长/.test(t) && !/阶梯|台阶|键槽/.test(t)) {
      var lenAxis = num(/长(?:度)?\s*([\d.]+)/) || num(/([\d.]+)\s*(?:mm|毫米)?\s*长/);
      var diaAxis = num(/(?:直径|φ)\s*([\d.]+)/) || num(/⌀\s*([\d.]+)/);
      if (lenAxis && diaAxis) {
        put('rect', {
          x0: round4(c0.x - lenAxis / 2), y0: round4(c0.y - diaAxis / 2),
          x1: round4(c0.x + lenAxis / 2), y1: round4(c0.y + diaAxis / 2)
        });
        return 'AI 自绘：轴 ⌀' + fmt(diaAxis, 1) + ' × 长 ' + fmt(lenAxis, 1) + '（视图中心，矩形表示外轮廓）';
      }
    }

    /* --- 六边形 / 螺母（对边宽 S 或边长 a） --- */
    if (/六边|六角|螺母/.test(t)) {
      var S = num(/(?:对边|扳手|宽)\s*([\d.]+)/) || num(/(?:直径|φ|⌀)\s*([\d.]+)/);
      var aSide = num(/边长\s*([\d.]+)/);
      var R = aSide || (S ? S / Math.sqrt(3) : 0);
      if (R) {
        var pts6 = [];
        for (var h6 = 0; h6 < 6; h6++) {
          var a6 = h6 * Math.PI / 3;
          pts6.push({ x: round4(c0.x + R * Math.cos(a6)), y: round4(c0.y + R * Math.sin(a6)) });
        }
        put('polyline', { pts: pts6, closed: true });
        return 'AI 自绘：六边形 ' + (aSide ? '边长 ' + fmt(aSide, 1) : '对边 ' + fmt(S, 1)) +
          '（外接圆 R ' + fmt(R, 2) + '，视图中心）';
      }
      return aiReplyText('六边形要尺寸，试试「六角 对边宽30」或「六边形 边长20」');
    }

    /* --- L 形支架 / 角钢 --- */
    if (/L\s*形|L形|角钢|支架/.test(t) && /长|宽|厚/.test(t)) {
      var A = num(/(?:总)?长\s*([\d.]+)/) || 80;
      var B = num(/(?:总)?宽\s*([\d.]+)/) || 60;
      var T = num(/厚\s*([\d.]+)/) || 10;
      if (A > T && B > T) {
        var lx = c0.x - A / 2, ly = c0.y - B / 2;
        var ptsL = [
          { x: round4(lx), y: round4(ly) }, { x: round4(lx + A), y: round4(ly) },
          { x: round4(lx + A), y: round4(ly + T) }, { x: round4(lx + T), y: round4(ly + T) },
          { x: round4(lx + T), y: round4(ly + B) }, { x: round4(lx), y: round4(ly + B) }
        ];
        put('polyline', { pts: ptsL, closed: true });
        return 'AI 自绘：L 形支架 ' + fmt(A, 1) + ' × ' + fmt(B, 1) + '，厚 ' + fmt(T, 1) + '（视图中心）';
      }
      return aiReplyText('L 形要三个尺寸，试试「L形支架 长80 宽60 厚10」');
    }

    /* --- 直槽 / 键槽 --- */
    if (/槽/.test(t) && !/键槽/.test(t)) {
      var slotL = num(/长\s*([\d.]+)/) || num(/([\d.]+)\s*(?:mm)?\s*长/);
      var slotW = num(/(?:宽|槽宽)\s*([\d.]+)/) || num(/(?:直径|φ|⌀)\s*([\d.]+)/);
      if (slotL && slotW && slotL > slotW) {
        var rS = slotW / 2, half = (slotL - slotW) / 2;
        var cL = { x: c0.x - half, y: c0.y }, cR = { x: c0.x + half, y: c0.y };
        put('line', { x0: round4(cL.x), y0: round4(cL.y - rS), x1: round4(cR.x), y1: round4(cR.y - rS) });
        put('line', { x0: round4(cL.x), y0: round4(cL.y + rS), x1: round4(cR.x), y1: round4(cR.y + rS) });
        put('arc', { cx: round4(cL.x), cy: round4(cL.y), r: round4(rS), a0: Math.PI / 2, a1: Math.PI * 1.5, dir: 1 });
        put('arc', { cx: round4(cR.x), cy: round4(cR.y), r: round4(rS), a0: -Math.PI / 2, a1: Math.PI / 2, dir: 1 });
        return 'AI 自绘：直槽 长 ' + fmt(slotL, 1) + ' × 宽 ' + fmt(slotW, 1) + '（视图中心）';
      }
      return aiReplyText('槽要长和宽，试试「直槽 长60 宽20」');
    }

    /* --- 阶梯轴：长 +  diameters 列表 --- */
    if (/阶梯轴|台阶轴/.test(t)) {
      var totalL = num(/总长(?:度)?\s*([\d.]+)/) || num(/长\s*([\d.]+)/) || 0;
      var diaList = (t.match(/\d+(?:\.\d+)?/g) || []).map(parseFloat);
      var segLenMatch = t.match(/(?:各段|分段)?长度\s*([\d.\s\/,、]+)/);
      var segLens = segLenMatch ? (segLenMatch[1].match(/\d+(?:\.\d+)?/g) || []).map(parseFloat) : [];
      /* 去掉「长」那个数，剩下的当直径序列 */
      var ds = [];
      var mm = t.match(/(?:直径|φ|⌀)\s*([\d.\s\/,、]+)/);
      if (mm) ds = (mm[1].match(/\d+(?:\.\d+)?/g) || []).map(parseFloat);
      if (ds.length < 2) ds = diaList.filter(function (v) { return v !== totalL; });
      if (ds.length >= 2 && (totalL || (segLens.length === ds.length))) {
        var segArr = [];
        if (segLens.length === ds.length) {
          var sumSeg = segLens.reduce(function (a, b) { return a + b; }, 0);
          var scaleSeg = totalL ? (totalL / sumSeg) : 1;
          segArr = segLens.map(function (v) { return v * scaleSeg; });
          if (!totalL) totalL = sumSeg;
        } else {
          for (var k0 = 0; k0 < ds.length; k0++) segArr.push(totalL / ds.length);
        }
        var xStart = c0.x - totalL / 2, xCur = xStart;
        for (var si = 0; si < ds.length; si++) {
          var d = ds[si];
          put('rect', {
            x0: round4(xCur), y0: round4(c0.y - d / 2),
            x1: round4(xCur + segArr[si]), y1: round4(c0.y + d / 2)
          });
          xCur += segArr[si];
        }
        /* 两端中心孔：轴类零件图里用端面中心的小圆示意 */
        var ctrDia = num(/中心孔.*?(?:直径|φ|⌀)\s*([\d.]+)/) || num(/(?:直径|φ|⌀)\s*([\d.]+)\s*(?:的)?中心孔/);
        if (ctrDia) {
          put('circle', { cx: round4(xStart), cy: round4(c0.y), r: round4(ctrDia / 2) });
          put('circle', { cx: round4(xStart + totalL), cy: round4(c0.y), r: round4(ctrDia / 2) });
        }
        return 'AI 自绘：阶梯轴 长 ' + fmt(totalL, 1) + '，' + ds.length + ' 段：⌀' +
          ds.map(function (v, i2) { return fmt(v, 1) + '×' + fmt(segArr[i2], 0); }).join(' / ') +
          (ctrDia ? '，两端中心孔 ⌀' + fmt(ctrDia, 1) : '');
      }
      return aiReplyText('阶梯轴要总长和直径，试试「阶梯轴 长200 直径40/30/20」');
    }

    /* --- 齿轮（简图：齿顶圆/分度圆/齿根圆 + 中心线） --- */
    if (/齿轮/.test(t)) {
      var gz = num(/齿数\s*(\d+)/) || num(/(\d+)\s*齿(?!数)/) || 20;
      var gm = num(/模数\s*([\d.]+)/) || 2;
      var dPitch = gm * gz, dOuter = gm * (gz + 2), dRoot = gm * (gz - 2.5);
      var rP = dPitch / 2, rA = dOuter / 2, rD = Math.max(0.5, dRoot / 2);
      var pitchAng = Math.PI * 2 / gz;
      var halfRoot = pitchAng * 0.27, halfTip = pitchAng * 0.16;
      var toothPts = [];
      for (var ti = 0; ti < gz; ti++) {
        var base = ti * pitchAng;
        toothPts.push({ x: round4(c0.x + rD * Math.cos(base - halfRoot)), y: round4(c0.y + rD * Math.sin(base - halfRoot)) });
        toothPts.push({ x: round4(c0.x + rA * Math.cos(base - halfTip)), y: round4(c0.y + rA * Math.sin(base - halfTip)) });
        toothPts.push({ x: round4(c0.x + rA * Math.cos(base + halfTip)), y: round4(c0.y + rA * Math.sin(base + halfTip)) });
        toothPts.push({ x: round4(c0.x + rD * Math.cos(base + halfRoot)), y: round4(c0.y + rD * Math.sin(base + halfRoot)) });
      }
      var gearE = put('polyline', { pts: toothPts, closed: true });
      gearE.ltype = 'continuous';
      /* 分度圆（点划线） */
      var pitchE = put('circle', { cx: round4(c0.x), cy: round4(c0.y), r: round4(rP) });
      pitchE.layer = (state.layers.some(function (l) { return l.id === 'center'; }) ? 'center' : pitchE.layer);
      pitchE.ltype = 'dashdot';
      /* 轴孔（可选） */
      var boreD = num(/轴孔\s*(?:直径|φ|⌀)?\s*([\d.]+)/) || num(/内孔\s*(?:直径|φ|⌀)?\s*([\d.]+)/);
      if (boreD) put('circle', { cx: round4(c0.x), cy: round4(c0.y), r: round4(boreD / 2) });
      addCenterLines(c0.x, c0.y, rA);
      return 'AI 自绘：齿轮 模数 ' + fmt(gm, 1) + ' × ' + gz + ' 齿（真实齿形）：齿顶圆 ⌀' + fmt(dOuter, 2) +
        ' / 分度圆 ⌀' + fmt(dPitch, 2) + ' / 齿根圆 ⌀' + fmt(dRoot, 2) + (boreD ? ' / 轴孔 ⌀' + fmt(boreD, 2) : '');
    }

    /* --- 沉孔（同轴双圆 + 可选阵列） --- */
    if (/沉孔/.test(t)) {
      var cbD = num(/(?:沉孔|沉头)(?:直径|φ|⌀)?\s*([\d.]+)/) || num(/沉孔.*?(?:直径|φ|⌀)\s*([\d.]+)/);
      var thruD = num(/通孔\s*(?:直径|φ|⌀)?\s*([\d.]+)/) || num(/过孔\s*(?:直径|φ|⌀)?\s*([\d.]+)/);
      var cbN = num(/(\d+)\s*(?:个|处)/) || 1;
      var cbPcd = num(/均布.*?(?:直径|φ|⌀)\s*([\d.]+)/);
      if (cbD && thruD) {
        for (var ci = 0; ci < Math.round(cbN); ci++) {
          var angC = cbN > 1 ? ci * Math.PI * 2 / Math.round(cbN) : 0;
          var cxC = c0.x + (cbN > 1 && cbPcd ? Math.cos(angC) * cbPcd / 2 : 0);
          var cyC = c0.y + (cbN > 1 && cbPcd ? Math.sin(angC) * cbPcd / 2 : 0);
          put('circle', { cx: round4(cxC), cy: round4(cyC), r: round4(cbD / 2) });
          put('circle', { cx: round4(cxC), cy: round4(cyC), r: round4(thruD / 2) });
        }
        return 'AI 自绘：沉孔 ' + fmt(Math.round(cbN), 0) + ' 处（沉孔 ⌀' + fmt(cbD, 2) + ' + 通孔 ⌀' + fmt(thruD, 2) + '）';
      }
      return aiReplyText('沉孔要两个直径，试试「沉孔直径20 通孔直径10」');
    }

    /* --- 垫圈 / 圆环（双圆 + 中心线） --- */
    if (/垫圈|圆环|套圈|隔套/.test(t)) {
      var wOuter = num(/外(?:圆|径|圆直径|直径)\s*(?:直径|φ|⌀)?\s*([\d.]+)/) || num(/(?:直径|φ|⌀)\s*([\d.]+)/);
      var wInner = num(/内(?:圆|孔|径|径直径)\s*(?:直径|φ|⌀)?\s*([\d.]+)/) || num(/内孔\s*(?:直径|φ|⌀)?\s*([\d.]+)/);
      if (wOuter && wInner) {
        put('circle', { cx: round4(c0.x), cy: round4(c0.y), r: round4(wOuter / 2) });
        put('circle', { cx: round4(c0.x), cy: round4(c0.y), r: round4(wInner / 2) });
        addCenterLines(c0.x, c0.y, wOuter / 2);
        return 'AI 自绘：垫圈 外径 ⌀' + fmt(wOuter, 2) + ' / 内孔 ⌀' + fmt(wInner, 2) + '（视图中心）';
      }
      return aiReplyText('垫圈要内外径，试试「垫圈 外径40 内径20」');
    }

    /* --- 键槽轴（轴 + 顶部键槽） --- */
    if (/键槽/.test(t) && /轴/.test(t)) {
      var kd = num(/(?:轴)?(?:直径|φ|⌀)\s*([\d.]+)/) || num(/([\d.]+)\s*(?:的)?轴/);
      var kL = num(/长(?:度)?\s*([\d.]+)/) || 0;
      var kW = num(/键槽\s*(?:宽)?\s*([\d.]+)/) || num(/宽\s*([\d.]+)/) || 12;
      var kSlotL = num(/键槽\s*长\s*([\d.]+)/) || num(/槽长\s*([\d.]+)/) || Math.min(kL ? kL * 0.4 : 50, 60);
      if (kd && kL) {
        put('rect', { x0: round4(c0.x - kL / 2), y0: round4(c0.y - kd / 2), x1: round4(c0.x + kL / 2), y1: round4(c0.y + kd / 2) });
        /* 键槽：轴顶部一个 U 形槽（两线 + 两半圆） */
        var kTop = c0.y - kd / 2;
        var kHalf = kW / 2, kX0 = c0.x - kSlotL / 2, kX1 = c0.x + kSlotL / 2;
        put('line', { x0: round4(kX0), y0: round4(kTop), x1: round4(kX0), y1: round4(kTop + kHalf) });
        put('line', { x0: round4(kX1), y0: round4(kTop), x1: round4(kX1), y1: round4(kTop + kHalf) });
        put('line', { x0: round4(kX0), y0: round4(kTop + kHalf), x1: round4(kX1), y1: round4(kTop + kHalf) });
        addCenterLines(c0.x, c0.y, Math.max(kd, 20) / 2);
        return 'AI 自绘：键槽轴 ⌀' + fmt(kd, 2) + ' × 长 ' + fmt(kL, 2) + '，键槽 宽 ' + fmt(kW, 2) + ' 长 ' + fmt(kSlotL, 2);
      }
      return aiReplyText('键槽轴要直径和长度，试试「键槽轴 直径40 长200 键槽宽12 键槽长50」');
    }

    /* --- 带轮 / 端盖 / 轴承盖（法兰式：外圆 + 内孔 + 均布孔） --- */
    if (/带轮|皮带轮|端盖|轴承盖|压盖/.test(t)) {
      var pOuter = num(/外(?:圆|径|圆直径|直径)\s*(?:直径|φ|⌀)?\s*([\d.]+)/) || num(/(?:直径|φ|⌀)\s*([\d.]+)/);
      var pInner = num(/(?:内孔|轴孔|中心孔)\s*(?:直径|φ|⌀)?\s*([\d.]+)/);
      if (pOuter) {
        put('circle', { cx: round4(c0.x), cy: round4(c0.y), r: round4(pOuter / 2) });
        if (pInner) put('circle', { cx: round4(c0.x), cy: round4(c0.y), r: round4(pInner / 2) });
        var mP = t.match(/(\d+)\s*(?:个|只)\s*(?:直径|φ|⌀)\s*([\d.]+)/);
        var pCount = mP ? parseFloat(mP[1]) : 0;
        var pHoleD = mP ? parseFloat(mP[2]) : 0;
        var pPcd = num(/均布.*?(?:直径|φ|⌀)\s*([\d.]+)/);
        if (pCount && pPcd) {
          for (var pi = 0; pi < pCount; pi++) {
            var pa = pi * Math.PI * 2 / pCount;
            put('circle', {
              cx: round4(c0.x + Math.cos(pa) * pPcd / 2),
              cy: round4(c0.y + Math.sin(pa) * pPcd / 2),
              r: round4(pHoleD / 2)
            });
          }
        }
        addCenterLines(c0.x, c0.y, pOuter / 2);
        return 'AI 自绘：' + (/带轮|皮带轮/.test(t) ? '带轮' : '端盖') + ' 外径 ⌀' + fmt(pOuter, 2) +
          (pInner ? ' / 内孔 ⌀' + fmt(pInner, 2) : '') +
          (pCount && pPcd ? ' / ' + pCount + '×⌀' + fmt(pHoleD, 2) + ' 均布 ⌀' + fmt(pPcd, 2) : '');
      }
      return aiReplyText('带轮/端盖要外径，试试「带轮 外径160 轴孔30 4个直径12的孔 均布直径120」');
    }

    /* --- 只报孔阵列/均布孔 --- */
    if (boltCount && boltPcd) {
      var n0 = Math.round(boltCount), r0 = (boltDia || 10) / 2;
      for (var k = 0; k < n0; k++) {
        var ang0 = k * Math.PI * 2 / n0;
        put('circle', {
          cx: round4(c0.x + Math.cos(ang0) * boltPcd / 2),
          cy: round4(c0.y + Math.sin(ang0) * boltPcd / 2),
          r: round4(r0)
        });
      }
      return 'AI 自绘：' + n0 + '×⌀' + fmt(boltDia || 10, 1) + ' 孔，均布在 ⌀' + fmt(boltPcd, 1) + ' 圆周上';
    }
    return null;
  }

  function aiApply(text) {
    var t = String(text || '').replace(/[，。；、]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return aiReplyText('写一句话，例如：画一条长120的线');
    if (/自动标注|标一下|自动尺寸|一键标注/.test(t)) {
      autoDimSelection();
      return aiReplyText('已按选中对象自动标注长宽');
    }
    var tpl = aiDraw(t);
    if (tpl) return aiReplyText(tpl);
    var sel = selectedEntities();
    var MOD = /(改成|改为|设为|改到|变成|调整成|变为)/;

    /* --- 修改类（需要选中） --- */
    if (/删除|清除|移除/.test(t) && /选[中择]|它|这/.test(t)) {
      if (!state.selection.size) return aiReplyText('先选中要删除的对象（点一下或框选），再说“删除选中的”');
      var n0 = state.selection.size;
      deleteSelection();
      return aiReplyText('已删除 ' + n0 + ' 个对象');
    }
    if (/半径/.test(t) && MOD.test(t)) {
      var r = aiNum(t, /(?:改成|改为|设为|改到|变成|调整成|变为)\s*([\d.]+)/);
      var circles = sel.filter(function (e) { return e.kind === 'circle'; });
      if (!circles.length) return aiReplyText('先选中一个圆，再说“半径改成 N”');
      if (r == null) return aiReplyText('没听清半径数值，试试“把选中的圆半径改成50”');
      var b1 = snapshot();
      circles.forEach(function (e) { e.r = round4(r); });
      pushUndo(b1, 'AI 改半径');
      afterChange();
      return aiReplyText('已把 ' + circles.length + ' 个圆的半径改为 ' + fmt(r, 2) + ' mm');
    }
    if (/(长度|长)/.test(t) && MOD.test(t) && /线/.test(t) && !/矩/.test(t)) {
      var len = aiNum(t, /(?:改成|改为|设为|改到|变成|调整成|变为)\s*([\d.]+)/);
      var lines = sel.filter(function (e) { return e.kind === 'line'; });
      if (!lines.length) return aiReplyText('先选中一条直线，再说“长度改成 N”');
      if (len == null || len <= 0) return aiReplyText('没听清长度数值，试试“把选中的线长度改成200”');
      var b2 = snapshot();
      lines.forEach(function (e) {
        var a = Math.atan2(e.y1 - e.y0, e.x1 - e.x0);
        e.x1 = round4(e.x0 + Math.cos(a) * len);
        e.y1 = round4(e.y0 + Math.sin(a) * len);
      });
      pushUndo(b2, 'AI 改长度');
      afterChange();
      return aiReplyText('已把 ' + lines.length + ' 条线的长度改为 ' + fmt(len, 2) + ' mm');
    }
    if (/矩/.test(t) && /(宽|高)/.test(t) && MOD.test(t)) {
      var rects = sel.filter(function (e) { return e.kind === 'rect'; });
      if (!rects.length) return aiReplyText('先选中一个矩形，再说“宽度改成 N / 高度改成 N”');
      var wv = aiNum(t, /(?:宽度|宽)\s*(?:改成|改为|设为|改到|变成|调整成|变为)\s*([\d.]+)/);
      var hv = aiNum(t, /(?:高度|高)\s*(?:改成|改为|设为|改到|变成|调整成|变为)\s*([\d.]+)/);
      if (wv == null && hv == null) return aiReplyText('没听清尺寸，试试“宽度改成150”');
      var b3 = snapshot();
      rects.forEach(function (e) {
        if (wv != null) { var sx = e.x1 >= e.x0 ? 1 : -1; e.x1 = round4(e.x0 + sx * wv); }
        if (hv != null) { var sy = e.y1 >= e.y0 ? 1 : -1; e.y1 = round4(e.y0 + sy * hv); }
      });
      pushUndo(b3, 'AI 改矩形尺寸');
      afterChange();
      return aiReplyText('已更新 ' + rects.length + ' 个矩形：' +
        (wv != null ? '宽 ' + fmt(wv, 2) + ' ' : '') + (hv != null ? '高 ' + fmt(hv, 2) : ''));
    }

    /* --- 创建类 --- */
    var c0 = viewCenterWorld();
    var ang = aiNum(t, /角度\s*(-?[\d.]+)/);
    if (/圆弧|弧/.test(t)) {
      var ar = aiNum(t, /半径\s*(?:是|为)?\s*([\d.]+)/) || aiNum(t, /([\d.]+)\s*(?:的)?\s*半径/);
      if (ar) {
        var sweep = ang == null ? 90 : Math.abs(ang);
        aiCreate('arc', state.curLayer, {
          cx: round4(c0.x), cy: round4(c0.y), r: round4(ar),
          a0: 0, a1: rad(sweep), dir: 1
        }, 'AI 画圆弧');
        return aiReplyText('已画圆弧：R ' + fmt(ar, 2) + '，圆心角 ' + fmt(sweep, 1) + '°');
      }
    }
    if (/圆/.test(t)) {
      var rr = aiNum(t, /半径\s*(?:是|为)?\s*([\d.]+)/) || aiNum(t, /([\d.]+)\s*(?:的)?\s*半径/);
      var dd = aiNum(t, /直径\s*(?:是|为)?\s*([\d.]+)/);
      if (dd != null && rr == null) rr = dd / 2;
      if (rr) {
        aiCreate('circle', state.curLayer, { cx: round4(c0.x), cy: round4(c0.y), r: round4(rr) }, 'AI 画圆');
        return aiReplyText('已画圆：R ' + fmt(rr, 2) + '（圆心在视图中心）');
      }
    }
    if (/矩|方框/.test(t)) {
      var mR = t.match(/([\d.]+)\s*[x×*]\s*([\d.]+)/) || t.match(/(?:长|宽)\s*([\d.]+)[^\d]+(?:宽|高)\s*([\d.]+)/);
      if (mR) {
        var W = parseFloat(mR[1]), H = parseFloat(mR[2]);
        if (W && H) {
          aiCreate('rect', state.curLayer, {
            x0: round4(c0.x - W / 2), y0: round4(c0.y - H / 2),
            x1: round4(c0.x + W / 2), y1: round4(c0.y + H / 2)
          }, 'AI 画矩形');
          return aiReplyText('已画矩形：' + fmt(W, 2) + ' × ' + fmt(H, 2) + '（视图中心）');
        }
      }
      return aiReplyText('矩形要两个尺寸，试试“画矩形120x80”');
    }
    if (/(直线|线段|线)/.test(t) && !/多段|折线/.test(t)) {
      var L = aiNum(t, /(?:长度|长)\s*(?:是|为)?\s*([\d.]+)/) || aiNum(t, /([\d.]+)\s*(?:的)?\s*(?:直线|线段|线)/);
      if (L) {
        var a2 = rad(ang == null ? 0 : ang);
        aiCreate('line', state.curLayer, {
          x0: round4(c0.x), y0: round4(c0.y),
          x1: round4(c0.x + Math.cos(a2) * L), y1: round4(c0.y + Math.sin(a2) * L)
        }, 'AI 画线');
        return aiReplyText('已画直线：长 ' + fmt(L, 2) + '，角度 ' + fmt(ang == null ? 0 : ang, 1) + '°（从视图中心起）');
      }
    }
    if (/多段|折线/.test(t)) {
      return aiReplyText('多段线需要点位，建议直接在画布上点；AI 这里先支持线 / 矩形 / 圆 / 圆弧');
    }
    return aiReplyText('没听懂。可用示例：画一条长120的线 · 画矩形120x80 · 画圆半径30 · 把选中的圆半径改成50 · 删除选中的');
  }

  /* ---------------- 对外接口 ---------------- */
  window.MDraw = {
    build: build,
    show: show,
    hide: hide,
    isVisible: isVisible,
    entities: function () { return state.entities; },
    selected: function () { return selectedEntities()[0] || null; },
    fit: fit,
    setTool: setTool,
    exportDXF: exportDXF,
    grid: function (v) {
      if (isFinite(v) && v > 0) { state.grid = v; drawGrid(true); updateStatus(); scheduleSave(); }
      return state.grid;
    },
    state: function () { return state; },
    aiDrawText: function (text) { if (!built) build(); return aiApply(text); },
    dxfText: function () { return lastDxfText; },
    entityCount: function () { return state.entities.length; },
    cmd: function (name) { startCmd(name); },
    space: function (name) { if (name) setSpace(name); return state.space; }
  };
})();
