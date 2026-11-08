/* =============================================================================
   参数化草图 · 应用层
   工具 / 选择 / 捕捉 / 约束 / 求解联动 / 命令栈 / 面板 / DXF
   ========================================================================== */

import { Doc } from './model.js';
import { solve } from './solver.js';
import { Renderer } from './render.js';
import { CommandStack, cmdAddEntities, cmdAddConstraint, cmdRemoveConstraint, cmdDeleteSelection, cmdEditValue } from './commands.js';
import { createConstraint, CONSTRAINT_META, describeConstraint } from './constraints.js';
import { exportDXF, importDXF } from './dxf.js';
import { parseIntent } from './nl.js';
import { norm2pi, deg, rad } from './math.js';

const $ = (sel) => document.querySelector(sel);
const D2R = Math.PI / 180;

/* ---------------- 状态 ---------------- */
const app = {
  doc: new Doc(),
  renderer: null,
  stack: new CommandStack(200),
  tool: 'select',
  selection: new Set(),
  hover: {},
  snap: null,
  preview: null,
  drag: null,
  pan: null,
  box: null,
  solveResult: null,
  draft: { points: [], tool: 'select' },
  lastVars: null,
};

const toolDefs = {
  select: { label: '选择', icon: '⬚', key: 'Esc' },
  line: { label: '直线', icon: '／', key: 'L' },
  rect: { label: '矩形', icon: '▭', key: 'R' },
  circle: { label: '圆', icon: '○', key: 'C' },
  arc: { label: '圆弧', icon: '◜', key: 'A' },
  point: { label: '点', icon: '•', key: 'P' },
};

const constraintTools = [
  ['coincident', '重合', 1], ['horizontal', '水平', 1], ['vertical', '竖直', 1],
  ['parallel', '平行', 2], ['perpendicular', '垂直', 2], ['tangent', '相切', 2],
  ['equalLength', '等长', 2], ['equalRadius', '等半径', 2],
  ['distance', '距离', 2], ['distanceX', '水平距', 2], ['distanceY', '竖直距', 2],
  ['radius', '半径', 1], ['diameter', '直径', 1], ['angle', '角度', 2],
  ['symmetric', '对称', 3], ['midpoint', '中点', 2], ['pointOnLine', '点在线上', 2],
  ['pointOnCircle', '点在圆上', 2], ['fix', '固定', 1],
];

/* ---------------- 初始化 ---------------- */
function init() {
  const svg = $('#canvas');
  app.renderer = new Renderer(svg);
  resize();
  window.addEventListener('resize', resize);

  // 自然语言建模
  const nlInput = $('#nl-input');
  const nlSend = () => {
    const text = nlInput.value.trim();
    if (!text) return;
    const reply = runNL(text);
    $('#nl-reply').textContent = reply;
    nlInput.value = '';
  };
  if (nlInput) {
    $('#nl-send').addEventListener('click', nlSend);
    nlInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') nlSend(); });
    document.querySelectorAll('[data-nl]').forEach((b) => b.addEventListener('click', () => {
      nlInput.value = b.dataset.nl;
      nlSend();
    }));
  }

  bindPointer(svg);
  bindKeys();
  bindToolbar();
  bindHeader();
  app.stack.on(() => updateToolbarState());

  loadDemo(false);
  render();
  fitView();
}

function resize() {
  const wrap = $('#canvas-wrap');
  const r = wrap.getBoundingClientRect();
  app.renderer.setSize(Math.max(320, r.width), Math.max(240, r.height));
  render();
}

/* ---------------- 求解 ---------------- */
function solveNow(opts = {}) {
  try {
    const res = solve(app.doc, opts);
    app.solveResult = res;
    updateStatus();
    return res;
  } catch (err) {
    console.error('求解异常', err);
    app.solveResult = { converged: false, message: '求解异常：' + err.message, dof: 0, conflicts: [], perConstraint: [] };
    updateStatus();
    return app.solveResult;
  }
}

function conflictEntitySet() {
  const set = new Set();
  const res = app.solveResult;
  if (!res || !res.conflicts || !res.conflicts.length) return set;
  for (const cid of res.conflicts) {
    const c = app.doc.constraints.get(cid);
    if (!c) continue;
    for (const v of Object.values(c.refs)) {
      if (typeof v === 'string') set.add(v);
    }
  }
  return set;
}

/* ---------------- 渲染 ---------------- */
let rafPending = false;
function render() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const res = app.solveResult || {};
    app.renderer.render(app.doc, {
      selection: app.selection,
      hover: app.hover,
      snap: app.snap,
      preview: app.preview,
      rubber: app.rubber,
      conflictIds: new Set(res.conflicts || []),
      conflictEntities: conflictEntitySet(),
    });
    throttlePanels();
  });
}

/* 面板刷新节流：拖动/缩放时不再每帧重建列表 */
let lastPanelsAt = 0;
function throttlePanels(force) {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (force || now - lastPanelsAt > 140) {
    lastPanelsAt = now;
    updatePanels();
  }
}

/* ---------------- 坐标与命中 ---------------- */
function evPos(ev) {
  const rect = app.renderer.svg.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}
