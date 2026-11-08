/* =============================================================================
   参数化草图 · DXF 读写（AutoCAD R12 / AC1009，ASCII）
   -----------------------------------------------------------------------------
   设计目标：
     1. exportDXF 产出的文件能被 AutoCAD 直接打开，不触发「修复 / AUDIT」告警；
     2. importDXF 足够宽容：R12 与 R2000+ 的组码流都能吃，不认识的实体只记 warning；
     3. 零依赖、纯 ES Module，node 里可直接 import 跑单元测试（不碰 DOM）。

   坐标与角度约定：
     - 与模型一致：右手系、Y 轴向上、单位由 doc.units 决定；
     - 模型里 arc 的 a0/a1 是弧度；DXF 的 ARC 50/51 是「度」，所以导出时转度，
       读入时保留文件里的度值原样返回（不归一化，保证 export→import 往返逐位一致）。
   ========================================================================== */

import { deg } from './math.js';

/** DXF 默认图层名 */
export const LAYER_DEFAULT = '0';
/** 构造几何图层名 */
export const LAYER_CONSTRUCTION = 'CONSTRUCTION';
/** 尺寸标注图层名（导出的标注线/文字放这里，便于在 CAD 里单独关层） */
export const LAYER_DIM = 'DIM';

const DECIMALS = 6;        // 数值小数位（随后手动去尾零）
const MAX_LAYER_LEN = 31;  // R12 图层名长度上限
const DIM_TEXT_H = 3.5;    // 标注文字字高（mm）
const DIM_OFFSET = 8;      // 尺寸线偏移（mm）
const DIM_ARROW = 2.5;     // 箭头长度（mm）

/* =============================================================================
   数值 / 名称工具
   ========================================================================== */

/**
 * 数值格式化：固定 6 位小数 → 去尾零 → 去掉 "-0"。
 * 例：1.5 -> "1.5"；2 -> "2"；-1e-9 -> "0"；0.000001 -> "0.000001"
 */
function fmt(v) {
  let n = Number(v);
  if (!Number.isFinite(n)) n = 0;
  if (Object.is(n, -0)) n = 0;
  if (Math.abs(n) >= 1e21) return String(n); // 极端量级避免 toFixed 转成指数
  let s = n.toFixed(DECIMALS);
  if (s.indexOf('.') !== -1) {
    s = s.replace(/0+$/, '');
    if (s.endsWith('.')) s = s.slice(0, -1);
  }
  if (s === '-0') s = '0';
  return s;
}

/**
 * 图层名消毒：R12 图层名不能含 < > / \ " : ; ? * | = 与空白，
 * 统一换成 "_"，并截断到 31 字符（超长会让部分读取器报警）。
 */
function sanitizeLayerName(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  s = s.replace(/[<>\/\\":;?*|=,\s]/g, '_');
  if (s.length > MAX_LAYER_LEN) s = s.slice(0, MAX_LAYER_LEN);
  return s;
}

/** 颜色号夹到 1..255（DXF 合法范围），非法则用兜底色 */
function clampColor(raw, fallback) {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 1 || n > 255) return fallback;
  return n;
}

/* =============================================================================
   导出
   ========================================================================== */

/**
 * 收集图层的最终清单。
 * 规则：opts.layers 优先；但 "0" 层必须存在且排第一（AutoCAD 的默认层 / 当前层），
 *      实体实际用到的层（如 CONSTRUCTION）若没被声明就自动补上，避免打开时被
 *      AutoCAD 自动建层而触发审计提示。
 */
function buildLayerTable(doc, opts) {
  const out = [];
  const seen = new Set();
  const add = (name, color) => {
    const n = sanitizeLayerName(name);
    if (!n) return;
    const key = n.toUpperCase(); // DXF 图层名大小写不敏感，按大写去重
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: n, color: clampColor(color, key === LAYER_CONSTRUCTION ? 8 : 7) });
  };

  const input = Array.isArray(opts.layers) && opts.layers.length ? opts.layers : null;
  const zero = input
    ? input.find((l) => l && String(l.name == null ? '' : l.name).trim().toUpperCase() === LAYER_DEFAULT)
    : null;
  add(zero ? zero.name : LAYER_DEFAULT, zero ? zero.color : 7); // "0" 永远第一位
  if (input) for (const l of input) if (l) add(l.name, l.color);

  for (const e of doc.entities.values()) {
    if (e && e.construction === true) { add(LAYER_CONSTRUCTION, 8); break; }
  }
  if (!input) add(LAYER_CONSTRUCTION, 8); // 默认配置下 CONSTRUCTION 层总是写上
  if (opts.dimensions !== false && hasDimConstraints(doc)) add(LAYER_DIM, 1);
  return out;
}

