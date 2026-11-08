/* =============================================================================
   参数化草图 · SVG 渲染器
   视图矩阵与屏幕坐标分离：屏幕 = 世界 × scale + 偏移，y 轴翻转（世界 y 向上）。
   ========================================================================== */

import { norm2pi, deg } from './math.js';
import { CONSTRAINT_META } from './constraints.js';

const COL = {
  paper: '#f8f9fb',
  gridMinor: '#e6eaf1',
  gridMajor: '#d3dae6',
  axis: '#b6c0d0',
  geo: '#1f4e79',
  geoHover: '#2f7fd1',
  sel: '#0b74de',
  construction: '#94a3b8',
  point: '#1f4e79',
  pointFixed: '#7c3aed',
  dim: '#b03a2e',
  glyph: '#0f766e',
  conflict: '#dc2626',
  text: '#334155',
};

function esc(s) {
  return String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

function fmt(v, n = 2) {
  const t = Math.abs(v) < 1e-9 ? 0 : v;
  return (Math.round(t * Math.pow(10, n)) / Math.pow(10, n)).toFixed(n).replace(/\.?0+$/, '');
}

export class Renderer {
  constructor(svg) {
    this.svg = svg;
    this.W = 800;
    this.H = 600;
    this.view = { scale: 3.2, ox: 120, oy: 520 };
    this._buildLayers();
  }

  _buildLayers() {
    const NS = 'http://www.w3.org/2000/svg';
    this.svg.innerHTML = '';
    const mk = (name) => {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('data-layer', name);
      this.svg.appendChild(g);
      return g;
    };
    this.bg = mk('bg');
    this.grid = mk('grid');
    this.ents = mk('entities');
    this.dims = mk('dims');
    this.glyphs = mk('glyphs');
    this.points = mk('points');
    this.overlay = mk('overlay');
  }

  setSize(w, h) {
    this.W = w; this.H = h;
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }

  /* --- 坐标变换 --- */
  sx(wx) { return wx * this.view.scale + this.view.ox; }
  sy(wy) { return -wy * this.view.scale + this.view.oy; }
  wx(px) { return (px - this.view.ox) / this.view.scale; }
  wy(py) { return (this.view.oy - py) / this.view.scale; }
  toScreen(wx, wy) { return [this.sx(wx), this.sy(wy)]; }

  zoomAt(px, py, factor) {
    const wx = this.wx(px), wy = this.wy(py);
    this.view.scale = Math.max(0.02, Math.min(200, this.view.scale * factor));
    this.view.ox = px - wx * this.view.scale;
    this.view.oy = py + wy * this.view.scale;
  }

  pan(dx, dy) { this.view.ox += dx; this.view.oy += dy; }

  fit(doc) {
    const b = this.bounds(doc);
    if (!b) return;
    const pad = 60;
    const w = Math.max(b.x1 - b.x0, 1e-6);
    const h = Math.max(b.y1 - b.y0, 1e-6);
    const s = Math.min((this.W - pad * 2) / w, (this.H - pad * 2) / h);
    this.view.scale = Math.max(0.05, Math.min(80, s));
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    this.view.ox = this.W / 2 - cx * this.view.scale;
    this.view.oy = this.H / 2 + cy * this.view.scale;
  }

  bounds(doc) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const put = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const e of doc.entities.values()) {
      if (e.type === 'point') put(e.x, e.y);
      else if (e.type === 'line') { const a = doc.pointOf(e.p1), b = doc.pointOf(e.p2); put(a.x, a.y); put(b.x, b.y); }
      else if (e.type === 'circle' || e.type === 'arc') {
        const c = doc.pointOf(e.center);
        put(c.x - e.r, c.y - e.r); put(c.x + e.r, c.y + e.r);
      }
    }
    if (!isFinite(x0)) return null;
    return { x0, y0, x1, y1 };
  }

  /* --- 主渲染 --- */
  render(doc, ui = {}) {
    const view = this.view;
    this.grid.innerHTML = this._gridSvg();
    this.ents.innerHTML = this._entitiesSvg(doc, ui);
    this.dims.innerHTML = this._dimsSvg(doc, ui);
    this.glyphs.innerHTML = this._glyphsSvg(doc, ui);
    this.points.innerHTML = this._pointsSvg(doc, ui);
    this.overlay.innerHTML = this._overlaySvg(doc, ui);
  }

  _gridSvg() {
    const { W, H } = this;
    const scale = this.view.scale;
    let step = 1;
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    for (const s of nice) { step = s; if (s * scale >= 22) break; }
    const major = step * 5;
    const x0 = this.wx(0), x1 = this.wx(W), y0 = this.wy(H), y1 = this.wy(0);
    const out = [];
    const line = (x1p, y1p, x2p, y2p, stroke, w) =>
      out.push(`<line x1="${x1p.toFixed(1)}" y1="${y1p.toFixed(1)}" x2="${x2p.toFixed(1)}" y2="${y2p.toFixed(1)}" stroke="${stroke}" stroke-width="${w}"/>`);

    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
      const px = this.sx(x);
      const isMajor = Math.abs(x / major - Math.round(x / major)) < 1e-9;
      line(px, 0, px, H, isMajor ? COL.gridMajor : COL.gridMinor, isMajor ? 1 : 0.8);
    }
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      const py = this.sy(y);
      const isMajor = Math.abs(y / major - Math.round(y / major)) < 1e-9;
      line(0, py, W, py, isMajor ? COL.gridMajor : COL.gridMinor, isMajor ? 1 : 0.8);
    }
    // 世界坐标轴
    const ax = this.sx(0), ay = this.sy(0);
    if (ax >= -1 && ax <= W + 1) line(ax, 0, ax, H, COL.axis, 1.2);
    if (ay >= -1 && ay <= H + 1) line(0, ay, W, ay, COL.axis, 1.2);
    out.push(`<circle cx="${ax}" cy="${ay}" r="3" fill="${COL.axis}"/>`);
    return out.join('');
  }

  _entityPath(e, doc) {
    if (e.type === 'line') {
      const a = doc.pointOf(e.p1), b = doc.pointOf(e.p2);
      return `M ${this.sx(a.x).toFixed(2)} ${this.sy(a.y).toFixed(2)} L ${this.sx(b.x).toFixed(2)} ${this.sy(b.y).toFixed(2)}`;
    }
    if (e.type === 'circle') {
      const c = doc.pointOf(e.center), r = e.r * this.view.scale;
      return `M ${this.sx(c.x) - r} ${this.sy(c.y)} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;
    }
    if (e.type === 'arc') {
      const c = doc.pointOf(e.center), r = e.r * this.view.scale;
      const a0 = this.sx(c.x + e.r * Math.cos(e.a0)), b0 = this.sy(c.y + e.r * Math.sin(e.a0));
      const a1 = this.sx(c.x + e.r * Math.cos(e.a1)), b1 = this.sy(c.y + e.r * Math.sin(e.a1));
      const sweep = norm2pi(e.a1 - e.a0);
      const large = sweep > Math.PI ? 1 : 0;
      return `M ${a0.toFixed(2)} ${b0.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${large} 1 ${a1.toFixed(2)} ${b1.toFixed(2)}`;
    }
    return '';
  }

  _entitiesSvg(doc, ui) {
    const out = [];
    const sel = ui.selection || new Set();
    const hover = ui.hover || {};
    const conflictEnts = ui.conflictEntities || new Set();
    for (const e of doc.entities.values()) {
      if (e.type === 'point') continue;
      const d = this._entityPath(e, doc);
      if (!d) continue;
      const isSel = sel.has(e.id);
      const isHover = hover.id === e.id;
      const isConflict = conflictEnts.has(e.id);
      const base = e.type === 'circle' && e.construction ? COL.construction : COL.geo;
      const stroke = isConflict ? COL.conflict : isSel ? COL.sel : isHover ? COL.geoHover : base;
      const dash = e.construction ? ' stroke-dasharray="7 4"' : '';
      if (isSel || isHover) {
        out.push(`<path d="${d}" fill="none" stroke="${COL.sel}" stroke-width="7" stroke-opacity="0.16" stroke-linecap="round"/>`);
      }
      out.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${isSel ? 2.2 : 1.6}" stroke-linecap="round"${dash}/>`);
    }
    return out.join('');
  }

  _pointsSvg(doc, ui) {
    const out = [];
    const sel = ui.selection || new Set();
    const hover = ui.hover || {};
    for (const e of doc.entities.values()) {
      if (e.type !== 'point') continue;
      const x = this.sx(e.x), y = this.sy(e.y);
      const isSel = sel.has(e.id);
      const isHover = hover.id === e.id;
      const color = e.fixed ? COL.pointFixed : isSel ? COL.sel : isHover ? COL.geoHover : COL.point;
      if (isSel || isHover) out.push(`<circle cx="${x}" cy="${y}" r="9" fill="${COL.sel}" fill-opacity="0.15"/>`);
      if (e.fixed) {
        out.push(`<rect x="${x - 4}" y="${y - 4}" width="8" height="8" fill="${color}" stroke="#fff" stroke-width="1.2"/>`);
      } else {
        out.push(`<rect x="${x - 3.2}" y="${y - 3.2}" width="6.4" height="6.4" fill="#fff" stroke="${color}" stroke-width="1.6"/>`);
      }
    }
    return out.join('');
  }

  /* --- 尺寸标注 --- */
  _dimsSvg(doc, ui) {
    const out = [];
    const sel = ui.selection || new Set();
    const conflictIds = ui.conflictIds || new Set();
    for (const c of doc.constraints.values()) {
      if (!['distance', 'distanceX', 'distanceY', 'radius', 'diameter', 'angle'].includes(c.type)) continue;
      try {
        const svg = this._dimSvg(doc, c, sel.has(c.id), conflictIds.has(c.id));
        if (svg) out.push(svg);
      } catch (err) { /* 引用失效时跳过 */ }
    }
    return out.join('');
  }

  _arrow(x, y, ang, color) {
    const s = 7;
    const p1 = [x - s * Math.cos(ang - 0.35), y - s * Math.sin(ang - 0.35)];
    const p2 = [x - s * Math.cos(ang + 0.35), y - s * Math.sin(ang + 0.35)];
    return `<path d="M ${x.toFixed(1)} ${y.toFixed(1)} L ${p1[0].toFixed(1)} ${p1[1].toFixed(1)} L ${p2[0].toFixed(1)} ${p2[1].toFixed(1)} Z" fill="${color}"/>`;
  }

  _text(x, y, text, color, anchor = 'middle', size = 12) {
    const w = text.length * (size * 0.62) + 8;
    return `<rect x="${(x - w / 2).toFixed(1)}" y="${(y - size * 0.75).toFixed(1)}" width="${w.toFixed(1)}" height="${(size * 1.35).toFixed(1)}" rx="3" fill="#fff" fill-opacity="0.86"/>` +
      `<text x="${x.toFixed(1)}" y="${(y + size * 0.32).toFixed(1)}" font-size="${size}" font-family="'Segoe UI',system-ui,sans-serif" text-anchor="${anchor}" fill="${color}">${esc(text)}</text>`;
  }

  _dimSvg(doc, c, isSel, isConflict) {
    const color = isConflict ? COL.conflict : isSel ? COL.sel : COL.dim;
    const label = c.value != null ? fmt(c.value, 2) : '';

    if (c.type === 'distance' || c.type === 'distanceX' || c.type === 'distanceY') {
      const a = doc.pointOf(c.refs.a), b = doc.pointOf(c.refs.b);
      const A = { x: this.sx(a.x), y: this.sy(a.y) };
      const B = { x: this.sx(b.x), y: this.sy(b.y) };
      let dx = B.x - A.x, dy = B.y - A.y;
      const len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len;
      const off = 26;
      if (c.type === 'distance') {
        const p1 = { x: A.x + nx * off, y: A.y + ny * off };
        const p2 = { x: B.x + nx * off, y: B.y + ny * off };
        return `<g>` +
          `<line x1="${A.x}" y1="${A.y}" x2="${p1.x}" y2="${p1.y}" stroke="${color}" stroke-width="0.9" stroke-dasharray="3 2"/>` +
          `<line x1="${B.x}" y1="${B.y}" x2="${p2.x}" y2="${p2.y}" stroke="${color}" stroke-width="0.9" stroke-dasharray="3 2"/>` +
          `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${color}" stroke-width="1.2"/>` +
          this._arrow(p1.x, p1.y, Math.atan2(p1.y - p2.y, p1.x - p2.x), color) +
          this._arrow(p2.x, p2.y, Math.atan2(p2.y - p1.y, p2.x - p1.x), color) +
          this._text((p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 9, label + ' mm', color) +
          `</g>`;
      }
      // 水平/垂直尺寸
      const horiz = c.type === 'distanceX';
      const p1 = horiz ? { x: A.x, y: A.y + off } : { x: A.x + off, y: A.y };
      const p2 = horiz ? { x: B.x, y: A.y + off } : { x: A.x + off, y: B.y };
      const ext1 = horiz ? { x: A.x, y: p1.y } : { x: p1.x, y: A.y };
      const ext2 = horiz ? { x: B.x, y: p2.y } : { x: p2.x, y: B.y };
      return `<g>` +
        `<line x1="${A.x}" y1="${A.y}" x2="${ext1.x}" y2="${ext1.y}" stroke="${color}" stroke-width="0.9" stroke-dasharray="3 2"/>` +
        `<line x1="${B.x}" y1="${B.y}" x2="${ext2.x}" y2="${ext2.y}" stroke="${color}" stroke-width="0.9" stroke-dasharray="3 2"/>` +
        `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${color}" stroke-width="1.2"/>` +
        this._arrow(p1.x, p1.y, Math.atan2(p1.y - p2.y, p1.x - p2.x), color) +
        this._arrow(p2.x, p2.y, Math.atan2(p2.y - p1.y, p2.x - p1.x), color) +
        this._text((p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 9, label + ' mm', color) +
        `</g>`;
    }

    if (c.type === 'radius' || c.type === 'diameter') {
      const e = doc.circleOf(c.refs.circle);
      const ctr = doc.pointOf(e.center);
      const ang = -Math.PI / 4;
      const r = e.r;
      const px0 = this.sx(ctr.x), py0 = this.sy(ctr.y);
      const ex = ctr.x + r * Math.cos(ang), ey = ctr.y + r * Math.sin(ang);
      const px1 = this.sx(ex), py1 = this.sy(ey);
      const dirx = px1 - px0, diry = py1 - py0;
      const L = Math.hypot(dirx, diry) || 1;
      const tipX = px1 + (dirx / L) * 18, tipY = py1 + (diry / L) * 18;
      const txt = (c.type === 'diameter' ? '⌀' : 'R') + label;
      const lineStart = c.type === 'diameter' ? { x: this.sx(ctr.x - r * Math.cos(ang)), y: this.sy(ctr.y - r * Math.sin(ang)) } : { x: px0, y: py0 };
      return `<g>` +
        `<line x1="${lineStart.x}" y1="${lineStart.y}" x2="${tipX}" y2="${tipY}" stroke="${color}" stroke-width="1.2"/>` +
        this._arrow(px1, py1, Math.atan2(py1 - py0, px1 - px0), color) +
        this._text(tipX + (dirx / L) * 26, tipY + (diry / L) * 12, txt, color) +
        `</g>`;
    }

    if (c.type === 'angle') {
      const l1 = doc.lineOf(c.refs.a), l2 = doc.lineOf(c.refs.b);
      const a1 = doc.pointOf(l1.p1), b1 = doc.pointOf(l1.p2);
      const a2 = doc.pointOf(l2.p1), b2 = doc.pointOf(l2.p2);
      const ip = intersectLines(a1, b1, a2, b2);
      if (!ip) return '';
      const ang1 = Math.atan2(b1.y - a1.y, b1.x - a1.x);
      const ang2 = Math.atan2(b2.y - a2.y, b2.x - a2.x);
      const px = this.sx(ip.x), py = this.sy(ip.y);
      const R = 42;
      let d = ang2 - ang1;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      const mid = ang1 + d / 2;
      const sp = (a) => [px + R * Math.cos(a), py - R * Math.sin(a)];
      const s0 = sp(ang1), s1 = sp(ang2);
      const large = Math.abs(d) > Math.PI ? 1 : 0;
      const sweep = d > 0 ? 0 : 1; // 屏幕 y 向下
      const tp = sp(mid);
      return `<g>` +
        `<path d="M ${s0[0].toFixed(1)} ${s0[1].toFixed(1)} A ${R} ${R} 0 ${large} ${sweep} ${s1[0].toFixed(1)} ${s1[1].toFixed(1)}" fill="none" stroke="${color}" stroke-width="1.2"/>` +
        this._text(tp[0] + 16 * Math.cos(mid), tp[1] - 16 * Math.sin(mid), label + '°', color) +
        `</g>`;
    }
    return '';
  }

  /* --- 约束标记 --- */
  _glyphsSvg(doc, ui) {
    const out = [];
    const sel = ui.selection || new Set();
    const conflictIds = ui.conflictIds || new Set();
    const counters = new Map();
    for (const c of doc.constraints.values()) {
      const meta = CONSTRAINT_META[c.type] || { glyph: '·', label: c.type };
      if (['distance', 'distanceX', 'distanceY', 'radius', 'diameter', 'angle'].includes(c.type)) continue;
      let anchor = null;
      try { anchor = this._glyphAnchor(doc, c); } catch (e) { anchor = null; }
      if (!anchor) continue;
      const key = anchor.key;
      const k = counters.get(key) || 0;
      counters.set(key, k + 1);
      const x = anchor.x + (k % 3) * 18;
      const y = anchor.y - Math.floor(k / 3) * 18;
      const isSel = sel.has(c.id);
      const isConflict = conflictIds.has(c.id);
      const fill = isConflict ? COL.conflict : isSel ? COL.sel : COL.glyph;
      out.push(`<g class="glyph" data-cid="${esc(c.id)}" style="cursor:pointer">` +
        `<rect x="${x - 8}" y="${y - 8}" width="16" height="16" rx="4" fill="#fff" stroke="${fill}" stroke-width="1.4"/>` +
        `<text x="${x}" y="${y + 3.6}" font-size="9.5" font-family="'Segoe UI',system-ui,sans-serif" text-anchor="middle" fill="${fill}">${esc(meta.glyph)}</text>` +
        `</g>`);
    }
    return out.join('');
  }

  _glyphAnchor(doc, c) {
    const r = c.refs || {};
    if (r.p) { const p = doc.pointOf(r.p); return { key: 'p' + JSON.stringify(r.p), x: this.sx(p.x) + 12, y: this.sy(p.y) - 12 }; }
    if (r.line) { const l = doc.lineOf(r.line); const a = doc.pointOf(l.p1), b = doc.pointOf(l.p2); return { key: 'l' + r.line, x: (this.sx(a.x) + this.sx(b.x)) / 2, y: (this.sy(a.y) + this.sy(b.y)) / 2 - 14 }; }
    if (r.circle) { const e = doc.circleOf(r.circle); const ctr = doc.pointOf(e.center); return { key: 'c' + r.circle, x: this.sx(ctr.x), y: this.sy(ctr.y) - e.r * this.view.scale - 14 }; }
    if (r.a && r.b && typeof r.a === 'string' && doc.entities.get(r.a) && doc.entities.get(r.a).type === 'line') {
      const l1 = doc.lineOf(r.a), l2 = doc.lineOf(r.b);
      const m1 = midpoint(doc.pointOf(l1.p1), doc.pointOf(l1.p2));
      const m2 = midpoint(doc.pointOf(l2.p1), doc.pointOf(l2.p2));
      return { key: 'ab' + r.a + r.b, x: (this.sx(m1.x) + this.sx(m2.x)) / 2, y: (this.sy(m1.y) + this.sy(m2.y)) / 2 - 16 };
    }
    if (r.a && r.b) {
      const pa = doc.pointOf(r.a), pb = doc.pointOf(r.b);
      return { key: 'ab' + JSON.stringify(r.a) + JSON.stringify(r.b), x: (this.sx(pa.x) + this.sx(pb.x)) / 2, y: (this.sy(pa.y) + this.sy(pb.y)) / 2 - 16 };
    }
    return null;
  }

  /* --- 交互覆盖层 --- */
  _overlaySvg(doc, ui) {
    const out = [];
    const snap = ui.snap;
    if (snap && snap.pos) {
      const [x, y] = this.toScreen(snap.pos.x, snap.pos.y);
      out.push(`<circle cx="${x}" cy="${y}" r="7" fill="none" stroke="${COL.sel}" stroke-width="1.6" stroke-dasharray="3 2"/>`);
      out.push(`<text x="${x + 12}" y="${y - 10}" font-size="11" fill="${COL.sel}" font-family="'Segoe UI',system-ui,sans-serif">${esc(snap.kind || '点')}</text>`);
    }
    const pv = ui.preview;
    if (pv && pv.points && pv.points.length) {
      const pts = pv.points.map((p) => this.toScreen(p.x, p.y));
      if (pv.kind === 'line') {
        out.push(`<line x1="${pts[0][0]}" y1="${pts[0][1]}" x2="${pts[1][0]}" y2="${pts[1][1]}" stroke="${COL.sel}" stroke-width="1.4" stroke-dasharray="5 4"/>`);
      } else if (pv.kind === 'rect') {
        out.push(`<rect x="${Math.min(pts[0][0], pts[1][0])}" y="${Math.min(pts[0][1], pts[1][1])}" width="${Math.abs(pts[1][0] - pts[0][0])}" height="${Math.abs(pts[1][1] - pts[0][1])}" fill="none" stroke="${COL.sel}" stroke-width="1.4" stroke-dasharray="5 4"/>`);
      } else if (pv.kind === 'circle') {
        const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
        out.push(`<circle cx="${pts[0][0]}" cy="${pts[0][1]}" r="${r}" fill="none" stroke="${COL.sel}" stroke-width="1.4" stroke-dasharray="5 4"/>`);
        out.push(`<line x1="${pts[0][0]}" y1="${pts[0][1]}" x2="${pts[1][0]}" y2="${pts[1][1]}" stroke="${COL.sel}" stroke-width="0.9" stroke-dasharray="3 3"/>`);
      }
    }
    if (ui.rubber && ui.rubber.length === 2) {
      const a = this.toScreen(ui.rubber[0].x, ui.rubber[0].y);
      const b = this.toScreen(ui.rubber[1].x, ui.rubber[1].y);
      out.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#64748b" stroke-width="1" stroke-dasharray="2 4"/>`);
    }
    return out.join('');
  }
}

/* ---------------- 几何小工具 ---------------- */
function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

export function intersectLines(a1, b1, a2, b2) {
  const d1 = { x: b1.x - a1.x, y: b1.y - a1.y };
  const d2 = { x: b2.x - a2.x, y: b2.y - a2.y };
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a2.x - a1.x) * d2.y - (a2.y - a1.y) * d2.x) / den;
  return { x: a1.x + t * d1.x, y: a1.y + t * d1.y };
}

export { COL, fmt as fmtNumber };
