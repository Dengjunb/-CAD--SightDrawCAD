/* =============================================================================
   参数化草图 · 文档模型
   实体：point / line / circle / arc。几何参数就是变量本身：
     point  -> [x, y]
     circle -> [r]
     arc    -> [r, a0, a1]（圆心由 center 点引用）
   约束通过 residuals(doc) 读取模型，求解器负责写回参数。
   ========================================================================== */

import { norm2pi, deg, rad } from './math.js';

/* ---------------- 实体构造 ---------------- */

export class Doc {
  constructor() {
    this.entities = new Map();
    this.constraints = new Map();
    this._seq = 1;
    this.units = 'mm';
  }

  newId(prefix) {
    return prefix + '_' + this._seq++ + '_' + Math.floor(Math.random() * 1e4).toString(36);
  }

  /* --- 图元 --- */
  addPoint(x, y, opts = {}) {
    this._bumpVars();
    const e = { id: this.newId('p'), type: 'point', x, y, fixed: !!opts.fixed };
    this.entities.set(e.id, e);
    return e;
  }
  addLine(p1, p2, opts = {}) {
    this._bumpVars();
    const e = { id: this.newId('l'), type: 'line', p1, p2, construction: !!opts.construction };
    this.entities.set(e.id, e);
    return e;
  }
  addCircle(center, r, opts = {}) {
    this._bumpVars();
    const e = { id: this.newId('c'), type: 'circle', center, r, construction: !!opts.construction };
    this.entities.set(e.id, e);
    return e;
  }
  addArc(center, r, a0, a1, opts = {}) {
    this._bumpVars();
    const e = { id: this.newId('a'), type: 'arc', center, r, a0, a1, construction: !!opts.construction };
    this.entities.set(e.id, e);
    return e;
  }

  addConstraint(c) {
    if (!c.id) c.id = this.newId('k');
    this.constraints.set(c.id, c);
    return c;
  }

  /* --- 查询 --- */
  entity(id) { return this.entities.get(id); }
  constraint(id) { return this.constraints.get(id); }

  /** 点引用：'p_1_xx'（点实体）或 {arc:'a_2_x', end:'start'|'end'} */
  pointOf(ref) {
    if (typeof ref === 'string') {
      const e = this.entities.get(ref);
      if (!e || e.type !== 'point') throw new Error('pointOf: 不是点实体 ' + ref);
      return { x: e.x, y: e.y, id: e.id };
    }
    if (ref && ref.arc) {
      const a = this.entities.get(ref.arc);
      if (!a || a.type !== 'arc') throw new Error('pointOf: 不是圆弧 ' + ref.arc);
      const c = this.pointOf(a.center);
      const ang = ref.end === 'end' ? a.a1 : a.a0;
      return { x: c.x + a.r * Math.cos(ang), y: c.y + a.r * Math.sin(ang) };
    }
    if (ref && ref.circle) {
      const c = this.entities.get(ref.circle);
      return this.pointOf(c.center);
    }
    throw new Error('pointOf: 无法解析 ' + JSON.stringify(ref));
  }

  lineOf(id) {
    const e = this.entities.get(id);
    if (!e || e.type !== 'line') throw new Error('lineOf: 不是直线 ' + id);
    return e;
  }

  circleOf(id) {
    const e = this.entities.get(id);
    if (!e || (e.type !== 'circle' && e.type !== 'arc')) throw new Error('circleOf: 不是圆/弧 ' + id);
    return e;
  }

  /* --- 变量布局 --- */
  _bumpVars() { this._varVersion = (this._varVersion || 0) + 1; }

  /** 基础变量下标（不含临时排除），结构不变时复用缓存 */
  _baseIndex() {
    const ver = this._varVersion || 0;
    if (this._varCache && this._varCache.version === ver) return this._varCache;
    const index = new Map();
    let n = 0;
    for (const e of this.entities.values()) {
      if (e.type === 'point') {
        if (!e.fixed) { index.set(e.id, n); n += 2; }
      } else if (e.type === 'circle') {
        index.set(e.id, n); n += 1;
      } else if (e.type === 'arc') {
        index.set(e.id, n); n += 3;
      }
    }
    this._varCache = { version: ver, index, size: n };
    return this._varCache;
  }

