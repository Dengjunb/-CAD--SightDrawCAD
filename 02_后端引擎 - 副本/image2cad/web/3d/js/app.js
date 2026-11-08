/* =============================================================================
   AI 3D · 页面逻辑：图片 → 识别 → 轮廓 → 拉伸实体 → 预览 / 导出
   ========================================================================== */

import { buildMesh, meshToOBJ, meshToSTL } from './mesh.js';
import { Viewer } from './viewer.js';

const $ = (s) => document.querySelector(s);
const state = { scene: null, mesh: null, runId: null, running: false, timer: 0, polls: 0 };

const viewer = new Viewer($('#v3canvas'));

function setStatus(text, kind) {
  const el = $('#v3status');
  el.textContent = text;
  el.className = 'status ' + (kind || '');
}

function addLog(text) {
  const box = $('#v3log');
  const div = document.createElement('div');
  div.className = 'log-line';
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function clearLog() { $('#v3log').innerHTML = ''; }

function heightMm() { return Math.max(1, Number($('#v3height').value) || 20); }

function rebuild() {
  if (!state.scene) return;
  const mesh = buildMesh(state.scene, { height: heightMm() });
  state.mesh = mesh;
  viewer.setMesh(mesh);
  const s = mesh.stats;
  $('#v3stats').innerHTML =
    `<div>闭合轮廓 <b>${s.contours || 0}</b> · 孔 <b>${s.holes || 0}</b></div>` +
    `<div>顶点 <b>${(s.vertices || 0).toLocaleString()}</b> · 三角面 <b>${(s.faces || 0).toLocaleString()}</b></div>` +
    (s.note ? `<div class="warn">${s.note}</div>` : '');
  $('#v3depthVal').textContent = heightMm();
  if (!mesh.verts.length) setStatus('没能从这张图提取到闭合轮廓，试试别的图', 'bad');
}

async function startRun(payload, label) {
  if (state.running) return;
  state.running = true;
  clearLog();
  setStatus('识别中…', 'busy');
  addLog('提交：' + label);
  let resp;
  try {
    resp = await fetch('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
    state.runId = data.runId;
  } catch (err) {
    state.running = false;
    setStatus('提交失败：' + err.message, 'bad');
    return;
  }
  state.polls = 0;
  poll();
}

async function poll() {
  if (!state.runId) return;
  try {
    const r = await fetch('/api/status/' + state.runId);
    const d = await r.json();
    const steps = d.steps || [];
    if (steps.length) {
      const last = steps[steps.length - 1];
      setStatus(`识别中… ${steps.length} 步 · ${last.title || ''}`, 'busy');
      if (!$('#v3log').dataset.last || $('#v3log').dataset.last !== String(steps.length)) {
        $('#v3log').dataset.last = String(steps.length);
        addLog(`${last.title || last.key} · ${last.detail || ''}`);
      }
    }
    if (d.status && d.status !== 'running') {
      state.running = false;
      if (d.status === 'error' || d.error) {
        setStatus('识别失败：' + (d.error || '未知错误'), 'bad');
        return;
      }
      const scene = d.result && d.result.scene;
      if (!scene) { setStatus('识别完成但没有几何结果', 'bad'); return; }
      state.scene = scene;
      const q = (d.result && d.result.quality) || {};
      addLog(`质量 F1 ${(q.f1 ?? 0).toFixed(2)}，线段 ${(scene.segments || []).length}，`
        + `圆 ${(scene.circles || []).length}，矩形 ${(scene.rects || []).length}，`
        + `多段线 ${(scene.polylines || []).length}`);
      rebuild();
      const s = (state.mesh && state.mesh.stats) || {};
      setStatus(`已生成 3D：${s.outer || 0} 个外轮廓 / ${s.holes || 0} 个孔`, s.vertices ? 'ok' : 'bad');
      return;
    }
  } catch (err) {
    addLog('轮询出错：' + err.message);
  }
  state.polls++;
  if (state.polls > 600) { state.running = false; setStatus('识别超时', 'bad'); return; }
  state.timer = setTimeout(poll, 350);
}

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------------- 从参数化草图导入（localStorage: sketch.draft.v1） ---------------- */
function sceneFromSketchDraft(draft) {
  const ents = draft.entities || [];
  const pts = new Map();
  for (const e of ents) if (e.type === 'point') pts.set(e.id, { x: e.x, y: e.y });
  const circles = [];
  for (const e of ents) {
    if (e.type === 'circle' && pts.get(e.center)) {
      circles.push({ cx: pts.get(e.center).x, cy: pts.get(e.center).y, r: e.r });
    }
  }
  const segs = [];
  for (const e of ents) {
    if (e.type === 'line') {
      const a = pts.get(e.p1), b = pts.get(e.p2);
      if (a && b) segs.push([a, b]);
    }
  }
  const loops = traceLoops(segs);
  let maxX = -Infinity, maxY = -Infinity, minX = Infinity, minY = Infinity;
  for (const p of pts.values()) { maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
  for (const c of circles) { maxX = Math.max(maxX, c.cx + c.r); maxY = Math.max(maxY, c.cy + c.r); minX = Math.min(minX, c.cx - c.r); minY = Math.min(minY, c.cy - c.r); }
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  return {
    width_px: bw * 1.2, height_px: bh * 1.2,
    scale_mm_per_px: 1,
    circles,
    rects: [],
    polylines: loops.map((ps) => ({ pts: ps.map((p) => [p.x, p.y]), closed: true })),
    _from: 'sketch',
  };
}

function traceLoops(segs) {
  const keyOf = (p) => Math.round(p.x * 1000) + ',' + Math.round(p.y * 1000);
  const nodes = new Map();
  const edges = [];
  for (const [a, b] of segs) {
    const ka = keyOf(a), kb = keyOf(b);
    if (ka === kb) continue;
    if (!nodes.has(ka)) nodes.set(ka, { x: a.x, y: a.y, adj: [] });
    if (!nodes.has(kb)) nodes.set(kb, { x: b.x, y: b.y, adj: [] });
    const ei = edges.length;
    edges.push({ ka, kb, used: false });
    nodes.get(ka).adj.push({ ei, other: kb });
    nodes.get(kb).adj.push({ ei, other: ka });
  }
  const loops = [];
  for (let ei = 0; ei < edges.length; ei++) {
    if (edges[ei].used) continue;
    const start = edges[ei].ka;
    let cur = start, edge = ei;
    const pts = [];
    let guard = 0;
    while (guard++ < edges.length * 2) {
      const e = edges[edge];
      e.used = true;
      const nxt = e.ka === cur ? e.kb : e.ka;
      pts.push(nodes.get(nxt));
      if (nxt === start) { if (pts.length >= 3) loops.push(pts); break; }
      const cand = nodes.get(nxt).adj.filter((x) => !edges[x.ei].used);
      if (!cand.length) break;
      cur = nxt; edge = cand[0].ei;
    }
  }
  return loops;
}

function importSketch() {
  let raw = null;
  try { raw = localStorage.getItem('sketch.draft.v1'); } catch (e) { }
  if (!raw) { setStatus('没有找到草图草稿：先去「参数化草图」点「保存草稿」', 'bad'); return; }
  let draft;
  try { draft = JSON.parse(raw); } catch (e) { setStatus('草图草稿解析失败', 'bad'); return; }
  const scene = sceneFromSketchDraft(draft);
  if (!scene.polylines.length && !scene.circles.length) {
    setStatus('草图里没有闭合轮廓（矩形/圆），先在草图里画一个', 'bad');
    return;
  }
  state.scene = scene;
  rebuild();
  clearLog();
  addLog(`从草图导入：${scene.polylines.length} 个闭合轮廓、${scene.circles.length} 个圆`);
  setStatus(`已从草图生成 3D：${scene.polylines.length} 轮廓 / ${scene.circles.length} 圆`, 'ok');
}

function bind() {
  $('#v3demo').addEventListener('click', () => startRun({ demo: '01-零件图-干净.png' }, '示例：零件图'));
  $('#v3file').addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result).split(',')[1] || '';
      startRun({ name: f.name, data_b64: b64 }, f.name);
    };
    reader.readAsDataURL(f);
    ev.target.value = '';
  });
  $('#v3height').addEventListener('input', () => { $('#v3depthVal').textContent = heightMm(); });
  $('#v3height').addEventListener('change', rebuild);
  $('#v3fit').addEventListener('click', () => { if (state.mesh) { viewer._fit(); viewer.render(); } });

