/* =============================================================================
   参数化二维工程草图 · 约束定义
   ---------------------------------------------------------------------------
   每个约束对象只负责一件事：把「当前几何是否满足该约束」表达成残差向量。
     residuals(doc) -> number[]，长度 = 方程数，值为 0 表示满足。
   求解器（js/solver.js）用这些残差做数值雅可比 + Levenberg–Marquardt。

   单位约定：
     · 长度类残差单位为 mm（真实长度差，不用平方差，避免量级失衡）；
     · 角度类 value 单位为「度」，内部换算成弧度；
     · 归一化类残差（parallel / perpendicular / pointOnLine / symmetric 等）
       除以方向向量长度，量纲为 1，避免长线主导。

   数值安全：
     · 所有除数都经过 lenClamp()/EPS 保护，不会出现 NaN；
     · 引用的点 / 线 / 圆 / 弧被删除时，residuals 返回空数组（不抛异常），
       UI 负责清理失效约束；
     · residuals 是 doc 当前状态的纯函数（不改写 doc、不产生副作用），
       唯一的例外是 fix 的目标坐标在「首次求值」时锁定（见下方说明）。
   ========================================================================== */

import { rad } from './math.js';

/* ---------------------------------------------------------------------------
   小工具
   ------------------------------------------------------------------------- */

const EPS = 1e-9;
const TAU = Math.PI * 2;

/** 有符号角度归一化到 (-π, π]（-π 映射到 +π） */
function wrapPi(a) {
  if (!Number.isFinite(a)) return 0;
  let t = a % TAU;
  if (t > Math.PI) t -= TAU;
  else if (t <= -Math.PI) t += TAU;
  return t;
}

/** 方向向量长度，退化时钳到 EPS，杜绝除零 */
function lenClamp(dx, dy) {
  const L = Math.hypot(dx, dy);
  return L < EPS ? EPS : L;
}

/** 实数化：任何非有限值都收敛到有限值，残差永不返回 NaN */
function sanitize(r) {
  if (!Array.isArray(r) || r.length === 0) return [];
  const out = new Array(r.length);
  for (let i = 0; i < r.length; i++) {
    const v = r[i];
    out[i] = Number.isFinite(v) ? v : (v === Infinity ? 1e9 : v === -Infinity ? -1e9 : 0);
  }
  return out;
}

/** 安全解析点引用：字符串 id 或 {arc, end}；失败/被删返回 null */
function safePoint(doc, ref) {
  if (ref === null || ref === undefined) return null;
  if (!doc || typeof doc.pointOf !== 'function') return null;
  try {
    const p = doc.pointOf(ref);
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return p;
  } catch (e) {
    return null; // 实体已删除 / 引用非法 —— 交给 UI 清理，不在数值层炸掉
  }
}

/** 安全解析实体（限定类型），失败/被删返回 null */
function safeEntity(doc, id, types) {
  if (id === null || id === undefined) return null;
  if (!doc || !doc.entities || typeof doc.entities.get !== 'function') return null;
  const e = doc.entities.get(id);
  if (!e || types.indexOf(e.type) < 0) return null;
  return e;
}

/** 直线几何：两端点位置 + 方向向量 */
function lineGeom(doc, id) {
  const e = safeEntity(doc, id, ['line']);
  if (!e) return null;
  const a = safePoint(doc, e.p1);
  const b = safePoint(doc, e.p2);
  if (!a || !b) return null;
  return { entity: e, a, b, dx: b.x - a.x, dy: b.y - a.y };
}

/** 圆/弧几何：圆心位置 + 半径（arc 与 circle 通用） */
function circleGeom(doc, id) {
  const e = safeEntity(doc, id, ['circle', 'arc']);
  if (!e) return null;
  const c = safePoint(doc, e.center);
  if (!c || !Number.isFinite(e.r)) return null;
  return { entity: e, c, r: e.r };
}

/** 取值：优先 createConstraint 的第三个参数，其次 refs.value */
function pickValue(refs, value) {
  if (value !== null && value !== undefined) return value;
  if (refs && refs.value !== null && refs.value !== undefined) return refs.value;
  return null;
}