/** 计算 $EXTMIN / $EXTMAX（圆与弧用保守的整圆包围盒，避免漏掉可见范围） */
function docBounds(doc) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  for (const e of doc.entities.values()) {
    try {
      if (e.type === 'point') grow(e.x, e.y);
      else if (e.type === 'line') {
        const a = doc.pointOf(e.p1); const b = doc.pointOf(e.p2);
        grow(a.x, a.y); grow(b.x, b.y);
      } else if (e.type === 'circle' || e.type === 'arc') {
        const c = doc.pointOf(e.center);
        const r = Math.abs(Number(e.r) || 0);
        grow(c.x - r, c.y - r); grow(c.x + r, c.y + r);
      }
    } catch {
      /* 引用损坏的实体：算包围盒时跳过，导出实体时同样跳过 */
    }
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

/** 实体所属图层：构造几何去 CONSTRUCTION，其余去 "0" */
function layerForEntity(e) {
  return e && e.construction === true ? LAYER_CONSTRUCTION : LAYER_DEFAULT;
}

/* =============================================================================
   尺寸标注 → DXF 实体（LINE + TEXT）
   说明：R12 的 DIMENSION 实体依赖块定义，跨软件兼容性差；这里把标注拆成
   「标注线 + 文字」，任何 CAD 都能打开、能单独关层、打印效果也稳定。
   ========================================================================== */

const DIM_TYPES = new Set(['distance', 'distanceX', 'distanceY', 'radius', 'diameter', 'angle']);

function hasDimConstraints(doc) {
  if (!doc.constraints || typeof doc.constraints.values !== 'function') return false;
  for (const c of doc.constraints.values()) if (c && DIM_TYPES.has(c.type)) return true;
  return false;
}

function vsub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
function vunit(v) { const L = Math.hypot(v.x, v.y) || 1; return { x: v.x / L, y: v.y / L }; }
function vadd(p, v, k) { return { x: p.x + v.x * k, y: p.y + v.y * k }; }
function vnorm(v) { return { x: -v.y, y: v.x }; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function dimTextValue(v) {
  const n = Math.round(Number(v) * 1000) / 1000;
  return String(n);
}

/** 生成标注图元（world 坐标），返回 {lines:[[p1,p2]...], texts:[{p,text,rot}]} */
function dimGeometry(doc, c) {
  const lines = [];
  const texts = [];
  const a = c.refs || {};
  const P = (ref) => doc.pointOf(ref);

  if (c.type === 'distance') {
    const p1 = P(a.a), p2 = P(a.b);
    const d = vunit(vsub(p2, p1));
    if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 1e-6) return { lines, texts };
    const n = vnorm(d);
    const q1 = vadd(p1, n, DIM_OFFSET), q2 = vadd(p2, n, DIM_OFFSET);
    lines.push([p1, q1], [p2, q2], [q1, q2]);
    // 箭头
    const arrow = (tip, dir) => {
      const back = vadd(tip, dir, DIM_ARROW);
      const side = vnorm(dir);
      lines.push([tip, vadd(back, side, DIM_ARROW * 0.42)]);
      lines.push([tip, vadd(back, { x: -side.x, y: -side.y }, DIM_ARROW * 0.42)]);
    };
    arrow(q1, d); arrow(q2, { x: -d.x, y: -d.y });
    const mid = { x: (q1.x + q2.x) / 2, y: (q1.y + q2.y) / 2 };
    const tp = vadd(mid, n, DIM_TEXT_H * 0.9);
    texts.push({ p: tp, text: dimTextValue(c.value), rot: (Math.atan2(d.y, d.x) * 180) / Math.PI });
    return { lines, texts };
  }

  if (c.type === 'distanceX' || c.type === 'distanceY') {
    const p1 = P(a.a), p2 = P(a.b);
    let q1, q2, rot = 0;
    if (c.type === 'distanceX') {
      const y = (p1.y + p2.y) / 2 + DIM_OFFSET;
      q1 = { x: p1.x, y }; q2 = { x: p2.x, y };
      lines.push([p1, q1], [p2, q2], [q1, q2]);
    } else {
      const x = (p1.x + p2.x) / 2 + DIM_OFFSET;
      q1 = { x, y: p1.y }; q2 = { x, y: p2.y };
      lines.push([p1, q1], [p2, q2], [q1, q2]);
      rot = 90;
    }
    const mid = { x: (q1.x + q2.x) / 2, y: (q1.y + q2.y) / 2 };
    const n = c.type === 'distanceX' ? { x: 0, y: 1 } : { x: 1, y: 0 };
    texts.push({ p: vadd(mid, n, DIM_TEXT_H * 0.9), text: dimTextValue(c.value), rot });
    return { lines, texts };
  }

  if (c.type === 'radius' || c.type === 'diameter') {
    const e = doc.circleOf(a.circle);
    const ctr = P(e.center);
    const ang = Math.PI / 4;
    const tip = { x: ctr.x + e.r * Math.cos(ang), y: ctr.y + e.r * Math.sin(ang) };
    const lead = { x: tip.x + 6, y: tip.y + 6 };
    lines.push([ctr, lead]);
    const label = (c.type === 'diameter' ? '%%c' : 'R') + dimTextValue(c.value);
    texts.push({ p: { x: lead.x + 1, y: lead.y + 1 }, text: label, rot: 45 });
    return { lines, texts };
  }

  if (c.type === 'angle') {
    const l1 = doc.lineOf(a.a), l2 = doc.lineOf(a.b);
    const a1 = P(l1.p1), b1 = P(l1.p2), a2 = P(l2.p1), b2 = P(l2.p2);
    const d1 = vsub(b1, a1), d2 = vsub(b2, a2);
    const den = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(den) < 1e-9) return { lines, texts };
    const t = ((a2.x - a1.x) * d2.y - (a2.y - a1.y) * d2.x) / den;
    const ip = { x: a1.x + t * d1.x, y: a1.y + t * d1.y };
    const A1 = Math.atan2(d1.y, d1.x), A2 = Math.atan2(d2.y, d2.x);
    let sweep = A2 - A1;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    const R = 12;
    const N = 24;
    let prev = { x: ip.x + R * Math.cos(A1), y: ip.y + R * Math.sin(A1) };
    for (let i = 1; i <= N; i++) {
      const ang = A1 + (sweep * i) / N;
      const p = { x: ip.x + R * Math.cos(ang), y: ip.y + R * Math.sin(ang) };
      lines.push([prev, p]);
      prev = p;
    }
    const midA = A1 + sweep / 2;
    const tp = { x: ip.x + (R + 4) * Math.cos(midA), y: ip.y + (R + 4) * Math.sin(midA) };
    texts.push({ p: tp, text: dimTextValue(c.value) + '%%d', rot: 0 });
    return { lines, texts };
  }

  return { lines, texts };
}