function world(ev) {
  const p = evPos(ev);
  return { x: app.renderer.wx(p.x), y: app.renderer.wy(p.y), sx: p.x, sy: p.y };
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hitTest(sx, sy, tolPx = 7) {
  const r = app.renderer;
  let best = null;
  const consider = (id, dist, prio) => {
    if (dist <= tolPx && (!best || prio > best.prio || (prio === best.prio && dist < best.dist))) {
      best = { id, dist, prio };
    }
  };
  for (const e of app.doc.entities.values()) {
    if (e.type === 'point') {
      consider(e.id, Math.hypot(sx - r.sx(e.x), sy - r.sy(e.y)), 3);
    } else if (e.type === 'line') {
      const a = app.doc.pointOf(e.p1), b = app.doc.pointOf(e.p2);
      consider(e.id, distToSegment(sx, sy, r.sx(a.x), r.sy(a.y), r.sx(b.x), r.sy(b.y)), 1);
    } else if (e.type === 'circle' || e.type === 'arc') {
      const c = app.doc.pointOf(e.center);
      const d = Math.abs(Math.hypot(sx - r.sx(c.x), sy - r.sy(c.y)) - e.r * r.view.scale);
      if (e.type === 'arc') {
        const ang = Math.atan2(r.wy(sy) - c.y, r.wx(sx) - c.x);
        if (!angleInArc(ang, e.a0, e.a1)) continue;
      }
      consider(e.id, d, 2);
    }
  }
  return best ? best.id : null;
}

function angleInArc(a, a0, a1) {
  const sweep = norm2pi(a1 - a0);
  const t = norm2pi(a - a0);
  return t <= sweep + 1e-6;
}

function snapPoint(sx, sy) {
  let best = null;
  for (const e of app.doc.entities.values()) {
    if (e.type !== 'point') continue;
    const d = Math.hypot(sx - app.renderer.sx(e.x), sy - app.renderer.sy(e.y));
    if (d <= 12 && (!best || d < best.d)) best = { d, id: e.id, x: e.x, y: e.y };
  }
  if (best) return { pos: { x: best.x, y: best.y }, kind: '端点', pointId: best.id };
  return null;
}

/* ---------------- 工具 ---------------- */
function setTool(tool) {
  app.tool = tool;
  app.draft.points = [];
  app.preview = null;
  app.rubber = null;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  hint(toolHint(tool));
  render();
}

function toolHint(tool) {
  if (tool === 'select') return '选择对象；拖动点/图元移动，Shift 多选，Delete 删除';
  if (tool === 'line') return '直线：单击起点，再单击终点（可捕捉端点）';
  if (tool === 'rect') return '矩形：单击一个角，再单击对角（自动加水平/竖直约束）';
  if (tool === 'circle') return '圆：单击圆心，再单击圆周上一点确定半径';
  if (tool === 'arc') return '圆弧：单击圆心，再单击起点，再单击终点';
  if (tool === 'point') return '点：单击放置';
  return '';
}

/* ---------------- 指针交互 ---------------- */
function bindPointer(svg) {
  svg.addEventListener('pointerdown', (ev) => {
    try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* 合成事件没有真实指针 */ }
    const w = world(ev);
    if (ev.button === 1 || (ev.button === 0 && ev.altKey)) {
      app.pan = { sx: w.sx, sy: w.sy };
      return;
    }
    if (ev.button !== 0) return;

    if (app.tool === 'select') {
      const hit = hitTest(w.sx, w.sy);
      const glyph = ev.target.closest ? ev.target.closest('.glyph') : null;
      if (glyph) {
        const cid = glyph.dataset.cid;
        app.selection = new Set([cid]);
        render();
        return;
      }
      if (hit) {
        const ent = app.doc.entity(hit);
        const isPoint = ent && ent.type === 'point';
        if (!ev.shiftKey) {
          if (!app.selection.has(hit)) app.selection = new Set([hit]);
        } else {
          if (app.selection.has(hit)) app.selection.delete(hit); else app.selection.add(hit);
        }
        if (isPoint || ent.type === 'line' || ent.type === 'circle' || ent.type === 'arc') {
          startDrag(w, ev);
        }
        render();
      } else {
        app.box = { x0: w.sx, y0: w.sy, x1: w.sx, y1: w.sy };
        if (!ev.shiftKey) app.selection = new Set();
        render();
      }
      return;
    }

    handleDrawClick(w);
  });

  svg.addEventListener('pointermove', (ev) => {
    const w = world(ev);
    if (app.pan) {
      app.renderer.pan(w.sx - app.pan.sx, w.sy - app.pan.sy);
      app.pan = { sx: w.sx, sy: w.sy };
      render();
      return;
    }
    if (app.box) {
      app.box.x1 = w.sx; app.box.y1 = w.sy;
      renderBoxOverlay();
      return;
    }
    if (app.drag) {
      // 指针事件可能高于 60Hz：只记录最新位置，用 rAF 合并成一帧一次求解
      app.drag.lastW = w;
      if (!app.drag.raf) {
        app.drag.raf = requestAnimationFrame(() => {
          if (!app.drag) return;
          app.drag.raf = 0;
          doDrag(app.drag.lastW);
        });
      }
      return;
    }
    // hover + 捕捉
    app.snap = snapPoint(w.sx, w.sy);
    const hit = hitTest(w.sx, w.sy);
    app.hover = hit ? { id: hit } : {};
    if (app.tool !== 'select') updatePreview(w);
    updateCoords(w);
    render();
  });

  svg.addEventListener('pointerup', (ev) => {
    const w = world(ev);
    if (app.pan) { app.pan = null; return; }
    if (app.box) {
      finishBox();
      return;
    }
    if (app.drag) endDrag();
  });

  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const p = evPos(ev);
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    app.renderer.zoomAt(p.x, p.y, factor);
    render();
  }, { passive: false });

  svg.addEventListener('dblclick', () => {
    const res = app.solveResult;
    if (res && !res.converged) {
      hint('约束冲突：红色标记的约束无法同时满足，删除其一或修改尺寸');
    }
  });
}

function renderBoxOverlay() {
  if (!app.box) return;
  app.rubber = null;
  render();
  const ov = app.renderer.overlay;
  const b = app.box;
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  el.setAttribute('x', Math.min(b.x0, b.x1)); el.setAttribute('y', Math.min(b.y0, b.y1));
  el.setAttribute('width', Math.abs(b.x1 - b.x0)); el.setAttribute('height', Math.abs(b.y1 - b.y0));
  el.setAttribute('fill', 'rgba(11,116,222,0.08)');
  el.setAttribute('stroke', '#0b74de');
  el.setAttribute('stroke-dasharray', '4 3');
  ov.appendChild(el);
}

function finishBox() {
  const b = app.box;
  app.box = null;
  if (!b) return;
  const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1);
  const y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
  if (Math.abs(x1 - x0) < 4 && Math.abs(y1 - y0) < 4) { render(); return; }
  for (const e of app.doc.entities.values()) {
    const pt = entityRepPoint(app.doc, e);
    if (!pt) continue;
    const sx = app.renderer.sx(pt.x), sy = app.renderer.sy(pt.y);
    if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) app.selection.add(e.id);
  }
  render();
}