/** 数值目标（尺寸类约束用）：非法值退化到 0，保证残差有限 */
function targetNum(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * 读取「当前的」value（尺寸联动/尺寸编辑的关键）。
 * app 改尺寸走 cmdEditValue：直接在 doc 里那条约束对象上写 c.value；
 * 而入 doc 的可能是 {...c} 拷贝（cmdAddConstraint / cmdAddEntities 都这么干），
 * 所以只看构造时捕获的值会让「改尺寸看全图联动」失效。
 * 解析顺序：
 *   1) doc 里按 id 找到的那条约束（可能是拷贝，持有用户改写后的 value）→ 用它；
 *   2) 本对象自己的 value（doc 里存的就是本对象时等价）；
 *   3) 构造时捕获的 fallback。
 * 对同一个 doc 反复求值结果一致，因此仍可视为 doc 当前状态的纯函数。
 */
function liveValue(doc, self, fallback) {
  const id = self && self.id;
  if (id !== null && id !== undefined &&
      doc && doc.constraints && typeof doc.constraints.get === 'function') {
    const stored = doc.constraints.get(id);
    if (stored && stored.type === self.type && stored.value !== null && stored.value !== undefined) {
      return stored.value;
    }
  }
  if (self && self.value !== null && self.value !== undefined) return self.value;
  return fallback;
}

/* ---------------------------------------------------------------------------
   残差实现表
   签名：(doc, refs, value, state) -> number[]
   state 是每个约束实例私有的小对象（目前只有 fix 用到：锁定目标坐标）。
   ------------------------------------------------------------------------- */

