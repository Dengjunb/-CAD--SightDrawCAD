/* =============================================================================
   参数化草图 · 数值基础（线性代数 / 向量）
   零依赖 ES Module，可在 node 中直接 import 做单元测试。
   ========================================================================== */

export function norm2(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

export function normInf(v) {
  let m = 0;
  for (let i = 0; i < v.length; i++) m = Math.max(m, Math.abs(v[i]));
  return m;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function addVec(a, b) {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
  return out;
}

export function subVec(a, b) {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

export function scaleVec(a, k) {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * k;
  return out;
}

/* ---------------------------------------------------------------------------
   A x = b，A 为 n×n 稠密数组（Array of Float64Array）。高斯消元 + 部分主元。
   返回 null 表示奇异（主元过小）。
   ------------------------------------------------------------------------- */
export function solveLinear(A, b, n) {
  const M = new Array(n);
  for (let i = 0; i < n; i++) {
    M[i] = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) M[i][j] = A[i][j];
    M[i][n] = b[i];
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-14) return null;
    if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
    const d = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

/* ---------------------------------------------------------------------------
   矩阵秩：对 m×n 矩阵 J 做行阶梯化，返回 {rank, pivotCols}。
   用于约束系统自由度 / 冗余约束诊断。
   ------------------------------------------------------------------------- */
export function matrixRank(J, m, n, tol = 1e-9) {
  const A = new Array(m);
  for (let i = 0; i < m; i++) A[i] = Float64Array.from(J[i]);
  let rank = 0;
  const pivotCols = [];
  for (let col = 0; col < n && rank < m; col++) {
    let piv = rank;
    let best = Math.abs(A[rank][col]);
    for (let r = rank + 1; r < m; r++) {
      const v = Math.abs(A[r][col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best <= tol) continue;
    if (piv !== rank) { const t = A[piv]; A[piv] = A[rank]; A[rank] = t; }
    const d = A[rank][col];
    for (let r = rank + 1; r < m; r++) {
      const f = A[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[rank][c];
    }
    pivotCols.push(col);
    rank++;
  }
  return { rank, pivotCols };
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

export function deg(radv) { return (radv * 180) / Math.PI; }
export function rad(degv) { return (degv * Math.PI) / 180; }

/* 归一化角度到 [0, 2π) */
export function norm2pi(a) {
  const t = a % (Math.PI * 2);
  return t < 0 ? t + Math.PI * 2 : t;
}
