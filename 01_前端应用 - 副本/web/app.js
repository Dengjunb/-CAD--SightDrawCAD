/* =========================================================================
   看图成图 · Image → CAD  —— 前端逻辑（原生 JS，零依赖、零构建）
   -------------------------------------------------------------------------
   数据来源：
     GET  /api/schema   参数定义 + 默认值
     GET  /api/demos    示例图列表
     POST /api/run      提交一次生成（demo 或上传）
     GET  /api/status/<runId>  每 400ms 轮询
     产物：/runs/<runId>/<path>（步骤缩略图 / DXF / SVG / JSON / 报告）
   ========================================================================= */
(function () {
  'use strict';

  var POLL_INTERVAL = 400;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

  var els = {
    modeBadge: document.getElementById('modeBadge'),
    serverState: document.getElementById('serverState'),
    serverStateText: document.getElementById('serverStateText'),
    aiBar: document.getElementById('aiBar'),
    aiModel: document.getElementById('aiModel'),
    aiInput: document.getElementById('aiInput'),
    aiSubmit: document.getElementById('aiSubmit'),

    viewToggle: document.getElementById('viewToggle'),
    previewStage: document.getElementById('previewStage'),
    stageEmpty: document.getElementById('stageEmpty'),
    canvasWrap: document.getElementById('canvasWrap'),
    previewImg: document.getElementById('previewImg'),
    overlay: document.getElementById('overlay'),
    stageMeta: document.getElementById('stageMeta'),
    metaName: document.getElementById('metaName'),
    metaSize: document.getElementById('metaSize'),
    opacity: document.getElementById('opacity'),
    opacityVal: document.getElementById('opacityVal'),
    legend: document.getElementById('legend'),

    cadToolbar: document.getElementById('cadToolbar'),
    cadZoomIn: document.getElementById('cadZoomIn'),
    cadZoomOut: document.getElementById('cadZoomOut'),
    cadZoom: document.getElementById('cadZoom'),
    cadFit: document.getElementById('cadFit'),
    cadGrid: document.getElementById('cadGrid'),
    cadLayers: document.getElementById('cadLayers'),
    cadHud: document.getElementById('cadHud'),
    cadHudZoom: document.getElementById('cadHudZoom'),
    cadHelp: document.getElementById('cadHelp'),

    runModeToggle: document.getElementById('runModeToggle'),
    runModeHint: document.getElementById('runModeHint'),
    manualBar: document.getElementById('manualBar'),
    manualStage: document.getElementById('manualStage'),
    manualStageTitle: document.getElementById('manualStageTitle'),
    manualNext: document.getElementById('manualNext'),
    manualApply: document.getElementById('manualApply'),
    manualRerun: document.getElementById('manualRerun'),
    manualStop: document.getElementById('manualStop'),
    manualHint: document.getElementById('manualHint'),

    demoGrid: document.getElementById('demoGrid'),
    demoCount: document.getElementById('demoCount'),
    fileInput: document.getElementById('fileInput'),
    uploadName: document.getElementById('uploadName'),
    sourceNote: document.getElementById('sourceNote'),

    paramPanel: document.getElementById('paramPanel'),
    resetParams: document.getElementById('resetParams'),
    startBtn: document.getElementById('startBtn'),
    runHint: document.getElementById('runHint'),
    errorBanner: document.getElementById('errorBanner'),
    errorText: document.getElementById('errorText'),

    runStatus: document.getElementById('runStatus'),
    progressBar: document.getElementById('progressBar'),
    progressFill: document.getElementById('progressFill'),
    stepList: document.getElementById('stepList'),
    stepsEmpty: document.getElementById('stepsEmpty'),

    statsHint: document.getElementById('statsHint'),
    statSegments: document.getElementById('statSegments'),
    statCircles: document.getElementById('statCircles'),
    statRects: document.getElementById('statRects'),
    statTexts: document.getElementById('statTexts'),
    statF1: document.getElementById('statF1'),
    statElapsed: document.getElementById('statElapsed'),
    qualityBox: document.getElementById('qualityBox'),
    qualityList: document.getElementById('qualityList'),
    statsNote: document.getElementById('statsNote'),

    dlDxf: document.getElementById('dlDxf'),
    dlSvg: document.getElementById('dlSvg'),
    dlJson: document.getElementById('dlJson'),
    dlReport: document.getElementById('dlReport'),
    downloadHint: document.getElementById('downloadHint'),

    recognitionBody: document.getElementById('recognitionBody'),
    refreshRecognition: document.getElementById('refreshRecognition'),

    lightbox: document.getElementById('lightbox'),
    lightboxImg: document.getElementById('lightboxImg'),
    lightboxCaption: document.getElementById('lightboxCaption'),
    lightboxClose: document.getElementById('lightboxClose'),

    playProcessBtn: document.getElementById('playProcessBtn'),
    replayModal: document.getElementById('replayModal'),
    replayImg: document.getElementById('replayImg'),
    replayCounter: document.getElementById('replayCounter'),
    replayClose: document.getElementById('replayClose'),
    replayPrev: document.getElementById('replayPrev'),
    replayPlay: document.getElementById('replayPlay'),
    replayNext: document.getElementById('replayNext'),
    replayStepTitle: document.getElementById('replayStepTitle'),
    replayStepDetail: document.getElementById('replayStepDetail'),
    replayStepMeta: document.getElementById('replayStepMeta'),
    replayProgressFill: document.getElementById('replayProgressFill')
  };

  var state = {
    schema: [],
    defaults: {},
    options: {},
    demos: [],
    currentDemo: null,
    upload: null,
    scene: null,
    viewMode: 'original',
    opacity: 0.72,
    runId: null,
    status: 'idle',
    busy: false,
    polling: false,
    pollTimer: null,
    pollFailures: 0,
    renderedSteps: 0,
    result: null,
    replay: { open: false, steps: [], index: 0, playing: false, timer: null },
    runMode: 'auto',
    manual: { active: false, done: false, runId: null, stage: null,
              stageDone: 0, total: 9, steps: [], busy: false },
    cad: { scale: 1, tx: 0, ty: 0, grid: true, panning: false,
           startX: 0, startY: 0, baseTx: 0, baseTy: 0,
           layers: { seg: true, cir: true, rec: true, txt: true, dim: true } }
  };

  /* ---------------------------------------------------------------- 工具 */
  function fetchJSON(url, options) {
    return fetch(url, options).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) {
          try { data = JSON.parse(text); } catch (err) { data = null; }
        }
        if (!res.ok) {
          var message = (data && (data.error || data.message)) ||
            ('请求失败（HTTP ' + res.status + '）');
          throw new Error(message);
        }
        if (data === null) throw new Error('服务器返回的不是 JSON');
        return data;
      });
    });
  }

  function fmtBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function fmtMs(ms) {
    if (ms === null || ms === undefined || isNaN(ms)) return '—';
    if (ms < 1000) return Math.round(ms) + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
  }

  function fmtNum(value, digits) {
    var num = Number(value);
    if (!isFinite(num)) return '—';
    return num.toFixed(digits);
  }

  function encodeRelPath(rel) {
    return String(rel || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  }

  function runUrl(runId, rel) {
    return '/runs/' + encodeURIComponent(runId) + '/' + encodeRelPath(rel);
  }

  function svgEl(tag) {
    return document.createElementNS(SVG_NS, tag);
  }

  function setRunStatus(kind, text) {
    els.runStatus.className = 'run-status' + (kind ? ' is-' + kind : '');
    els.runStatus.textContent = text;
  }

  function showError(message) {
    els.errorText.textContent = message || '未知错误';
    els.errorBanner.hidden = false;
  }

  function clearError() {
    els.errorBanner.hidden = true;
    els.errorText.textContent = '';
  }

  function setServerState(kind, text) {
    els.serverState.className = 'server-state' + (kind ? ' is-' + kind : '');
    els.serverStateText.textContent = text;
  }

  function hasSource() {
    return !!(state.currentDemo || state.upload);
  }

  function updateStartButton() {
    var manual = state.runMode === 'manual';
    if (manual) {
      els.startBtn.textContent = state.busy ? '执行中…'
        : (state.manual.active ? '手动会话进行中' : '开始分步生成');
    } else {
      els.startBtn.textContent = state.busy ? '生成中…' : '开始生成';
    }
    els.startBtn.disabled = state.busy || !hasSource() || (manual && state.manual.active);
  }

  /* -------------------------------------------------------------- 参数面板 */
  function decimalsOfStep(step) {
    var text = String(step);
    var dot = text.indexOf('.');
    return dot < 0 ? 0 : Math.max(0, text.length - dot - 1);
  }

  function formatOption(value, item) {
    if (value === null || value === undefined) return '—';
    if (item.type === 'range') {
      return Number(value).toFixed(decimalsOfStep(item.step || 1));
    }
    return String(value);
  }

  function setOption(key, value) {
    state.options[key] = value;
    onOptionsChanged();
  }

  function onOptionsChanged() {
    if (state.runMode === 'manual' && state.manual.active) {
      els.manualHint.textContent = '参数已修改：点「应用参数并重跑」会从最早受影响的步骤重跑'
        + '（如二值化→预处理，最短线段→直线），确认后再继续下一步。';
      els.manualApply.disabled = state.manual.busy;
    }
  }

  function renderParams(items) {
    els.paramPanel.innerHTML = '';
    if (!items.length) {
      els.paramPanel.appendChild(hintParagraph('未读取到参数定义。'));
      return;
    }
    items.forEach(function (item) {
      var wrap = document.createElement('div');
      wrap.className = 'param';
      wrap.dataset.key = item.key;

      if (item.type === 'switch') {
        var row = document.createElement('div');
        row.className = 'switch-row';
        var label = document.createElement('span');
        label.className = 'param-label';
        label.textContent = item.label;

        var switchBox = document.createElement('label');
        switchBox.className = 'switch';
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!state.options[item.key];
        input.addEventListener('change', function () {
          setOption(item.key, input.checked);
        });
        var track = document.createElement('span');
        track.className = 'track';
        switchBox.appendChild(input);
        switchBox.appendChild(track);

        row.appendChild(label);
        row.appendChild(switchBox);
        wrap.appendChild(row);
        if (item.hint) wrap.appendChild(hintParagraph(item.hint));
      } else if (item.type === 'range') {
        var head = document.createElement('div');
        head.className = 'param-head';
        var title = document.createElement('span');
        title.className = 'param-label';
        title.textContent = item.label;
        var valueOut = document.createElement('span');
        valueOut.className = 'param-value';
        valueOut.textContent = formatOption(state.options[item.key], item);
        head.appendChild(title);
        head.appendChild(valueOut);

        var inputRange = document.createElement('input');
        inputRange.type = 'range';
        inputRange.className = 'param-range';
        inputRange.min = String(item.min !== undefined ? item.min : 0);
        inputRange.max = String(item.max !== undefined ? item.max : 100);
        inputRange.step = String(item.step !== undefined ? item.step : 1);
        inputRange.value = String(Number(state.options[item.key]));
        inputRange.addEventListener('input', function () {
          var value = Number(inputRange.value);
          setOption(item.key, value);
          valueOut.textContent = formatOption(value, item);
        });

        wrap.appendChild(head);
        wrap.appendChild(inputRange);
        if (item.hint) wrap.appendChild(hintParagraph(item.hint));
      } else if (item.type === 'select') {
        var head2 = document.createElement('div');
        head2.className = 'param-head';
        var title2 = document.createElement('span');
        title2.className = 'param-label';
        title2.textContent = item.label;
        head2.appendChild(title2);

        var select = document.createElement('select');
        select.className = 'param-select';
        (item.options || []).forEach(function (pair) {
          var option = document.createElement('option');
          var value = Array.isArray(pair) ? pair[0] : pair;
          var text = Array.isArray(pair) ? pair[1] : String(pair);
          option.value = String(value);
          option.textContent = text;
          if (String(state.options[item.key]) === String(value)) option.selected = true;
          select.appendChild(option);
        });
        select.addEventListener('change', function () {
          setOption(item.key, select.value);
        });
        wrap.appendChild(head2);
        wrap.appendChild(select);
        if (item.hint) wrap.appendChild(hintParagraph(item.hint));
      } else if (item.type === 'number') {
        var head3 = document.createElement('div');
        head3.className = 'param-head';
        var title3 = document.createElement('span');
        title3.className = 'param-label';
        title3.textContent = item.label;
        head3.appendChild(title3);

        var number = document.createElement('input');
        number.type = 'number';
        number.className = 'param-number';
        if (item.min !== undefined) number.min = String(item.min);
        if (item.max !== undefined) number.max = String(item.max);
        if (item.step !== undefined) number.step = String(item.step);
        number.value = String(state.options[item.key]);
        number.addEventListener('change', function () {
          var value = Number(number.value);
          if (!isFinite(value)) {
            number.value = String(state.options[item.key]);
            return;
          }
          if (item.min !== undefined && value < item.min) value = item.min;
          if (item.max !== undefined && value > item.max) value = item.max;
          number.value = String(value);
          setOption(item.key, value);
        });
        wrap.appendChild(head3);
        wrap.appendChild(number);
        if (item.hint) wrap.appendChild(hintParagraph(item.hint));
      } else {
        wrap.appendChild(hintParagraph('暂不支持的参数类型：' + item.type));
      }

      els.paramPanel.appendChild(wrap);
    });
  }

  function hintParagraph(text) {
    var p = document.createElement('p');
    p.className = 'param-hint';
    p.textContent = text;
    return p;
  }

  /* -------------------------------------------------------------- 示例图 */
  function renderDemos(demos) {
    state.demos = demos || [];
    els.demoGrid.innerHTML = '';
    if (!state.demos.length) {
      els.demoGrid.appendChild(hintParagraph('demo/images 下没有示例图，请直接上传图纸。'));
      els.demoCount.textContent = '';
      return;
    }
    els.demoCount.textContent = '共 ' + state.demos.length + ' 张示例';
    var fragment = document.createDocumentFragment();
    state.demos.forEach(function (demo) {
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'demo-card';
      card.dataset.name = demo.name;

      var thumb = document.createElement('img');
      thumb.className = 'demo-thumb';
      thumb.loading = 'lazy';
      thumb.src = demo.url;
      thumb.alt = demo.name;

      var name = document.createElement('span');
      name.className = 'demo-name';
      name.textContent = demo.name;

      var kind = document.createElement('span');
      kind.className = 'demo-kind';
      kind.textContent = demo.kind || '';

      card.appendChild(thumb);
      card.appendChild(name);
      card.appendChild(kind);
      card.addEventListener('click', function () {
        if (state.busy) return;
        selectDemo(demo);
      });
      fragment.appendChild(card);
    });
    els.demoGrid.appendChild(fragment);
  }

  function clearDemoActive() {
    Array.prototype.forEach.call(els.demoGrid.querySelectorAll('.demo-card'), function (card) {
      card.classList.remove('is-active');
    });
  }

  function selectDemo(demo) {
    state.currentDemo = demo;
    state.upload = null;
    els.uploadName.textContent = 'PNG / JPG / BMP / TIF，≤ 64MB';
    els.uploadName.classList.remove('has-file');
    els.fileInput.value = '';

    clearDemoActive();
    Array.prototype.forEach.call(els.demoGrid.querySelectorAll('.demo-card'), function (card) {
      if (card.dataset.name === demo.name) card.classList.add('is-active');
    });

    els.sourceNote.textContent = '当前使用示例图：' + demo.name;
    setPreview(demo.url, demo.name);
    resetRunView();
    clearError();
    updateStartButton();
  }

  /* ---------------------------------------------------------------- 预览 */
  function setPreview(src, name) {
    state.previewSrc = src;
    els.previewImg.onload = function () {
      els.stageEmpty.hidden = true;
      els.canvasWrap.hidden = false;
      els.stageMeta.hidden = false;
      els.metaName.textContent = name || '图纸';
      els.metaSize.textContent = els.previewImg.naturalWidth + ' × ' +
        els.previewImg.naturalHeight + ' px';
      fitPreview();
      setCadAvailable(true);
      resetCadView();
    };
    els.previewImg.onerror = function () {
      showError('图片加载失败：' + src);
    };
    els.previewImg.src = src;
    if (els.previewImg.complete && els.previewImg.naturalWidth) {
      els.previewImg.onload();
    }
  }

  function fitPreview() {
    var img = els.previewImg;
    if (!img.naturalWidth || !img.naturalHeight) return;
    if (els.canvasWrap.hidden) return;
    var pad = 22;
    var maxW = Math.max(40, els.previewStage.clientWidth - pad * 2);
    var maxH = Math.max(40, els.previewStage.clientHeight - pad * 2);
    var scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
    els.canvasWrap.style.width = Math.round(img.naturalWidth * scale) + 'px';
    els.canvasWrap.style.height = Math.round(img.naturalHeight * scale) + 'px';
  }

  /* ------------------------------------------------------------ CAD 画布 */
  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function applyCadTransform() {
    var cad = state.cad;
    els.canvasWrap.style.transform = 'translate(' + cad.tx + 'px,' + cad.ty + 'px) scale(' + cad.scale + ')';
    var pct = Math.round(cad.scale * 100) + '%';
    els.cadZoom.textContent = pct;
    if (els.cadHudZoom) els.cadHudZoom.textContent = pct;
    els.previewStage.classList.toggle('is-zoomed', cad.scale !== 1);
  }

  function resetCadView() {
    state.cad.scale = 1;
    state.cad.tx = 0;
    state.cad.ty = 0;
    applyCadTransform();
  }

  function setCadAvailable(available) {
    if (!els.cadToolbar) return;
    els.cadToolbar.hidden = !available;
    els.cadHud.hidden = !available;
    els.cadHelp.hidden = !available;
    if (!available) {
      els.previewStage.classList.remove('is-grid');
      return;
    }
    els.previewStage.classList.toggle('is-grid', state.cad.grid);
    els.cadGrid.classList.toggle('is-active', state.cad.grid);
  }

  function cadZoomAt(factor, clientX, clientY) {
    if (els.canvasWrap.hidden) return;
    var stageRect = els.previewStage.getBoundingClientRect();
    var wrapRect = els.canvasWrap.getBoundingClientRect();
    var next = clamp(state.cad.scale * factor, 0.25, 10);
    var ratio = next / state.cad.scale;
    state.cad.tx = (clientX - stageRect.left) - ((clientX - wrapRect.left) * ratio);
    state.cad.ty = (clientY - stageRect.top) - ((clientY - wrapRect.top) * ratio);
    state.cad.scale = next;
    applyCadTransform();
  }

  function cadFit() {
    fitPreview();
    resetCadView();
  }

  function updateCadCrosshair(clientX, clientY) {
    if (!els.cadHud || els.canvasWrap.hidden) return;
    var img = els.previewImg;
    if (!img.naturalWidth) return;
    var wrapRect = els.canvasWrap.getBoundingClientRect();
    var baseW = parseFloat(els.canvasWrap.style.width) || wrapRect.width;
    var baseH = parseFloat(els.canvasWrap.style.height) || wrapRect.height;
    var px = (clientX - wrapRect.left) / Math.max(0.001, state.cad.scale) * (img.naturalWidth / Math.max(1, baseW));
    var py = (clientY - wrapRect.top) / Math.max(0.001, state.cad.scale) * (img.naturalHeight / Math.max(1, baseH));
    if (px < 0 || py < 0 || px > img.naturalWidth || py > img.naturalHeight) {
      els.cadHud.textContent = 'X —　Y —';
      return;
    }
    var text = 'X ' + px.toFixed(1) + '　Y ' + py.toFixed(1) + ' px';
    if (state.scene && state.scene.scale_mm_per_px) {
      var s = Number(state.scene.scale_mm_per_px);
      text += '　( ' + (px * s).toFixed(2) + ', ' + ((state.scene.height_px - py) * s).toFixed(2) + ' )';
    }
    els.cadHud.textContent = text;
    if (els.cadHudZoom) els.cadHudZoom.textContent = Math.round(state.cad.scale * 100) + '%';
  }

  function applyLayerVisibility() {
    if (!els.overlay) return;
    Object.keys(state.cad.layers).forEach(function (key) {
      var group = els.overlay.querySelector('g[data-layer="' + key + '"]');
      if (group) group.style.display = state.cad.layers[key] ? '' : 'none';
    });
  }

  function bindCadEvents() {
    els.cadZoomIn.addEventListener('click', function () {
      var rect = els.previewStage.getBoundingClientRect();
      cadZoomAt(1.25, rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    els.cadZoomOut.addEventListener('click', function () {
      var rect = els.previewStage.getBoundingClientRect();
      cadZoomAt(0.8, rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    els.cadFit.addEventListener('click', cadFit);
    els.cadGrid.addEventListener('click', function () {
      state.cad.grid = !state.cad.grid;
      els.cadGrid.classList.toggle('is-active', state.cad.grid);
      els.previewStage.classList.toggle('is-grid', state.cad.grid && !els.canvasWrap.hidden);
    });
    els.cadLayers.addEventListener('change', function (event) {
      var input = event.target;
      if (!input || !input.dataset.layer) return;
      state.cad.layers[input.dataset.layer] = !!input.checked;
      applyLayerVisibility();
    });

    els.previewStage.addEventListener('wheel', function (event) {
      if (els.canvasWrap.hidden) return;
      event.preventDefault();
      cadZoomAt(event.deltaY < 0 ? 1.12 : 0.89, event.clientX, event.clientY);
    }, { passive: false });

    els.previewStage.addEventListener('pointerdown', function (event) {
      if (els.canvasWrap.hidden) return;
      if (event.target.closest('.cad-toolbar')) return;
      state.cad.panning = true;
      state.cad.startX = event.clientX;
      state.cad.startY = event.clientY;
      state.cad.baseTx = state.cad.tx;
      state.cad.baseTy = state.cad.ty;
      els.previewStage.classList.add('is-panning');
      try { els.previewStage.setPointerCapture(event.pointerId); } catch (err) { }
    });
    els.previewStage.addEventListener('pointermove', function (event) {
      updateCadCrosshair(event.clientX, event.clientY);
      if (!state.cad.panning) return;
      state.cad.tx = state.cad.baseTx + (event.clientX - state.cad.startX);
      state.cad.ty = state.cad.baseTy + (event.clientY - state.cad.startY);
      applyCadTransform();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) {
      els.previewStage.addEventListener(name, function () {
        state.cad.panning = false;
        els.previewStage.classList.remove('is-panning');
      });
    });
    els.previewStage.addEventListener('dblclick', function (event) {
      if (event.target.closest('.cad-toolbar')) return;
      cadFit();
    });
  }

  function applyView() {
    var showOverlay = state.viewMode === 'overlay' && !!state.scene;
    els.overlay.style.display = showOverlay ? '' : 'none';
    els.overlay.style.opacity = String(state.opacity);
    els.legend.classList.toggle('is-muted', !state.scene);
    Array.prototype.forEach.call(els.viewToggle.querySelectorAll('.seg-btn'), function (btn) {
      btn.classList.toggle('is-active', btn.dataset.view === state.viewMode);
    });
  }

  function clearOverlay() {
    state.scene = null;
    while (els.overlay.firstChild) els.overlay.removeChild(els.overlay.firstChild);
    els.overlay.removeAttribute('viewBox');
    els.overlay.style.display = 'none';
    applyView();
  }

  function drawOverlay(scene) {
    while (els.overlay.firstChild) els.overlay.removeChild(els.overlay.firstChild);
    if (!scene || !scene.width_px || !scene.height_px) {
      state.scene = null;
      applyView();
      return;
    }
    state.scene = scene;
    var width = Number(scene.width_px);
    var height = Number(scene.height_px);
    els.overlay.setAttribute('viewBox', '0 0 ' + width + ' ' + height);

    var fragment = document.createDocumentFragment();

    var gSeg = svgEl('g');
    gSeg.setAttribute('data-layer', 'seg');
    (scene.segments || []).forEach(function (segment) {
      var line = svgEl('line');
      line.setAttribute('class', 'seg');
      line.setAttribute('x1', segment.x1);
      line.setAttribute('y1', segment.y1);
      line.setAttribute('x2', segment.x2);
      line.setAttribute('y2', segment.y2);
      gSeg.appendChild(line);
    });
    fragment.appendChild(gSeg);

    var gCircle = svgEl('g');
    gCircle.setAttribute('data-layer', 'cir');
    (scene.circles || []).forEach(function (circle) {
      var node = svgEl('circle');
      node.setAttribute('class', 'cir');
      node.setAttribute('cx', circle.cx);
      node.setAttribute('cy', circle.cy);
      node.setAttribute('r', circle.r);
      gCircle.appendChild(node);
    });
    fragment.appendChild(gCircle);

    var gRect = svgEl('g');
    gRect.setAttribute('data-layer', 'rec');
    (scene.rects || []).forEach(function (rect) {
      var node = svgEl('rect');
      node.setAttribute('class', 'rec');
      node.setAttribute('x', rect.x);
      node.setAttribute('y', rect.y);
      node.setAttribute('width', rect.w);
      node.setAttribute('height', rect.h);
      gRect.appendChild(node);
    });
    fragment.appendChild(gRect);

    var gText = svgEl('g');
    gText.setAttribute('data-layer', 'txt');
    (scene.text_boxes || []).forEach(function (box) {
      var node = svgEl('rect');
      node.setAttribute('class', 'txt');
      node.setAttribute('x', box.x);
      node.setAttribute('y', box.y);
      node.setAttribute('width', box.w);
      node.setAttribute('height', box.h);
      gText.appendChild(node);
    });
    fragment.appendChild(gText);

    els.overlay.appendChild(fragment);
    applyLayerVisibility();
    applyView();
  }

  /* ---------------------------------------------------------------- 步骤 */
  function buildStep(step, index) {
    var li = document.createElement('li');
    li.className = 'step-item';
    li.dataset.key = step.key || '';

    var number = document.createElement('span');
    number.className = 'step-index';
    number.textContent = String(index + 1).padStart(2, '0');

    var thumb;
    if (step.image && state.runId) {
      thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'step-thumb';
      thumb.title = '点击放大：' + (step.title || '');
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = step.title || '步骤缩略图';
      img.src = runUrl(state.runId, step.image);
      thumb.appendChild(img);
      thumb.addEventListener('click', function () {
        openLightbox(runUrl(state.runId, step.image), step.title || '',
          step.detail || '');
      });
    } else {
      thumb = document.createElement('div');
      thumb.className = 'step-thumb is-empty';
      var none = document.createElement('span');
      none.className = 'thumb-none';
      none.textContent = '无缩略图';
      thumb.appendChild(none);
    }

    var body = document.createElement('div');
    body.className = 'step-body';

    var titleRow = document.createElement('div');
    titleRow.className = 'step-title-row';
    var title = document.createElement('span');
    title.className = 'step-title';
    title.textContent = step.title || '步骤';
    var ms = document.createElement('span');
    ms.className = 'step-ms';
    ms.textContent = fmtMs(step.ms);
    titleRow.appendChild(title);
    titleRow.appendChild(ms);

    var detail = document.createElement('p');
    detail.className = 'step-detail';
    detail.textContent = step.detail || '';
    detail.title = step.detail || '';

    body.appendChild(titleRow);
    body.appendChild(detail);

    var metrics = step.metrics || {};
    var keys = Object.keys(metrics);
    if (keys.length) {
      var meta = document.createElement('div');
      meta.className = 'step-metrics';
      keys.slice(0, 8).forEach(function (key) {
        var span = document.createElement('span');
        var value = metrics[key];
        if (typeof value === 'number' && !Number.isInteger(value)) {
          value = Number(value.toFixed(3));
        }
        span.textContent = key + ': ' + value;
        meta.appendChild(span);
      });
      body.appendChild(meta);
    }

    li.appendChild(number);
    li.appendChild(thumb);
    li.appendChild(body);
    return li;
  }

  function appendSteps(steps) {
    var list = steps || [];
    for (var i = state.renderedSteps; i < list.length; i++) {
      els.stepList.appendChild(buildStep(list[i], i));
    }
    state.renderedSteps = list.length;
    els.stepsEmpty.hidden = list.length > 0;

    Array.prototype.forEach.call(els.stepList.querySelectorAll('.step-item.is-latest'), function (item) {
      item.classList.remove('is-latest');
    });
    var items = els.stepList.querySelectorAll('.step-item');
    if (items.length) items[items.length - 1].classList.add('is-latest');
  }

  function openLightbox(src, title, detail) {
    els.lightboxImg.src = src;
    els.lightboxCaption.textContent = title + (detail ? ' · ' + detail : '');
    els.lightbox.hidden = false;
  }

  function closeLightbox() {
    els.lightbox.hidden = true;
    els.lightboxImg.src = '';
  }

  /* ---------------------------------------------------------------- 统计 */
  function resetStats() {
    [els.statSegments, els.statCircles, els.statRects, els.statTexts,
      els.statF1, els.statElapsed].forEach(function (node) {
      node.textContent = '—';
      node.classList.remove('is-good', 'is-warn');
    });
    els.qualityBox.hidden = true;
    els.qualityBox.open = false;
    els.qualityList.innerHTML = '';
    els.statsNote.textContent = '生成完成后显示识别数量与栅格自检分数。';
    els.statsHint.textContent = '';
  }

  function renderStats(result) {
    var metrics = result.metrics || {};
    var scene = result.scene || {};
    els.statSegments.textContent = String(metrics.segments !== undefined ? metrics.segments : (scene.segments || []).length);
    els.statCircles.textContent = String(metrics.circles !== undefined ? metrics.circles : (scene.circles || []).length);
    els.statRects.textContent = String(metrics.rects !== undefined ? metrics.rects : (scene.rects || []).length);
    els.statTexts.textContent = String(metrics.text_boxes !== undefined ? metrics.text_boxes : (scene.text_boxes || []).length);

    var quality = result.quality || {};
    var f1 = Number(quality.f1);
    if (isFinite(f1) && f1 > 0) {
      els.statF1.textContent = f1.toFixed(3);
      els.statF1.classList.toggle('is-good', f1 >= 0.8);
      els.statF1.classList.toggle('is-warn', f1 < 0.8 && f1 >= 0.6);
    } else {
      els.statF1.textContent = '—';
    }

    els.statElapsed.textContent = fmtMs(metrics.elapsed_ms !== undefined ? metrics.elapsed_ms : result.elapsed_ms);

    var rows = [
      ['精确率 precision', quality.precision],
      ['召回率 recall', quality.recall],
      ['F1', quality.f1],
      ['平均偏差 chamfer', quality.chamfer_px !== undefined ? quality.chamfer_px + ' px' : undefined],
      ['墨迹占比', quality.ink_ratio !== undefined ? (Number(quality.ink_ratio) * 100).toFixed(2) + '%' : undefined],
      ['明显偏离线段', quality.extra_segments]
    ];
    els.qualityList.innerHTML = '';
    rows.forEach(function (row) {
      if (row[1] === undefined || row[1] === null) return;
      var wrap = document.createElement('div');
      var dt = document.createElement('dt');
      dt.textContent = row[0];
      var dd = document.createElement('dd');
      dd.textContent = typeof row[1] === 'number' ? String(Number(row[1].toFixed ? row[1].toFixed(4) : row[1])) : String(row[1]);
      wrap.appendChild(dt);
      wrap.appendChild(dd);
      els.qualityList.appendChild(wrap);
    });
    els.qualityBox.hidden = !els.qualityList.children.length;

    els.statsHint.textContent = (metrics.method === 'mock') ? '联调数据' : '识别结果';
    var sourceInfo = '';
    if (result.source && result.source.name) {
      sourceInfo = '来源：' + result.source.name + ' · ' + result.source.width + ' × ' + result.source.height + ' px';
    }
    var warning = (result.warnings && result.warnings.length) ? '　注意：' + result.warnings.join('；') : '';
    els.statsNote.textContent = sourceInfo + warning;
  }

  /* ---------------------------------------------------------------- 下载 */
  var DOWNLOADS = [
    { id: 'dlDxf', key: 'dxf', ext: '.dxf', format: 'DXF' },
    { id: 'dlSvg', key: 'svg', ext: '.svg', format: 'SVG' },
    { id: 'dlJson', key: 'json', ext: '.json', format: 'JSON' },
    { id: 'dlReport', key: 'report', ext: '.html', format: 'HTML' }
  ];

  function resetDownloads() {
    DOWNLOADS.forEach(function (item) {
      var node = els[item.id];
      node.classList.add('is-disabled');
      node.setAttribute('aria-disabled', 'true');
      node.removeAttribute('href');
      node.removeAttribute('download');
    });
    els.downloadHint.textContent = '生成完成后可下载 DXF、SVG、场景 JSON 与 HTML 报告。';
  }

  function renderDownloads(result) {
    var files = (result && result.files) || {};
    var enabled = 0;
    DOWNLOADS.forEach(function (item) {
      var node = els[item.id];
      var rel = files[item.key];
      if (rel && state.runId) {
        node.href = runUrl(state.runId, rel);
        node.setAttribute('download', '看图成图-' + state.runId + item.ext);
        node.classList.remove('is-disabled');
        node.setAttribute('aria-disabled', 'false');
        enabled += 1;
      } else {
        node.classList.add('is-disabled');
        node.setAttribute('aria-disabled', 'true');
        node.removeAttribute('href');
        node.removeAttribute('download');
      }
    });
    els.downloadHint.textContent = enabled
      ? '共 ' + enabled + ' 个文件可下载；DXF 可直接在 AutoCAD 中打开。'
      : '本次运行没有返回可下载文件。';
  }

  /* ------------------------------------------------------------ 图框识读 */
  function resetRecognition() {
    els.recognitionBody.innerHTML = '';
    els.recognitionBody.appendChild(hintParagraph(
      '生成完成后，若勾选「联动图框识读」，这里会显示标题栏字段（零件名称 / 材料 / 图号等）。'));
    els.refreshRecognition.disabled = true;
  }

  function flattenFields(object, prefix, rows) {
    Object.keys(object).forEach(function (key) {
      var value = object[key];
      var label = prefix ? prefix + ' · ' + key : key;
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) return;
      if (typeof value === 'object') {
        flattenFields(value, label, rows);
        return;
      }
      if (key === 'note' || key === 'engine') return;
      rows.push({ label: label, value: String(value) });
    });
    return rows;
  }

  function renderRecognition(recognition) {
    els.recognitionBody.innerHTML = '';
    if (!recognition) {
      resetRecognition();
      return;
    }
    var rows = [];
    // 后端识读结果有两种形状：{fields:[...]}（mock / 简化）与
    // {pairs:[{label,value,confidence}], matched, empty, unmatched, ...}（pipeline 真实形状）。
    var list = null;
    if (Array.isArray(recognition.fields)) list = recognition.fields;
    else if (Array.isArray(recognition.pairs)) list = recognition.pairs;
    if (list) {
      list.forEach(function (field) {
        if (!field) return;
        rows.push({
          label: field.label || field.key || field.name || '字段',
          value: (field.value === undefined || field.value === null) ? '' : String(field.value),
          confidence: field.confidence
        });
      });
    } else {
      flattenFields(recognition, '', rows);
    }

    if (!rows.length) {
      resetRecognition();
      return;
    }

    var table = document.createElement('table');
    table.className = 'rec-table';
    var tbody = document.createElement('tbody');
    var maxRows = 16;
    rows.slice(0, maxRows).forEach(function (row) {
      var tr = document.createElement('tr');
      var th = document.createElement('th');
      th.textContent = row.label;
      th.title = row.label;
      var td = document.createElement('td');
      td.textContent = row.value || '—';
      td.title = row.value || '';
      if (typeof row.confidence === 'number') {
        var conf = document.createElement('span');
        conf.className = 'rec-conf';
        conf.textContent = Math.round(row.confidence * 100) + '%';
        td.appendChild(conf);
      }
      tr.appendChild(th);
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    els.recognitionBody.appendChild(table);

    var notes = [];
    if (recognition.engine) notes.push('识读引擎：' + recognition.engine);
    if (typeof recognition.confidence === 'number') {
      notes.push('整体置信度：' + Math.round(recognition.confidence * 100) + '%');
    }
    if (typeof recognition.matched === 'number') notes.push('匹配 ' + recognition.matched + ' 项');
    if (typeof recognition.empty === 'number') notes.push('留空 ' + recognition.empty + ' 项');
    if (typeof recognition.unmatched === 'number') notes.push('未匹配 ' + recognition.unmatched + ' 项');
    if (typeof recognition.elapsed_s === 'number') notes.push('识读耗时 ' + recognition.elapsed_s.toFixed(3) + ' s');
    if (recognition.output) notes.push('识读 DXF：' + recognition.output);
    if (recognition.note) notes.push(recognition.note);
    if (recognition.error) notes.push('识读错误：' + recognition.error);
    if (notes.length) {
      var note = document.createElement('p');
      note.className = 'rec-note';
      note.textContent = notes.join(' · ');
      els.recognitionBody.appendChild(note);
    }
    els.refreshRecognition.disabled = state.status !== 'done' || !state.runId;
  }

  /* ---------------------------------------------------------------- 运行 */
  function resetRunView() {
    stopPolling();
    state.runId = null;
    state.status = 'idle';
    state.result = null;
    state.renderedSteps = 0;
    state.manual = { active: false, done: false, runId: null, stage: null,
                     stageDone: 0, total: 9, steps: [], busy: false, status: null };
    if (els.manualBar) els.manualBar.hidden = true;
    [els.manualNext, els.manualApply, els.manualRerun, els.manualStop].forEach(function (btn) {
      if (btn) btn.disabled = true;
    });
    if (state.replay.open) closeReplay();
    els.stepList.innerHTML = '';
    els.stepsEmpty.hidden = false;
    els.progressBar.hidden = true;
    els.progressBar.classList.remove('is-idle');
    els.progressFill.style.width = '0%';
    setRunStatus('', '未开始');
    resetStats();
    resetDownloads();
    resetRecognition();
    clearOverlay();
    els.runHint.textContent = hasSource()
      ? '可以开始生成；生成时按左侧参数执行。'
      : '请先选择示例图或上传图片。';
    updateStartButton();
    updatePlayButton();
  }

  function setBusy(busy) {
    state.busy = busy;
    updateStartButton();
    els.resetParams.disabled = busy;
    els.fileInput.disabled = busy;
    if (busy) {
      els.runHint.textContent = '正在生成，请稍候…';
    }
  }

  function startRun() {
    if (state.busy) return;
    if (state.runMode === 'manual') {
      startManualRun();
      return;
    }
    if (!hasSource()) {
      showError('请先选择一张示例图，或上传本地图纸。');
      return;
    }
    clearError();
    resetRunView();
    setBusy(true);
    updatePlayButton();
    setRunStatus('running', '提交中…');
    els.progressBar.hidden = false;
    els.progressBar.classList.add('is-idle');
    els.progressFill.style.width = '0%';

    var payload = {
      options: state.options
    };
    if (state.currentDemo) {
      payload.demo = state.currentDemo.name;
    } else {
      payload.name = state.upload.name;
      payload.data_b64 = state.upload.base64;
    }

    fetchJSON('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (data) {
      state.runId = data.runId;
      state.status = 'running';
      state.pollFailures = 0;
      setRunStatus('running', '生成中 · 0 步');
      els.runHint.textContent = '正在识别，步骤会实时出现…';
      startPolling();
    }).catch(function (err) {
      setBusy(false);
      state.status = 'error';
      els.progressBar.hidden = true;
      els.progressBar.classList.remove('is-idle');
      setRunStatus('error', '提交失败');
      showError(err.message || '提交失败');
      els.runHint.textContent = '可以调整参数后重试。';
    });
  }

  /* -------------------------------------------------------- 手动分步执行 */
  function setRunMode(mode) {
    if (state.busy || state.manual.active) {
      els.runModeHint.textContent = state.manual.active
        ? '手动会话进行中：请先点「停止」或完成后再切换'
        : '生成进行中，暂时不能切换运行方式';
      return;
    }
    if (state.runMode === mode) return;
    state.runMode = mode;
    Array.prototype.forEach.call(els.runModeToggle.querySelectorAll('.seg-btn'), function (btn) {
      btn.classList.toggle('is-active', btn.dataset.runMode === mode);
    });
    els.runModeHint.textContent = mode === 'manual' ? '每步暂停 · 可改参数' : '一键跑完';
    resetRunView();
    updateStartButton();
    els.runHint.textContent = mode === 'manual'
      ? '手动分步：开始时读取图像，之后每点一次执行下一步；每步结束会暂停供核对。'
      : '可以开始生成；生成时按左侧参数执行。';
  }

  function updateManualBar() {
    var m = state.manual;
    var visible = state.runMode === 'manual' && (m.active || m.done || m.status === 'stopped');
    els.manualBar.hidden = !visible;
    if (!visible) return;
    var total = m.total || 9;
    var index = m.stage ? Math.min(total, m.stage.index || m.stageDone + 1) : 0;
    els.manualStage.textContent = '第 ' + index + ' / ' + total + ' 步';
    els.manualStageTitle.textContent = m.stage ? (m.stage.title || '') : '—';
    els.manualNext.disabled = !m.active || m.busy;
    els.manualApply.disabled = !m.active || m.busy || m.stageDone < 1;
    els.manualRerun.disabled = !m.active || m.busy || m.stageDone < 1;
    els.manualStop.disabled = !m.active || m.busy;
    if (m.done) {
      els.manualHint.textContent = '全部 9 步已完成：可下载 DXF/SVG/报告，也可用「播放过程」回放。';
    } else if (m.status === 'stopped') {
      els.manualHint.textContent = '已停止；已产生的步骤截图与中间结果保留在本次运行目录。';
    } else if (m.busy) {
      els.manualHint.textContent = '正在执行，请稍候…';
    }
  }

  function renderManualPayload(data, hintText) {
    var m = state.manual;
    m.runId = data.runId;
    state.runId = data.runId;
    m.stage = data.stage || null;
    m.stageDone = Number(data.stageDone || 0);
    m.total = Number(data.totalStages || 9);
    m.status = data.status;
    m.done = data.status === 'done';
    m.active = data.status === 'paused';
    m.busy = false;
    m.steps = data.steps || [];
    state.status = data.status === 'done' ? 'done'
      : (data.status === 'paused' ? 'paused' : data.status);

    state.renderedSteps = 0;
    els.stepList.innerHTML = '';
    appendSteps(m.steps);
    els.stepsEmpty.hidden = m.steps.length > 0;
    els.manualBar.hidden = false;
    els.progressBar.hidden = false;
    els.progressBar.classList.remove('is-idle');
    els.progressFill.style.width = Math.min(100, Math.round((m.stageDone / Math.max(1, m.total)) * 100)) + '%';

    if (data.status === 'done' && data.result) {
      state.result = data.result;
      m.active = false;
      els.progressFill.style.width = '100%';
      renderStats(data.result);
      renderDownloads(data.result);
      renderRecognition(data.result.recognition);
      drawOverlay(data.result.scene);
      state.viewMode = 'overlay';
      applyView();
      setRunStatus('done', '已完成 · ' + fmtMs(data.elapsedMs));
      els.refreshRecognition.disabled = true;  // 手动会话不走补识读接口
      updatePlayButton();
    } else if (data.status === 'error') {
      m.active = false;
      setRunStatus('error', '手动步骤失败');
      showError(data.error || '手动步骤执行失败');
      els.refreshRecognition.disabled = true;
    } else if (data.status === 'stopped') {
      m.active = false;
      setRunStatus('', '已停止');
      els.refreshRecognition.disabled = true;
    } else {
      setRunStatus('running', '已暂停 · 第 ' + (data.stage ? data.stage.index : 0) + ' / ' + m.total + ' 步');
      els.refreshRecognition.disabled = true;
      updatePlayButton();
    }
    updateManualBar();
    updateStartButton();
    if (hintText) els.runHint.textContent = hintText;
  }

  function startManualRun() {
    if (state.busy || state.manual.active) return;
    if (!hasSource()) {
      showError('请先选择一张示例图，或上传本地图纸。');
      return;
    }
    clearError();
    resetRunView();
    setBusy(true);
    els.runModeHint.textContent = '手动分步 · 初始化';
    els.progressBar.hidden = false;
    els.progressFill.style.width = '0%';
    setRunStatus('running', '准备中…');

    var payload = { options: state.options };
    if (state.currentDemo) payload.demo = state.currentDemo.name;
    else {
      payload.name = state.upload.name;
      payload.data_b64 = state.upload.base64;
    }

    fetchJSON('/api/manual/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (data) {
      setBusy(false);
      renderManualPayload(data, '已读取图像。检查预览，点「执行下一步」预处理；每步结束会暂停。');
    }).catch(function (err) {
      setBusy(false);
      setRunStatus('error', '启动失败');
      showError(err.message || '手动模式启动失败');
    });
  }

  function manualRequest(action, hintText) {
    var m = state.manual;
    if (m.busy || !m.runId || !m.active) return;
    m.busy = true;
    updateManualBar();
    var body = { options: state.options };
    var url = '/api/manual/' + action + '/' + encodeURIComponent(m.runId);
    fetchJSON(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (data) {
      renderManualPayload(data, hintText);
    }).catch(function (err) {
      m.busy = false;
      updateManualBar();
      setRunStatus('error', '步骤执行失败');
      showError(err.message || '步骤执行失败');
    });
  }

  function manualStop() {
    var m = state.manual;
    if (!m.runId || m.busy) return;
    m.busy = true;
    updateManualBar();
    fetchJSON('/api/manual/stop/' + encodeURIComponent(m.runId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }).then(function (data) {
      renderManualPayload(data, '已停止手动会话。');
    }).catch(function (err) {
      m.busy = false;
      updateManualBar();
      showError(err.message || '停止失败');
    });
  }

  function startPolling() {
    state.polling = true;
    schedulePoll(0);
  }

  function stopPolling() {
    state.polling = false;
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function schedulePoll(delay) {
    if (!state.polling) return;
    state.pollTimer = setTimeout(pollOnce, delay);
  }

  function pollOnce() {
    if (!state.polling || !state.runId) return;
    var url = '/api/status/' + encodeURIComponent(state.runId);
    fetchJSON(url).then(function (status) {
      state.pollFailures = 0;
      applyStatus(status);
      if (status.status === 'running') {
        schedulePoll(POLL_INTERVAL);
      } else {
        stopPolling();
        finishRun(status);
      }
    }).catch(function (err) {
      state.pollFailures += 1;
      if (state.pollFailures > 6) {
        stopPolling();
        setBusy(false);
        state.status = 'error';
        els.progressBar.hidden = true;
        setRunStatus('error', '进度获取失败');
        showError('无法获取生成进度：' + (err.message || err));
      } else {
        schedulePoll(800);
      }
    });
  }

  function applyStatus(status) {
    appendSteps(status.steps || []);
    var elapsed = fmtMs(status.elapsedMs);
    if (status.status === 'running') {
      setRunStatus('running', '生成中 · ' + (status.steps || []).length + ' 步 · ' + elapsed);
      els.progressFill.style.width = Math.min(92, 8 + (status.steps || []).length * 11) + '%';
    }
    if (status.source && status.source.url && state.upload && !state.previewFromRun) {
      state.previewFromRun = true;
      setPreview(status.source.url, status.source.name);
    }
    if (status.status === 'done' && status.result) {
      renderStats(status.result);
      renderDownloads(status.result);
      renderRecognition(status.result.recognition);
      drawOverlay(status.result.scene);
      if (status.result.scene) {
        state.viewMode = 'overlay';
      }
      applyView();
      els.stepsEmpty.hidden = (status.steps || []).length > 0;
    }
    if (status.status === 'error') {
      setRunStatus('error', '生成失败');
      showError(status.error || '生成失败，请调整参数后重试。');
      els.progressBar.hidden = true;
    }
  }

  function finishRun(status) {
    setBusy(false);
    state.status = status.status;
    if (status.status === 'done') {
      els.progressBar.classList.remove('is-idle');
      els.progressFill.style.width = '100%';
      setRunStatus('done', '已完成 · ' + fmtMs(status.elapsedMs));
      els.runHint.textContent = '已完成。可切换「矢量叠加」查看识别结果，或下载 CAD 文件。';
      els.refreshRecognition.disabled = !state.runId;
      if (status.result) state.result = status.result;
      updatePlayButton();
      if (!status.result) {
        showError('生成结束但没有返回结果，请查看 out/runs 下的 error.txt。');
      }
    } else {
      els.runHint.textContent = '失败后可调整参数重新生成。';
      els.refreshRecognition.disabled = true;
      updatePlayButton();
    }
  }

  /* ------------------------------------------------------------ 过程回放 */
  function replaySteps() {
    var result = state.result;
    if (!result || !result.steps) return [];
    return result.steps.filter(function (step) {
      return step && step.image;
    });
  }

  function openReplay() {
    var steps = replaySteps();
    if (!steps.length || !state.runId) {
      showError('这次运行没有可回放的步骤截图。');
      return;
    }
    state.replay.steps = steps;
    state.replay.index = 0;
    state.replay.open = true;
    els.replayModal.hidden = false;
    renderReplayFrame();
    playReplay();
  }

  function renderReplayFrame() {
    var replay = state.replay;
    var step = replay.steps[replay.index];
    if (!step) return;
    var url = '/runs/' + encodeURIComponent(state.runId) + '/' + encodeRelPath(step.image);
    els.replayImg.src = url;
    els.replayCounter.textContent = (replay.index + 1) + ' / ' + replay.steps.length;
    els.replayStepTitle.textContent = step.title || '—';
    els.replayStepDetail.textContent = step.detail || '';
    var meta = [];
    if (step.ms) meta.push('耗时 ' + fmtMs(step.ms));
    if (step.metrics) {
      Object.keys(step.metrics).forEach(function (key) {
        var value = step.metrics[key];
        if (value === null || value === undefined) return;
        meta.push(key + '：' + value);
      });
    }
    els.replayStepMeta.textContent = meta.join(' · ');
    els.replayProgressFill.style.width =
      Math.round(((replay.index + 1) / replay.steps.length) * 100) + '%';
    els.replayPlay.textContent = replay.playing ? '暂停' : '播放';
  }

  function playReplay() {
    var replay = state.replay;
    if (!replay.open) return;
    replay.playing = true;
    els.replayPlay.textContent = '暂停';
    if (replay.timer) clearInterval(replay.timer);
    replay.timer = setInterval(function () {
      if (replay.index >= replay.steps.length - 1) {
        pauseReplay();
        return;
      }
      replay.index += 1;
      renderReplayFrame();
    }, 1500);
  }

  function pauseReplay() {
    var replay = state.replay;
    replay.playing = false;
    if (replay.timer) {
      clearInterval(replay.timer);
      replay.timer = null;
    }
    els.replayPlay.textContent = '播放';
  }

  function stepReplay(delta) {
    var replay = state.replay;
    if (!replay.open) return;
    replay.index = Math.max(0, Math.min(replay.steps.length - 1, replay.index + delta));
    renderReplayFrame();
  }

  function closeReplay() {
    var replay = state.replay;
    pauseReplay();
    replay.open = false;
    els.replayModal.hidden = true;
    els.replayImg.removeAttribute('src');
  }

  function updatePlayButton() {
    if (!els.playProcessBtn) return;
    var enabled = state.status === 'done' && replaySteps().length > 0;
    els.playProcessBtn.disabled = !enabled;
    els.playProcessBtn.title = enabled ? '按顺序回放生成过程的每一步' : '生成完成后可回放';
  }

  /* ---------------------------------------------------------------- 事件 */
  function bindEvents() {
    bindCadEvents();
    els.startBtn.addEventListener('click', startRun);

    els.runModeToggle.addEventListener('click', function (event) {
      var btn = event.target.closest('.seg-btn');
      if (btn && btn.dataset.runMode) setRunMode(btn.dataset.runMode);
    });
    els.manualNext.addEventListener('click', function () {
      manualRequest('step', '下一步已完成，可检查截图与指标后继续。');
    });
    els.manualApply.addEventListener('click', function () {
      manualRequest('apply', '已按新参数从最早受影响的步骤重跑；确认后可继续下一步。');
    });
    els.manualRerun.addEventListener('click', function () {
      manualRequest('rerun', '已按当前参数重跑本步。');
    });
    els.manualStop.addEventListener('click', manualStop);

    els.resetParams.addEventListener('click', function () {
      state.options = Object.assign({}, state.defaults);
      renderParams(state.schema);
    });

    els.viewToggle.addEventListener('click', function (event) {
      var button = event.target.closest('.seg-btn');
      if (!button) return;
      state.viewMode = button.dataset.view;
      applyView();
    });

    els.opacity.addEventListener('input', function () {
      var value = Number(els.opacity.value);
      state.opacity = value / 100;
      els.opacityVal.textContent = value + '%';
      applyView();
    });

    els.fileInput.addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (file) handleFile(file);
    });

    var stage = els.previewStage;
    ['dragenter', 'dragover'].forEach(function (name) {
      stage.addEventListener(name, function (event) {
        if (state.busy) return;
        event.preventDefault();
        stage.classList.add('is-drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (name) {
      stage.addEventListener(name, function (event) {
        event.preventDefault();
        stage.classList.remove('is-drag');
      });
    });
    stage.addEventListener('drop', function (event) {
      if (state.busy) return;
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    els.lightboxClose.addEventListener('click', closeLightbox);
    els.lightbox.addEventListener('click', function (event) {
      if (event.target === els.lightbox) closeLightbox();
    });
    if (els.playProcessBtn) {
      els.playProcessBtn.addEventListener('click', openReplay);
    }
    if (els.replayClose) {
      els.replayClose.addEventListener('click', closeReplay);
      els.replayPrev.addEventListener('click', function () { stepReplay(-1); });
      els.replayNext.addEventListener('click', function () { stepReplay(1); });
      els.replayPlay.addEventListener('click', function () {
        if (state.replay.playing) pauseReplay(); else playReplay();
      });
      els.replayModal.addEventListener('click', function (event) {
        if (event.target === els.replayModal) closeReplay();
      });
    }
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !els.lightbox.hidden) closeLightbox();
      if (!els.replayModal.hidden) {
        if (event.key === 'Escape') { closeReplay(); return; }
        if (event.key === 'ArrowLeft') { pauseReplay(); stepReplay(-1); return; }
        if (event.key === 'ArrowRight') { pauseReplay(); stepReplay(1); return; }
        if (event.code === 'Space') {
          event.preventDefault();
          if (state.replay.playing) pauseReplay(); else playReplay();
        }
      }
    });

    els.refreshRecognition.addEventListener('click', function () {
      if (!state.runId || state.status !== 'done') return;
      els.refreshRecognition.disabled = true;
      els.refreshRecognition.textContent = '识读中…';
      fetchJSON('/api/recognition/' + encodeURIComponent(state.runId), { method: 'POST' })
        .then(function (data) {
          renderRecognition(data.recognition);
          if (state.result) state.result.recognition = data.recognition;
        })
        .catch(function (err) {
          showError('识读失败：' + (err.message || err));
        })
        .then(function () {
          els.refreshRecognition.textContent = '重新识读';
          els.refreshRecognition.disabled = state.status !== 'done';
        });
    });

    window.addEventListener('resize', fitPreview);
  }

  function handleFile(file) {
    if (state.busy) return;
    if (!/^image\//.test(file.type)) {
      showError('请选择图片文件（PNG / JPG / BMP / TIF）。');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      showError('图片体积 ' + fmtBytes(file.size) + '，超过 64MB 上限，请先压缩。');
      return;
    }
    clearError();
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result);
      var base64 = dataUrl.indexOf(',') >= 0 ? dataUrl.split(',')[1] : '';
      if (!base64) {
        showError('读取图片失败，请换一张试试。');
        return;
      }
      state.upload = { name: file.name, dataUrl: dataUrl, base64: base64 };
      state.currentDemo = null;
      state.previewFromRun = false;
      clearDemoActive();
      els.uploadName.textContent = file.name + ' · ' + fmtBytes(file.size);
      els.uploadName.classList.add('has-file');
      els.sourceNote.textContent = '当前使用本地图片：' + file.name;
      resetRunView();
      setPreview(dataUrl, file.name);
      updateStartButton();
    };
    reader.onerror = function () {
      showError('读取图片失败，请重试。');
    };
    reader.readAsDataURL(file);
  }

  /* ---------------------------------------------------------------- 启动 */
  function init() {
    bindEvents();
    els.opacityVal.textContent = Math.round(state.opacity * 100) + '%';
    els.opacity.value = String(Math.round(state.opacity * 100));
    applyView();
    resetRunView();

    Promise.all([
      fetchJSON('/api/schema'),
      fetchJSON('/api/demos')
    ]).then(function (results) {
      var schema = results[0];
      var demos = results[1];
      state.schema = schema.options || [];
      state.defaults = schema.defaults || {};
      state.options = Object.assign({}, state.defaults);
      renderParams(state.schema);
      if (schema.mock) els.modeBadge.hidden = false;
      renderDemos(demos.demos || []);
      setServerState('ok', '本地服务已连接');
      loadAiModels();
      if (state.demos.length) selectDemo(state.demos[0]);
    }).catch(function (err) {
      setServerState('error', '无法连接本地服务');
      showError('无法连接本地服务：' + (err.message || err) +
        '。请先在工程目录运行 python -m image2cad.server --port 8710，再刷新页面。');
      els.paramPanel.innerHTML = '';
      els.paramPanel.appendChild(hintParagraph('连接服务后才能读取参数定义。'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ------------------------------------------------ AI 制图助手 ----------- */
  function loadAiModels() {
    fetchJSON('/api/ai/models').then(function (data) {
      var models = data.models || [];
      if (!models.length) return;
      els.aiModel.innerHTML = '';
      models.forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = m.name;
        if (m.default) opt.selected = true;
        els.aiModel.appendChild(opt);
      });
    }).catch(function () { /* 无模型可连时保持默认 */ });
  }

  function stateSchemaKeys() {
    var keys = {};
    (state.schema || []).forEach(function (item) { keys[item.key] = true; });
    return keys;
  }

  function runAiTask() {
    var text = els.aiInput.value.trim();
    if (!text) { showError("请输入要做什么（例如：把这张图转成 CAD 并加尺寸标注）。"); return; }
    var model = els.aiModel.value || '';
    els.aiSubmit.disabled = true;
    els.aiSubmit.textContent = '解析中…';
    fetchJSON('/api/ai/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, model: model, options: state.options })
    }).then(function (data) {
      var keys = stateSchemaKeys();
      var changes = data.changes || {};
      Object.keys(changes).forEach(function (key) {
        if (key in keys) setOption(key, changes[key]);
      });
      var hint = data.hint || ("已解析：" + (data.action || "apply"));
      els.runHint.textContent = hint;
      var auto = (data.action === "run" || data.action === "annotate" || data.action === "classify");
      if (auto && hasSource()) {
        startRun();
      } else if (auto) {
        showError("请先选择示例图或上传图纸，再让我生成 CAD。");
      }
      if (data.reply) {
        var hintP = document.createElement('p');
        hintP.className = 'empty-hint';
        hintP.textContent = "AI：" + data.reply;
        els.stepList.insertBefore(hintP, els.stepList.firstChild);
      }
    }).catch(function (err) {
      showError(err.message || "AI 解析失败");
    }).then(function () {
      els.aiSubmit.disabled = false;
      els.aiSubmit.textContent = '执行';
    });
  }

  els.aiSubmit.addEventListener('click', runAiTask);
  els.aiInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') runAiTask();
  });
})();


/* =========================================================================
   模式 A：图框识读（DXF / DWG → 字段 + 标准化块）
   —— 与模式 B 的 IIFE 独立，避免互相污染状态；共用同一套接口与样式。
   ========================================================================= */
(function () {
  'use strict';

  var MAX_TB_BYTES = 32 * 1024 * 1024;
  var modeAInited = false;

  var tb = {
    tabs: document.querySelectorAll('.mode-tab'),
    modeA: document.getElementById('modeA'),
    modeB: document.getElementById('modeB'),
    demoGrid: document.getElementById('tbDemoGrid'),
    demoCount: document.getElementById('tbDemoCount'),
    fileInput: document.getElementById('tbFileInput'),
    fileName: document.getElementById('tbFileName'),
    sourceNote: document.getElementById('tbSourceNote'),
    startBtn: document.getElementById('tbStartBtn'),
    runHint: document.getElementById('tbRunHint'),
    errorBanner: document.getElementById('tbErrorBanner'),
    errorText: document.getElementById('tbErrorText'),
    runStatus: document.getElementById('tbRunStatus'),
    stepList: document.getElementById('tbStepList'),
    stepsEmpty: document.getElementById('tbStepsEmpty'),
    previewToggle: document.getElementById('tbPreviewToggle'),
    previewStage: document.getElementById('tbPreviewStage'),
    previewEmpty: document.getElementById('tbPreviewEmpty'),
    previewImg: document.getElementById('tbPreviewImg'),
    previewMeta: document.getElementById('tbPreviewMeta'),
    statsHint: document.getElementById('tbStatsHint'),
    statsBadges: document.getElementById('tbStatsBadges'),
    fieldTableWrap: document.getElementById('tbFieldTableWrap'),
    fieldsEmpty: document.getElementById('tbFieldsEmpty'),
    unmatchedCard: document.getElementById('tbUnmatchedCard'),
    unmatchedCount: document.getElementById('tbUnmatchedCount'),
    unmatchedBody: document.getElementById('tbUnmatchedBody'),
    dlDxf: document.getElementById('tbDlDxf'),
    dlJson: document.getElementById('tbDlJson'),
    downloadHint: document.getElementById('tbDownloadHint')
  };

  var st = {
    demos: [],
    selection: null,          // {demo: name} 或 {name, base64, size}
    running: false,
    result: null,
    previewView: 'before'
  };

  function jsonFetch(url, options) {
    return fetch(url, options).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) {
          try { data = JSON.parse(text); } catch (err) { data = null; }
        }
        if (!res.ok) {
          var message = (data && (data.error || data.message)) ||
            ('请求失败（HTTP ' + res.status + '）');
          throw new Error(message);
        }
        if (data === null) throw new Error('服务器返回的不是 JSON');
        return data;
      });
    });
  }

  function bytesText(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function hint(text) {
    var p = document.createElement('p');
    p.className = 'empty-hint';
    p.textContent = text;
    return p;
  }

  function showTbError(message) {
    if (!message) return;
    tb.errorText.textContent = message;
    tb.errorBanner.hidden = false;
  }

  function clearTbError() {
    tb.errorBanner.hidden = true;
    tb.errorText.textContent = '';
  }

  function setTbStatus(kind, text) {
    tb.runStatus.textContent = text;
    tb.runStatus.className = 'run-status' + (kind ? ' is-' + kind : '');
  }

  function resetResults() {
    st.result = null;
    tb.stepList.innerHTML = '';
    tb.stepsEmpty.hidden = false;
    tb.statsBadges.innerHTML = '';
    tb.fieldTableWrap.hidden = true;
    tb.fieldTableWrap.innerHTML = '';
    tb.fieldsEmpty.hidden = false;
    tb.unmatchedCard.hidden = true;
    tb.unmatchedBody.innerHTML = '';
    tb.statsHint.textContent = '';
    tb.previewImg.hidden = true;
    tb.previewImg.removeAttribute('src');
    tb.previewEmpty.hidden = false;
    tb.previewMeta.textContent = '预览来自识读引擎；原稿不会被修改。';
    disableDownload(tb.dlDxf);
    disableDownload(tb.dlJson);
    tb.downloadHint.textContent = '识读完成后可下载「标准化 DXF」与「识读 JSON」；原稿不会被修改。';
    setTbStatus('', '未开始');
  }

  function disableDownload(el) {
    if (!el) return;
    el.classList.add('is-disabled');
    el.setAttribute('aria-disabled', 'true');
    el.removeAttribute('href');
    el.removeAttribute('download');
  }

  function enableDownload(el, url, name) {
    if (!el || !url) return;
    el.classList.remove('is-disabled');
    el.setAttribute('aria-disabled', 'false');
    el.href = url;
    el.setAttribute('download', name || '');
  }

  function updateStartButton() {
    tb.startBtn.disabled = st.running || !st.selection;
    if (st.running) {
      tb.runHint.textContent = '正在识读，请稍候…';
    } else if (!st.selection) {
      tb.runHint.textContent = '选择图框后可开始；识读会定位标题栏、配对字段并生成标准化块副本。';
    } else {
      tb.runHint.textContent = '可以开始识读；原稿不会被修改。';
    }
  }

  /* ------------------------------------------------------------ 示例与上传 */
  function renderDemos(demos) {
    tb.demoGrid.innerHTML = '';
    st.demos = demos || [];
    tb.demoCount.textContent = st.demos.length ? st.demos.length + ' 个示例' : '';
    if (!st.demos.length) {
      tb.demoGrid.appendChild(hint('没有找到示例图框（工程内 示例图纸/ 目录为空）。'));
      return;
    }
    st.demos.forEach(function (demo, index) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tb-demo' + (index === 0 ? ' is-active' : '');
      btn.dataset.name = demo.name;
      var title = document.createElement('span');
      title.className = 'tb-demo-name';
      title.textContent = demo.name;
      var sub = document.createElement('span');
      sub.className = 'tb-demo-sub';
      sub.textContent = '示例图框';
      btn.appendChild(title);
      btn.appendChild(sub);
      btn.addEventListener('click', function () { selectDemo(demo, btn); });
      tb.demoGrid.appendChild(btn);
    });
  }

  function selectDemo(demo, btn) {
    if (st.running) return;
    clearTbError();
    resetResults();
    st.selection = { demo: demo.name };
    Array.prototype.forEach.call(tb.demoGrid.querySelectorAll('.tb-demo'), function (item) {
      item.classList.toggle('is-active', item === btn);
    });
    tb.fileName.textContent = demo.name + ' · 示例';
    tb.fileName.classList.add('has-file');
    tb.sourceNote.textContent = '当前使用示例图框：' + demo.name;
    updateStartButton();
  }

  function handleTbFile(file) {
    if (st.running) return;
    var name = String(file.name || '');
    var ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    if (ext !== '.dxf' && ext !== '.dwg') {
      showTbError('只支持 .dxf / .dwg 图纸，请重新选择。');
      return;
    }
    if (file.size > MAX_TB_BYTES) {
      showTbError('图纸体积 ' + bytesText(file.size) + '，超过 32MB 上限，请先精简。');
      return;
    }
    clearTbError();
    resetResults();
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result);
      var base64 = dataUrl.indexOf(',') >= 0 ? dataUrl.split(',')[1] : '';
      if (!base64) {
        showTbError('读取图纸失败，请重试。');
        return;
      }
      st.selection = { name: name, base64: base64, size: file.size };
      Array.prototype.forEach.call(tb.demoGrid.querySelectorAll('.tb-demo'), function (item) {
        item.classList.remove('is-active');
      });
      tb.fileName.textContent = name + ' · ' + bytesText(file.size);
      tb.fileName.classList.add('has-file');
      tb.sourceNote.textContent = '当前使用本地图纸：' + name;
      updateStartButton();
    };
    reader.onerror = function () { showTbError('读取图纸失败，请重试。'); };
    reader.readAsDataURL(file);
  }

  /* ------------------------------------------------------------ 运行与渲染 */
  function startTitleblockRun() {
    if (st.running || !st.selection) return;
    clearTbError();
    resetResults();
    st.running = true;
    updateStartButton();
    setTbStatus('running', '识读中…');
    tb.startBtn.textContent = '识读中…';

    var payload = st.selection.demo
      ? { demo: st.selection.demo }
      : { name: st.selection.name, data_b64: st.selection.base64 };

    jsonFetch('/api/titleblock/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (data) {
      renderResult(data);
      setTbStatus('done', '已完成 · ' + (data.elapsed_s ? data.elapsed_s.toFixed(2) : '0.00') + ' s');
    }).catch(function (err) {
      setTbStatus('error', '识读失败');
      showTbError(err.message || '识读失败');
    }).then(function () {
      st.running = false;
      tb.startBtn.textContent = '开始识读';
      updateStartButton();
    });
  }

  function renderResult(data) {
    st.result = data;
    renderSteps(data.steps || []);
    renderFields(data);
    renderUnmatched(data);
    renderDownloads(data);
    renderPreview(data);
    tb.stepsEmpty.hidden = true;
  }

  function renderSteps(steps) {
    tb.stepList.innerHTML = '';
    if (!steps.length) {
      tb.stepsEmpty.hidden = false;
      return;
    }
    steps.forEach(function (step, index) {
      var li = document.createElement('li');
      li.className = 'tb-step';
      var badge = document.createElement('span');
      badge.className = 'tb-step-index';
      badge.textContent = (index + 1);
      var body = document.createElement('div');
      body.className = 'tb-step-body';
      var title = document.createElement('h3');
      title.className = 'tb-step-title';
      title.textContent = step.title || step.key || '';
      var detail = document.createElement('p');
      detail.className = 'tb-step-detail';
      detail.textContent = step.detail || '';
      var meta = document.createElement('p');
      meta.className = 'tb-step-meta';
      var items = [];
      Object.keys(step.metrics || {}).forEach(function (key) {
        var value = step.metrics[key];
        if (value === null || value === undefined) return;
        items.push(key + '：' + value);
      });
      meta.textContent = items.join(' · ');
      body.appendChild(title);
      body.appendChild(detail);
      if (items.length) body.appendChild(meta);
      li.appendChild(badge);
      li.appendChild(body);
      tb.stepList.appendChild(li);
    });
  }

  function renderFields(data) {
    var pairs = data.pairs || [];
    var stats = data.stats || {};
    var matched = Number(stats.matched_pairs || 0);
    var empty = Number(stats.empty_values || 0);
    var unmatched = Number(stats.unmatched || 0);

    tb.statsHint.textContent = '文字 ' + (stats.text_elements || 0) + ' · 标签 ' + (stats.labels || 0);
    tb.statsBadges.innerHTML = '';
    [
      ['配对', matched, 'ok'],
      ['空值', empty, empty ? 'warn' : ''],
      ['未匹配', unmatched, unmatched ? 'warn' : '']
    ].forEach(function (item) {
      var chip = document.createElement('span');
      chip.className = 'tb-badge' + (item[2] ? ' is-' + item[2] : '');
      chip.textContent = item[0] + ' ' + item[1];
      tb.statsBadges.appendChild(chip);
    });

    tb.fieldTableWrap.innerHTML = '';
    if (!pairs.length) {
      tb.fieldTableWrap.hidden = true;
      tb.fieldsEmpty.hidden = false;
      return;
    }
    tb.fieldsEmpty.hidden = true;
    tb.fieldTableWrap.hidden = false;
    var table = document.createElement('table');
    table.className = 'tb-table';
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['字段', '值', '置信度'].forEach(function (text) {
      var th = document.createElement('th');
      th.textContent = text;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    pairs.forEach(function (pair) {
      var tr = document.createElement('tr');
      if (pair.unmatched_label || pair.unmatched_value) tr.className = 'is-unmatched';
      var tdLabel = document.createElement('td');
      tdLabel.textContent = pair.label || '（未命名）';
      var tdValue = document.createElement('td');
      tdValue.textContent = pair.value || '（空值）';
      if (!pair.value) tdValue.className = 'is-empty';
      var tdConf = document.createElement('td');
      tdConf.className = 'tb-conf';
      var conf = Number(pair.confidence);
      if (isFinite(conf) && conf > 0) {
        tdConf.textContent = Math.round(conf * 100) + '%';
      } else {
        tdConf.textContent = '—';
      }
      tr.appendChild(tdLabel);
      tr.appendChild(tdValue);
      tr.appendChild(tdConf);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tb.fieldTableWrap.appendChild(table);
  }

  function renderUnmatched(data) {
    var items = data.unmatched || [];
    tb.unmatchedBody.innerHTML = '';
    if (!items.length) {
      tb.unmatchedCard.hidden = true;
      return;
    }
    tb.unmatchedCard.hidden = false;
    tb.unmatchedCount.textContent = items.length + ' 项';
    var list = document.createElement('ul');
    list.className = 'tb-unmatched-list';
    items.slice(0, 40).forEach(function (item) {
      var li = document.createElement('li');
      var label = item.label || '（未命名）';
      var value = item.value || '（空值）';
      li.textContent = label + ' → ' + value;
      list.appendChild(li);
    });
    tb.unmatchedBody.appendChild(list);
  }

  function renderPreview(data) {
    var urls = data.urls || {};
    var before = urls.preview_before || '';
    var after = urls.preview_after || '';
    st.previewUrls = { before: before, after: after };
    if (!before && !after) {
      tb.previewImg.hidden = true;
      tb.previewEmpty.hidden = false;
      tb.previewMeta.textContent = '该图纸未能生成预览（DWG 需识读后转换，或文件不可读）。';
      return;
    }
    if (before) st.previewView = 'before';
    else st.previewView = 'after';
    applyPreview();
    tb.previewMeta.textContent = '橙色框为标题栏区域；原稿未被修改。';
  }

  function applyPreview() {
    var urls = st.previewUrls || {};
    var url = st.previewView === 'after' ? urls.after : urls.before;
    if (!url) {
      tb.previewImg.hidden = true;
      tb.previewEmpty.hidden = false;
      return;
    }
    tb.previewEmpty.hidden = true;
    tb.previewImg.hidden = false;
    tb.previewImg.src = url;
    Array.prototype.forEach.call(tb.previewToggle.querySelectorAll('.seg-btn'), function (btn) {
      btn.classList.toggle('is-active', btn.dataset.tbView === st.previewView);
    });
  }

  function renderDownloads(data) {
    var urls = data.urls || {};
    var files = data.files || {};
    if (urls.recognized) {
      enableDownload(tb.dlDxf, urls.recognized, files.recognized || 'recognized.dxf');
    }
    if (urls.json) {
      enableDownload(tb.dlJson, urls.json, files.json || 'result.json');
    }
    tb.downloadHint.textContent = urls.recognized
      ? '标准化副本已生成；原始图纸保持不变。'
      : '本次没有生成标准化副本（详见上方步骤）。';
  }

  /* ------------------------------------------------------------ 模式切换 */
  function switchMode(mode) {
    var showA = mode === 'a';
    tb.modeA.hidden = !showA;
    tb.modeB.hidden = showA;
    Array.prototype.forEach.call(tb.tabs, function (btn) {
      var active = btn.dataset.mode === mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    try { localStorage.setItem('i2c.mode', mode); } catch (err) { }
    if (showA && !modeAInited) {
      modeAInited = true;
      loadTbDemos();
    }
  }

  function loadTbDemos() {
    jsonFetch('/api/titleblock/demos').then(function (data) {
      renderDemos(data.demos || []);
      if ((data.demos || []).length) {
        var first = tb.demoGrid.querySelector('.tb-demo');
        if (first) first.click();
      }
    }).catch(function (err) {
      tb.demoGrid.innerHTML = '';
      tb.demoGrid.appendChild(hint('无法读取示例图框：' + (err.message || err)));
    });
  }

  function bindModeA() {
    Array.prototype.forEach.call(tb.tabs, function (btn) {
      btn.addEventListener('click', function () { switchMode(btn.dataset.mode); });
    });
    tb.startBtn.addEventListener('click', startTitleblockRun);
    tb.fileInput.addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (file) handleTbFile(file);
      event.target.value = '';
    });
    tb.previewToggle.addEventListener('click', function (event) {
      var btn = event.target.closest('.seg-btn');
      if (!btn) return;
      st.previewView = btn.dataset.tbView;
      applyPreview();
    });
    tb.previewStage.addEventListener('dragover', function (event) {
      if (st.running) return;
      event.preventDefault();
      tb.previewStage.classList.add('is-drag');
    });
    tb.previewStage.addEventListener('dragleave', function () {
      tb.previewStage.classList.remove('is-drag');
    });
    tb.previewStage.addEventListener('drop', function (event) {
      event.preventDefault();
      tb.previewStage.classList.remove('is-drag');
      if (st.running) return;
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) handleTbFile(file);
    });
  }

  function initModeA() {
    bindModeA();
    var saved = null;
    try { saved = localStorage.getItem('i2c.mode'); } catch (err) { }
    switchMode(saved === 'a' ? 'a' : 'b');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initModeA);
  } else {
    initModeA();
  }

  /* ==== AI_CHAT_DRAWER_v22_STREAM : 流式对话 + 解释识图结果 ==== */
  (function initAiChatStream() {
    var fab = document.getElementById('aiFab');
    var box = document.getElementById('aiChat');
    var log = document.getElementById('aiChatLog');
    var input = document.getElementById('aiChatInput');
    var send = document.getElementById('aiChatSend');
    var sel = document.getElementById('aiChatModel');
    var status = document.getElementById('aiChatStatus');
    var closeBtn = document.getElementById('aiChatClose');
    if (!fab || !box || !log || !input || !send || !sel) return;
    if (fab.getAttribute('data-stream') === '1') return;
    fab.setAttribute('data-stream', '1');

    var style = document.createElement('style');
    style.textContent = [
      '.ai-chat-explain{flex:0 0 auto;padding:0 12px;border-radius:9px;border:1px solid rgba(120,140,255,.40);',
      'background:rgba(120,140,255,.14);color:#c3cdf0;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}',
      '.ai-chat-explain:hover{background:rgba(120,140,255,.24)}',
      '.ai-chat-explain:disabled{opacity:.5;cursor:default}'
    ].join('');
    document.head.appendChild(style);

    var explain = document.createElement('button');
    explain.type = 'button';
    explain.id = 'aiChatExplain';
    explain.className = 'ai-chat-explain';
    explain.textContent = '解释识图结果';
    var compose = send.parentNode;
    compose.insertBefore(explain, send);

    function push(role, text) {
      var d = document.createElement('div');
      d.className = 'ai-msg ai-msg-' + role;
      d.textContent = text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
      return d;
    }
    function setStatus(t) { if (status) status.textContent = t || ''; }
    function openBox() {
      box.hidden = false; box.style.display = 'flex';
      fab.style.display = 'none';
      setTimeout(function () { input.focus(); }, 30);
    }
    function closeBox() {
      box.hidden = true; box.style.display = 'none';
      fab.style.display = 'inline-flex';
    }
    fab.addEventListener('click', openBox);
    if (closeBtn) closeBtn.addEventListener('click', closeBox);

    function loadModels() {
      fetch('/api/ai/models', { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var models = (data && data.models) || [];
          sel.innerHTML = '';
          if (!models.length) {
            var o0 = document.createElement('option');
            o0.value = ''; o0.textContent = '（无可用模型）';
            sel.appendChild(o0);
            push('sys', '还没有可用模型。请在 ai_config.json（exe 同目录）里填写 key，然后重启应用。');
            return;
          }
          models.forEach(function (m) {
            var o = document.createElement('option');
            o.value = m.name;
            o.textContent = m.name;
            if (m.default) o.selected = true;
            sel.appendChild(o);
          });
          push('sys', '已连接 ' + models.length + ' 个模型（流式对话）。当前：' + sel.value);
        })
        .catch(function () { push('err', '读取模型列表失败：本地服务可能未就绪。'); });
    }

    // ---- 流式请求 ----
    function streamChat(messages, bubble) {
      var body = JSON.stringify({ messages: messages, model: sel.value || null });
      return fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body
      }).then(function (resp) {
        if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
        var reader = resp.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var buffer = '';
        var text = '';
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) return text;
            buffer += decoder.decode(res.value, { stream: true });
            var parts = buffer.split('\n\n');
            buffer = parts.pop();
            for (var i = 0; i < parts.length; i++) {
              var line = parts[i].trim();
              if (line.indexOf('data:') !== 0) continue;
              var payload = line.slice(5).trim();
              if (!payload) continue;
              var obj = null;
              try { obj = JSON.parse(payload); } catch (e) { continue; }
              if (obj.error) throw new Error(obj.error);
              if (obj.delta) {
                text += obj.delta;
                bubble.textContent = text;
                log.scrollTop = log.scrollHeight;
              }
            }
            return pump();
          });
        }
        return pump();
      });
    }

    function doSend() {
      var text = (input.value || '').trim();
      if (!text) { input.focus(); return; }
      push('user', text);
      input.value = '';
      var bubble = push('ai', '');
      bubble.textContent = '…';
      send.disabled = true; explain.disabled = true;
      setStatus('流式接收中…');
      streamChat([{ role: 'user', content: text }], bubble)
        .then(function (full) {
          if (!full) bubble.textContent = '（空回复）';
          setStatus('完成 · ' + (full || '').length + ' 字');
        })
        .catch(function (e) {
          bubble.className = 'ai-msg ai-msg-err';
          bubble.textContent = '请求失败：' + (e && e.message ? e.message : e);
          setStatus('');
        })
        .then(function () { send.disabled = false; explain.disabled = false; });
    }

    // ---- 解释识图结果 ----
    function collectStats() {
      function g(id) { var el = document.getElementById(id); return el ? (el.textContent || '').trim() : ''; }
      var steps = [];
      try {
        var nodes = document.querySelectorAll('#stepList .step-title, #stepList li, #stepList .step-name');
        for (var i = 0; i < nodes.length && steps.length < 12; i++) {
          var t = (nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
          if (t) steps.push(t);
        }
      } catch (e) {}
      var active = document.querySelector('.mode-tab.is-active');
      return {
        mode: active ? (active.textContent || '').trim() : '',
        segments: g('statSegments'), circles: g('statCircles'),
        rects: g('statRects'), texts: g('statTexts'),
        f1: g('statF1'), elapsed: g('statElapsed'),
        steps: steps
      };
    }

    function doExplain() {
      var s = collectStats();
      var lines = [];
      lines.push('工作模式：' + (s.mode || '未知'));
      lines.push('线段=' + (s.segments || '—') + '，圆=' + (s.circles || '—') +
                 '，矩形=' + (s.rects || '—') + '，文字区=' + (s.texts || '—'));
      lines.push('F1 自检=' + (s.f1 || '—') + '，总耗时=' + (s.elapsed || '—'));
      if (s.steps.length) lines.push('处理步骤：' + s.steps.join(' / '));
      if ((s.segments || '—') === '—') {
        push('sys', '还没有识图结果，请先点「开始生成 / 开始识读」跑一次。');
        return;
      }
      push('user', '解释这次识图结果');
      var bubble = push('ai', '');
      bubble.textContent = '…';
      send.disabled = true; explain.disabled = true;
      setStatus('流式接收中…');
      var messages = [
        { role: 'system', content: '你是 CAD 识图（栅格图矢量化）专家。请用中文简洁解释本次识图结果：'
            + '先给一句总体判断，再说明质量与可能的问题，最后给 1-2 条可操作的参数调整建议。'
            + '不要复述原始数字清单，控制在 220 字以内。' },
        { role: 'user', content: '本次识图统计如下：\n' + lines.join('\n') }
      ];
      streamChat(messages, bubble)
        .then(function (full) { setStatus('完成 · ' + (full || '').length + ' 字'); })
        .catch(function (e) {
          bubble.className = 'ai-msg ai-msg-err';
          bubble.textContent = '请求失败：' + (e && e.message ? e.message : e);
          setStatus('');
        })
        .then(function () { send.disabled = false; explain.disabled = false; });
    }

    send.addEventListener('click', doSend);
    explain.addEventListener('click', doExplain);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); doSend(); }
    });

    loadModels();
  })();

})();