const RESIDUALS = {
  /* ---- 重合：两点坐标差，2 个方程 ---- */
  coincident(doc, refs) {
    const a = safePoint(doc, refs.a);
    const b = safePoint(doc, refs.b);
    if (!a || !b) return [];
    return [a.x - b.x, a.y - b.y];
  },

  /* ---- 点在线上：点到直线的有符号距离，1 个方程 ---- */
  pointOnLine(doc, refs) {
    const p = safePoint(doc, refs.p);
    const L = lineGeom(doc, refs.line);
    if (!p || !L) return [];
    const len = lenClamp(L.dx, L.dy);
    // cross(p - p1, p2 - p1) / |p2 - p1|
    return [((p.x - L.a.x) * L.dy - (p.y - L.a.y) * L.dx) / len];
  },

  /* ---- 点在圆/弧上：|p - center| - r，1 个方程 ---- */
  pointOnCircle(doc, refs) {
    const p = safePoint(doc, refs.p);
    const C = circleGeom(doc, refs.circle);
    if (!p || !C) return [];
    return [Math.hypot(p.x - C.c.x, p.y - C.c.y) - C.r];
  },

  /* ---- 水平：两端点 y 差（mm），1 个方程 ---- */
  horizontal(doc, refs) {
    const L = lineGeom(doc, refs.line);
    if (!L) return [];
    return [L.b.y - L.a.y];
  },

  /* ---- 竖直：两端点 x 差（mm），1 个方程 ---- */
  vertical(doc, refs) {
    const L = lineGeom(doc, refs.line);
    if (!L) return [];
    return [L.b.x - L.a.x];
  },

  /* ---- 平行：归一化叉积，1 个方程 ---- */
  parallel(doc, refs) {
    const A = lineGeom(doc, refs.a);
    const B = lineGeom(doc, refs.b);
    if (!A || !B) return [];
    const la = lenClamp(A.dx, A.dy);
    const lb = lenClamp(B.dx, B.dy);
    return [(A.dx * B.dy - A.dy * B.dx) / (la * lb)];
  },

  /* ---- 垂直：归一化点积，1 个方程 ---- */
  perpendicular(doc, refs) {
    const A = lineGeom(doc, refs.a);
    const B = lineGeom(doc, refs.b);
    if (!A || !B) return [];
    const la = lenClamp(A.dx, A.dy);
    const lb = lenClamp(B.dx, B.dy);
    return [(A.dx * B.dx + A.dy * B.dy) / (la * lb)];
  },

  /* ---- 相切：圆心到直线距离 - 半径，1 个方程 ----
     距离取有符号值 s = cross(d, c-p1)/|d| 的绝对值，两侧相切都能归零；
     s 的符号记录切侧，用于画布上标记/描述，不进入残差（否则只能切单侧）。 */
  tangent(doc, refs) {
    const L = lineGeom(doc, refs.line);
    const C = circleGeom(doc, refs.circle);
    if (!L || !C) return [];
    const len = lenClamp(L.dx, L.dy);
    const s = (L.dx * (C.c.y - L.a.y) - L.dy * (C.c.x - L.a.x)) / len;
    return [Math.abs(s) - C.r];
  },

  /* ---- 等长：真实长度差，1 个方程 ---- */
  equalLength(doc, refs) {
    const A = lineGeom(doc, refs.a);
    const B = lineGeom(doc, refs.b);
    if (!A || !B) return [];
    return [Math.hypot(A.dx, A.dy) - Math.hypot(B.dx, B.dy)];
  },

  /* ---- 等半径：半径差，1 个方程 ---- */
  equalRadius(doc, refs) {
    const A = circleGeom(doc, refs.a);
    const B = circleGeom(doc, refs.b);
    if (!A || !B) return [];
    return [A.r - B.r];
  },

  /* ---- 两点距离：真实距离差（非平方差），1 个方程 ---- */
  distance(doc, refs, value) {
    const a = safePoint(doc, refs.a);
    const b = safePoint(doc, refs.b);
    if (!a || !b) return [];
    return [Math.hypot(b.x - a.x, b.y - a.y) - targetNum(value)];
  },

  /* ---- 水平距离：(b.x - a.x) - value，1 个方程 ---- */
  distanceX(doc, refs, value) {
    const a = safePoint(doc, refs.a);
    const b = safePoint(doc, refs.b);
    if (!a || !b) return [];
    return [(b.x - a.x) - targetNum(value)];
  },

  /* ---- 竖直距离：(b.y - a.y) - value，1 个方程 ---- */
  distanceY(doc, refs, value) {
    const a = safePoint(doc, refs.a);
    const b = safePoint(doc, refs.b);
    if (!a || !b) return [];
    return [(b.y - a.y) - targetNum(value)];
  },

  /* ---- 半径：r - value，1 个方程 ---- */
  radius(doc, refs, value) {
    const C = circleGeom(doc, refs.circle);
    if (!C) return [];
    return [C.r - targetNum(value)];
  },

  /* ---- 直径：2r - value，1 个方程 ---- */
  diameter(doc, refs, value) {
    const C = circleGeom(doc, refs.circle);
    if (!C) return [];
    return [2 * C.r - targetNum(value)];
  },

  /* ---- 有向夹角：atan2(cross, dot) - rad(value)，归一化到 (-π, π]，1 个方程 ---- */
  angle(doc, refs, value) {
    const A = lineGeom(doc, refs.a);
    const B = lineGeom(doc, refs.b);
    if (!A || !B) return [];
    // 退化直线方向无定义，直接视为满足，避免残差乱蹦
    if (lenClamp(A.dx, A.dy) <= EPS || lenClamp(B.dx, B.dy) <= EPS) return [0];
    const cross = A.dx * B.dy - A.dy * B.dx;
    const dotv = A.dx * B.dx + A.dy * B.dy;
    const theta = Math.atan2(cross, dotv);
    return [wrapPi(theta - rad(targetNum(value)))];
  },

  /* ---- 关于直线对称：中点在线上 + ab 垂直该线，2 个方程 ---- */
  symmetric(doc, refs) {
    const a = safePoint(doc, refs.a);
    const b = safePoint(doc, refs.b);
    const L = lineGeom(doc, refs.line);
    if (!a || !b || !L) return [];
    const len = lenClamp(L.dx, L.dy);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    // 中点到直线的（归一化）有符号距离
    const midDist = ((mx - L.a.x) * L.dy - (my - L.a.y) * L.dx) / len;
    // ab 在直线方向上的投影（垂直时应为 0）
    const abProj = ((b.x - a.x) * L.dx + (b.y - a.y) * L.dy) / len;
    return [midDist, abProj];
  },

  /* ---- 中点：p 与两端点中点重合，2 个方程 ---- */
  midpoint(doc, refs) {
    const p = safePoint(doc, refs.p);
    const L = lineGeom(doc, refs.line);
    if (!p || !L) return [];
    return [p.x - (L.a.x + L.b.x) / 2, p.y - (L.a.y + L.b.y) / 2];
  },

  /* ---- 固定点：锁定坐标，2 个方程 ----
     目标坐标优先取 value/refs.value 的 {x,y}；未给时在「首次求值」锁定当前坐标。
     （createConstraint 拿不到 doc，无法在构造时采样，故用实例私有 state 缓存；
      缓存后不再变化，因此对同一个 doc 的多次求值仍是确定性的。）
     求解器也可直接用 point.fixed 标记，这条约束是等价的显式版本。 */
  fix(doc, refs, value, state) {
    const p = safePoint(doc, refs.p);
    if (!p) return [];
    if (!state || !state.target) {
      const given = value && typeof value === 'object' ? value : (refs && refs.value);
      if (given && Number.isFinite(given.x) && Number.isFinite(given.y)) {
        state.target = { x: given.x, y: given.y };
      } else {
        state.target = { x: p.x, y: p.y };
      }
    }
    return [p.x - state.target.x, p.y - state.target.y];
  },
};

