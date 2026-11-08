/* =============================================================================
   参数化草图 · 约束求解器
   Levenberg–Marquardt + 数值雅可比（前向差分 + 直接变量扰动）。
   只做二维草图自由度；求解失败自动回滚到上一有效状态。
   诊断：自由度 = 变量数 − rank(J)；冗余 = 约束方程数 − rank(J)。

   性能要点（拖动时每帧都要解，必须快）：
     * 雅可比按「变量 → 实体字段」直接扰动，不再每次 applyVars 全量写回（O(n²) → O(n)）；
     * 前向差分（n 次求值），比中心差分省一半；
     * 残差方程数按约束缓存，避免每轮重复求值计数。
   ========================================================================== */

import { norm2, normInf, matrixRank } from './math.js';

const CONF_TOL = 1e-6;

/** 变量下标 → 实体字段，用于直接扰动（避免全量写回） */
function varTargets(doc, index) {
  const targets = [];
  for (const [id, base] of index) {
    const e = doc.entities.get(id);
    if (!e) continue;
    if (e.type === 'point') {
      targets[base] = { ent: e, key: 'x', off: 0 };
      targets[base + 1] = { ent: e, key: 'y', off: 1 };
    } else if (e.type === 'circle') {
      targets[base] = { ent: e, key: 'r', off: 0 };
    } else if (e.type === 'arc') {
      targets[base] = { ent: e, key: 'r', off: 0 };
      targets[base + 1] = { ent: e, key: 'a0', off: 1 };
      targets[base + 2] = { ent: e, key: 'a1', off: 2 };
    }
  }
  return targets;
}

function applyX(doc, x, index) {
  doc.applyVars(x, index);
}

/** 残差向量：各约束残差 × 权重；同时缓存每个约束的方程数 */
function residualsOf(doc, cons) {
  const out = [];
  for (const c of cons) {
    const r = c.residuals(doc);
    if (r.length !== undefined) c.__rows = r.length;
    const w = typeof c.weight === 'number' ? c.weight : 1;
    for (let i = 0; i < r.length; i++) out.push(r[i] * w);
  }
  return out;
}

function countRows(doc, cons) {
  let m = 0;
  for (const c of cons) {
    if (typeof c.__rows === 'number') m += c.__rows;
    else m += c.residuals(doc).length;
  }
  return m;
}

/** 前向差分雅可比：m×n，O(n) 次残差求值，且只改一个字段 */
function jacobian(doc, cons, x, index, n, targets) {
  const m = countRows(doc, cons);
  const J = new Array(m);
  for (let i = 0; i < m; i++) J[i] = new Float64Array(n);
  const r0 = residualsOf(doc, cons);
  for (let j = 0; j < n; j++) {
    const t = targets[j];
    if (!t) continue;
    const old = t.ent[t.key];
    const h = 1e-7 * Math.max(1, Math.abs(old));
    t.ent[t.key] = old + h;
    const rp = residualsOf(doc, cons);
    t.ent[t.key] = old;
    for (let i = 0; i < m; i++) J[i][j] = (rp[i] - r0[i]) / h;
  }
  return { J, m, r0 };
}

function normalEquations(J, r, m, n) {
  const A = new Array(n);
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) A[i] = new Float64Array(n);
  for (let row = 0; row < m; row++) {
    const Jr = J[row];
    const ri = r[row];
    for (let i = 0; i < n; i++) {
      const vi = Jr[i];
      if (vi === 0) continue;
      g[i] += vi * ri;
      const Ai = A[i];
      for (let j = i; j < n; j++) Ai[j] += vi * Jr[j];
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) A[i][j] = A[j][i];
  return { A, g };
}

function solveSmall(A, b, n) {
  const M = new Array(n);
  for (let i = 0; i < n; i++) {
    M[i] = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) M[i][j] = A[i][j];
    M[i][n] = b[i];
  }
  for (let col = 0; col < n; col++) {
    let piv = col, best = Math.abs(M[col][col]);
    for (let rr = col + 1; rr < n; rr++) {
      const v = Math.abs(M[rr][col]);
      if (v > best) { best = v; piv = rr; }
    }
    if (best < 1e-14) return null;
    if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
    const d = M[col][col];
    for (let rr = col + 1; rr < n; rr++) {
      const f = M[rr][col] / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[rr][c] -= f * M[col][c];
    }
  }
  const out = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * out[j];
    out[i] = s / M[i][i];
  }
  return out;
}