function entityRepPoint(doc, e) {
  try {
    if (e.type === 'point') return { x: e.x, y: e.y };
    if (e.type === 'line') { const a = doc.pointOf(e.p1), b = doc.pointOf(e.p2); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
    return doc.pointOf(e.center);
  } catch (err) { return null; }
}

/* ---- 拖动 ---- */
/* 约束引用到的实体 id */
function refIdsOf(doc, refs) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') { if (doc.entities.has(v)) out.push(v); return; }
    if (v && typeof v === 'object') {
      if (v.arc && doc.entities.has(v.arc)) out.push(v.arc);
      if (v.circle && doc.entities.has(v.circle)) out.push(v.circle);
      for (const k in v) if (k !== 'arc' && k !== 'circle') walk(v[k]);
    }
  };
  walk(refs);
  return out;
}

/* 拖动的「受影响子图」：实体 <-> 约束 连通分量，只解这一块，其余保持不动 */
function affectedSubgraph(doc, seeds) {
  const ents = new Set(seeds);
  const cons = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of doc.constraints.values()) {
      if (cons.has(c.id)) continue;
      const ids = refIdsOf(doc, c.refs);
      if (ids.some((id) => ents.has(id))) {
        cons.add(c.id);
        for (const id of ids) if (!ents.has(id)) { ents.add(id); changed = true; }
      }
    }
  }
  return { ents, cons };
}

function startDrag(w, ev) {
  const ids = [...app.selection].filter((id) => {
    const e = app.doc.entity(id);
    return e && (e.type === 'point' || e.type === 'line' || e.type === 'circle' || e.type === 'arc');
  });
  if (!ids.length) return;
  const points = new Set();
  for (const id of ids) {
    const e = app.doc.entity(id);
    if (!e) continue;
    if (e.type === 'point') points.add(e.id);
    else if (e.type === 'line') { points.add(e.p1); points.add(e.p2); }
    else { points.add(e.center); }
  }
  const affected = affectedSubgraph(app.doc, new Set([...ids, ...points]));
  app.drag = {
    ids, points: [...points], vBefore: app.doc.snapshotVars(),
    startWorld: { x: w.x, y: w.y }, moved: false, affected,
  };
}

function doDrag(w) {
  const d = app.drag;
  const dx = w.x - d.startWorld.x;
  const dy = w.y - d.startWorld.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9 && !d.moved) return;
  d.moved = true;
  // 恢复起点变量，按位移平移选中点，再求解（拖动点视为临时固定）
  app.doc.restoreVars(d.vBefore);
  for (const pid of d.points) {
    const p = app.doc.entities.get(pid);
    if (p && p.type === 'point' && !p.fixed) { p.x += dx; p.y += dy; }
  }
  const fixed = new Set(d.points.filter((pid) => { const p = app.doc.entities.get(pid); return p && p.type === 'point' && !p.fixed; }));
  // 拖动是热路径：只解受影响子图 + 迭代上限 6
  const inc = d.affected;
  solveNow({ fixedPoints: fixed, maxIter: 6,
             includeEntities: inc && inc.ents, onlyConstraintIds: inc && inc.cons });
  render();
}

function endDrag() {
  const d = app.drag;
  app.drag = null;
  if (!d || !d.moved) return;
  // 落点做一次完整求解（不临时固定拖动点）：几何精确，诊断也回到整张草图
  solveNow({ maxIter: 30 });
  commitVars('移动图元', d.vBefore);
  render();
}

function commitVars(label, vBefore) {
  app.stack.record(label, vBefore, app.doc.snapshotVars());
  updateToolbarState();
}

/* ---- 绘制 ---- */
function handleDrawClick(w) {
  const snap = snapPoint(w.sx, w.sy);
  const pos = snap ? snap.pos : { x: w.x, y: w.y };
  const pts = app.draft.points;
  if (app.tool === 'point') {
    const p = app.doc.addPoint(pos.x, pos.y);
    app.stack.execute(cmdAddEntities([p], []), app.doc, () => solveNow());
    render();
    return;
  }
  if (app.tool === 'line') {
    if (!pts.length) { app.draft.points = [{ ...pos, pointId: snap ? snap.pointId : null }]; return; }
    const a = pts[0];
    const aId = a.pointId || createPointRaw(a.x, a.y);
    const bId = snap ? snap.pointId : createPointRaw(pos.x, pos.y);
    if (aId === bId) return;
    const line = app.doc.addLine(aId, bId);
    // 自动约束：接近水平/竖直时直接加约束（对标 FreeCAD 的 auto-constraints）
    const auto = autoAxisConstraint(line);
    const cons = [];
    if (auto) { auto.id = app.doc.newId('k'); cons.push({ ...auto }); }
    app.stack.execute(cmdAddEntities([app.doc.entities.get(aId), app.doc.entities.get(bId), line], cons), app.doc, () => solveNow());
    if (auto) hint('已自动添加' + (auto.type === 'horizontal' ? '水平' : '竖直') + '约束');
    app.draft.points = [];
    app.preview = null;
    render();
    return;
  }
  if (app.tool === 'rect') {
    if (!pts.length) { app.draft.points = [{ ...pos }]; return; }
    const a = pts[0];
    buildRect(a.x, a.y, pos.x, pos.y);
    app.draft.points = [];
    app.preview = null;
    render();
    return;
  }
  if (app.tool === 'circle') {
    if (!pts.length) { app.draft.points = [{ ...pos, pointId: snap ? snap.pointId : null }]; return; }
    const a = pts[0];
    const cId = a.pointId || createPointRaw(a.x, a.y);
    const r = Math.hypot(pos.x - a.x, pos.y - a.y);
    if (r < 1e-6) return;
    const circle = app.doc.addCircle(cId, r);
    app.stack.execute(cmdAddEntities([app.doc.entities.get(cId), circle], []), app.doc, () => solveNow());
    app.draft.points = [];
    app.preview = null;
    render();
    return;
  }
  if (app.tool === 'arc') {
    if (pts.length < 2) {
      app.draft.points.push({ ...pos });
      return;
    }
    const c = pts[0], s = pts[1];
    const r = Math.hypot(s.x - c.x, s.y - c.y);
    const a0 = Math.atan2(s.y - c.y, s.x - c.x);
    const a1 = Math.atan2(pos.y - c.y, pos.x - c.x);
    const cId = createPointRaw(c.x, c.y);
    const arc = app.doc.addArc(cId, r, a0, a1);
    app.stack.execute(cmdAddEntities([app.doc.entities.get(cId), arc], []), app.doc, () => solveNow());
    app.draft.points = [];
    app.preview = null;
    render();
  }
}