  buildVars(excludePoints = null, includeEntities = null) {
    const base = this._baseIndex();
    let index = base.index;
    let n = base.size;
    if ((excludePoints && excludePoints.size) || includeEntities) {
      index = new Map();
      n = 0;
      for (const [id, b] of base.index) {
        const e = this.entities.get(id);
        if (!e) continue;
        if (includeEntities && !includeEntities.has(id)) continue;
        if (e.type === 'point' && excludePoints && excludePoints.has(id)) continue;
        index.set(id, n);
        n += e.type === 'point' ? 2 : e.type === 'circle' ? 1 : 3;
      }
    }
    const values = new Float64Array(n);
    for (const [id, base0] of index) {
      const e = this.entities.get(id);
      if (e.type === 'point') { values[base0] = e.x; values[base0 + 1] = e.y; }
      else if (e.type === 'circle') { values[base0] = e.r; }
      else if (e.type === 'arc') { values[base0] = e.r; values[base0 + 1] = e.a0; values[base0 + 2] = e.a1; }
    }
    return { index, values, size: n };
  }

  applyVars(values, index) {
    for (const [id, base] of index) {
      const e = this.entities.get(id);
      if (e.type === 'point') { e.x = values[base]; e.y = values[base + 1]; }
      else if (e.type === 'circle') { e.r = values[base]; }
      else if (e.type === 'arc') { e.r = values[base]; e.a0 = values[base + 1]; e.a1 = values[base + 2]; }
    }
  }

  snapshotVars() {
    const { index, values } = this.buildVars();
    return { index: [...index.entries()], values: values.slice() };
  }

  restoreVars(snap) {
    const index = new Map(snap.index);
    this.applyVars(snap.values, index);
  }

  /* --- 依赖关系（删除级联） --- */
  /** 返回引用某实体的约束 id 列表 */
  constraintsReferencing(entityId) {
    const out = [];
    for (const c of this.constraints.values()) {
      if (JSON.stringify(c.refs).indexOf(entityId) >= 0) out.push(c.id);
    }
    return out;
  }

  /** 删除实体（含级联：点 -> 端点所在线；线/圆/弧 -> 其约束） */
  removeEntity(id) {
    this._bumpVars();
    const removedConstraints = new Set();
    const removed = new Set([id]);
    const e = this.entities.get(id);
    if (!e) return { removed: [], removedConstraints: [] };

    if (e.type === 'point') {
      for (const other of this.entities.values()) {
        if (other.type === 'line' && (other.p1 === id || other.p2 === id)) removed.add(other.id);
        if ((other.type === 'circle' || other.type === 'arc') && other.center === id) removed.add(other.id);
      }
    }
    // 级联第二层：被删圆/弧/线的约束
    for (const rid of [...removed]) {
      for (const cid of this.constraintsReferencing(rid)) removedConstraints.add(cid);
    }
    for (const cid of removedConstraints) this.constraints.delete(cid);
    for (const rid of removed) this.entities.delete(rid);
    return { removed: [...removed], removedConstraints: [...removedConstraints] };
  }

  /* --- 序列化 --- */
  toJSON() {
    const ents = [...this.entities.values()].map((e) => ({ ...e }));
    const cons = [...this.constraints.values()].map((c) => ({
      id: c.id, type: c.type, refs: c.refs, value: c.value, weight: c.weight,
    }));
    return { version: 1, units: this.units, entities: ents, constraints: cons, seq: this._seq };
  }

  static fromJSON(data) {
    const d = new Doc();
    d.units = data.units || 'mm';
    for (const e of data.entities || []) d.entities.set(e.id, { ...e });
    for (const c of data.constraints || []) d.constraints.set(c.id, { ...c });
    d._seq = data.seq || 1;
    d._bumpVars();
    return d;
  }

  stats() {
    const c = { point: 0, line: 0, circle: 0, arc: 0 };
    for (const e of this.entities.values()) c[e.type] = (c[e.type] || 0) + 1;
    return { ...c, constraints: this.constraints.size };
  }
}

/* ---------------- 几何工具 ---------------- */

export function arcSweep(arc) {
  return norm2pi(arc.a1 - arc.a0);
}

export function arcBounds(arc, center) {
  // 保守包围盒：整圆
  return {
    x0: center.x - arc.r, y0: center.y - arc.r,
    x1: center.x + arc.r, y1: center.y + arc.r,
  };
}

export function lineAngle(line, a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

export function distPointLine(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1e-12;
  return ((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

export { deg, rad };
