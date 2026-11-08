/* =============================================================================
   约束模块单元测试 —— node tests/constraints.test.mjs
   ---------------------------------------------------------------------------
   覆盖：
     · 每种约束的「满足 → 破坏 → 求解收敛 → 几何回到满足」闭环；
     · 方程数 / 元数据 / 描述文案等 app 契约；
     · 数值安全（除零、NaN、实体被删除、残差纯函数）。
   输出 [PASS]/[FAIL]，失败时以非零码退出。
   ========================================================================== */

import { Doc, rad } from '../js/model.js';
import {
  createConstraint,
  describeConstraint,
  CONSTRAINT_META,
  CONSTRAINT_TYPES,
} from '../js/constraints.js';
import { solve } from '../js/solver.js';

/* ---------------------------------------------------------------------------
   极简测试框架
   ------------------------------------------------------------------------- */

let passed = 0;
let failed = 0;
const failureLines = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('[PASS] ' + name);
  } catch (e) {
    failed++;
    const msg = e && e.message ? e.message : String(e);
    failureLines.push(name + ' → ' + msg);
    console.log('[FAIL] ' + name + ' → ' + msg);
    if (e && e.stack) {
      const line = String(e.stack).split('\n').find((s) => s.includes('constraints.test.mjs'));
      if (line) console.log('       ' + line.trim());
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function near(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg || '数值不等'}：实际 ${actual}，期望 ${expected}，容差 ${tol}`);
  }
}

function close0(v, tol, msg) {
  near(v, 0, tol, msg);
}

function maxAbs(arr) {
  let m = 0;
  for (let i = 0; i < arr.length; i++) m = Math.max(m, Math.abs(arr[i]));
  return m;
}

function allFinite(arr) {
  return arr.every((v) => Number.isFinite(v));
}

/* 每种类型的方程数（与 constraints.js 的契约一致） */
const ROWS = {
  coincident: 2,
  symmetric: 2,
  midpoint: 2,
  fix: 2,
};
function rowsOf(type) {
  return ROWS[type] ?? 1;
}

/* ---------------------------------------------------------------------------
   几何读取小工具（测试侧）
   ------------------------------------------------------------------------- */

function pt(doc, id) {
  return doc.pointOf(id);
}

function lineLen(doc, id) {
  const l = doc.lineOf(id);
  const a = doc.pointOf(l.p1);
  const b = doc.pointOf(l.p2);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function lineDir(doc, id) {
  const l = doc.lineOf(id);
  const a = doc.pointOf(l.p1);
  const b = doc.pointOf(l.p2);
  return { dx: b.x - a.x, dy: b.y - a.y };
}

/** 两条直线的有向夹角（弧度，atan2 版本） */
function angleBetween(doc, idA, idB) {
  const A = lineDir(doc, idA);
  const B = lineDir(doc, idB);
  return Math.atan2(A.dx * B.dy - A.dy * B.dx, A.dx * B.dx + A.dy * B.dy);
}

/** 归一化到 (-π, π] */
function wrapPi(a) {
  const T = Math.PI * 2;
  let t = a % T;
  if (t > Math.PI) t -= T;
  else if (t <= -Math.PI) t += T;
  return t;
}

/* ---------------------------------------------------------------------------
   通用闭环用例：
     1) 构造 doc + 约束（几何初始满足）
     2) 断言残差 ≈ 0
     3) 破坏几何，断言残差明显且有限
     4) solve(doc)，断言收敛、残差归零，再跑 verify 做几何断言
   ------------------------------------------------------------------------- */

function constraintCase(name, spec) {
  test(name, () => {
    const doc = new Doc();
    const ctx = spec.build(doc) || {};
    const c = ctx.c;
    assert(c && c.type, 'build 必须返回 { c }');
    assert(doc.constraints.has(c.id), '约束应已加入 doc.constraints');

    const eq = spec.eq ?? rowsOf(c.type);
    const r0 = c.residuals(doc);
    assert(Array.isArray(r0), 'residuals 必须返回数组');
    assert(r0.length === eq, `方程数应为 ${eq}，实际 ${r0.length}`);
    assert(allFinite(r0), '初始残差必须全部有限');
    if (ctx.satisfied !== false) close0(maxAbs(r0), 1e-9, '满足时残差应≈0');

    if (spec.break) {
      spec.break(doc);
      const r1 = c.residuals(doc);
      assert(allFinite(r1), '破坏后残差必须全部有限');
      const m = maxAbs(r1);
      assert(m >= (spec.breakMin ?? 0.05), `破坏后残差应明显，实际 ${m}`);
    }

    const out = solve(doc);
    assert(out.converged, '求解应收敛：' + out.message);
    close0(maxAbs(c.residuals(doc)), 1e-6, '求解后残差应为 0');

    if (spec.verify) spec.verify(doc, c);
  });
}

/* =========================================================================
   1. 重合（2 方程）
   ========================================================================= */
constraintCase('coincident：两点重合', {
  build(doc) {
    const a = doc.addPoint(3, 4);
    const b = doc.addPoint(3, 4);
    const c = doc.addConstraint(createConstraint('coincident', { a: a.id, b: b.id }));
    return { c, doc, a, b };
  },
  break(doc) {
    const e = [...doc.entities.values()].filter((x) => x.type === 'point');
    e[1].x = 10;
    e[1].y = -2;
  },
  verify(doc) {
    const e = [...doc.entities.values()].filter((x) => x.type === 'point');
    near(Math.abs(e[0].x - e[1].x) + Math.abs(e[0].y - e[1].y), 0, 1e-6, '两点应重合');
  },
});

/* =========================================================================
   2. 距离（真实长度差）
   ========================================================================= */
test('distance：距离 100 mm', () => {
  const doc = new Doc();
  const a = doc.addPoint(0, 0, { fixed: true });
  const b = doc.addPoint(60, 80);
  const c = doc.addConstraint(createConstraint('distance', { a: a.id, b: b.id }, 100));

  const r0 = c.residuals(doc);
  assert(r0.length === 1, '方程数应为 1');
  close0(maxAbs(r0), 1e-9, '初始（60,80）距离 100 应满足');

  b.x = 10;
  b.y = 10;
  const broken = c.residuals(doc)[0];
  near(broken, Math.hypot(10, 10) - 100, 1e-9, '残差应为真实距离差');
  assert(broken < -80, '破坏后残差应明显');

  const out = solve(doc);
  assert(out.converged, '求解应收敛：' + out.message);
  near(Math.hypot(b.x - a.x, b.y - a.y), 100, 1e-6, '求解后距离应为 100');
  close0(maxAbs(c.residuals(doc)), 1e-6, '求解后残差为 0');
});

/* =========================================================================
   3/4. distanceX / distanceY（带符号）
   ========================================================================= */
test('distanceX：水平距离 40 mm', () => {
  const doc = new Doc();
  const a = doc.addPoint(0, 0, { fixed: true });
  const b = doc.addPoint(40, 10);
  const c = doc.addConstraint(createConstraint('distanceX', { a: a.id, b: b.id }, 40));
  close0(maxAbs(c.residuals(doc)), 1e-9, 'b.x−a.x=40 应满足');

  b.x = 10;
  near(c.residuals(doc)[0], -30, 1e-9, '破坏后残差应为 −30');

  const out = solve(doc);
  assert(out.converged, '求解应收敛');
  near(b.x - a.x, 40, 1e-6, '求解后水平距离应为 40');
});

test('distanceY：竖直距离 −25 mm（带符号）', () => {
  const doc = new Doc();
  const a = doc.addPoint(0, 0, { fixed: true });
  const b = doc.addPoint(10, -25);
  const c = doc.addConstraint(createConstraint('distanceY', { a: a.id, b: b.id }, -25));
  close0(maxAbs(c.residuals(doc)), 1e-9, 'b.y−a.y=−25 应满足');

  b.y = 5;
  near(c.residuals(doc)[0], 30, 1e-9, '破坏后残差应为 30');

  const out = solve(doc);
  assert(out.converged, '求解应收敛');
  near(b.y - a.y, -25, 1e-6, '求解后竖直距离应为 −25');
});

/* =========================================================================
   5. 水平
   ========================================================================= */
constraintCase('horizontal：水平', {
  build(doc) {
    const a = doc.addPoint(0, 0, { fixed: true });
    const b = doc.addPoint(10, 0);
    const l = doc.addLine(a.id, b.id);
    const c = doc.addConstraint(createConstraint('horizontal', { line: l.id }));
    return { c, satisfied: true };
  },
  break(doc) {
    const b = [...doc.entities.values()].find((x) => x.type === 'point' && !x.fixed);
    b.y = 6;
  },
  breakMin: 5,
  verify(doc) {
    const b = [...doc.entities.values()].find((x) => x.type === 'point' && !x.fixed);
    near(b.y, 0, 1e-6, '求解后两端应等高');
  },
});

/* =========================================================================
   6. 竖直
   ========================================================================= */
constraintCase('vertical：竖直', {
  build(doc) {
    const a = doc.addPoint(0, 0, { fixed: true });
    const b = doc.addPoint(0, 10);
    const l = doc.addLine(a.id, b.id);
    const c = doc.addConstraint(createConstraint('vertical', { line: l.id }));
    return { c, satisfied: true };
  },
  break(doc) {
    const b = [...doc.entities.values()].find((x) => x.type === 'point' && !x.fixed);
    b.x = 6;
  },
  breakMin: 5,
  verify(doc) {
    const b = [...doc.entities.values()].find((x) => x.type === 'point' && !x.fixed);
    near(b.x, 0, 1e-6, '求解后两端应同列');
  },
});

/* =========================================================================
   7. 平行（归一化叉积）
   ========================================================================= */
test('parallel：两条直线平行', () => {
  const doc = new Doc();
  const a1 = doc.addPoint(0, 0, { fixed: true });
  const a2 = doc.addPoint(10, 0, { fixed: true });
  const la = doc.addLine(a1.id, a2.id);
  const b1 = doc.addPoint(0, 5, { fixed: true });
  const b2 = doc.addPoint(10, 5);
  const lb = doc.addLine(b1.id, b2.id);
  const c = doc.addConstraint(createConstraint('parallel', { a: la.id, b: lb.id }));

  close0(maxAbs(c.residuals(doc)), 1e-12, '平行时应≈0');

  b2.y = 9; // 破坏：与水平线夹角 ≈ 21.8°
  const r = c.residuals(doc);
  assert(r.length === 1 && allFinite(r), '平行残差应为 1 个有限值');
  near(r[0], Math.sin(Math.atan2(4, 10)), 1e-9, '残差应为归一化叉积 sinθ');
  assert(r[0] > 0.3, '破坏后残差应明显');

  const out = solve(doc);
  assert(out.converged, '求解应收敛');
  close0(maxAbs(c.residuals(doc)), 1e-6, '求解后残差为 0');
  const A = lineDir(doc, la.id);
  const B = lineDir(doc, lb.id);
  const laLen = Math.hypot(A.dx, A.dy);
  const lbLen = Math.hypot(B.dx, B.dy);
  close0((A.dx * B.dy - A.dy * B.dx) / (laLen * lbLen), 1e-6, '求解后应平行');
});

/* =========================================================================
   8. 垂直（归一化点积）
   ========================================================================= */
test('perpendicular：两条直线垂直', () => {
  const doc = new Doc();
  const a1 = doc.addPoint(0, 0, { fixed: true });
  const a2 = doc.addPoint(10, 0, { fixed: true });
  const la = doc.addLine(a1.id, a2.id);
  const b1 = doc.addPoint(0, 0, { fixed: true });
  const b2 = doc.addPoint(0, 10);
  const lb = doc.addLine(b1.id, b2.id);
  const c = doc.addConstraint(createConstraint('perpendicular', { a: la.id, b: lb.id }));

  close0(maxAbs(c.residuals(doc)), 1e-12, '垂直时应≈0');

  b2.x = 3;
  const r = c.residuals(doc);
  near(r[0], 30 / (10 * Math.hypot(3, 10)), 1e-9, '残差应为归一化点积');
  assert(r[0] > 0.2, '破坏后残差应明显');

  const out = solve(doc);
  assert(out.converged, '求解应收敛');
  close0(maxAbs(c.residuals(doc)), 1e-6, '求解后残差为 0');
  const A = lineDir(doc, la.id);
  const B = lineDir(doc, lb.id);
  close0((A.dx * B.dx + A.dy * B.dy) / (Math.hypot(A.dx, A.dy) * Math.hypot(B.dx, B.dy)), 1e-6,
    '求解后应垂直');
});

/* =========================================================================
   9. 相切（线到圆心距离 − r）
   ========================================================================= */
test('tangent：直线与圆相切', () => {
  const doc = new Doc();
  const a = doc.addPoint(-20, 0, { fixed: true });
  const b = doc.addPoint(20, 0, { fixed: true });
  const line = doc.addLine(a.id, b.id);
  const cen = doc.addPoint(0, 5);
  const circle = doc.addCircle(cen.id, 5);
  const c = doc.addConstraint(createConstraint('tangent', { line: line.id, circle: circle.id }));

  close0(maxAbs(c.residuals(doc)), 1e-12, '圆心距 5、半径 5 时应相切');

  cen.y = 8;
  near(c.residuals(doc)[0], 3, 1e-9, '残差应为 圆心距−半径');
  assert(c.residuals(doc)[0] > 2, '破坏后残差应明显');

  const out = solve(doc);
  assert(out.converged, '求解应收敛');
  close0(maxAbs(c.residuals(doc)), 1e-6, '求解后残差为 0');

  // 几何关系：圆心到直线距离 = 半径
  const center = doc.pointOf(cen.id);
  const s = Math.abs(center.y - 0);
  near(s, circle.r, 1e-6, '求解后圆心到线距离应等于半径');
});

test('tangent：圆在直线两侧都能相切（残差 = |圆心距| − r）', () => {
  const doc = new Doc();
  const a = doc.addPoint(-20, 0, { fixed: true });
  const b = doc.addPoint(20, 0, { fixed: true });
  const line = doc.addLine(a.id, b.id);

  const below = doc.addPoint(0, -5); // 圆心在直线下方，有符号距离 s = −5
  const cBelow = doc.addCircle(below.id, 5);
  const kBelow = doc.addConstraint(
    createConstraint('tangent', { line: line.id, circle: cBelow.id })
  );
  close0(maxAbs(kBelow.residuals(doc)), 1e-12, '圆在直线下方、距 5、r=5 也应相切');

  const above = doc.addPoint(0, 5); // 圆心在直线上方，s = +5
  const cAbove = doc.addCircle(above.id, 5);
  const kAbove = doc.addConstraint(
    createConstraint('tangent', { line: line.id, circle: cAbove.id })
  );
  close0(maxAbs(kAbove.residuals(doc)), 1e-12, '圆在直线上方、距 5、r=5 也应相切');

  // 两侧同半径变化时残差同号：|s|−r 与切侧无关
  cBelow.r = 7;
  near(kBelow.residuals(doc)[0], -2, 1e-12, '下方：|s|−r 应为 −2');
  cAbove.r = 7;
  near(kAbove.residuals(doc)[0], -2, 1e-12, '上方：|s|−r 应为 −2');
});

/* =========================================================================
   10. 等长
   ========================================================================= */
test('equalLength：两条直线等长', () => {
  const doc = new Doc();
  const a1 = doc.addPoint(0, 0, { fixed: true });
  const a2 = doc.addPoint(10, 0, { fixed: true });
  const la = doc.addLine(a1.id, a2.id);
  const b1 = doc.addPoint(0, 5, { fixed: true });
  const b2 = doc.addPoint(10, 5);
  const lb = doc.addLine(b1.id, b2.id);
  const c = doc.addConstraint(createConstraint('equalLength', { a: la.id, b: lb.id }));

  close0(maxAbs(c.residuals(doc)), 1e-12, '等长时应≈0');

  b2.x = 4;
  near(c.residuals(doc)[0], 6, 1e-9, '残差应为长度差');
  assert(c.residuals(doc)[0] > 5, '破坏后残差应明显');

  const out = solve(doc);
  assert(out.converged, '求解应收敛');
  near(lineLen(doc, lb.id), 10, 1e-6, '求解后两线应等长');
  close0(maxAbs(c.residuals(doc)), 1e-6, '求解后残差为 0');
});

/* =========================================================================
   11. 等半径
   ========================================================================= */
test('equalRadius：两个圆等半径', () => {
  const doc = new Doc();
  const c1c = doc.addPoint(0, 0, { fixed: true });
  const c2c = doc.addPoint(30, 0, { fixed: true });
  const c1 = doc.addCircle(c1c.id, 6);
  const c2 = doc.addCircle(c2c.id, 6);
  const c = doc.addConstraint(createConstraint('equalRadius', { a: c1.id, b: c2.id }));

  close0(maxAbs(c.residuals(doc)), 1e-12, '等半径时应≈0');

  c2.r = 9;
  near(c.residuals(doc)[0], -3, 1e-9, '残差应为半径差');
  assert(Math.abs(c.residuals(doc)[0]) > 2, '破坏后残差应明显');

  const out = solve(doc);
  assert(out.converged, '求解应收敛');
  near(c1.r - c2.r, 0, 1e-6, '求解后两圆半径应相等');
});

/* =========================================================================
   12. 半径
   ========================================================================= */
test('radius：半径 4 mm', () => {
  const doc = new Doc();
  const cen = doc.addPoint(0, 0, { fixed: true });
  const circle = doc.addCircle(cen.id, 4);
  const c = doc.addConstraint(createConstraint('radius', { circle: circle.id }, 4));
  close0(maxAbs(c.residuals(doc)), 1e-9, '半径 4 应满足');

  circle.r = 9;
  near(c.residuals(doc)[0], 5, 1e-9, '破坏后残差应为 5');

  const out = solve(doc);
  assert(out.converged, '求解应收敛');
  near(circle.r, 4, 1e-6, '求解后半径应为 4');
});

/* =========================================================================
   13. 直径（弧同样适用）
   ========================================================================= */
test('diameter：圆弧直径 10 mm（arc 通用）', () => {
  const doc = new Doc();
  const cen = doc.addPoint(0, 0, { fixed: true });
  const arc = doc.addArc(cen.id, 5, 0, Math.PI / 2);
  const c = doc.addConstraint(createConstraint('diameter', { circle: arc.id }, 10));
  close0(maxAbs(c.residuals(doc)), 1e-9, '直径 10 应满足');

  arc.r = 2;
  near(c.residuals(doc)[0], -6, 1e-9, '破坏后残差应为 −6');

  const out = solve(doc);
  assert(out.converged, '求解应收敛');
  near(arc.r, 5, 1e-6, '求解后半径应为 5（直径 10）');
});

/* =========================================================================
   14. 角度（有向夹角，度）
   ========================================================================= */
test('angle：夹角 45°（度制入参）', () => {
  const doc = new Doc();
  const a1 = doc.addPoint(0, 0, { fixed: true });
  const a2 = doc.addPoint(10, 0, { fixed: true });
  const la = doc.addLine(a1.id, a2.id);
  const b1 = doc.addPoint(0, 0, { fixed: true });
  const b2 = doc.addPoint(10, 10);
  const lb = doc.addLine(b1.id, b2.id);
  const c = doc.addConstraint(createConstraint('angle', { a: la.id, b: lb.id }, 45));

  close0(maxAbs(c.residuals(doc)), 1e-12, '45° 夹角应满足');

  b2.y = 10 * Math.tan(rad(10)); // 改成 10°
  const r = c.residuals(doc);
  assert(r.length === 1 && allFinite(r), '角度残差应为 1 个有限值');
  near(r[0], rad(-35), 1e-6, '残差应为 θ − 目标角（弧度）');
  assert(Math.abs(r[0]) > 0.5, '破坏后残差应明显');

  const out = solve(doc);
  assert(out.converged, '求解应收敛');
  close0(maxAbs(c.residuals(doc)), 1e-6, '求解后残差为 0');
  near(wrapPi(angleBetween(doc, la.id, lb.id) - rad(45)), 0, 1e-6, '求解后夹角应为 45°');
});

test('angle：残差归一化到 (−π, π]', () => {
  const doc = new Doc();
  const a1 = doc.addPoint(0, 0, { fixed: true });
  const a2 = doc.addPoint(10, 0, { fixed: true });
  const la = doc.addLine(a1.id, a2.id);
  const b1 = doc.addPoint(0, 0, { fixed: true });

  for (const degv of [179.9, -179.9, 90, -90, 0]) {
    const p = doc.addPoint(10 * Math.cos(rad(degv)), 10 * Math.sin(rad(degv)));
    const lb = doc.addLine(b1.id, p.id);
    const c = doc.addConstraint(createConstraint('angle', { a: la.id, b: lb.id }, 0));
    const r = c.residuals(doc)[0];
    assert(Number.isFinite(r), degv + '° 角度残差应有限');
    assert(Math.abs(r) <= Math.PI + 1e-12, `${degv}° 残差应落在 (−π, π]，实际 ${r}`);
  }

  // 180° 边界：wrapPi(−π) 归一化为 +π，因此 180° 夹角应视为满足
  const pBack = doc.addPoint(-10, 0);
  const lbBack = doc.addLine(b1.id, pBack.id);
  const c180 = doc.addConstraint(createConstraint('angle', { a: la.id, b: lbBack.id }, 180));
  close0(maxAbs(c180.residuals(doc)), 1e-12, '180° 夹角应满足');
});

/* =========================================================================
   15. 对称（2 方程）
   ========================================================================= */
constraintCase('symmetric：两点关于直线对称', {
  build(doc) {
    const a1 = doc.addPoint(0, -10, { fixed: true });
    const a2 = doc.addPoint(0, 10, { fixed: true });
    const axis = doc.addLine(a1.id, a2.id);
    const a = doc.addPoint(-4, 3);
    const b = doc.addPoint(4, 3);
    const c = doc.addConstraint(
      createConstraint('symmetric', { a: a.id, b: b.id, line: axis.id })
    );
    return { c };
  },
  break(doc) {
    const pts = [...doc.entities.values()].filter((x) => x.type === 'point' && !x.fixed);
    pts[1].x = 7;
    pts[1].y = 6;
  },
  breakMin: 2,
  verify(doc) {
    const pts = [...doc.entities.values()].filter((x) => x.type === 'point' && !x.fixed);
    near((pts[0].x + pts[1].x) / 2, 0, 1e-6, '中点应在对称轴（x=0）上');
    near(pts[0].y - pts[1].y, 0, 1e-6, '两点应等高');
  },
});

/* =========================================================================
   16. 中点（2 方程）
   ========================================================================= */
constraintCase('midpoint：点位于线段中点', {
  build(doc) {
    const a1 = doc.addPoint(0, 0, { fixed: true });
    const a2 = doc.addPoint(10, 0, { fixed: true });
    const line = doc.addLine(a1.id, a2.id);
    const p = doc.addPoint(5, 0);
    const c = doc.addConstraint(createConstraint('midpoint', { p: p.id, line: line.id }));
    return { c };
  },
  break(doc) {
    const p = [...doc.entities.values()].find((x) => x.type === 'point' && !x.fixed);
    p.x = 2;
    p.y = 7;
  },
  breakMin: 4,
  verify(doc) {
    const p = [...doc.entities.values()].find((x) => x.type === 'point' && !x.fixed);
    near(p.x, 5, 1e-6, '中点 x 应为 5');
    near(p.y, 0, 1e-6, '中点 y 应为 0');
  },
});

/* =========================================================================
   17. 点在线上
   ========================================================================= */
constraintCase('pointOnLine：点在直线上', {
  build(doc) {
    const a1 = doc.addPoint(0, 0, { fixed: true });
    const a2 = doc.addPoint(10, 0, { fixed: true });
    const line = doc.addLine(a1.id, a2.id);
    const p = doc.addPoint(5, 0);
    const c = doc.addConstraint(createConstraint('pointOnLine', { p: p.id, line: line.id }));
    return { c };
  },
  break(doc) {
    const p = [...doc.entities.values()].find((x) => x.type === 'point' && !x.fixed);
    p.y = 4;
  },
  breakMin: 3,
  verify(doc) {
    const p = [...doc.entities.values()].find((x) => x.type === 'point' && !x.fixed);
    near(p.y, 0, 1e-6, '求解后点应回到直线上');
  },
});

/* =========================================================================
   18. 点在圆上
   ========================================================================= */
constraintCase('pointOnCircle：点在圆上', {
  build(doc) {
    const cen = doc.addPoint(0, 0, { fixed: true });
    const circle = doc.addCircle(cen.id, 5);
    const p = doc.addPoint(3, 4); // 正好在半径 5 的圆上
    const c = doc.addConstraint(createConstraint('pointOnCircle', { p: p.id, circle: circle.id }));
    return { c };
  },
  break(doc) {
    const p = [...doc.entities.values()].find((x) => x.type === 'point' && !x.fixed);
    p.x = 3;
    p.y = 3;
  },
  breakMin: 0.5,
  verify(doc) {
    const p = [...doc.entities.values()].find((x) => x.type === 'point' && !x.fixed);
    const circle = [...doc.entities.values()].find((x) => x.type === 'circle');
    near(Math.hypot(p.x, p.y) - circle.r, 0, 1e-6, '求解后点到圆心距离应等于半径');
  },
});

/* =========================================================================
   19. 固定（2 方程，目标坐标首次求值锁定）
   ========================================================================= */
test('fix：锁定点坐标', () => {
  const doc = new Doc();
  const p = doc.addPoint(3, 4);
  const c = doc.addConstraint(createConstraint('fix', { p: p.id }));

  const r0 = c.residuals(doc);
  assert(r0.length === 2, 'fix 应有 2 个方程');
  close0(maxAbs(r0), 1e-12, '刚创建时应为 0（目标=当前位置）');

  p.x = 9;
  p.y = -1;
  const broken = c.residuals(doc);
  near(broken[0], 6, 1e-9, '破坏后 x 残差应为 6');
  near(broken[1], -5, 1e-9, '破坏后 y 残差应为 −5');

  const out = solve(doc);
  assert(out.converged, '求解应收敛');
  near(p.x, 3, 1e-6, '求解后 x 应回到 3');
  near(p.y, 4, 1e-6, '求解后 y 应回到 4');
});

test('fix：显式 {x,y} 目标坐标', () => {
  const doc = new Doc();
  const p = doc.addPoint(5, 5);
  const c = doc.addConstraint(createConstraint('fix', { p: p.id }, { x: 1, y: 2 }));
  const r = c.residuals(doc);
  near(r[0], 4, 1e-12, 'x 残差应为 4');
  near(r[1], 3, 1e-12, 'y 残差应为 3');
});

/* =========================================================================
   20. 圆弧端点引用（{arc, end} 形态）
   ========================================================================= */
constraintCase('coincident：圆弧端点与点重合（{arc,end} 引用）', {
  build(doc) {
    const cen = doc.addPoint(0, 0, { fixed: true });
    const arc = doc.addArc(cen.id, 5, 0, Math.PI / 2); // 起点 = (5,0)
    const p = doc.addPoint(5, 0);
    const c = doc.addConstraint(
      createConstraint('coincident', { a: { arc: arc.id, end: 'start' }, b: p.id })
    );
    return { c, doc, arc, p };
  },
  break(doc) {
    const p = [...doc.entities.values()].find((x) => x.type === 'point' && !x.fixed);
    p.x = 8;
    p.y = 3;
  },
  breakMin: 2,
  verify(doc, c) {
    const arc = [...doc.entities.values()].find((x) => x.type === 'arc');
    const p = [...doc.entities.values()].find((x) => x.type === 'point' && !x.fixed);
    const s = doc.pointOf({ arc: arc.id, end: 'start' });
    near(Math.hypot(s.x - p.x, s.y - p.y), 0, 1e-6, '求解后圆弧起点应与点重合');
  },
});

/* =========================================================================
   21. 方程数契约（全部 19 种）
   ========================================================================= */
test('方程数：19 种约束的 residuals 长度与契约一致', () => {
  const doc = new Doc();
  const A = doc.addPoint(0, 0, { fixed: true });
  const B = doc.addPoint(10, 0, { fixed: true });
  const C = doc.addPoint(0, 5);
  const D = doc.addPoint(10, 5);
  const l1 = doc.addLine(A.id, B.id);
  const l2 = doc.addLine(C.id, D.id);
  const cen = doc.addPoint(5, -4);
  const c1 = doc.addCircle(cen.id, 3);
  const arc1 = doc.addArc(cen.id, 6, 0, Math.PI / 2);
  const P = doc.addPoint(4, 4);

  const specs = {
    coincident: [{ a: A.id, b: C.id }, null],
    pointOnLine: [{ p: C.id, line: l1.id }, null],
    pointOnCircle: [{ p: C.id, circle: c1.id }, null],
    horizontal: [{ line: l1.id }, null],
    vertical: [{ line: l1.id }, null],
    parallel: [{ a: l1.id, b: l2.id }, null],
    perpendicular: [{ a: l1.id, b: l2.id }, null],
    tangent: [{ line: l1.id, circle: c1.id }, null],
    equalLength: [{ a: l1.id, b: l2.id }, null],
    equalRadius: [{ a: c1.id, b: arc1.id }, null],
    distance: [{ a: A.id, b: C.id }, 10],
    distanceX: [{ a: A.id, b: C.id }, 10],
    distanceY: [{ a: A.id, b: C.id }, 5],
    radius: [{ circle: c1.id }, 3],
    diameter: [{ circle: arc1.id }, 12],
    angle: [{ a: l1.id, b: l2.id }, 45],
    symmetric: [{ a: A.id, b: C.id, line: l1.id }, null],
    midpoint: [{ p: P.id, line: l1.id }, null],
    fix: [{ p: P.id }, null],
  };

  assert(
    Object.keys(specs).length === CONSTRAINT_TYPES.length,
    `测试覆盖 ${Object.keys(specs).length} 种，元数据声明 ${CONSTRAINT_TYPES.length} 种`
  );

  for (const type of CONSTRAINT_TYPES) {
    const spec = specs[type];
    assert(spec, '缺少 ' + type + ' 的用例');
    const c = doc.addConstraint(createConstraint(type, spec[0], spec[1]));
    const r = c.residuals(doc);
    assert(r.length === rowsOf(type), `${type} 方程数应为 ${rowsOf(type)}，实际 ${r.length}`);
    assert(allFinite(r), `${type} 残差应全部有限`);
  }
});

/* =========================================================================
   22. 元数据契约
   ========================================================================= */
test('CONSTRAINT_META：19 种类型字段完整且合法', () => {
  const kinds = new Set(['geo', 'dim']);
  const units = new Set([null, 'mm', 'deg']);
  for (const type of CONSTRAINT_TYPES) {
    const m = CONSTRAINT_META[type];
    assert(m, '缺少元数据 ' + type);
    assert(typeof m.label === 'string' && m.label.length > 0, type + ' 缺少 label');
    assert(typeof m.glyph === 'string' && m.glyph.length > 0, type + ' 缺少 glyph');
    assert([...m.glyph].length === 1, type + ' glyph 应为单字符，实际 ' + m.glyph);
    assert(m.arity === 1 || m.arity === 2 || m.arity === 3, type + ' arity 非法');
    assert(kinds.has(m.kind), type + ' kind 非法');
    assert(units.has(m.valueUnit), type + ' valueUnit 非法');
    assert(typeof m.hint === 'string' && m.hint.length > 0, type + ' 缺少 hint');
  }
  // 尺寸约束必须带单位；几何约束不带
  for (const type of CONSTRAINT_TYPES) {
    const m = CONSTRAINT_META[type];
    if (m.kind === 'dim') assert(m.valueUnit !== null, type + ' 是尺寸约束，必须有 valueUnit');
    else assert(m.valueUnit === null, type + ' 是几何约束，valueUnit 应为 null');
  }
});

/* =========================================================================
   23. describeConstraint 文案
   ========================================================================= */
test('describeConstraint：中文描述', () => {
  const mk = (type, refs, value) => ({ type, refs, value });
  assert(describeConstraint(mk('distance', {}, 100)) === '距离 100 mm', '距离 100 mm');
  assert(describeConstraint(mk('radius', {}, 12.5)) === '半径 12.5 mm', '半径 12.5 mm');
  assert(describeConstraint(mk('diameter', {}, 20.5)) === '直径 20.5 mm', '直径 20.5 mm');
  assert(describeConstraint(mk('distanceY', {}, -25)) === '竖直距离 -25 mm', '竖直距离 -25 mm');
  assert(describeConstraint(mk('angle', {}, 90)) === '角度 90°', '角度 90°');
  assert(describeConstraint(mk('coincident', {})) === '重合', '重合');
  assert(describeConstraint(mk('parallel', {})) === '平行', '平行');
  // 值从 refs.value 读取
  assert(describeConstraint({ type: 'distance', refs: { value: 50 } }) === '距离 50 mm', 'refs.value');
  // 尺寸约束缺 value 时退化到 label，不抛异常
  assert(describeConstraint({ type: 'radius', refs: {} }) === '半径', '缺 value 应退化');
  assert(describeConstraint(null) === '未知约束', '空值应安全');
  assert(describeConstraint({ type: 'nope' }) === '未知约束（nope）', '未知类型应安全');
});

/* =========================================================================
   24. 工厂契约
   ========================================================================= */
test('createConstraint：对象契约（id/weight/value/refs）', () => {
  const doc = new Doc();
  const a = doc.addPoint(0, 0);
  const b = doc.addPoint(3, 4);
  const c = createConstraint('distance', { a: a.id, b: b.id }, 10);
  assert(c.id === null, '未入 doc 时 id 应为 null');
  assert(c.type === 'distance', 'type 应保留');
  assert(c.weight === 1, 'weight 默认 1');
  assert(typeof c.residuals === 'function', 'residuals 应为函数');
  assert(c.refs.a === a.id && c.refs.b === b.id, 'refs 应原样保留');
  assert(c.value === 10, 'value 应保留');

  const added = doc.addConstraint(c);
  assert(typeof added.id === 'string' && added.id.length > 0, '入 doc 后应有 id');

  // refs.value 也可作为取值来源
  const c2 = createConstraint('distance', { a: a.id, b: b.id, value: 50 });
  assert(c2.value === 50, '应从 refs.value 取值');
  near(c2.residuals(doc)[0], 5 - 50, 1e-12, '按 50 计算残差');

  // 尺寸约束必须有数值
  let threw = false;
  try {
    createConstraint('radius', { circle: 'x' });
  } catch (e) {
    threw = true;
  }
  assert(threw, '尺寸约束缺 value 应抛错');

  // 未知类型
  threw = false;
  try {
    createConstraint('nope', {});
  } catch (e) {
    threw = true;
  }
  assert(threw, '未知类型应抛错');
});

/* =========================================================================
   24b. 尺寸联动：app 的 cmdEditValue 路径（改 doc 内约束的 value）
   ========================================================================= */
test('尺寸约束：改写 doc 中约束的 value 后，求解跟随新值（cmdEditValue 路径）', () => {
  const doc = new Doc();
  const a = doc.addPoint(0, 0, { fixed: true });
  const b = doc.addPoint(30, 0);
  const k = createConstraint('distanceX', { a: a.id, b: b.id }, 10);
  doc.addConstraint(k);

  // app 的 cmdAddConstraint/cmdAddEntities 用 { ...c } 拷贝入 doc
  const stored = { ...k };
  doc.constraints.set(k.id, stored);

  // app 的 cmdEditValue：直接改写 doc 内那条对象的 value
  stored.value = 50;
  near(stored.residuals(doc)[0], 30 - 50, 1e-12, '残差应使用改写后的 value');

  const out = solve(doc);
  assert(out.converged, '求解应收敛');
  near(b.x - a.x, 50, 1e-6, '求解后水平距离应变成 50');

  // 再改一次，即时生效
  stored.value = 10;
  near(stored.residuals(doc)[0], (b.x - a.x) - 10, 1e-12, '再次改值应即时生效');
  const out2 = solve(doc);
  assert(out2.converged, '再次求解应收敛');
  near(b.x - a.x, 10, 1e-6, '求解后水平距离应改回 10');
});

test('尺寸约束：未改 value 时行为不变（回归保护）', () => {
  const doc = new Doc();
  const cen = doc.addPoint(0, 0, { fixed: true });
  const circle = doc.addCircle(cen.id, 4);
  const k = createConstraint('radius', { circle: circle.id }, 12);
  doc.addConstraint(k);
  const stored = { ...k };
  doc.constraints.set(k.id, stored);
  near(stored.residuals(doc)[0], 4 - 12, 1e-12, '按构造值 12 计算');
  const out = solve(doc);
  assert(out.converged, '求解应收敛');
  near(circle.r, 12, 1e-6, '半径应变为 12');
});

/* =========================================================================
   25. 实体被删除时不抛异常
   ========================================================================= */
test('删除实体后 residuals 返回空数组（不抛异常）', () => {
  const doc = new Doc();
  const a = doc.addPoint(0, 0, { fixed: true });
  const b = doc.addPoint(10, 0, { fixed: true });
  const line = doc.addLine(a.id, b.id);
  const cen = doc.addPoint(5, 5);
  const circle = doc.addCircle(cen.id, 3);
  const p = doc.addPoint(2, 2);

  const cs = [
    doc.addConstraint(createConstraint('horizontal', { line: line.id })),
    doc.addConstraint(createConstraint('tangent', { line: line.id, circle: circle.id })),
    doc.addConstraint(createConstraint('pointOnCircle', { p: p.id, circle: circle.id })),
    doc.addConstraint(createConstraint('coincident', { a: p.id, b: b.id })),
    doc.addConstraint(createConstraint('pointOnLine', { p: p.id, line: line.id })),
  ];
  for (const c of cs) assert(c.residuals(doc).length > 0, '删除前应有方程');

  // 删直线（级联删掉引用它的约束，但我们保留对象句柄）
  doc.removeEntity(line.id);
  // 删点（p、cen 都删）
  doc.removeEntity(p.id);
  doc.removeEntity(cen.id);

  for (const c of cs) {
    let r;
    r = c.residuals(doc);
    assert(Array.isArray(r), '应返回数组');
    assert(r.length === 0, '实体缺失时应返回空数组，实际 ' + JSON.stringify(r));
  }

  // 求解器不应因空残差崩溃
  const out = solve(doc);
  assert(typeof out.converged === 'boolean', '求解器应正常返回');
});

/* =========================================================================
   26. 除零保护：零长度直线不产生 NaN
   ========================================================================= */
test('零长度直线：各类残差有限且不为 NaN', () => {
  const doc = new Doc();
  const p = doc.addPoint(3, 3);
  const zero1 = doc.addLine(p.id, p.id);
  const zero2 = doc.addLine(p.id, p.id);
  const cen = doc.addPoint(0, 0, { fixed: true });
  const circle = doc.addCircle(cen.id, 5);
  const q = doc.addPoint(7, 1);

  const cases = [
    createConstraint('horizontal', { line: zero1.id }),
    createConstraint('vertical', { line: zero1.id }),
    createConstraint('parallel', { a: zero1.id, b: zero2.id }),
    createConstraint('perpendicular', { a: zero1.id, b: zero2.id }),
    createConstraint('tangent', { line: zero1.id, circle: circle.id }),
    createConstraint('pointOnLine', { p: q.id, line: zero1.id }),
    createConstraint('equalLength', { a: zero1.id, b: zero2.id }),
    createConstraint('angle', { a: zero1.id, b: zero2.id }, 30),
    createConstraint('symmetric', { a: q.id, b: cen.id, line: zero1.id }),
    createConstraint('midpoint', { p: q.id, line: zero1.id }),
  ];
  for (const c of cases) {
    doc.addConstraint(c);
    const r = c.residuals(doc);
    assert(r.length > 0, c.type + ' 应仍有方程');
    assert(allFinite(r), c.type + ' 残差出现非有限值：' + JSON.stringify(r));
  }
});

/* =========================================================================
   27. 残差是纯函数：不改写 doc，可重复求值
   ========================================================================= */
test('residuals 是纯函数（不改写 doc，重复求值一致）', () => {
  const doc = new Doc();
  const a = doc.addPoint(0, 0, { fixed: true });
  const b = doc.addPoint(3, 4);
  const line = doc.addLine(a.id, b.id);
  const c1 = doc.addConstraint(createConstraint('distance', { a: a.id, b: b.id }, 10));
  const c2 = doc.addConstraint(createConstraint('horizontal', { line: line.id }));
  const c3 = doc.addConstraint(createConstraint('fix', { p: b.id }));

  const before = JSON.stringify(doc.toJSON());
  const r1 = [c1.residuals(doc), c2.residuals(doc), c3.residuals(doc)];
  const r2 = [c1.residuals(doc), c2.residuals(doc), c3.residuals(doc)];
  const after = JSON.stringify(doc.toJSON());

  assert(before === after, 'residuals 不应改写 doc');
  for (let i = 0; i < r1.length; i++) {
    assert(r1[i].length === r2[i].length, '重复求值方程数应一致');
    for (let k = 0; k < r1[i].length; k++) {
      assert(r1[i][k] === r2[i][k], '重复求值结果应一致');
    }
  }
});

/* =========================================================================
   28. 权重参与求解（weight > 1 的约束优先满足）
   ========================================================================= */
test('weight：权重大小不影响静态残差，但参与求解', () => {
  const doc = new Doc();
  const a = doc.addPoint(0, 0, { fixed: true });
  const b = doc.addPoint(10, 0);
  const c = doc.addConstraint(createConstraint('distanceY', { a: a.id, b: b.id }, 0));
  const raw = c.residuals(doc)[0];
  c.weight = 5;
  near(c.residuals(doc)[0], raw, 1e-12, 'residuals 本身不应乘权重');
  const out = solve(doc);
  assert(out.converged, '加权求解应收敛');
  near(b.y, 0, 1e-6, '求解后应满足');
});

/* ---------------------------------------------------------------------------
   汇总
   ------------------------------------------------------------------------- */
console.log('');
console.log('============================================');
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`);
if (failed) {
  console.log('失败项：');
  for (const line of failureLines) console.log('  - ' + line);
}
console.log('============================================');

process.exit(failed ? 1 : 0);