function createPointRaw(x, y) {
  const p = app.doc.addPoint(x, y);
  return p.id;
}

/* 自动轴向约束：角度在 2° 内视为水平/竖直 */
function autoAxisConstraint(line) {
  try {
    const a = app.doc.pointOf(line.p1), b = app.doc.pointOf(line.p2);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;
    const tol = Math.sin((2 * Math.PI) / 180);
    if (Math.abs(dy) / len <= tol) return createConstraint('horizontal', { line: line.id });
    if (Math.abs(dx) / len <= tol) return createConstraint('vertical', { line: line.id });
  } catch (e) { /* ignore */ }
  return null;
}

/* 缩放到某个图元 */
function zoomToEntity(id) {
  const e = app.doc.entity(id);
  if (!e) return;
  let x0, y0, x1, y1;
  try {
    if (e.type === 'point') { x0 = e.x - 1; y0 = e.y - 1; x1 = e.x + 1; y1 = e.y + 1; }
    else if (e.type === 'line') {
      const a = app.doc.pointOf(e.p1), b = app.doc.pointOf(e.p2);
      x0 = Math.min(a.x, b.x); x1 = Math.max(a.x, b.x); y0 = Math.min(a.y, b.y); y1 = Math.max(a.y, b.y);
    } else {
      const c = app.doc.pointOf(e.center);
      x0 = c.x - e.r; x1 = c.x + e.r; y0 = c.y - e.r; y1 = c.y + e.r;
    }
  } catch (err) { return; }
  const W = app.renderer.W, H = app.renderer.H, pad = 70;
  const w = Math.max(x1 - x0, 1e-3), h = Math.max(y1 - y0, 1e-3);
  app.renderer.view.scale = Math.max(0.05, Math.min(80, Math.min((W - pad * 2) / w, (H - pad * 2) / h)));
  app.renderer.view.ox = W / 2 - ((x0 + x1) / 2) * app.renderer.view.scale;
  app.renderer.view.oy = H / 2 + ((y0 + y1) / 2) * app.renderer.view.scale;
  render();
}

function updatePreview(w) {
  const p = { x: w.x, y: w.y };
  const snap = app.snap ? app.snap.pos : p;
  if (app.tool === 'line' && app.draft.points.length === 1) {
    app.preview = { kind: 'line', points: [app.draft.points[0], snap] };
  } else if (app.tool === 'rect' && app.draft.points.length === 1) {
    app.preview = { kind: 'rect', points: [app.draft.points[0], snap] };
  } else if (app.tool === 'circle' && app.draft.points.length === 1) {
    app.preview = { kind: 'circle', points: [app.draft.points[0], snap] };
  } else if (app.tool === 'arc' && app.draft.points.length >= 1) {
    app.preview = { kind: 'line', points: [app.draft.points[app.draft.points.length - 1], snap] };
  } else {
    app.preview = null;
  }
}

function buildRect(x0, y0, x1, y1) {
  const L = Math.min(x0, x1), R = Math.max(x0, x1);
  const B = Math.min(y0, y1), T = Math.max(y0, y1);
  if (Math.abs(R - L) < 1e-6 || Math.abs(T - B) < 1e-6) return;
  const p1 = app.doc.addPoint(L, B);
  const p2 = app.doc.addPoint(R, B);
  const p3 = app.doc.addPoint(R, T);
  const p4 = app.doc.addPoint(L, T);
  const l1 = app.doc.addLine(p1.id, p2.id);
  const l2 = app.doc.addLine(p2.id, p3.id);
  const l3 = app.doc.addLine(p3.id, p4.id);
  const l4 = app.doc.addLine(p4.id, p1.id);
  const k = [
    createConstraint('horizontal', { line: l1.id }),
    createConstraint('vertical', { line: l2.id }),
    createConstraint('horizontal', { line: l3.id }),
    createConstraint('vertical', { line: l4.id }),
  ];
  k.forEach((c) => app.doc.addConstraint(c));
  const ents = [p1, p2, p3, p4, l1, l2, l3, l4];
  const cons = k.map((c) => ({ ...c }));
  // execute 需要先撤掉已写入的约束（cmdAddEntities 会重放）
  for (const c of cons) app.doc.constraints.delete(c.id);
  for (const e of ents) app.doc.entities.delete(e.id);
  app.stack.execute(cmdAddEntities(ents, cons), app.doc, () => solveNow());
  app.selection = new Set([l1.id]);
  hint('矩形已创建，并自动加水平/竖直约束');
}

