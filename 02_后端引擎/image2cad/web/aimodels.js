/* =========================================================================
   AI 模型管理（「AI 设置」弹窗）  —— 原生 JS，零依赖、零构建
   -------------------------------------------------------------------------
   目标：用户能在界面里自己导入 / 新增 / 测试 / 切换大模型，不再手改 ai_config.json。

   用到的接口：
     GET  /api/ai/models        脱敏模型列表（只回 hasKey / 尾 4 位，明文 Key 不出服务端）
     POST /api/ai/models/save   {models:[...], default} → 校验后写入配置文件，保存即生效
     POST /api/ai/models/test   {base, key?, model} → {ok, latencyMs, error?, errorType?}（不落盘）

   安全约定：本文件**永远拿不到明文 Key**。
     * 列表里只显示服务端给的 keyMasked（如 sk-…abcd）；
     * 编辑已有模型时 Key 输入框留空 = 沿用服务端已保存的 Key（提交里不带 key）；
     * 「测试连接」留空 Key 时，由服务端用同地址模型已保存的 Key 去测。
   ========================================================================= */
(function () {
  'use strict';

  var MODAL_ID = 'aiModelModal';
  var els = null;           // 弹窗内元素缓存（首次打开时建好）

  var state = {
    models: [],             // 服务端当前模型（脱敏）
    draft: [],              // 待保存草稿：{name, base, model, key?, hasKey, keyMasked}
    defaultName: '',
    editing: null,          // 正在编辑的模型名；null = 新增
    configPath: '',
    busy: false
  };

  /* ---------------------------------------------------------------- 工具 */
  function requestJSON(url, options) {
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
        if (data === null) throw new Error('服务端返回的不是 JSON');
        return data;
      });
    });
  }

  function setText(node, text) { if (node) node.textContent = text == null ? '' : String(text); }

  function setStatus(text, isError) {
    if (!els || !els.status) return;
    els.status.textContent = text || '';
    els.status.classList.toggle('is-err', !!isError);
  }

  function setTestResult(text, isError) {
    if (!els || !els.testResult) return;
    els.testResult.textContent = text || '';
    els.testResult.classList.toggle('is-err', !!isError);
    els.testResult.classList.toggle('is-ok', !isError && !!text);
  }

  function setImportResult(text, isError) {
    if (!els || !els.importResult) return;
    els.importResult.textContent = text || '';
    els.importResult.classList.toggle('is-err', !!isError);
    els.importResult.classList.toggle('is-ok', !isError && !!text);
  }

  /* ------------------------------------------------------------ 弹窗骨架 */
  function ensureModal() {
    if (els) return els;
    var existing = document.getElementById(MODAL_ID);
    if (existing) existing.parentNode.removeChild(existing);   // 老版本热重载时重建

    var mask = document.createElement('div');
    mask.id = MODAL_ID;
    mask.className = 'aim-mask';
    mask.hidden = true;
    mask.innerHTML =
      '<div class="aim-card" role="dialog" aria-modal="true" aria-labelledby="aimTitle">' +
        '<div class="aim-head">' +
          '<b id="aimTitle">AI 模型管理</b>' +
          '<span class="aim-path" id="aimPath" title="Key 只保存在本机这个文件里">配置文件：—</span>' +
          '<button type="button" class="aim-x" id="aimClose" aria-label="关闭">&times;</button>' +
        '</div>' +
        '<div class="aim-body">' +
          '<div class="aim-sec-head">' +
            '<span>当前模型 <em id="aimCount">0</em></span>' +
            '<span class="aim-sec-acts">' +
              '<button type="button" class="aim-btn" id="aimReload" title="重新从配置文件读取">重新载入</button>' +
            '</span>' +
          '</div>' +
          '<div class="aim-table-wrap">' +
            '<table class="aim-table">' +
              '<thead><tr>' +
                '<th>名称</th><th>Base URL</th><th>模型名</th><th>Key</th><th>默认</th><th>操作</th>' +
              '</tr></thead>' +
              '<tbody id="aimRows"></tbody>' +
            '</table>' +
            '<p class="aim-empty" id="aimEmpty" hidden>还没有模型，先在下面新增一个。</p>' +
          '</div>' +

          '<div class="aim-block">' +
            '<div class="aim-sec-head"><span id="aimFormTitle">新增模型</span></div>' +
            '<div class="aim-grid">' +
              '<label class="aim-field"><span>名称</span>' +
                '<input id="aimName" type="text" placeholder="DeepSeek" autocomplete="off"></label>' +
              '<label class="aim-field"><span>Base URL</span>' +
                '<input id="aimBase" type="text" placeholder="https://api.deepseek.com" autocomplete="off"></label>' +
              '<label class="aim-field"><span>模型名</span>' +
                '<input id="aimModel" type="text" placeholder="deepseek-chat" autocomplete="off"></label>' +
              '<label class="aim-field"><span>API Key</span>' +
                '<input id="aimKey" type="password" placeholder="留空 = 不修改已保存的 Key" autocomplete="off"></label>' +
            '</div>' +
            '<div class="aim-form-foot">' +
              '<button type="button" class="aim-btn" id="aimTest">测试连接</button>' +
              '<button type="button" class="aim-btn primary" id="aimSaveOne">保存模型</button>' +
              '<button type="button" class="aim-btn" id="aimCancelEdit" hidden>取消编辑</button>' +
              '<span class="aim-msg" id="aimTestResult"></span>' +
            '</div>' +
            '<p class="aim-hint">Base URL 填域名即可，路径里没有版本段时会自动补 /v1；' +
              'Key 只写在本机服务端，列表里只显示尾 4 位。</p>' +
          '</div>' +

          '<div class="aim-block">' +
            '<div class="aim-sec-head"><span>导入配置</span></div>' +
            '<label class="aim-drop" id="aimDrop">' +
              '<input type="file" id="aimFile" accept=".json,application/json" hidden>' +
              '<span class="aim-drop-main">把 ai_config.json 拖到这里，或 <b>点击选择文件</b></span>' +
              '<span class="aim-drop-sub">形如 {&quot;models&quot;:[...],&quot;default&quot;:&quot;...&quot;}；' +
                '同名模型会被覆盖，文件里没写 Key 的沿用原 Key。</span>' +
            '</label>' +
            '<span class="aim-msg" id="aimImportResult"></span>' +
          '</div>' +
        '</div>' +
        '<div class="aim-foot">' +
          '<span class="aim-status" id="aimStatus">修改会立即写入配置文件并生效，无需重启服务。</span>' +
          '<button type="button" class="aim-btn primary" id="aimDone">完成</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(mask);

    els = {
      mask: mask,
      path: mask.querySelector('#aimPath'),
      count: mask.querySelector('#aimCount'),
      rows: mask.querySelector('#aimRows'),
      empty: mask.querySelector('#aimEmpty'),
      reload: mask.querySelector('#aimReload'),
      formTitle: mask.querySelector('#aimFormTitle'),
      name: mask.querySelector('#aimName'),
      base: mask.querySelector('#aimBase'),
      model: mask.querySelector('#aimModel'),
      key: mask.querySelector('#aimKey'),
      test: mask.querySelector('#aimTest'),
      saveOne: mask.querySelector('#aimSaveOne'),
      cancelEdit: mask.querySelector('#aimCancelEdit'),
      testResult: mask.querySelector('#aimTestResult'),
      drop: mask.querySelector('#aimDrop'),
      file: mask.querySelector('#aimFile'),
      importResult: mask.querySelector('#aimImportResult'),
      status: mask.querySelector('#aimStatus'),
      done: mask.querySelector('#aimDone'),
      close: mask.querySelector('#aimClose')
    };
    wireModal(els);
    return els;
  }

  /* ------------------------------------------------------------- 数据同步 */
  function syncDraft() {
    state.draft = state.models.map(function (m) {
      return {
        name: m.name,
        base: m.base,
        model: m.model,
        hasKey: !!m.hasKey,
        keyMasked: m.keyMasked || '',
        key: ''                       // 明文 Key 前端不持有；留空 = 沿用
      };
    });
    if (state.editing && !findRow(state.editing)) state.editing = null;
  }

  function findRow(name) {
    for (var i = 0; i < state.draft.length; i++) {
      if (state.draft[i].name === name) return state.draft[i];
    }
    return null;
  }

  function applyModels(models, configPath, followDefault) {
    state.models = (models || []).slice();
    if (configPath) state.configPath = configPath;
    syncDraft();
    var def = null;
    for (var i = 0; i < state.models.length; i++) {
      if (state.models[i].isDefault) { def = state.models[i].name; break; }
    }
    state.defaultName = def || (state.models[0] ? state.models[0].name : '');
    renderAll();
    renderSelects(!!followDefault);
  }

  function renderAll() {
    renderPath();
    renderRows();
    renderFormState();
  }

  function renderPath() {
    setText(els.path, state.configPath ? ('配置文件：' + state.configPath) : '配置文件：—');
    els.path.title = state.configPath || '';
  }

  function keyLabel(row) {
    if (row.key) return { text: '新 Key（待保存）', cls: 'is-new' };
    if (row.hasKey) return { text: row.keyMasked || '已配置（尾 4 位不可见）', cls: 'is-ok' };
    return { text: '未配置', cls: 'is-missing' };
  }

  function makeBtn(label, act, name, cls) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'aim-row-btn' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.setAttribute('data-act', act);
    b.setAttribute('data-name', name);
    return b;
  }

  function renderRows() {
    if (!els || !els.rows) return;
    els.rows.innerHTML = '';
    els.empty.hidden = state.draft.length > 0;
    setText(els.count, state.draft.length);

    state.draft.forEach(function (row) {
      var tr = document.createElement('tr');
      if (row.name === state.defaultName) tr.className = 'is-default';
      if (row.name === state.editing) tr.className += ' is-editing';

      var tdName = document.createElement('td');
      var b = document.createElement('b');
      b.textContent = row.name;
      tdName.appendChild(b);
      if (row.name === state.editing) {
        var tag = document.createElement('span');
        tag.className = 'aim-tag';
        tag.textContent = '编辑中';
        tdName.appendChild(tag);
      }
      tr.appendChild(tdName);

      var tdBase = document.createElement('td');
      tdBase.className = 'aim-mono aim-ellipsis';
      tdBase.textContent = row.base || '—';
      tdBase.title = row.base || '';
      tr.appendChild(tdBase);

      var tdModel = document.createElement('td');
      tdModel.className = 'aim-mono aim-ellipsis';
      tdModel.textContent = row.model || '—';
      tdModel.title = row.model || '';
      tr.appendChild(tdModel);

      var tdKey = document.createElement('td');
      var label = keyLabel(row);
      var span = document.createElement('span');
      span.className = 'aim-key ' + label.cls;
      span.textContent = label.text;
      if (row.keyMasked) span.title = '只显示尾 4 位';
      tdKey.appendChild(span);
      tr.appendChild(tdKey);

      var tdDef = document.createElement('td');
      if (row.name === state.defaultName) {
        var badge = document.createElement('span');
        badge.className = 'aim-badge';
        badge.textContent = '默认';
        tdDef.appendChild(badge);
      } else {
        tdDef.className = 'aim-dim';
        tdDef.textContent = '—';
      }
      tr.appendChild(tdDef);

      var tdActs = document.createElement('td');
      tdActs.className = 'aim-acts';
      if (row.name !== state.defaultName) tdActs.appendChild(makeBtn('设为默认', 'default', row.name));
      tdActs.appendChild(makeBtn('测试', 'test', row.name));
      tdActs.appendChild(makeBtn('编辑', 'edit', row.name));
      tdActs.appendChild(makeBtn('删除', 'del', row.name, 'is-danger'));
      tr.appendChild(tdActs);

      els.rows.appendChild(tr);
    });
  }

  function renderFormState() {
    var editing = state.editing ? findRow(state.editing) : null;
    setText(els.formTitle, editing ? ('编辑模型：' + editing.name) : '新增模型');
    els.cancelEdit.hidden = !editing;
    els.key.placeholder = (editing && editing.hasKey)
      ? ('已配置 ' + (editing.keyMasked || 'Key') + '，留空表示不修改')
      : '留空 = 不修改已保存的 Key';
  }

  /* 让顶部 AI 模型下拉框立即跟上（不用刷新页面）。
     followDefault=true：保存类操作后切到当前默认模型（这就是「生效」的样子）；
     false：只是重新载入，保留用户手动选过的模型。 */
  function renderSelects(followDefault) {
    var selects = document.querySelectorAll('#aiModel, #aiChatModel');
    for (var s = 0; s < selects.length; s++) {
      var sel = selects[s];
      if (!sel || sel.tagName !== 'SELECT') continue;
      var prev = sel.value;
      sel.innerHTML = '';
      state.models.forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = m.name;
        sel.appendChild(opt);
      });
      if (!state.models.length) {
        var none = document.createElement('option');
        none.value = '';
        none.textContent = '（无可用模型）';
        sel.appendChild(none);
      } else if (followDefault) {
        sel.value = state.defaultName || state.models[0].name;
      } else {
        sel.value = prev;
        if (sel.value !== prev) sel.value = state.defaultName || state.models[0].name;
      }
    }
  }

  /* --------------------------------------------------------------- 读取/保存 */
  function load() {
    setStatus('正在读取模型列表…');
    return requestJSON('/api/ai/models', { headers: { 'Accept': 'application/json' } })
      .then(function (data) {
        applyModels(data.models || [], data.configPath || '', false);
        setStatus(state.models.length
          ? ('已载入 ' + state.models.length + ' 个模型' + (data.aiMock ? '（联调模式）' : ''))
          : '还没有模型，先新增一个吧。');
      })
      .catch(function (err) {
        setStatus('读取模型列表失败：' + (err && err.message ? err.message : err), true);
      });
  }

  function payloadModels() {
    return state.draft.map(function (row) {
      var item = { name: row.name, base: row.base, model: row.model };
      if (row.key) item.key = row.key;          // 只有用户新输入的 Key 才回传
      return item;
    });
  }

  function commit(okMessage) {
    if (state.busy) return Promise.resolve(null);
    if (!state.draft.length) {
      setStatus('至少要保留一个模型。', true);
      return Promise.resolve(null);
    }
    state.busy = true;
    setStatus('正在保存…');
    els.saveOne.disabled = true;
    return requestJSON('/api/ai/models/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: payloadModels(), default: state.defaultName })
    }).then(function (data) {
      applyModels(data.models || [], data.configPath || '', true);
      setStatus(okMessage || ('已保存 ' + data.count + ' 个模型，已立即生效'));
      return data;
    }).catch(function (err) {
      // 保存失败时把界面拉回「文件里真实的样子」，避免看到假成功
      setStatus('保存失败：' + (err && err.message ? err.message : err), true);
      load();
      return null;
    }).then(function (data) {
      state.busy = false;
      els.saveOne.disabled = false;
      return data;
    });
  }

  /* --------------------------------------------------------------- 表单动作 */
  function readForm() {
    return {
      name: (els.name.value || '').trim(),
      base: (els.base.value || '').trim(),
      model: (els.model.value || '').trim(),
      key: els.key.value || ''
    };
  }

  function resetForm() {
    state.editing = null;
    els.name.value = '';
    els.base.value = '';
    els.model.value = '';
    els.key.value = '';
    els.name.disabled = false;
    setTestResult('');
    renderFormState();
  }

  function fillForm(row) {
    state.editing = row.name;
    els.name.value = row.name;
    els.base.value = row.base || '';
    els.model.value = row.model || '';
    els.key.value = '';
    setTestResult('');
    renderFormState();
    renderRows();
    els.base.focus();
  }

  function saveOne() {
    var form = readForm();
    if (!form.name) { setTestResult('请填写名称（如 DeepSeek）。', true); els.name.focus(); return; }
    if (!form.base) { setTestResult('请填写 Base URL（如 https://api.deepseek.com）。', true); els.base.focus(); return; }
    if (!form.model) { setTestResult('请填写模型名（如 deepseek-chat）。', true); els.model.focus(); return; }

    var row = {
      name: form.name,
      base: form.base,
      model: form.model,
      key: form.key,
      hasKey: !!(form.key || (state.editing && findRow(state.editing) && findRow(state.editing).hasKey)),
      keyMasked: form.key ? '' : (state.editing && findRow(state.editing) ? findRow(state.editing).keyMasked : '')
    };

    var existing = findRow(form.name);
    if (state.editing && state.editing !== form.name) {
      // 改名：先摘掉旧条目，再按新名字覆盖/追加
      state.draft = state.draft.filter(function (item) { return item.name !== state.editing; });
      existing = findRow(form.name);
      if (state.defaultName === state.editing) state.defaultName = form.name;
    }
    if (existing) {
      existing.base = row.base;
      existing.model = row.model;
      if (row.key) { existing.key = row.key; existing.hasKey = true; }
      existing.keyMasked = row.key ? '' : (row.keyMasked || existing.keyMasked || '');
    } else {
      state.draft.push(row);
      if (!state.defaultName) state.defaultName = row.name;
    }
    state.editing = null;
    renderAll();
    commit('已保存：' + form.name).then(function (data) {
      if (data) { resetForm(); setTestResult('已保存并生效。', false); }
    });
  }

  function doTestFromForm() {
    var form = readForm();
    if (!form.base) { setTestResult('请先填写 Base URL。', true); els.base.focus(); return; }
    if (!form.model) { setTestResult('请先填写模型名。', true); els.model.focus(); return; }
    runTest({ base: form.base, key: form.key, model: form.model }, els.testResult);
  }

  function runTest(body, target) {
    var btn = els.test;
    btn.disabled = true;
    if (target) { target.textContent = '测试中…'; target.className = 'aim-msg'; }
    requestJSON('/api/ai/models/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      var text;
      if (r.ok) {
        text = '连接成功 · 延迟 ' + (r.latencyMs || 0) + ' ms' +
          (r.mock ? '（联调模式，未真实请求）' : '');
        if (target) { target.textContent = text; target.className = 'aim-msg is-ok'; }
        else setStatus(text);
      } else {
        text = '连接失败 · ' + (r.error || '未知错误') +
          (r.latencyMs ? '（耗时 ' + r.latencyMs + ' ms）' : '');
        if (target) { target.textContent = text; target.className = 'aim-msg is-err'; }
        else setStatus(text, true);
      }
    }).catch(function (err) {
      var text = '测试请求失败：' + (err && err.message ? err.message : err);
      if (target) { target.textContent = text; target.className = 'aim-msg is-err'; }
      else setStatus(text, true);
    }).then(function () {
      btn.disabled = false;
    });
  }

  /* --------------------------------------------------------------- 行内操作 */
  function setDefault(name) {
    if (!findRow(name)) return;
    state.defaultName = name;
    renderAll();
    commit('已把「' + name + '」设为默认模型');
  }

  function removeModel(name) {
    if (!findRow(name)) return;
    var ok = window.confirm('确定删除模型「' + name + '」？删除后需要重新填写它的 Key。');
    if (!ok) return;
    if (state.editing === name) resetForm();
    state.draft = state.draft.filter(function (row) { return row.name !== name; });
    if (state.defaultName === name) state.defaultName = state.draft[0] ? state.draft[0].name : '';
    renderAll();
    commit('已删除「' + name + '」');
  }

  /* --------------------------------------------------------------- 导入配置 */
  function mergeImported(data) {
    if (!data || typeof data !== 'object') throw new Error('文件内容不是 JSON 对象');
    var incoming = data.models;
    if (!Array.isArray(incoming) || !incoming.length) {
      throw new Error('文件里没有 models 数组（形如 {"models":[...],"default":"..."}）');
    }
    var byName = {};
    var order = [];
    state.draft.forEach(function (row) { byName[row.name] = row; order.push(row.name); });

    var added = 0, updated = 0, skipped = 0;
    incoming.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') { skipped += 1; return; }
      var name = String(raw.name || '').trim();
      var base = String(raw.base || '').trim();
      var model = String(raw.model || name).trim();
      if (!name || !base || !model) { skipped += 1; return; }
      var key = typeof raw.key === 'string' ? raw.key.trim() : '';
      var prev = byName[name];
      var node = {
        name: name,
        base: base,
        model: model,
        key: key || (prev ? prev.key : ''),
        hasKey: !!(key || (prev && prev.hasKey)),
        keyMasked: key ? '' : (prev ? prev.keyMasked : '')
      };
      if (!prev) { order.push(name); added += 1; } else { updated += 1; }
      byName[name] = node;
    });
    state.draft = order.map(function (n) { return byName[n]; });

    var def = String((data && data.default) || '').trim();
    if (def && byName[def]) state.defaultName = def;
    if (!findRow(state.defaultName)) state.defaultName = state.draft[0] ? state.draft[0].name : '';
    return { added: added, updated: updated, skipped: skipped };
  }

  function importFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data = null;
      try {
        data = JSON.parse(String(reader.result || ''));
      } catch (err) {
        setImportResult('不是合法 JSON：' + (err && err.message ? err.message : err), true);
        return;
      }
      var stat = null;
      try {
        stat = mergeImported(data);
      } catch (err) {
        setImportResult(err && err.message ? err.message : String(err), true);
        return;
      }
      renderAll();
      commit('已导入：新增 ' + stat.added + ' 个、覆盖 ' + stat.updated +
        ' 个' + (stat.skipped ? '、跳过 ' + stat.skipped + ' 条不完整记录' : '') + '，已生效')
        .then(function (result) {
          if (result) {
            setImportResult('导入成功：新增 ' + stat.added + ' 个、覆盖 ' + stat.updated + ' 个。', false);
          }
        });
    };
    reader.onerror = function () { setImportResult('读取文件失败，请重试。', true); };
    reader.readAsText(file, 'utf-8');
  }

  /* --------------------------------------------------------------- 事件绑定 */
  function wireModal(m) {
    m.close.addEventListener('click', close);
    m.done.addEventListener('click', close);
    m.reload.addEventListener('click', function () { resetForm(); load(); });
    m.saveOne.addEventListener('click', saveOne);
    m.test.addEventListener('click', doTestFromForm);
    m.cancelEdit.addEventListener('click', function () { resetForm(); renderRows(); });

    // 点遮罩空白处关闭（点卡片内部不关）
    m.mask.addEventListener('click', function (e) {
      if (e.target === m.mask) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !m.mask.hidden) close();
    });

    // 行内按钮：事件委托，避免每行重复绑定
    m.rows.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      var name = btn.getAttribute('data-name');
      var act = btn.getAttribute('data-act');
      if (act === 'default') setDefault(name);
      else if (act === 'edit') { var row = findRow(name); if (row) fillForm(row); }
      else if (act === 'del') removeModel(name);
      else if (act === 'test') {
        var rowTest = findRow(name);
        if (rowTest) runTest({ base: rowTest.base, model: rowTest.model }, els.status);
      }
    });

    // 表单回车 = 保存
    [m.name, m.base, m.model, m.key].forEach(function (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); saveOne(); }
      });
    });

    // 导入：文件选择 + 拖拽
    m.file.addEventListener('change', function () {
      var file = m.file.files && m.file.files[0];
      if (file) importFile(file);
      m.file.value = '';              // 允许重复导入同一个文件
    });
    ['dragenter', 'dragover'].forEach(function (type) {
      m.drop.addEventListener(type, function (e) {
        e.preventDefault();
        e.stopPropagation();
        m.drop.classList.add('is-over');
      });
    });
    ['dragleave', 'dragend'].forEach(function (type) {
      m.drop.addEventListener(type, function (e) {
        e.preventDefault();
        m.drop.classList.remove('is-over');
      });
    });
    m.drop.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      m.drop.classList.remove('is-over');
      var dt = e.dataTransfer;
      var file = dt && dt.files && dt.files[0];
      if (file) importFile(file);
    });
  }

  /* --------------------------------------------------------------- 开关 */
  function open() {
    ensureModal();
    els.mask.hidden = false;
    document.body.classList.add('aim-open');
    resetForm();
    renderAll();
    setStatus('正在读取模型列表…');
    load().then(function () { els.name.focus(); });
  }

  function close() {
    if (!els) return;
    els.mask.hidden = true;
    document.body.classList.remove('aim-open');
  }

  /* 顶部「AI 设置」按钮 / 门户首页的入口按钮都走 open() */
  function bindEntry() {
    var btn = document.getElementById('aiSettingsBtn');
    if (btn) btn.addEventListener('click', open);
  }

  window.AiModels = { open: open, close: close, load: load };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEntry);
  } else {
    bindEntry();
  }
})();