/** 把标注写进 ENTITIES 段 */
function emitDim(rec, doc, c) {
  if (!c || !DIM_TYPES.has(c.type)) return;
  const { lines, texts } = dimGeometry(doc, c);
  for (const [p1, p2] of lines) {
    rec(0, 'LINE');
    rec(8, LAYER_DIM);
    rec(10, fmt(p1.x)); rec(20, fmt(p1.y)); rec(30, '0');
    rec(11, fmt(p2.x)); rec(21, fmt(p2.y)); rec(31, '0');
  }
  for (const t of texts) {
    rec(0, 'TEXT');
    rec(8, LAYER_DIM);
    rec(10, fmt(t.p.x)); rec(20, fmt(t.p.y)); rec(30, '0');
    rec(40, fmt(DIM_TEXT_H));
    rec(1, String(t.text));
    if (t.rot) rec(50, fmt(t.rot));
  }
}

/**
 * 导出 DXF R12 文本。
 * @param {import('./model.js').Doc} doc
 * @param {{layers?: Array<{name:string,color:number}>}} [opts]
 * @returns {string} 完整 DXF 文本（行尾 CRLF，末行 EOF 后带回车换行）
 */
export function exportDXF(doc, opts = {}) {
  if (!doc || typeof doc !== 'object' || !doc.entities || typeof doc.entities.values !== 'function') {
    throw new Error('exportDXF: 需要 model.js 的 Doc 实例');
  }

  const lines = [];
  /** 写一个组码对：先码后值（DXF 的组码流就是「码行 + 值行」交替） */
  const rec = (code, value) => { lines.push(String(code)); lines.push(String(value)); };

  const layers = buildLayerTable(doc, opts);
  const bb = docBounds(doc);
  // 单位：$MEASUREMENT 1=公制 0=英制（doc.units 为 inch 时按英制写）
  const metric = String(doc.units || 'mm').toLowerCase() !== 'inch' ? 1 : 0;

  /* ---------------- HEADER ---------------- */
  rec(0, 'SECTION'); rec(2, 'HEADER');
  rec(9, '$ACADVER'); rec(1, 'AC1009');          // R12
  rec(9, '$INSBASE'); rec(10, '0'); rec(20, '0'); rec(30, '0');
  rec(9, '$EXTMIN'); rec(10, fmt(bb.x0)); rec(20, fmt(bb.y0)); rec(30, '0');
  rec(9, '$EXTMAX'); rec(10, fmt(bb.x1)); rec(20, fmt(bb.y1)); rec(30, '0');
  rec(9, '$MEASUREMENT'); rec(70, String(metric));
  rec(0, 'ENDSEC');

  /* ---------------- TABLES ---------------- */
  rec(0, 'SECTION'); rec(2, 'TABLES');

  // LTYPE：R12 的线型表字段是 2/70/3/72/73/40，缺 72/73/40 时部分读取器会报错
  rec(0, 'TABLE'); rec(2, 'LTYPE'); rec(70, '1');
  rec(0, 'LTYPE');
  rec(2, 'CONTINUOUS');
  rec(70, '0');                 // 64=被外部引用；0=普通
  rec(3, 'Solid line');
  rec(72, '65');                // 对齐方式：65 = A（两端对齐）
  rec(73, '0');                 // 虚线段数为 0（实线）
  rec(40, '0');                 // 线型总长度
  rec(0, 'ENDTAB');

  // LAYER：字段 2/70/62/6，6 必须是已定义的线型名
  rec(0, 'TABLE'); rec(2, 'LAYER'); rec(70, String(layers.length));
  for (const l of layers) {
    rec(0, 'LAYER');
    rec(2, l.name);
    rec(70, '0');
    rec(62, String(l.color));
    rec(6, 'CONTINUOUS');
  }
  rec(0, 'ENDTAB');

  rec(0, 'ENDSEC');

  /* ---------------- BLOCKS（空段） ----------------
     R12 的完整体例里 BLOCKS 段是常规必备段；这里没有块定义，写一个空段即可，
     比整段缺失更保守（个别第三方读取器缺失该段会报结构不完整）。 */
  rec(0, 'SECTION'); rec(2, 'BLOCKS'); rec(0, 'ENDSEC');

  /* ---------------- ENTITIES ---------------- */
  rec(0, 'SECTION'); rec(2, 'ENTITIES');
  // 被线端点 / 圆心引用的点实体：导出时默认仍写成 POINT，
  // opts.skipReferencedPoints=true 时跳过，避免交点处多出小点影响图面。
  const referencedPts = new Set();
  for (const e of doc.entities.values()) {
    if (!e) continue;
    if (e.type === 'line') { referencedPts.add(e.p1); referencedPts.add(e.p2); }
    else if (e.type === 'circle' || e.type === 'arc') referencedPts.add(e.center);
  }
  const skipRefPts = opts.skipReferencedPoints === true;
  for (const e of doc.entities.values()) {
    if (!e) continue;
    const layer = layerForEntity(e);
    try {
      switch (e.type) {
        case 'line': {
          const a = doc.pointOf(e.p1);
          const b = doc.pointOf(e.p2);
          rec(0, 'LINE');
          rec(8, layer);
          rec(10, fmt(a.x)); rec(20, fmt(a.y)); rec(30, '0');
          rec(11, fmt(b.x)); rec(21, fmt(b.y)); rec(31, '0');
          break;
        }
        case 'circle': {
          const c = doc.pointOf(e.center);
          rec(0, 'CIRCLE');
          rec(8, layer);
          rec(10, fmt(c.x)); rec(20, fmt(c.y)); rec(30, '0');
          rec(40, fmt(e.r));
          break;
        }
        case 'arc': {
          const c = doc.pointOf(e.center);
          rec(0, 'ARC');
          rec(8, layer);
          rec(10, fmt(c.x)); rec(20, fmt(c.y)); rec(30, '0');
          rec(40, fmt(e.r));
          rec(50, fmt(deg(e.a0)));  // 起始角（度，逆时针）
          rec(51, fmt(deg(e.a1)));  // 终止角（度，逆时针）
          break;
        }
        case 'point': {
          // 注意：被圆/弧圆心、线端点引用的点实体本身也是 doc.entities 的一员，
          // 按「point -> POINT」的约定一并导出，读回时仍是独立点实体。
          if (skipRefPts && referencedPts.has(e.id)) break;
          rec(0, 'POINT');
          rec(8, layer);
          rec(10, fmt(e.x)); rec(20, fmt(e.y)); rec(30, '0');
          break;
        }
        default:
          break; // 未知实体类型：导出侧静默跳过（模型里不该出现）
      }
    } catch {
      /* 端点/圆心引用损坏：跳过该实体，不让整个导出失败 */
    }
  }
  /* ---------------- 尺寸标注（LINE + TEXT，图层 DIM） ---------------- */
  if (opts.dimensions !== false && doc.constraints && typeof doc.constraints.values === 'function') {
    for (const c of doc.constraints.values()) {
      try { emitDim(rec, doc, c); } catch { /* 引用损坏的约束跳过 */ }
    }
  }

  rec(0, 'ENDSEC');
  rec(0, 'EOF');

  return lines.join('\r\n') + '\r\n';
}