/* ---------------- 添加约束 ---------------- */
function addConstraintByType(type) {
  const sel = [...app.selection].map((id) => app.doc.entity(id)).filter(Boolean);
  const cons = app.doc.constraints;
  const selCons = [...app.selection].map((id) => cons.get(id)).filter(Boolean);
  const lines = sel.filter((e) => e.type === 'line');
  const circles = sel.filter((e) => e.type === 'circle' || e.type === 'arc');
  const points = sel.filter((e) => e.type === 'point');
  let c = null;
  let need = '';

  try {
    switch (type) {
      case 'coincident':
        if (points.length >= 2) c = createConstraint('coincident', { a: points[0].id, b: points[1].id });
        else need = '选中两个点';
        break;
      case 'horizontal':
      case 'vertical':
        if (lines.length === 1) c = createConstraint(type, { line: lines[0].id });
        else need = '选中一条直线';
        break;
      case 'parallel':
      case 'perpendicular':
        if (lines.length >= 2) c = createConstraint(type, { a: lines[0].id, b: lines[1].id });
        else need = '选中两条直线';
        break;
      case 'tangent':
        if (lines.length >= 1 && circles.length >= 1) c = createConstraint('tangent', { line: lines[0].id, circle: circles[0].id });
        else need = '选中一条直线 + 一个圆/弧';
        break;
      case 'equalLength':
        if (lines.length >= 2) c = createConstraint('equalLength', { a: lines[0].id, b: lines[1].id });
        else need = '选中两条直线';
        break;
      case 'equalRadius':
        if (circles.length >= 2) c = createConstraint('equalRadius', { a: circles[0].id, b: circles[1].id });
        else need = '选中两个圆/弧';
        break;
      case 'distance': {
        if (points.length >= 2) {
          const a = app.doc.pointOf(points[0].id), b = app.doc.pointOf(points[1].id);
          c = createConstraint('distance', { a: points[0].id, b: points[1].id }, roundLen(Math.hypot(b.x - a.x, b.y - a.y)));
        } else need = '选中两个点';
        break;
      }
      case 'distanceX':
      case 'distanceY': {
        if (points.length >= 2) {
          const a = app.doc.pointOf(points[0].id), b = app.doc.pointOf(points[1].id);
          const v = type === 'distanceX' ? b.x - a.x : b.y - a.y;
          c = createConstraint(type, { a: points[0].id, b: points[1].id }, roundLen(v));
        } else need = '选中两个点';
        break;
      }
      case 'radius':
        if (circles.length === 1) c = createConstraint('radius', { circle: circles[0].id }, roundLen(circles[0].r));
        else need = '选中一个圆/弧';
        break;
      case 'diameter':
        if (circles.length === 1) c = createConstraint('diameter', { circle: circles[0].id }, roundLen(circles[0].r * 2));
        else need = '选中一个圆/弧';
        break;
      case 'angle':
        if (lines.length >= 2) {
          const l1 = app.doc.lineOf(lines[0].id), l2 = app.doc.lineOf(lines[1].id);
          const a1 = Math.atan2(app.doc.pointOf(l1.p2).y - app.doc.pointOf(l1.p1).y, app.doc.pointOf(l1.p2).x - app.doc.pointOf(l1.p1).x);
          const a2 = Math.atan2(app.doc.pointOf(l2.p2).y - app.doc.pointOf(l2.p1).y, app.doc.pointOf(l2.p2).x - app.doc.pointOf(l2.p1).x);
          let d = deg(a2 - a1) % 360;
          if (d > 180) d -= 360;
          if (d < -180) d += 360;
          c = createConstraint('angle', { a: lines[0].id, b: lines[1].id }, Math.round(d * 100) / 100);
        } else need = '选中两条直线';
        break;
      case 'symmetric':
        if (points.length >= 2 && lines.length >= 1) c = createConstraint('symmetric', { a: points[0].id, b: points[1].id, line: lines[0].id });
        else need = '选中两个点 + 一条对称线';
        break;
      case 'midpoint':
        if (points.length >= 1 && lines.length >= 1) c = createConstraint('midpoint', { p: points[0].id, line: lines[0].id });
        else need = '选中一个点 + 一条直线';
        break;
      case 'pointOnLine':
        if (points.length >= 1 && lines.length >= 1) c = createConstraint('pointOnLine', { p: points[0].id, line: lines[0].id });
        else need = '选中一个点 + 一条直线';
        break;
      case 'pointOnCircle':
        if (points.length >= 1 && circles.length >= 1) c = createConstraint('pointOnCircle', { p: points[0].id, circle: circles[0].id });
        else need = '选中一个点 + 一个圆/弧';
        break;
      case 'fix':
        if (points.length === 1) c = createConstraint('fix', { p: points[0].id });
        else need = '选中一个点';
        break;
      default:
        need = '暂不支持的约束';
    }
  } catch (err) {
    console.error(err);
    hint('添加约束失败：' + err.message);
    return;
  }

  if (!c) { hint(need || '选择不满足该约束'); return; }
  app.doc.addConstraint(c);
  const saved = { ...c };
  app.doc.constraints.delete(c.id);
  const res = app.stack.execute(cmdAddConstraint(saved), app.doc, () => solveNow());
  if (res && !res.converged) hint('约束冲突：' + res.message);
  else hint('已添加约束：' + (CONSTRAINT_META[type] ? CONSTRAINT_META[type].label : type));
  app.selection = new Set([saved.id]);
  render();
}

function roundLen(v) { return Math.round(v * 1000) / 1000; }

/* ---------------- 面板 ---------------- */
function updateStatus() {
  const res = app.solveResult;
  const el = $('#status-solve');
  const badge = $('#solve-badge');
  if (!res) return;
  if (!res.converged) {
    el.textContent = res.message;
    el.className = 'status-error';
    badge.textContent = '约束冲突';
    badge.className = 'badge badge-error';
  } else if (res.dof > 0) {
    el.textContent = res.message;
    el.className = 'status-warn';
    badge.textContent = '欠约束 · ' + res.dof + ' DoF';
    badge.className = 'badge badge-warn';
  } else {
    el.textContent = res.message;
    el.className = 'status-ok';
    badge.textContent = '完全约束';
    badge.className = 'badge badge-ok';
  }
  const st = app.doc.stats();
  $('#status-counts').textContent = `${st.line} 线 · ${st.circle} 圆 · ${st.arc} 弧 · ${st.point} 点 · ${st.constraints} 约束`;
  $('#status-vars').textContent = res.freeVars != null ? `变量 ${res.freeVars} · 迭代 ${res.iterations}` : '';
}