/* ---------------------------------------------------------------------------
   约束元数据（画布标记 / 右侧约束列表 / 选择流程用）
     arity    —— 需要选几个几何对象（1 单对象；2 两个对象/点；symmetric 为 3）
     kind     —— 'geo' 几何约束 / 'dim' 尺寸约束（可改数值）
     valueUnit—— null / 'mm' / 'deg'
   ------------------------------------------------------------------------- */

export const CONSTRAINT_META = {
  coincident: {
    label: '重合', glyph: '●', arity: 2, kind: 'geo', valueUnit: null,
    hint: '两点移到同一位置',
  },
  pointOnLine: {
    label: '点在线上', glyph: '⌖', arity: 2, kind: 'geo', valueUnit: null,
    hint: '点落在直线上（含延长线）',
  },
  pointOnCircle: {
    label: '点在圆上', glyph: '⊙', arity: 2, kind: 'geo', valueUnit: null,
    hint: '点落在圆/圆弧上',
  },
  horizontal: {
    label: '水平', glyph: 'H', arity: 1, kind: 'geo', valueUnit: null,
    hint: '直线两端等高（平行 X 轴）',
  },
  vertical: {
    label: '竖直', glyph: 'V', arity: 1, kind: 'geo', valueUnit: null,
    hint: '直线两端同列（平行 Y 轴）',
  },
  parallel: {
    label: '平行', glyph: '∥', arity: 2, kind: 'geo', valueUnit: null,
    hint: '两条直线方向相同',
  },
  perpendicular: {
    label: '垂直', glyph: '⊥', arity: 2, kind: 'geo', valueUnit: null,
    hint: '两条直线夹角 90°',
  },
  tangent: {
    label: '相切', glyph: 'T', arity: 2, kind: 'geo', valueUnit: null,
    hint: '直线与圆/弧相切（圆心到线距离 = 半径）',
  },
  equalLength: {
    label: '等长', glyph: '=', arity: 2, kind: 'geo', valueUnit: null,
    hint: '两条直线长度相等',
  },
  equalRadius: {
    label: '等半径', glyph: '≡', arity: 2, kind: 'geo', valueUnit: null,
    hint: '两个圆/弧半径相等',
  },
  distance: {
    label: '距离', glyph: '↔', arity: 2, kind: 'dim', valueUnit: 'mm',
    hint: '两点间真实距离',
  },
  distanceX: {
    label: '水平距离', glyph: '⇥', arity: 2, kind: 'dim', valueUnit: 'mm',
    hint: 'b.x − a.x（带符号）',
  },
  distanceY: {
    label: '竖直距离', glyph: '⇡', arity: 2, kind: 'dim', valueUnit: 'mm',
    hint: 'b.y − a.y（带符号）',
  },
  radius: {
    label: '半径', glyph: 'R', arity: 1, kind: 'dim', valueUnit: 'mm',
    hint: '圆/弧半径',
  },
  diameter: {
    label: '直径', glyph: '⌀', arity: 1, kind: 'dim', valueUnit: 'mm',
    hint: '圆/弧直径（2r）',
  },
  angle: {
    label: '角度', glyph: '∠', arity: 2, kind: 'dim', valueUnit: 'deg',
    hint: '两条直线的有向夹角（度）',
  },
  symmetric: {
    label: '对称', glyph: '⇋', arity: 3, kind: 'geo', valueUnit: null,
    hint: '两点关于直线对称（2 点 + 1 条对称轴）',
  },
  midpoint: {
    label: '中点', glyph: 'M', arity: 2, kind: 'geo', valueUnit: null,
    hint: '点位于线段中点',
  },
  fix: {
    label: '固定', glyph: '⌾', arity: 1, kind: 'geo', valueUnit: null,
    hint: '锁定点坐标不再移动',
  },
};