/* =============================================================================
   读取
   ========================================================================== */

/**
 * 把文本切成组码对 [{code, value}]。
 * 容忍：BOM、CRLF/LF/CR 混排、空行、码行前后的空白、个别非数字垃圾行（计数后跳过）。
 */
function tokenize(text) {
  const rawLines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  let bad = 0;
  let i = 0;
  while (i < rawLines.length) {
    const codeStr = rawLines[i].replace(/^\uFEFF/, '').replace(/\u0000/g, '').trim();
    if (codeStr === '') { i++; continue; }              // 空行直接跳过
    const code = Number(codeStr);
    if (!Number.isInteger(code) || code < 0 || code > 1071) { bad++; i++; continue; }
    if (i + 1 >= rawLines.length) { bad++; break; }      // 末尾落单的码行
    // 值行只去右侧空白（空字符串是合法值，例如某些块名）
    const value = rawLines[i + 1].replace(/\u0000/g, '').trim();
    pairs.push({ code, value });
    i += 2;
  }
  return { pairs, bad };
}

/** 定位某个 SECTION：返回 { start, end, closed }，start/end 是 pairs 下标 */
function findSection(pairs, name) {
  const want = String(name).toUpperCase();
  for (let i = 0; i + 1 < pairs.length; i++) {
    const a = pairs[i];
    const b = pairs[i + 1];
    if (a.code === 0 && String(a.value).toUpperCase() === 'SECTION'
      && b.code === 2 && String(b.value).toUpperCase() === want) {
      const start = i + 2;
      let end = pairs.length;
      let closed = false;
      for (let j = start; j < pairs.length; j++) {
        if (pairs[j].code === 0 && String(pairs[j].value).toUpperCase() === 'ENDSEC') {
          end = j;
          closed = true;
          break;
        }
      }
      return { start, end, closed };
    }
  }
  return null;
}