function updatePanels() {
  const list = $('#constraint-list');
  const rows = [];
  const conflict = new Set((app.solveResult && app.solveResult.conflicts) || []);
  for (const c of app.doc.constraints.values()) {
    const meta = CONSTRAINT_META[c.type] || { glyph: '·', label: c.type, valueUnit: null };
    const sel = app.selection.has(c.id);
    const bad = conflict.has(c.id);
    const isDim = ['distance', 'distanceX', 'distanceY', 'radius', 'diameter', 'angle'].includes(c.type);
    rows.push(
      `<div class="k-row ${sel ? 'sel' : ''} ${bad ? 'bad' : ''}" data-cid="${c.id}">` +
      `<span class="k-glyph">${meta.glyph || '·'}</span>` +
      `<span class="k-name">${describeConstraint(c)}</span>` +
      (isDim ? `<input class="k-val" data-cid="${c.id}" type="number" step="0.5" value="${c.value}">` : '') +
      `<button class="k-del" data-del="${c.id}" title="删除约束">✕</button>` +
      `</div>`
    );
  }
  list.innerHTML = rows.join('') || '<div class="empty">还没有约束：选择图元后点左侧约束按钮</div>';

  // 图元列表（图元树）
  const eRows = [];
  const eIcon = { line: '／', circle: '○', arc: '◜', point: '•' };
  const order = { line: 0, arc: 1, circle: 2, point: 3 };
  const ents = [...app.doc.entities.values()].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
  for (const e of ents) {
    const sel = app.selection.has(e.id);
    let label = e.type;
    let meta = '';
    try {
      if (e.type === 'line') {
        const a = app.doc.pointOf(e.p1), b = app.doc.pointOf(e.p2);
        label = '直线'; meta = `长 ${Math.hypot(b.x - a.x, b.y - a.y).toFixed(2)} mm`;
      } else if (e.type === 'circle') { label = '圆'; meta = `R${e.r.toFixed(2)}`; }
      else if (e.type === 'arc') { label = '圆弧'; meta = `R${e.r.toFixed(2)} · ${deg(norm2pi(e.a1 - e.a0)).toFixed(0)}°`; }
      else if (e.type === 'point') { label = '点'; meta = `(${e.x.toFixed(1)}, ${e.y.toFixed(1)})${e.fixed ? ' 固定' : ''}`; }
    } catch (err) { /* 引用损坏 */ }
    eRows.push(
      `<div class="e-row ${sel ? 'sel' : ''}" data-eid="${e.id}">` +
      `<span class="e-icon">${eIcon[e.type] || '·'}</span>` +
      `<span class="e-name">${escText(label)} <span class="e-meta">${escText(meta)}</span></span>` +
      `</div>`
    );
  }
  $('#entity-list').innerHTML = eRows.join('') || '<div class="empty">画布为空</div>';

  // 选中对象特性
  const props = [];
  for (const id of app.selection) {
    const e = app.doc.entity(id);
    if (e) {
      if (e.type === 'point') props.push(`点 ${e.id} · (${e.x.toFixed(2)}, ${e.y.toFixed(2)})${e.fixed ? ' · 固定' : ''}`);
      else if (e.type === 'line') {
        const a = app.doc.pointOf(e.p1), b = app.doc.pointOf(e.p2);
        props.push(`直线 ${e.id} · 长 ${Math.hypot(b.x - a.x, b.y - a.y).toFixed(2)} mm`);
      } else if (e.type === 'circle') props.push(`圆 ${e.id} · 半径 ${e.r.toFixed(2)} mm`);
      else if (e.type === 'arc') props.push(`圆弧 ${e.id} · R${e.r.toFixed(2)} · ${(deg(norm2pi(e.a1 - e.a0))).toFixed(1)}°`);
      continue;
    }
    const c = app.doc.constraint(id);
    if (c) props.push(`约束 · ${describeConstraint(c)}`);
  }
  $('#props').innerHTML = props.length ? props.map((p) => `<div class="prop">${p}</div>`).join('') : '<div class="empty">未选中对象</div>';

  // 诊断
  const res = app.solveResult;
  const diag = [];
  if (res) {
    diag.push(`自由度 <b>${res.dof}</b> · 约束 ${app.doc.constraints.size} 条 · 变量 ${res.freeVars}`);
    if (res.redundant > 0) diag.push(`冗余约束 <b>${res.redundant}</b> 条`);
    if (res.conflicts && res.conflicts.length) {
      const names = res.conflicts.map((cid) => {
        const c = app.doc.constraint(cid);
        return c ? describeConstraint(c) : cid;
      }).join('、');
      diag.push(`冲突约束 ${res.conflicts.length} 条：<b>${escText(names)}</b>`);
    }
    diag.push(`残差 ${res.residualMax != null ? res.residualMax.toExponential(1) : '-'} · 迭代 ${res.iterations}`);
  }
  $('#diagnostics').innerHTML = diag.map((d) => `<div class="diag">${d}</div>`).join('');

  // 状态栏已选数量
  const selEl = $('#status-sel');
  if (selEl) selEl.textContent = app.selection.size ? `已选 ${app.selection.size}` : '';
}