/** 全部约束类型（顺序与 CONSTRAINT_META 一致） */
export const CONSTRAINT_TYPES = Object.keys(CONSTRAINT_META);

/* ---------------------------------------------------------------------------
   工厂
   ------------------------------------------------------------------------- */

/**
 * 创建一个约束对象。
 * @param {string} type  约束类型（见 CONSTRAINT_META）
 * @param {object} refs  引用结构（见任务契约 / 下方 builder）
 * @param {*}      value 尺寸类约束的数值（mm 或 度）；fix 可传 {x,y} 锁定目标
 * @returns {{id:null,type:string,refs:object,value:*,weight:number,residuals:Function}}
 */
export function createConstraint(type, refs = {}, value = null) {
  const builder = RESIDUALS[type];
  const meta = CONSTRAINT_META[type];
  if (!builder || !meta) throw new Error('createConstraint: 未知约束类型 ' + type);
  if (!refs || typeof refs !== 'object') {
    throw new Error('createConstraint: refs 必须是对象（' + type + '）');
  }

  const v = pickValue(refs, value);
  if (meta.valueUnit && !Number.isFinite(v)) {
    throw new Error(
      'createConstraint: ' + type + ' 需要数值 value（单位 ' + meta.valueUnit + '）'
    );
  }

  const state = {}; // 每个约束实例私有（fix 锁目标）

  const c = {
    id: null,
    type,
    refs,
    value: v,
    weight: 1,
    residuals(doc) {
      // 纯函数：只读 doc，不写回；实体缺失返回 []
      try {
        // 关键：尺寸类约束必须读「当前」value，否则用户改尺寸不会驱动几何。
        // this 通常是 doc 里那条约束对象（可能是 {...c} 拷贝）；
        // liveValue 再按 id 回查一次 doc，兜住「原对象上调用、doc 里另存拷贝」的情况。
        const self = this || c;
        const val = pickValue(refs, liveValue(doc, self, v));
        return sanitize(builder(doc, refs, val, state));
      } catch (e) {
        return []; // 极端情况下也不让求解器崩掉
      }
    },
  };
  return c;
}

/* ---------------------------------------------------------------------------
   描述（右侧约束列表）
   ------------------------------------------------------------------------- */

/** 数值格式化：最多 3 位小数，去掉多余的 0 */
function fmtNum(v) {
  if (!Number.isFinite(v)) return '—';
  const r = Math.round(v * 1000) / 1000;
  return String(r);
}

/**
 * 返回一句话中文描述，例如「距离 100 mm」「角度 90°」「重合」。
 * @param {object} c 约束对象（含 type / value / refs）
 */
export function describeConstraint(c) {
  if (!c || !c.type) return '未知约束';
  const meta = CONSTRAINT_META[c.type];
  if (!meta) return '未知约束（' + c.type + '）';

  const v = pickValue(c.refs, c.value);
  if (meta.valueUnit === 'mm') {
    return Number.isFinite(v) ? meta.label + ' ' + fmtNum(v) + ' mm' : meta.label;
  }
  if (meta.valueUnit === 'deg') {
    return Number.isFinite(v) ? meta.label + ' ' + fmtNum(v) + '°' : meta.label;
  }
  return meta.label;
}
