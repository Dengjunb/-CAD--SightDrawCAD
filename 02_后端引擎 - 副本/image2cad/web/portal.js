/* =========================================================================
   门户 · 工作台 · 3D 预览  —— 前端逻辑（原生 JS，零依赖）
   手动绘图已拆分到 mdraw.js，通过 window.MDraw 调用
   ========================================================================= */
(function () {
  'use strict';

  var VEIL_ID = 'portalVeil';

  /* ---------------- 门户首页：两个入口（手动 / AI） ---------------- */
  function ensureVeil() {
    if (document.getElementById(VEIL_ID)) return;
    var v = document.createElement('div');
    v.id = VEIL_ID;
    v.className = 'portal-veil';
    v.innerHTML =
      '<div class="portal-wrap">' +
        '<div class="portal-title">CAD 双模式智能识图 <em>工作台</em></div>' +
        '<div class="portal-sub">两个窗口 · 「手动」自由绘图 + 参数化草图（约束 / 尺寸驱动 / AI 建模）+「AI」看图成图 + AI 全自动 3D</div>' +
        '<div class="portal-grid">' +
          '<div class="portal-card" data-mod="manual" role="button" tabindex="0">' +
            '<div class="icon">&#9999;</div><h3>手动</h3>' +
            '<div class="desc">自由绘制线段 / 矩形 / 圆 / 圆弧，也能切到参数化草图用约束和尺寸驱动整个图形；画的时候随时叫 AI 建模或 AI 助手。</div>' +
            '<span class="go">进入手动绘图 ›</span>' +
          '</div>' +
          '<div class="portal-card" data-mod="ai" role="button" tabindex="0">' +
            '<div class="icon">&#9889;</div><h3>AI</h3>' +
            '<div class="desc">一张图直接出结果：看图成图（图片 → DXF / SVG），或 AI 全自动 3D（图片 → 带孔实体 → STL / OBJ）。</div>' +
            '<span class="go">进入 AI 制图 ›</span>' +
          '</div>' +
        '</div>' +
        '<div class="portal-foot"><span>手动 · 草图 · AI 建模</span><span>看图成图 · AI 3D</span><span>v3.0</span>' +
          '<button type="button" class="portal-ai-set" data-act="ai-settings" ' +
            'title="导入 / 新增 / 测试 / 切换大模型">&#9881; AI 模型设置</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(v);
    v.addEventListener('click', function (e) {
      // 首页左下角的「AI 模型设置」入口（弹窗盖在门户之上）
      var act = e.target.closest ? e.target.closest('[data-act="ai-settings"]') : null;
      if (act) {
        if (window.AiModels) window.AiModels.open();
        return;
      }
      var card = e.target.closest ? e.target.closest('.portal-card') : null;
      if (!card) return;
      enterModule(card.getAttribute('data-mod'));
    });
    v.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var card = e.target.closest ? e.target.closest('.portal-card') : null;
      if (!card) return;
      e.preventDefault();
      enterModule(card.getAttribute('data-mod'));
    });
  }

  /* ---------------- 模块切换 ---------------- */
  function enterModule(mod) {
    var veil = document.getElementById(VEIL_ID);
    var main = document.querySelector('main.mode-shell');
    var view3d = document.getElementById('view3dApp');
    if (main) main.hidden = true;
    if (view3d) view3d.hidden = true;
    if (window.MDraw) window.MDraw.hide();

    if (mod === 'sketch') {
      // 参数化草图是独立页面（零后端改动，走 /static/ 静态路由）
      window.location.assign('/static/sketch/index.html');
      return;
    }
    if (mod === 'ai3d') {
      window.location.assign('/static/3d/index.html');
      return;
    }

    if (mod === 'manual') {
      if (window.MDraw) {
        window.MDraw.build();
        window.MDraw.show();
      } else {
        if (main) main.hidden = false;
        activateModeB();
      }
      // 手动窗口里也能直接叫 AI 助手（抽屉层级在画布之上）
      var chatFab = document.getElementById('aiFab');
      if (chatFab) chatFab.style.display = 'inline-flex';
    } else if (mod === 'view3d') {
      if (!view3d) view3d = buildView3dApp();
      view3d.hidden = false;
      if (view3d._init) view3d._init();
    } else {
      if (main) main.hidden = false;
      activateModeB();
    }
    if (veil) veil.hidden = true;
  }

  function activateModeB() {
    var tabs = document.querySelectorAll('.mode-tab');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute('data-mode') === 'b') { tabs[i].click(); break; }
    }
    var aiBar = document.getElementById('aiBar');
    if (aiBar) aiBar.style.display = 'flex';
    var fab = document.getElementById('aiFab');
    if (fab) fab.style.display = 'inline-flex';
  }

  function ensureFab() {
    if (document.getElementById('portalFab')) return;
    var f = document.createElement('button');
    f.id = 'portalFab';
    f.className = 'portal-fab';
    f.textContent = '⌂ 工作台';
    f.addEventListener('click', goHome);
    document.body.appendChild(f);
  }

  function goHome() {
    var veil = document.getElementById(VEIL_ID);
    if (veil) veil.hidden = false;
    var main = document.querySelector('main.mode-shell');
    var view3d = document.getElementById('view3dApp');
    if (main) main.hidden = true;
    if (view3d) view3d.hidden = true;
    if (window.MDraw) window.MDraw.hide();
    var chat = document.getElementById('aiChat');
    var fab = document.getElementById('aiFab');
    if (chat) chat.hidden = true;
    if (fab) fab.style.display = 'none';
  }

  /* 两个窗口内部的切换：手动 ⇄ 参数化草图，看图成图 ⇄ AI 3D */
  function wireWindowSwitches() {
    var to3d = document.getElementById('aiTo3d');
    if (to3d && !to3d.getAttribute('data-wired')) {
      to3d.setAttribute('data-wired', '1');
      to3d.addEventListener('click', function () {
        window.location.assign('/static/3d/index.html');
      });
    }
  }

  /* ===================================================================
     3D 预览（正交投影，把 2D 实体沿 Y 轴拉伸成立体）
     =================================================================== */
  var V3 = { rotX: -28, rotY: 32, scale: 3.2, depth: 40, auto: true };
  var v3Running = false;
  var v3PendingFit = true;

  function buildView3dApp() {
    var app = document.createElement('div');
    app.id = 'view3dApp';
    app.className = 'view3d-app';
    app.hidden = true;
    app.innerHTML =
      '<canvas id="view3dCanvas" class="view3d-canvas"></canvas>' +
      '<button type="button" class="md-home v3-home" id="v3Home" title="返回工作台">&#8962;</button>' +
      '<div class="view3d-title">3D 预览 <span id="v3Count">0 个图元</span></div>' +
      '<div class="view3d-bar">' +
        '<button type="button" class="tool-btn is-on" id="v3Rotate">旋转</button>' +
        '<button type="button" class="tool-btn" id="v3Reset">复位</button>' +
        '<button type="button" class="tool-btn" id="v3Top">俯视</button>' +
        '<button type="button" class="tool-btn" id="v3Front">正视</button>' +
        '<button type="button" class="tool-btn" id="v3Left">左视</button>' +
        '<button type="button" class="tool-btn" id="v3Iso">等轴</button>' +
        '<button type="button" class="tool-btn is-on" id="v3Auto">自动旋转</button>' +
        '<label class="v3-depth">拉伸<input type="range" id="v3Depth" min="5" max="200" step="1" value="40"><b id="v3DepthVal">40</b></label>' +
      '</div>' +
      '<div class="view3d-help">拖动旋转 · 滚轮缩放 · 图形来自「手动绘图」；要拉伸草图请去 AI 窗口的「AI 全自动 3D」</div>' +
      '<div class="view3d-empty" id="v3Empty" hidden>' +
        '<div class="t">还没有可拉伸的 2D 图元</div>' +
        '<div>先去手动绘图画几个图形，再回来查看 3D 效果</div>' +
        '<button type="button" class="tool-btn" id="v3GoDraw">去手动绘图 ›</button>' +
      '</div>';
    document.body.appendChild(app);
    wireView3d(app);
    return app;
  }

  function wireView3d(app) {
    var canvas = document.getElementById('view3dCanvas');
    var ctx = canvas.getContext('2d');
    var dragging = false;
    var last = { x: 0, y: 0 };
    var lastSize = { w: 0, h: 0 };

    canvas.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      last = { x: e.clientX, y: e.clientY };
      V3.auto = false;
      setOn('v3Auto', false);
      setOn('v3Rotate', true);
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      V3.rotY += (e.clientX - last.x) * 0.5;
      V3.rotX += (e.clientY - last.y) * 0.5;
      V3.rotX = Math.max(-89, Math.min(89, V3.rotX));
      last = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mouseup', function () { dragging = false; });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      V3.scale = Math.max(0.2, Math.min(40, V3.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    }, { passive: false });

    function setView(rx, ry) {
      V3.rotX = rx; V3.rotY = ry;
      V3.auto = false;
      setOn('v3Auto', false);
      setOn('v3Rotate', true);
    }
    function setOn(id, on) { var b = document.getElementById(id); if (b) b.classList.toggle('is-on', on); }

    document.getElementById('v3Rotate').addEventListener('click', function () {
      V3.auto = false; setOn('v3Auto', false); setOn('v3Rotate', true);
    });
    document.getElementById('v3Auto').addEventListener('click', function () {
      V3.auto = true; setOn('v3Auto', true); setOn('v3Rotate', false);
    });
    document.getElementById('v3Reset').addEventListener('click', function () {
      setView(-28, 32); V3.scale = 3.2; v3PendingFit = true;
    });
    document.getElementById('v3Top').addEventListener('click', function () { setView(-90, 0); });
    document.getElementById('v3Front').addEventListener('click', function () { setView(0, 0); });
    document.getElementById('v3Left').addEventListener('click', function () { setView(0, -90); });
    document.getElementById('v3Iso').addEventListener('click', function () { setView(-35, 45); });
    document.getElementById('v3Home').addEventListener('click', goHome);
    document.getElementById('v3GoDraw').addEventListener('click', function () { enterModule('manual'); });

    var depth = document.getElementById('v3Depth');
    depth.addEventListener('input', function () {
      V3.depth = Math.max(5, parseFloat(depth.value) || 40);
      document.getElementById('v3DepthVal').textContent = Math.round(V3.depth);
    });

    function resize() {
      var r = canvas.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      if (lastSize.w !== r.width || lastSize.h !== r.height) {
        lastSize = { w: r.width, h: r.height };
        canvas.width = Math.max(1, Math.round(r.width * dpr));
        canvas.height = Math.max(1, Math.round(r.height * dpr));
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, r.width, r.height);
      return r;
    }

    function modelBounds(ents) {
      if (!ents.length) return null;
      var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (var i = 0; i < ents.length; i++) {
        var e = ents[i];
        var eb;
        if (e.kind === 'line' || e.kind === 'rect') {
          eb = { x0: Math.min(e.x0, e.x1), y0: Math.min(e.y0, e.y1), x1: Math.max(e.x0, e.x1), y1: Math.max(e.y0, e.y1) };
        } else if (e.kind === 'circle') {
          eb = { x0: e.cx - e.r, y0: e.cy - e.r, x1: e.cx + e.r, y1: e.cy + e.r };
        } else if (e.kind === 'polyline') {
          eb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
          (e.pts || []).forEach(function (p) {
            eb.x0 = Math.min(eb.x0, p.x); eb.y0 = Math.min(eb.y0, p.y);
            eb.x1 = Math.max(eb.x1, p.x); eb.y1 = Math.max(eb.y1, p.y);
          });
          if (!isFinite(eb.x0)) eb = { x0: 0, y0: 0, x1: 0, y1: 0 };
        } else {
          var sweep = e.dir > 0 ? ((e.a1 - e.a0) % 6.2832 + 6.2832) % 6.2832 : ((e.a0 - e.a1) % 6.2832 + 6.2832) % 6.2832;
          eb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
          for (var k = 0; k <= 32; k++) {
            var a = e.a0 + e.dir * sweep * k / 32;
            var px = e.cx + e.r * Math.cos(a), py = e.cy + e.r * Math.sin(a);
            eb.x0 = Math.min(eb.x0, px); eb.y0 = Math.min(eb.y0, py);
            eb.x1 = Math.max(eb.x1, px); eb.y1 = Math.max(eb.y1, py);
          }
        }
        b.x0 = Math.min(b.x0, eb.x0); b.y0 = Math.min(b.y0, eb.y0);
        b.x1 = Math.max(b.x1, eb.x1); b.y1 = Math.max(b.y1, eb.y1);
      }
      return b;
    }

    function autoFit(ents) {
      var b = modelBounds(ents);
      if (!b) return;
      var W = canvas.clientWidth || 900, H = canvas.clientHeight || 600;
      var bw = Math.max(b.x1 - b.x0, 1), bh = Math.max(b.y1 - b.y0, 1);
      V3.depth = Math.max(10, Math.min(Math.min(bw, bh) * 0.28, 160));
      document.getElementById('v3Depth').value = String(Math.round(V3.depth));
      document.getElementById('v3DepthVal').textContent = Math.round(V3.depth);
      var span = Math.max(bw * 0.9 + bh * 0.55, bh * 0.8 + V3.depth + 20);
      V3.scale = Math.max(0.2, Math.min((W * 0.72) / span, (H * 0.66) / (bh * 0.55 + V3.depth + 20)));
    }

    function loop() {
      if (!v3Running) return;
      var appEl = document.getElementById('view3dApp');
      if (!appEl || appEl.hidden) { v3Running = false; return; }
      var ents = window.MDraw ? window.MDraw.entities() : [];
      if (v3PendingFit) { autoFit(ents); v3PendingFit = false; }
      if (V3.auto) V3.rotY += 0.35;
      draw3d(ents);
      requestAnimationFrame(loop);
    }

    function draw3d(ents) {
      var r = resize();
      var W = r.width, H = r.height;
      var countEl = document.getElementById('v3Count');
      if (countEl) {
        var ct = ents.length + ' 个图元';
        if (countEl.textContent !== ct) countEl.textContent = ct;
      }
      var emptyEl = document.getElementById('v3Empty');
      if (emptyEl) emptyEl.hidden = ents.length > 0;
      if (!ents.length) return;

      var bb = modelBounds(ents);
      var CX = (bb.x0 + bb.x1) / 2, CZ = (bb.y0 + bb.y1) / 2;
      var D = V3.depth;
      var cy = Math.cos(V3.rotY), sy = Math.sin(V3.rotY);
      var sx = Math.sin(V3.rotX), cx = Math.cos(V3.rotX);

      function proj(px, py, pz) {
        var x = px - CX, z = pz - CZ, y = py - D / 2;
        var x1 = x * cy + z * sy;
        var z1 = -x * sy + z * cy;
        var y1 = y * cx - z1 * sx;
        var z2 = y * sx + z1 * cx;
        return { x: W / 2 + x1 * V3.scale, y: H / 2 - y1 * V3.scale, z: z2 };
      }
      function lineTo(p, q) { ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
      function poly(pts) {
        if (!pts.length) return;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.fill();
      }
      function niceStep(v) {
        var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
        var n = v / p;
        var m = n < 1.5 ? 1 : (n < 3.5 ? 2 : (n < 7.5 ? 5 : 10));
        return m * p;
      }

      /* 地面网格 */
      var step = niceStep(Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) / 8);
      var gx0 = Math.floor(bb.x0 / step) * step, gx1 = Math.ceil(bb.x1 / step) * step;
      var gz0 = Math.floor(bb.y0 / step) * step, gz1 = Math.ceil(bb.y1 / step) * step;
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(76,154,255,0.10)';
      for (var gx = gx0; gx <= gx1 + 1e-6; gx += step) lineTo(proj(gx, 0, gz0), proj(gx, 0, gz1));
      for (var gz = gz0; gz <= gz1 + 1e-6; gz += step) lineTo(proj(gx0, 0, gz), proj(gx1, 0, gz));

      /* 实体拉伸 */
      ents.forEach(function (e) {
        if (e.kind === 'line') {
          var A = proj(e.x0, 0, e.y0), B = proj(e.x1, 0, e.y1);
          var A2 = proj(e.x0, D, e.y0), B2 = proj(e.x1, D, e.y1);
          ctx.lineWidth = 1.2; ctx.strokeStyle = '#3f6f9e'; lineTo(A2, B2);
          ctx.strokeStyle = '#9ed6ff'; lineTo(A, B);
          ctx.strokeStyle = '#5c8cbd'; lineTo(A, A2); lineTo(B, B2);
        } else if (e.kind === 'rect') {
          var rx0 = Math.min(e.x0, e.x1), rx1 = Math.max(e.x0, e.x1);
          var ry0 = Math.min(e.y0, e.y1), ry1 = Math.max(e.y0, e.y1);
          var c = [[rx0, ry0], [rx1, ry0], [rx1, ry1], [rx0, ry1]];
          var top = [], base = [];
          for (var m = 0; m < 4; m++) {
            top.push(proj(c[m][0], D, c[m][1]));
            base.push(proj(c[m][0], 0, c[m][1]));
          }
          ctx.fillStyle = 'rgba(120,180,255,0.10)';
          poly(top);
          ctx.strokeStyle = '#9ed6ff'; ctx.lineWidth = 1.5;
          for (var t = 0; t < 4; t++) lineTo(top[t], top[(t + 1) % 4]);
          ctx.strokeStyle = '#3f6f9e'; ctx.lineWidth = 1.1;
          for (var b2 = 0; b2 < 4; b2++) lineTo(base[b2], base[(b2 + 1) % 4]);
          ctx.strokeStyle = '#5c8cbd';
          for (var v = 0; v < 4; v++) lineTo(base[v], top[v]);
        } else if (e.kind === 'polyline') {
          var pl = e.pts || [];
          if (pl.length < 2) return;
          var pTop = pl.map(function (p) { return proj(p.x, D, p.y); });
          var pBase = pl.map(function (p) { return proj(p.x, 0, p.y); });
          var pCount = pl.length;
          var pSegs = e.closed ? pCount : pCount - 1;
          if (e.closed) {
            ctx.fillStyle = 'rgba(120,180,255,0.08)';
            poly(pTop);
          }
          ctx.strokeStyle = '#9ed6ff'; ctx.lineWidth = 1.5;
          for (var ps = 0; ps < pSegs; ps++) lineTo(pTop[ps], pTop[(ps + 1) % pCount]);
          ctx.strokeStyle = '#3f6f9e'; ctx.lineWidth = 1.1;
          for (var pb = 0; pb < pSegs; pb++) lineTo(pBase[pb], pBase[(pb + 1) % pCount]);
          ctx.strokeStyle = '#5c8cbd';
          var pEvery = Math.max(1, Math.floor(pCount / 16));
          for (var pv = 0; pv < pCount; pv += pEvery) lineTo(pBase[pv], pTop[pv]);
        } else {
          var sweep, n, pts = [];
          if (e.kind === 'circle') { sweep = Math.PI * 2; n = 64; }
          else {
            sweep = e.dir > 0 ? ((e.a1 - e.a0) % 6.2832 + 6.2832) % 6.2832 : ((e.a0 - e.a1) % 6.2832 + 6.2832) % 6.2832;
            n = Math.max(8, Math.ceil(sweep / 6.2832 * 64));
          }
          for (var k = 0; k <= n; k++) {
            var a = e.kind === 'circle' ? k / n * 6.2832 : e.a0 + e.dir * sweep * k / n;
            pts.push({ x: e.cx + e.r * Math.cos(a), y: e.cy + e.r * Math.sin(a) });
          }
          var topPts = pts.map(function (p) { return proj(p.x, D, p.y); });
          var basePts = pts.map(function (p) { return proj(p.x, 0, p.y); });
          if (e.kind === 'circle') {
            ctx.fillStyle = 'rgba(120,180,255,0.10)';
            poly(topPts);
          }
          ctx.lineWidth = 1.4; ctx.strokeStyle = '#9ed6ff';
          for (var q = 1; q < topPts.length; q++) lineTo(topPts[q - 1], topPts[q]);
          ctx.strokeStyle = '#3f6f9e'; ctx.lineWidth = 1.1;
          for (var q2 = 1; q2 < basePts.length; q2++) lineTo(basePts[q2 - 1], basePts[q2]);
          ctx.strokeStyle = '#5c8cbd';
          var every = Math.max(1, Math.floor(n / 16));
          for (var q3 = 0; q3 < basePts.length; q3 += every) lineTo(basePts[q3], topPts[q3]);
        }
      });
    }

    app._init = function () {
      var ents = window.MDraw ? window.MDraw.entities() : [];
      autoFit(ents);
      v3PendingFit = false;
      draw3d(ents);
      if (v3Running) return;
      v3Running = true;
      requestAnimationFrame(loop);
    };
  }

  window.Portal = { enterModule: enterModule, goHome: goHome };

  /* ---------- 启动 ---------- */
  /* AI 窗口里的「AI 自绘」（与手动窗口的 AI 制图同源，都走 MDraw.aiDrawText） */
  function wireAiSelfDraw() {
    var btn = document.getElementById('aiSelfDraw');
    var pop = document.getElementById('aiDrawPop');
    var input = document.getElementById('aiDrawInput');
    var reply = document.getElementById('aiDrawReply');
    var count = document.getElementById('aiDrawCount');
    if (!btn || !pop) return;
    function open(force) {
      var show = typeof force === 'boolean' ? force : pop.hidden;
      pop.hidden = !show;
      if (show && input) setTimeout(function () { input.focus(); }, 30);
    }
    function countText() {
      var n = (window.MDraw && window.MDraw.entityCount) ? window.MDraw.entityCount() : 0;
      if (count) count.textContent = '当前图形共 ' + n + ' 个图元';
    }
    function run(text) {
      var t = (typeof text === 'string' ? text : (input ? input.value : '')).trim();
      var fileEl = document.getElementById('aiDrawFile');
      var file = fileEl && fileEl.files && fileEl.files[0];
      /* 有图 → 走识图流程；没图 → 自绘 */
      if (file) {
        var target = document.getElementById('fileInput');
        var tabB = document.querySelector('.mode-tab[data-mode=b]');
        if (!target) { if (reply) reply.textContent = '识图入口不可用，请刷新页面'; return; }
        try {
          var dt = new DataTransfer();
          dt.items.add(file);
          target.files = dt.files;
          target.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
          if (reply) reply.textContent = '附图片失败：' + (e.message || e);
          return;
        }
        if (tabB) tabB.click();
        if (reply) reply.textContent = '已按「识图」处理「' + file.name + '」，结果在下方预览与「输出文件」区';
        setTimeout(function () {
          var sb = document.getElementById('startBtn');
          if (sb && !sb.disabled) sb.click();
        }, 700);
        setTimeout(function () { pop.hidden = true; }, 250);
        return;
      }
      if (!t) { if (reply) reply.textContent = '没附图就写一句话：法兰 外圆120 内孔60 6个直径10的孔 均布直径100'; return; }
      if (!window.MDraw || !window.MDraw.aiDrawText) { if (reply) reply.textContent = '绘图模块未就绪，请刷新页面'; return; }
      var out = window.MDraw.aiDrawText(t);
      if (reply) reply.textContent = out || '没听懂，换个说法试试';
      if (input) input.value = '';
      countText();
    }
    btn.addEventListener('click', function () { open(); countText(); });
    var close = document.getElementById('aiDrawClose');
    if (close) close.addEventListener('click', function () { open(false); });
    var runBtn = document.getElementById('aiDrawRun');
    if (runBtn) runBtn.addEventListener('click', function () { run(); });
    var fileEl0 = document.getElementById('aiDrawFile');
    var fileName = document.getElementById('aiDrawFileName');
    if (fileEl0) fileEl0.addEventListener('change', function () {
      var f = fileEl0.files && fileEl0.files[0];
      if (fileName) fileName.textContent = f ? ('已附图：' + f.name + '（生成时走识图）') : '未附图：按自绘处理';
    });

    if (input) input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); run(); }
      if (e.key === 'Escape') open(false);
    });
    var chips = pop.querySelector('.ai-pop-chips');
    if (chips) chips.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-draw]');
      if (b) run(b.getAttribute('data-draw'));
    });
    var exp = document.getElementById('aiDrawExport');
    if (exp) exp.addEventListener('click', function () {
      if (!window.MDraw || !window.MDraw.exportDXF) return;
      window.MDraw.build();
      window.MDraw.exportDXF();
    });
    var toManual = document.getElementById('aiDrawManual');
    if (toManual) toManual.addEventListener('click', function () {
      window.location.assign('/?mod=manual');
    });
  }

  /* AI 窗口浅色主题 */
  function wireAiLight() {
    var btn = document.getElementById('aiLightBtn');
    function apply(on, silent) {
      document.body.classList.toggle('ai-light', !!on);
      if (btn) btn.title = on ? '当前：浅色（点击切回深色）' : '当前：深色（点击切到浅色）';
      try { localStorage.setItem('ai.light', on ? '1' : '0'); } catch (e) {}
      void silent;
    }
    if (btn) btn.addEventListener('click', function () {
      apply(!document.body.classList.contains('ai-light'));
    });
    var saved = null;
    try { saved = localStorage.getItem('ai.light'); } catch (e) {}
    /* 默认浅色整体白调；用户显式切过深色（'0'）才恢复深色 */
    if (saved === '0') apply(false, true);
    else apply(true, true);
  }

  function boot() {
    ensureVeil();
    ensureFab();
    wireWindowSwitches();
    wireAiSelfDraw();
    wireAiLight();
    var veil = document.getElementById(VEIL_ID);
    if (veil) veil.hidden = false;
    // 从草图页 / AI 3D 页返回时带 ?mod=manual|ai，直接进对应窗口，不再多一次点击
    var m = (location.search.match(/[?&]mod=(manual|ai)\b/) || [])[1];
    if (m) enterModule(m);
    if (m === "manual" && /[?&]ai=1/.test(location.search)) {
      setTimeout(function () { var b = document.getElementById("mdAiBtn"); if (b) b.click(); }, 400);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();