function lmSolve(doc, cons, index, x0, n, maxIter, tol, targets) {
  let x = x0.slice();
  applyX(doc, x, index);
  let r = residualsOf(doc, cons);
  const m = r.length;
  let f = norm2(r);
  let { J } = jacobian(doc, cons, x, index, n, targets);
  let lambda = 1e-3;
  let iters = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    iters = iter + 1;
    const { A, g } = normalEquations(J, r, m, n);
    let accepted = false;
    let step = null;
    let newF = f;
    let newR = null;

    for (let inner = 0; inner < 8; inner++) {
      const M = new Array(n);
      for (let i = 0; i < n; i++) {
        M[i] = Float64Array.from(A[i]);
        M[i][i] += lambda * Math.max(A[i][i], 1e-9);
      }
      const rhs = new Float64Array(n);
      for (let i = 0; i < n; i++) rhs[i] = -g[i];
      const delta = solveSmall(M, rhs, n);
      if (!delta) { lambda *= 10; continue; }
      const candidate = new Float64Array(n);
      for (let i = 0; i < n; i++) candidate[i] = x[i] + delta[i];
      applyX(doc, candidate, index);
      const rNew = residualsOf(doc, cons);
      const fNew = norm2(rNew);
      if (fNew < f) {
        accepted = true; step = delta; newF = fNew; newR = rNew; x = candidate;
        break;
      }
      lambda *= 10;
    }

    if (!accepted) break;
    r = newR; f = newF;
    lambda = Math.max(lambda / 3, 1e-12);
    const next = jacobian(doc, cons, x, index, n, targets);
    J = next.J;
    if (normInf(step) < 1e-12 || f < tol) break;
  }
  return { x, r, f, iters, J, m };
}

/**
 * 求解。
 * @param {Doc} doc
 * @param {object} opts {fixedPoints?:Set<string>, maxIter?:number, tol?:number, apply?:boolean}
 */
export function solve(doc, opts = {}) {
  const maxIter = opts.maxIter ?? 60;
  const tol = opts.tol ?? 1e-9;
  const apply = opts.apply !== false;
  let cons = [...doc.constraints.values()];
  if (opts.onlyConstraintIds) {
    const keep = opts.onlyConstraintIds;
    cons = cons.filter((c) => keep.has(c.id));
  }
  const vars = doc.buildVars(opts.fixedPoints || null, opts.includeEntities || null);
  const n = vars.size;
  const index = vars.index;
  const x0 = vars.values.slice();
  const before = doc.snapshotVars();

  if (n === 0) {
    return {
      ok: true, converged: true, dof: 0, redundant: 0, freeVars: 0,
      iterations: 0, residualMax: 0, residualNorm: 0, conflicts: [], perConstraint: [],
      message: '没有可求解的变量',
    };
  }
  if (!cons.length) {
    if (apply) applyX(doc, x0, index);
    return {
      ok: true, converged: true, dof: n, redundant: 0, freeVars: n,
      iterations: 0, residualMax: 0, residualNorm: 0, conflicts: [], perConstraint: [],
      message: `欠约束 ${n} 个自由度`,
    };
  }

  const targets = varTargets(doc, index);
  const res = lmSolve(doc, cons, index, x0, n, maxIter, tol, targets);
  const rMax = res.r.length ? normInf(res.r) : 0;
  const converged = rMax <= CONF_TOL;

  let dof = n, redundant = 0;
  if (res.J && res.J.length && n) {
    const { rank } = matrixRank(res.J, res.m, n);
    dof = n - rank;
    redundant = Math.max(0, res.m - rank);
  }

  const perConstraint = cons.map((c) => {
    applyX(doc, res.x, index);
    const rr = c.residuals(doc);
    const w = typeof c.weight === 'number' ? c.weight : 1;
    return { id: c.id, type: c.type, residual: normInf(rr.map((v) => v * w)) };
  });
  const conflicts = converged ? [] : perConstraint.filter((p) => p.residual > CONF_TOL).map((p) => p.id);

  let message;
  if (!converged) message = `求解失败：${conflicts.length || 1} 条约束无法同时满足`;
  else if (dof > 0) message = `欠约束：剩余 ${dof} 个自由度`;
  else if (redundant > 0) message = `完全约束（含 ${redundant} 条冗余约束）`;
  else message = '完全约束';

  if (apply) {
    if (converged) applyX(doc, res.x, index);
    else doc.restoreVars(before);
  } else {
    doc.restoreVars(before);
  }

  return {
    ok: converged,
    converged, dof, redundant, freeVars: n, iterations: res.iters,
    residualMax: rMax, residualNorm: res.f,
    conflicts, perConstraint, message,
  };
}

/** 只计算残差，不改几何（给状态栏/冲突定位用） */
export function residualReport(doc) {
  return [...doc.constraints.values()].map((c) => {
    const rr = c.residuals(doc);
    return { id: c.id, type: c.type, residual: normInf(rr) };
  });
}
