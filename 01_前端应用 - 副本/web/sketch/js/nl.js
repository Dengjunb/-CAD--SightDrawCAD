/* =============================================================================
   自然语言建模（离线规则解析）
   把中文描述转成「建模动作」，由 app.js 执行成图元 + 约束。
   例：
     画一个长100宽50的矩形
     在中心打一个直径20的孔
     把长度改成120
   ========================================================================== */

const NUM_RE = /(\d+(?:\.\d+)?)/g;

function numbers(text) {
  const out = [];
  let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(text))) out.push(parseFloat(m[1]));
  return out;
}

function pick(text, re, fallback) {
  const m = text.match(re);
  return m ? m[1] : fallback;
}

export function parseIntent(raw) {
  const text = String(raw || '').trim();
  if (!text) return { actions: [], reply: '说点什么，比如「画一个长100宽50的矩形」' };
  const t = text.replace(/\s+/g, '');

  if (/清空|清除|重来/.test(t)) return { actions: [{ op: 'clear' }], reply: '已清空画布' };

  // 修改尺寸：把长度/宽度/直径/半径 改成 N
  const mod = t.match(/(?:把)?(长度|长|宽度|宽|直径|半径|高度|高)(?:改成|改为|设为|变成)(\d+(?:\.\d+)?)/);
  if (mod) {
    const keyMap = { 长度: 'width', 长: 'width', 宽度: 'height', 宽: 'height', 高度: 'height', 高: 'height', 直径: 'diameter', 半径: 'radius' };
    return { actions: [{ op: 'dim', key: keyMap[mod[1]], value: parseFloat(mod[2]) }], reply: `把${mod[1]}改成 ${mod[2]}` };
  }

  // 先解析矩形尺寸（长/宽 或 AxB），支持「矩形 + 孔」一句话多动作
  const dimsEarly = t.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/);
  let rectW = null, rectH = null;
  if (dimsEarly) { rectW = parseFloat(dimsEarly[1]); rectH = parseFloat(dimsEarly[2]); }
  else {
    const lm0 = t.match(/(?:长|长度)(\d+(?:\.\d+)?)/);
    const wm0 = t.match(/(?:宽|宽度|高)(\d+(?:\.\d+)?)/);
    if (lm0) rectW = parseFloat(lm0[1]);
    if (wm0) rectH = parseFloat(wm0[1]);
  }
  const hasRectWord = /矩形|方框|方板|板|方块/.test(t);
  const holeM = t.match(/(?:打|加|开)?(?:一个)?(直径|半径|D|R|⌀)(\d+(?:\.\d+)?)(?:的)?(?:孔|圆)?/i);
  if (hasRectWord && holeM && rectW && rectH) {
    const isDia0 = /直径|D|⌀/i.test(holeM[1]);
    const v0 = parseFloat(holeM[2]);
    return {
      actions: [{ op: 'rect', w: rectW, h: rectH },
                { op: 'circle', r: isDia0 ? v0 / 2 : v0, at: 'center' }],
      reply: `画 ${rectW} × ${rectH} 的矩形，中心加 ${isDia0 ? '直径' : '半径'}${v0} 的孔`,
    };
  }

  // 加孔 / 圆
  const hole = t.match(/(?:打|加|开)?(?:一个)?(直径|半径|D|R|⌀)(\d+(?:\.\d+)?)(?:的)?(?:孔|圆)?/i);
  if (hole) {
    const isDia = /直径|D|⌀/i.test(hole[1]);
    const v = parseFloat(hole[2]);
    const r = isDia ? v / 2 : v;
    return { actions: [{ op: 'circle', r, at: /中心|中间|正中/.test(t) ? 'center' : 'origin' }], reply: `在${/中心|中间|正中/.test(t) ? '中心' : '原点'}加 ${isDia ? '直径' : '半径'}${v} 的孔` };
  }

  // 矩形：长100宽50 / 100x50
  const rect = /矩形|方框|方板|板|方块/.test(t);
  const dims = t.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/);
  const nums = numbers(t);
  if (rect) {
    let w = null, h = null;
    if (dims) { w = parseFloat(dims[1]); h = parseFloat(dims[2]); }
    else {
      const lm = t.match(/(?:长|长度)(\d+(?:\.\d+)?)/);
      const wm = t.match(/(?:宽|宽度|高)(\d+(?:\.\d+)?)/);
      if (lm) w = parseFloat(lm[1]);
      if (wm) h = parseFloat(wm[1]);
      if (w == null && nums.length >= 2) { w = nums[0]; h = nums[1]; }
      if (h == null && nums.length === 1) h = nums[0];
    }
    if (w && h) return { actions: [{ op: 'rect', w, h }], reply: `画 ${w} × ${h} 的矩形（带尺寸约束）` };
    return { actions: [], reply: '矩形需要长和宽，比如「画一个长100宽50的矩形」' };
  }

  if (/圆|孔/.test(t) && nums.length) {
    return { actions: [{ op: 'circle', r: nums[0] / 2, at: /中心|中间/.test(t) ? 'center' : 'origin' }], reply: `画直径 ${nums[0]} 的圆` };
  }

  return { actions: [], reply: '没听懂。试试：「画一个长120宽80的矩形」「在中心打一个直径30的孔」「把长度改成150」' };
}

/* 解析自检（node 测试用） */
export function _selfTest() {
  const cases = [
    ['画一个长100宽50的矩形', 'rect'],
    ['矩形 120x80', 'rect'],
    ['在中心打一个直径20的孔', 'circle'],
    ['把长度改成150', 'dim'],
    ['清空', 'clear'],
  ];
  return cases.map(([text, op]) => {
    const r = parseIntent(text);
    return { text, expect: op, got: r.actions[0] ? r.actions[0].op : null, ok: r.actions[0] && r.actions[0].op === op };
  });
}
