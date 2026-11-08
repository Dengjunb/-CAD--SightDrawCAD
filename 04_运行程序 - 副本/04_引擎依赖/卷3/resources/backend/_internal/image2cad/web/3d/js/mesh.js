/* =============================================================================
   AI 3D · 二维轮廓 → 拉伸实体（带孔）
   输入：识别结果的场景（segments / circles / rects / polylines，像素坐标）
   输出：三角网格 {verts:[[x,y,z]...], faces:[[i,j,k]...], stats:{...}}

   坐标约定：识别是像素坐标、y 向下；这里换成 CAD 空间：
     X = px * scale,  Z = -py * scale,  Y = 拉伸高度（Y 向上）。
   ========================================================================== */

export function collectContours(scene, scale) {
  const out = [];
  const s = scale || scene.scale_mm_per_px || 1;
  const tf = (pt) => [pt[0] * s, -pt[1] * s];

  for (const c of scene.circles || []) {
    const r = c.r * s;
    const pts = [];
    const N = 48;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push(tf([c.cx + c.r * Math.cos(a), c.cy + c.r * Math.sin(a)]));
    }
    out.push({ pts, kind: 'circle', r, area: Math.abs(Math.PI * r * r) });
  }
  for (const rct of scene.rects || []) {
    const x0 = rct.x, y0 = rct.y, x1 = rct.x + rct.w, y1 = rct.y + rct.h;
    const pts = [tf([x0, y0]), tf([x1, y0]), tf([x1, y1]), tf([x0, y1])];
    out.push({ pts, kind: 'rect', area: Math.abs(rct.w * rct.h * s * s) });
  }
  for (const p of scene.polylines || []) {
    const pts = (p.pts || []).map((q) => tf(q));
    if (pts.length >= 3 && p.closed !== false) {
      out.push({ pts, kind: 'polyline', area: Math.abs(polyArea(pts)) });
    }
  }
  return out.filter((c) => c.pts.length >= 3 && c.area > 1e-6);
}

export function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const hit = (yi > pt[1]) !== (yj > pt[1]) &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / ((yj - yi) || 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function ensureCCW(pts) {
  return polyArea(pts) < 0 ? pts.slice().reverse() : pts;
}

/* --- 三角化：带孔多边形（孔桥接 + 耳切） --- */
export function triangulate(outer, holes) {
  let poly = ensureCCW(outer.slice());
  const hs = (holes || []).map((h) => ensureCCW(h.slice()));
  for (const hole of hs) {
    const merged = bridgeHole(poly, hole);
    if (merged) poly = merged;
  }
  return earClip(poly);
}

function bridgeHole(outer, hole) {
  let hi = 0;
  for (let i = 1; i < hole.length; i++) if (hole[i][0] > hole[hi][0]) hi = i;
  const hp = hole[hi];
  let bestEdge = -1, bestT = Infinity, bestX = Infinity;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i], b = outer[(i + 1) % outer.length];
    const minY = Math.min(a[1], b[1]), maxY = Math.max(a[1], b[1]);
    if (hp[1] < minY || hp[1] > maxY) continue;
    if (Math.abs(b[1] - a[1]) < 1e-12) continue;
    const t = (hp[1] - a[1]) / (b[1] - a[1]);
    if (t < 0 || t > 1) continue;
    const x = a[0] + t * (b[0] - a[0]);
    if (x < hp[0] - 1e-9) continue;
    if (x < bestX) { bestX = x; bestEdge = i; bestT = t; }
  }
  if (bestEdge < 0) return null;
  const intersection = [bestX, hp[1]];
  const rotated = hole.slice(hi).concat(hole.slice(0, hi));
  const merged = outer.slice(0, bestEdge + 1).concat(
    [intersection], rotated, [rotated[0], intersection],
    outer.slice(bestEdge + 1)
  );
  return merged;
}

function earClip(poly) {
  const pts = poly.slice();
  const tris = [];
  let guard = 0;
  while (pts.length > 3 && guard++ < pts.length * pts.length) {
    let clipped = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cross <= 1e-12) continue; // 凹点或退化
      let inside = false;
      for (let k = 0; k < pts.length; k++) {
        if (k === i || k === (i - 1 + pts.length) % pts.length || k === (i + 1) % pts.length) continue;
        if (pointInTriangle(pts[k], a, b, c)) { inside = true; break; }
      }
      if (inside) continue;
      tris.push([a, b, c]);
      pts.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (pts.length === 3) tris.push([pts[0], pts[1], pts[2]]);
  return tris;
}

function pointInTriangle(p, a, b, c) {
  const d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  const d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]);
  const d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
  const neg = (d1 < -1e-12) || (d2 < -1e-12) || (d3 < -1e-12);
  const pos = (d1 > 1e-12) || (d2 > 1e-12) || (d3 > 1e-12);
  return !(neg && pos);
}