/** 把 [start,end) 的组码流按 0 组码切成实体记录 [{type, tags}] */
function splitRecords(pairs, start, end) {
  const records = [];
  let cur = null;
  for (let i = start; i < end; i++) {
    const p = pairs[i];
    if (p.code === 0) {
      cur = { type: String(p.value).toUpperCase(), tags: [] };
      records.push(cur);
    } else if (cur) {
      cur.tags.push(p);
    }
  }
  return records;
}

/** LWPOLYLINE 顶点：10/20 按「10 开新顶点、20 补 Y」的方式配对，42 是凸度 */
function readLwVertices(rec, onBulge) {
  const verts = [];
  let cur = null;
  for (const t of rec.tags) {
    if (t.code === 10) {
      cur = { x: Number(t.value), y: null };
      verts.push(cur);
    } else if (t.code === 20) {
      if (cur && cur.y === null) cur.y = Number(t.value);
    } else if (t.code === 42) {
      if (cur) {
        const b = Number(t.value);
        if (Number.isFinite(b) && Math.abs(b) > 1e-12) onBulge();
      }
    }
  }
  return verts.filter((v) => Number.isFinite(v.x) && Number.isFinite(v.y));
}

/** 顶点序列 -> 线段序列；closed 时补最后一段回到起点。返回生成的段数。 */
function emitSegments(verts, closed, layer, pushLine) {
  const n = verts.length;
  if (n < 2) return 0;
  let count = 0;
  for (let k = 0; k < n - 1; k++) { pushLine(verts[k], verts[k + 1]); count++; }
  if (closed && n > 2) { pushLine(verts[n - 1], verts[0]); count++; }
  return count;
}