/* 文本转义（实体列表/诊断用） */
function escText(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

function updateCoords(w) {
  $('#status-coords').textContent = `X ${w.x.toFixed(2)}  Y ${w.y.toFixed(2)} mm`;
}

function hint(text) {
  $('#status-hint').textContent = text;
}

/* ---------------- 头部 / 工具栏 ---------------- */
function bindToolbar() {
  document.querySelectorAll('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });
  document.querySelectorAll('[data-constraint]').forEach((btn) => {
    btn.addEventListener('click', () => addConstraintByType(btn.dataset.constraint));
    btn.title = btn.dataset.constraint;
  });
  // 约束列表交互（委托）
  $('#constraint-list').addEventListener('click', (ev) => {
    const del = ev.target.closest('[data-del]');
    if (del) {
      const c = app.doc.constraint(del.dataset.del);
      if (c) {
        const saved = { ...c };
        app.doc.constraints.delete(c.id);
        app.stack.execute(cmdRemoveConstraint(saved), app.doc, () => solveNow());
        app.selection.delete(c.id);
        render();
      }
      return;
    }
    const row = ev.target.closest('[data-cid]');
    if (row && !ev.target.closest('input')) {
      app.selection = new Set([row.dataset.cid]);
      render();
    }
  });
  $('#constraint-list').addEventListener('change', (ev) => {
    const inp = ev.target.closest('input.k-val');
    if (!inp) return;
    const c = app.doc.constraint(inp.dataset.cid);
    if (!c) return;
    const v = parseFloat(inp.value);
    if (!isFinite(v)) return;
    app.stack.execute(cmdEditValue(c, v), app.doc, () => solveNow());
    render();
  });

  // 页签：约束 / 图元
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 图元列表：单击选中、双击缩放到对象
  $('#entity-list').addEventListener('click', (ev) => {
    const row = ev.target.closest ? ev.target.closest('[data-eid]') : null;
    if (!row) return;
    app.selection = new Set([row.dataset.eid]);
    render();
    throttlePanels(true);
  });
  $('#entity-list').addEventListener('dblclick', (ev) => {
    const row = ev.target.closest ? ev.target.closest('[data-eid]') : null;
    if (!row) return;
    zoomToEntity(row.dataset.eid);
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  const cons = $('#constraint-list'), ents = $('#entity-list');
  if (cons) cons.hidden = name !== 'cons';
  if (ents) ents.hidden = name !== 'ents';
  throttlePanels(true);
}

function updateToolbarState() {
  $('#undo-btn').disabled = !app.stack.canUndo();
  $('#redo-btn').disabled = !app.stack.canRedo();
  $('#undo-btn').title = app.stack.canUndo() ? '撤销：' + app.stack.topLabel() : '撤销';
}

function bindHeader() {
  $('#demo-btn').addEventListener('click', () => { loadDemo(true); });
  $('#clear-btn').addEventListener('click', () => {
    app.doc = new Doc();
    app.stack.clear();
    app.selection = new Set();
    app.solveResult = null;
    render();
    hint('画布已清空');
  });
  $('#fit-btn').addEventListener('click', () => { fitView(); render(); });
  $('#undo-btn').addEventListener('click', () => { if (app.stack.undo(app.doc)) { solveNow({ apply: false }); render(); } });
  $('#redo-btn').addEventListener('click', () => { if (app.stack.redo(app.doc)) { solveNow({ apply: false }); render(); } });
  $('#dxf-btn').addEventListener('click', exportToDXF);
  const pdfBtn = $('#pdf-btn');
  if (pdfBtn) pdfBtn.addEventListener('click', () => {
    hint('打印对话框里选「另存为 PDF」即可得到矢量图纸');
    setTimeout(() => window.print(), 120);
  });
  $('#save-btn').addEventListener('click', saveDraft);
  const loadBtn = $('#load-btn');
  if (loadBtn) loadBtn.addEventListener('click', loadDraft);
  $('#import-input').addEventListener('change', importFromDXF);
  const to3d = $('#to3d');
  if (to3d) to3d.addEventListener('click', () => {
    try {
      localStorage.setItem('sketch.draft.v1', JSON.stringify(app.doc.toJSON()));
    } catch (e) { hint('保存草稿失败：' + e.message); return; }
    window.open('/static/3d/index.html?from=sketch', '_blank');
    hint('已保存草稿，正在 3D 页拉伸');
  });
  $('#help-btn').addEventListener('click', () => {
    $('#help-panel').classList.toggle('show');
  });
}

function exportToDXF() {
  try {
    const text = exportDXF(app.doc, { skipReferencedPoints: true, dimensions: true });
    const blob = new Blob([text], { type: 'application/dxf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sketch-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.dxf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    hint('已导出 DXF（R12），可直接在 AutoCAD 打开');
  } catch (err) {
    console.error(err);
    hint('导出失败：' + err.message);
  }
}

function saveDraft() {
  try {
    localStorage.setItem('sketch.draft.v1', JSON.stringify(app.doc.toJSON()));
    hint('草稿已保存到浏览器');
  } catch (err) { hint('保存失败：' + err.message); }
}

function loadDraft() {
  try {
    const raw = localStorage.getItem('sketch.draft.v1');
    if (!raw) { hint('没有已保存的草稿'); return; }
    app.doc = Doc.fromJSON(JSON.parse(raw));
    app.stack.clear();
    app.selection = new Set();
    solveNow();
    render();
    fitView();
    render();
    hint('已载入草稿');
  } catch (err) {
    hint('载入失败：' + err.message);
  }
}

function importFromDXF(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const { items, warnings } = importDXF(String(reader.result));
      const ents = [];
      for (const it of items) {
        if (it.type === 'line') {
          const p1 = app.doc.addPoint(it.x1, it.y1);
          const p2 = app.doc.addPoint(it.x2, it.y2);
          ents.push(p1, p2, app.doc.addLine(p1.id, p2.id));
        } else if (it.type === 'circle') {
          const c = app.doc.addPoint(it.cx, it.cy);
          ents.push(c, app.doc.addCircle(c.id, it.r));
        } else if (it.type === 'arc') {
          const c = app.doc.addPoint(it.cx, it.cy);
          const a = app.doc.addArc(c.id, it.r, it.a0 * D2R, it.a1 * D2R);
          if (a.a1 <= a.a0) a.a1 += Math.PI * 2;
          ents.push(c, a);
        } else if (it.type === 'point') {
          ents.push(app.doc.addPoint(it.x, it.y));
        }
      }
      for (const e of ents) app.doc.entities.delete(e.id);
      app.stack.execute(cmdAddEntities(ents, []), app.doc, () => solveNow());
      fitView();
      render();
      hint(`已导入 DXF：${items.length} 个图元${warnings.length ? '（' + warnings[0] + '）' : ''}`);
    } catch (err) {
      console.error(err);
      hint('导入失败：' + err.message);
    }
  };
  reader.readAsText(file, 'utf-8');
  ev.target.value = '';
}

/* ---------------- 键盘 ---------------- */
function bindKeys() {
  window.addEventListener('keydown', (ev) => {
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) { if (app.stack.redo(app.doc)) { solveNow({ apply: false }); render(); } }
      else if (app.stack.undo(app.doc)) { solveNow({ apply: false }); render(); }
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      if (app.stack.redo(app.doc)) { solveNow({ apply: false }); render(); }
      return;
    }
    if (ev.key === 'Escape') { setTool('select'); app.selection = new Set(); render(); return; }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      deleteSelection();
      return;
    }
    const k = ev.key.toLowerCase();
    if (k === 'l') setTool('line');
    else if (k === 'r') setTool('rect');
    else if (k === 'c') setTool('circle');
    else if (k === 'a') setTool('arc');
    else if (k === 'p') setTool('point');
    else if (k === 'h') addConstraintByType('horizontal');
    else if (k === 'v') addConstraintByType('vertical');
  });
}

function deleteSelection() {
  const entityIds = [];
  const constraintIds = [];
  for (const id of app.selection) {
    if (app.doc.entity(id)) entityIds.push(id);
    else if (app.doc.constraint(id)) constraintIds.push(id);
  }
  if (!entityIds.length && !constraintIds.length) return;
  app.stack.execute(cmdDeleteSelection(entityIds, constraintIds), app.doc, () => solveNow());
  app.selection = new Set();
  render();
  hint('已删除');
}

function fitView() {
  app.renderer.fit(app.doc);
}

/* ---------------- 示例场景 ---------------- */
/* ---------------- 自然语言建模 ---------------- */
let lastRect = null;

function runNL(text) {
  const intent = parseIntent(text);
  if (!intent.actions.length) { hint(intent.reply); return intent.reply; }
  let reply = intent.reply;
  for (const a of intent.actions) {
    if (a.op === 'clear') {
      app.doc = new Doc();
      app.stack.clear();
      app.selection = new Set();
      app.solveResult = null;
      lastRect = null;
      solveNow();
      render();
      fitView();
      continue;
    }
    if (a.op === 'rect') {
      lastRect = makeRectNL(0, 0, a.w, a.h);
      reply += `；四边自动加水平/竖直约束并标好尺寸`;
      continue;
    }
    if (a.op === 'circle') {
      const c = lastRect
        ? { x: lastRect.x0 + lastRect.w / 2, y: lastRect.y0 + lastRect.h / 2 }
        : { x: 0, y: 0 };
      makeCircleNL(c.x, c.y, a.r, lastRect);
      continue;
    }
    if (a.op === 'dim') {
      if (!applyDimNL(a.key, a.value)) reply += '；没找到可改的尺寸约束';
    }
  }
  render();
  hint(reply);
  return reply;
}

function makeRectNL(x0, y0, w, h) {
  const p1 = app.doc.addPoint(x0, y0, { fixed: true });
  const p2 = app.doc.addPoint(x0 + w, y0);
  const p3 = app.doc.addPoint(x0 + w, y0 + h);
  const p4 = app.doc.addPoint(x0, y0 + h);
  const l1 = app.doc.addLine(p1.id, p2.id);
  const l2 = app.doc.addLine(p2.id, p3.id);
  const l3 = app.doc.addLine(p3.id, p4.id);
  const l4 = app.doc.addLine(p4.id, p1.id);
  const cons = [
    createConstraint('horizontal', { line: l1.id }),
    createConstraint('vertical', { line: l2.id }),
    createConstraint('horizontal', { line: l3.id }),
    createConstraint('vertical', { line: l4.id }),
    createConstraint('distanceX', { a: p1.id, b: p2.id }, w),
    createConstraint('distanceY', { a: p2.id, b: p3.id }, h),
  ];
  const ents = [p1, p2, p3, p4, l1, l2, l3, l4];
  for (const c of cons) c.id = app.doc.newId('k');
  app.stack.execute(cmdAddEntities(ents, cons.map((c) => ({ ...c }))), app.doc, () => solveNow());
  app.selection = new Set([l1.id]);
  fitView();
  return { x0, y0, w, h, p1: p1.id };
}

function makeCircleNL(cx, cy, r, rect) {
  const center = app.doc.addPoint(cx, cy);
  const circle = app.doc.addCircle(center.id, r);
  const cons = [createConstraint('radius', { circle: circle.id }, r)];
  if (rect && rect.p1) {
    cons.push(createConstraint('distanceX', { a: rect.p1, b: center.id }, cx - rect.x0));
    cons.push(createConstraint('distanceY', { a: rect.p1, b: center.id }, cy - rect.y0));
  }
  for (const c of cons) c.id = app.doc.newId('k');
  app.stack.execute(cmdAddEntities([center, circle], cons.map((c) => ({ ...c }))), app.doc, () => solveNow());
}

function applyDimNL(key, value) {
  const cons = [...app.doc.constraints.values()];
  let target = null;
  if (key === 'width') target = cons.find((c) => c.type === 'distanceX');
  else if (key === 'height') target = cons.find((c) => c.type === 'distanceY');
  else if (key === 'radius') target = cons.find((c) => c.type === 'radius');
  else if (key === 'diameter') target = cons.find((c) => c.type === 'diameter') || cons.find((c) => c.type === 'radius');
  if (!target) return false;
  const v = key === 'diameter' ? value : value;
  app.stack.execute(cmdEditValue(target, v), app.doc, () => solveNow());
  return true;
}

function loadDemo(withHint = true) {
  const doc = new Doc();
  // 支架轮廓：120 × 80，左下角固定（A 点固定 = 基准）
  const A = doc.addPoint(0, 0, { fixed: true });
  const B = doc.addPoint(120, 0);
  const C = doc.addPoint(120, 80);
  const D = doc.addPoint(0, 80);
  const AB = doc.addLine(A.id, B.id);
  const BC = doc.addLine(B.id, C.id);
  const CD = doc.addLine(C.id, D.id);
  const DA = doc.addLine(D.id, A.id);
  const k = [
    createConstraint('horizontal', { line: AB.id }),
    createConstraint('vertical', { line: BC.id }),
    createConstraint('horizontal', { line: CD.id }),
    createConstraint('vertical', { line: DA.id }),
    createConstraint('distanceX', { a: A.id, b: B.id }, 120),
    createConstraint('distanceY', { a: B.id, b: C.id }, 80),
  ];
  // 中心孔：位置由两个坐标尺寸 + 半径确定
  const O = doc.addPoint(60, 40);
  const hole = doc.addCircle(O.id, 15);
  k.push(createConstraint('distanceX', { a: A.id, b: O.id }, 60));
  k.push(createConstraint('distanceY', { a: A.id, b: O.id }, 40));
  k.push(createConstraint('radius', { circle: hole.id }, 15));

  for (const c of k) {
    if (!c.id) c.id = doc.newId('k');
    doc.constraints.set(c.id, c);
  }

  app.doc = doc;
  app.stack.clear();
  app.selection = new Set();
  app.solveResult = null;
  solveNow();
  render();
  fitView();
  render();
  if (withHint) hint('示例：支架草图（完全约束）—— 改尺寸看全图联动');
}

/* ---------------- 启动 ---------------- */
window.MSKETCH_DBG = {
  doc: () => app.doc,
  app,
  solveText: () => (app.solveResult ? app.solveResult.message : ''),
  solve: () => app.solveResult,
  bbox: () => {
    const r = app.renderer;
    const b = r.bounds(app.doc);
    return b ? `${b.x0.toFixed(1)},${b.y0.toFixed(1)} → ${b.x1.toFixed(1)},${b.y1.toFixed(1)}` : '';
  },
  addConstraint: (type) => addConstraintByType(type),
  exportDXF: () => exportDXF(app.doc, { skipReferencedPoints: true, dimensions: true }),
  loadDemo: (h) => loadDemo(h),
  nl: (text) => runNL(text),
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();