const setView = (yaw, pitch) => { viewer.yaw = yaw; viewer.pitch = pitch; viewer.render(); };
document.querySelectorAll('#viewcube button').forEach((b) => {
  b.addEventListener('click', () => {
    const v = b.getAttribute('data-v');
    if (v === 'top') setView(0, 1.5);
    else if (v === 'front') setView(0, 0);
    else if (v === 'left') setView(-Math.PI / 2, 0);
    else if (v === 'right') setView(Math.PI / 2, 0);
    else if (v === 'back') setView(Math.PI, 0);
    else if (v === 'bottom') setView(0, -1.5);
    else setView(-0.6, 0.5);
  });
});
['v3iso', 'v3top', 'v3front', 'v3left'].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('click', () => {
    if (id === 'v3iso') setView(-0.6, 0.5);
    if (id === 'v3top') setView(0, 1.5);
    if (id === 'v3front') setView(0, 0);
    if (id === 'v3left') setView(-Math.PI / 2, 0);
  });
});
  $('#v3obj').addEventListener('click', () => {
    if (!state.mesh) return;
    download('ai3d-' + Date.now() + '.obj', meshToOBJ(state.mesh), 'text/plain');
  });
  $('#v3stl').addEventListener('click', () => {
    if (!state.mesh) return;
    download('ai3d-' + Date.now() + '.stl', meshToSTL(state.mesh), 'model/stl');
  });
  const sk = $('#v3sketch');
  if (sk) sk.addEventListener('click', importSketch);
  window.addEventListener('resize', () => viewer.render());

  // 从草图页跳转过来时自动导入
  if (new URLSearchParams(location.search).get('from') === 'sketch') {
    setTimeout(importSketch, 200);
  }
}

bind();
viewer.render();
setStatus('选一张图，自动识别并生成 3D', '');