/**
 * 解析 DXF 文本为中性图元（不依赖 doc/模型）。
 * @param {string} text
 * @returns {{items: Array<object>, warnings: string[]}}
 */
export function importDXF(text) {
  const items = [];
  const warnings = [];
  const result = { items, warnings };

  if (typeof text !== 'string') {
    warnings.push('输入不是字符串，未解析到任何实体');
    return result;
  }
  const src = text.replace(/^\uFEFF/, '');
  if (src.trim() === '') {
    warnings.push('DXF 内容为空，未解析到任何实体');
    return result;
  }

  const { pairs, bad } = tokenize(src);
  if (bad > 0) warnings.push('组码流有 ' + bad + ' 行无法识别，已跳过');
  if (!pairs.length) {
    warnings.push('DXF 内容为空，未解析到任何实体');
    return result;
  }

  const sec = findSection(pairs, 'ENTITIES');
  if (!sec) {
    warnings.push('未找到 ENTITIES 段');
    return result;
  }
  if (!sec.closed) warnings.push('ENTITIES 段缺少 ENDSEC，已按文件末尾结束解析');

  const records = splitRecords(pairs, sec.start, sec.end);

  /* 组码读取小工具 */
  const numTag = (rec, code) => {
    for (const t of rec.tags) {
      if (t.code === code) {
        const n = Number(t.value);
        return Number.isFinite(n) ? n : null;
      }
    }
    return null;
  };
  const strTag = (rec, code) => {
    for (const t of rec.tags) if (t.code === code) return String(t.value).trim();
    return null;
  };
  const layerOf = (rec) => {
    const l = strTag(rec, 8);
    return l ? l : LAYER_DEFAULT; // 缺 8 组码按默认层处理
  };

  const unsupported = new Map(); // 类型 -> 个数
  let bulgeIgnored = 0;          // 被忽略的 bulge 段数
  let malformed = 0;             // 缺组码/几何无效而被跳过的实体数

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    switch (r.type) {
      case 'LINE': {
        const x1 = numTag(r, 10); const y1 = numTag(r, 20);
        const x2 = numTag(r, 11); const y2 = numTag(r, 21);
        if (x1 === null || y1 === null || x2 === null || y2 === null) { malformed++; break; }
        items.push({ type: 'line', x1, y1, x2, y2, layer: layerOf(r) });
        break;
      }
      case 'CIRCLE': {
        const cx = numTag(r, 10); const cy = numTag(r, 20); const rr = numTag(r, 40);
        if (cx === null || cy === null || rr === null || !(rr > 0)) { malformed++; break; }
        items.push({ type: 'circle', cx, cy, r: rr, layer: layerOf(r) });
        break;
      }
      case 'ARC': {
        const cx = numTag(r, 10); const cy = numTag(r, 20); const rr = numTag(r, 40);
        const a0 = numTag(r, 50); const a1 = numTag(r, 51);
        if (cx === null || cy === null || rr === null || !(rr > 0) || a0 === null || a1 === null) {
          malformed++;
          break;
        }
        // DXF 的 50/51 就是「度」；原样返回，不去归一化，保证与导出值逐位一致
        items.push({ type: 'arc', cx, cy, r: rr, a0, a1, layer: layerOf(r) });
        break;
      }
      case 'POINT': {
        const x = numTag(r, 10); const y = numTag(r, 20);
        if (x === null || y === null) { malformed++; break; }
        items.push({ type: 'point', x, y, layer: layerOf(r) });
        break;
      }
      case 'LWPOLYLINE': {
        const verts = readLwVertices(r, () => { bulgeIgnored++; });
        const closed = ((numTag(r, 70) || 0) & 1) === 1;
        const layer = layerOf(r);
        const n = emitSegments(verts, closed, layer, (a, b) => {
          items.push({ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer });
        });
        if (n === 0) malformed++;
        break;
      }
      case 'POLYLINE': {
        // 顶点以紧随其后的 VERTEX 记录给出，最后跟一条 SEQEND
        const verts = [];
        const closed = ((numTag(r, 70) || 0) & 1) === 1;
        let j = i + 1;
        while (j < records.length && records[j].type === 'VERTEX') {
          const v = records[j];
          const x = numTag(v, 10); const y = numTag(v, 20);
          const b = numTag(v, 42);
          if (b !== null && Math.abs(b) > 1e-12) bulgeIgnored++;
          if (x !== null && y !== null) verts.push({ x, y });
          j++;
        }
        if (j < records.length && records[j].type === 'SEQEND') j++;
        const layer = layerOf(r);
        const n = emitSegments(verts, closed, layer, (a, b) => {
          items.push({ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer });
        });
        if (n === 0) malformed++;
        i = j - 1; // 跳过已消费的 VERTEX/SEQEND
        break;
      }
      case 'VERTEX':
      case 'SEQEND':
        break; // 正常情况已被 POLYLINE 消费；孤立出现时忽略
      case 'ENDSEC':
      case 'EOF':
      case 'SECTION':
      case 'TABLE':
      case 'ENDTAB':
        break; // 结构性组码，出现在实体流里也忽略
      default: {
        const key = String(r.type || '(空类型)');
        unsupported.set(key, (unsupported.get(key) || 0) + 1);
        break;
      }
    }
  }

  for (const [type, n] of unsupported) warnings.push('跳过实体 ' + type + ' ' + n + ' 个');
  if (bulgeIgnored > 0) {
    warnings.push('多段线的 bulge（凸度弧段）共 ' + bulgeIgnored + ' 处已忽略，按直线段处理');
  }
  if (malformed > 0) warnings.push('有 ' + malformed + ' 个实体缺少必要组码或几何无效，已跳过');

  return result;
}