/* --- 主入口：选主轮廓 + 孔 → 拉伸网格 --- */
export function buildMesh(scene, opts = {}) {
  const height = Math.max(0.5, Number(opts.height) || 20);
  const scale = opts.scale || scene.scale_mm_per_px || 1;
  const contours = collectContours(scene, scale);
  const stats = { contours: contours.length, outer: 0, holes: 0, note: '' };

  if (!contours.length) return { verts: [], faces: [], stats: { ...stats, note: '没有闭合轮廓' } };

  // 主轮廓：面积最大的闭合轮廓；若它吞掉几乎所有轮廓，说明是图框，退而取次大的「不是图框」的
  contours.sort((a, b) => b.area - a.area);
  let outer = contours[0];
  if (contours.length > 1) {
    // 判「图框」：包围盒几乎铺满整张图（宽高都 >90%），这种外框不是零件外形，
    // 换成次大的闭合轮廓，否则 3D 会变成一块「带孔的大板」。
    const xs = outer.pts.map((p) => p[0]), ys = outer.pts.map((p) => p[1]);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    const imgW = scene.width_px * scale, imgH = scene.height_px * scale;
    const isFrame = bw > 0.9 * imgW && bh > 0.9 * imgH;
    if (isFrame) outer = contours[1];
  }
  const holes = contours.filter((c) => c !== outer && c.area < outer.area * 0.98 &&
    c.pts.every((p) => pointInPoly(p, outer.pts)));

  stats.outer = 1;
  stats.holes = holes.length;

  let tris = [];
  try {
    tris = triangulate(outer.pts, holes.map((h) => h.pts));
  } catch (e) {
    tris = earClip(ensureCCW(outer.pts.slice()));
    stats.note = '三角化降级：' + e.message;
  }
  if (!tris.length) return { verts: [], faces: [], stats: { ...stats, note: '三角化失败' } };

  // 顶点池：外轮廓 + 各孔 的原始点（三角化桥接产生的新点也并入，保证盖面闭合）
  const pool = [];
  const keyOf = (p) => Math.round(p[0] * 1e4) + ',' + Math.round(p[1] * 1e4);
  const indexOf = new Map();
  const addPoint = (p) => {
    const k = keyOf(p);
    if (indexOf.has(k)) return indexOf.get(k);
    const i = pool.length;
    pool.push([p[0], p[1]]);
    indexOf.set(k, i);
    return i;
  };

  const rings = [outer.pts].concat(holes.map((h) => h.pts));
  const ringIndices = [];
  for (const ring of rings) {
    const idx = [];
    for (const p of ring) idx.push(addPoint(p));
    ringIndices.push(idx);
  }
  for (const t of tris) for (const p of t) addPoint(p);

  const verts = [];
  const faces = [];
  const n = pool.length;
  for (const p of pool) verts.push([p[0], 0, p[1]]);            // 底
  for (const p of pool) verts.push([p[0], height, p[1]]);      // 顶
  const TOP = n;

  // 盖面：底面朝下（反向），顶面朝上
  for (const t of tris) {
    const ia = indexOf.get(keyOf(t[0]));
    const ib = indexOf.get(keyOf(t[1]));
    const ic = indexOf.get(keyOf(t[2]));
    if (ia == null || ib == null || ic == null) continue;
    faces.push([ic, ib, ia]);
    faces.push([TOP + ia, TOP + ib, TOP + ic]);
  }
  // 侧壁：外轮廓朝外，孔壁朝内（绕向相反）
  for (let r = 0; r < ringIndices.length; r++) {
    const idx = ringIndices[r];
    const holeWall = r > 0;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[i], b = idx[(i + 1) % idx.length];
      if (holeWall) {
        faces.push([a, TOP + b, TOP + a]);
        faces.push([a, b, TOP + b]);
      } else {
        faces.push([a, b, TOP + b]);
        faces.push([a, TOP + b, TOP + a]);
      }
    }
  }
  stats.vertices = verts.length;
  stats.faces = faces.length;
  return { verts, faces, stats };
}

/* --- 导出 OBJ / STL（ASCII） --- */
export function meshToOBJ(mesh, name = 'ai3d') {
  const lines = ['# AI 3D · ' + name];
  for (const v of mesh.verts) lines.push('v ' + v[0].toFixed(4) + ' ' + v[1].toFixed(4) + ' ' + v[2].toFixed(4));
  for (const f of mesh.faces) lines.push('f ' + (f[0] + 1) + ' ' + (f[1] + 1) + ' ' + (f[2] + 1));
  return lines.join('\n') + '\n';
}

export function meshToSTL(mesh, name = 'ai3d') {
  const out = ['solid ' + name];
  for (const f of mesh.faces) {
    const a = mesh.verts[f[0]], b = mesh.verts[f[1]], c = mesh.verts[f[2]];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map((k) => k / len);
    out.push(' facet normal ' + n.map((k) => k.toFixed(4)).join(' '));
    out.push('  outer loop');
    for (const p of [a, b, c]) out.push('   vertex ' + p.map((k) => k.toFixed(4)).join(' '));
    out.push('  endloop');
    out.push(' endfacet');
  }
  out.push('endsolid ' + name);
  return out.join('\n') + '\n';
}

