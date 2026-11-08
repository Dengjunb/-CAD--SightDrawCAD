/* =============================================================================
   dxf.js 单元测试（node tests/dxf.test.mjs，零依赖）
   -----------------------------------------------------------------------------
   覆盖：
     1. Doc -> exportDXF -> importDXF 往返：数量、坐标、半径、弧起止角（度）；
     2. 导出文本的 DXF 结构（CRLF、$ACADVER、TABLES、EOF、6 位去尾零、图层归属）；
     3. 读取容错：空文件、缺 ENTITIES、未知实体、LWPOLYLINE（含 bulge/闭合）、
        POLYLINE+VERTEX、R2000 风格组码、缺组码的坏实体、BOM/LF 行尾。
   ========================================================================== */

import { Doc, deg, rad } from '../js/model.js';
import { exportDXF, importDXF } from '../js/dxf.js';

/* ---------------- 迷你断言框架 ---------------- */

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('[PASS] ' + name);
  } else {
    fail++;
    console.log('[FAIL] ' + name + (detail ? '  -> ' + detail : ''));
  }
}

function near(a, b, tol = 1e-6) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
}

/** 组码行数组 -> DXF 文本（测试用，行尾 CRLF） */
const E = (lines) => lines.join('\r\n') + '\r\n';

/** 只含 ENTITIES 段的迷你 DXF */
const entFile = (body) => E(['0', 'SECTION', '2', 'ENTITIES', ...body, '0', 'ENDSEC', '0', 'EOF']);

/* =============================================================================
   1. 建 doc：2 线 + 1 圆 + 1 弧 + 1 点（额外带 2 个圆心点、1 个无关点）
   ========================================================================== */
const doc = new Doc();
doc.units = 'mm';

const p1 = doc.addPoint(0, 0, { fixed: true });
const p2 = doc.addPoint(100, 0);
const p3 = doc.addPoint(100, 50);
const l1 = doc.addLine(p1.id, p2.id);                       // 普通线 -> 图层 "0"
const l2 = doc.addLine(p2.id, p3.id, { construction: true }); // 构造线 -> CONSTRUCTION

const cp = doc.addPoint(40, 30);
const c1 = doc.addCircle(cp.id, 12.5);

const ap = doc.addPoint(-20, 15);
const arc1 = doc.addArc(ap.id, 8, rad(30), rad(120));

const sp = doc.addPoint(60, -25);                            // 独立点

/* ---------------- 导出 ---------------- */
const text = exportDXF(doc);
const norm = text.replace(/\r\n/g, '\n');

/* =============================================================================
   2. 导出文本的结构断言
   ========================================================================== */
ok('导出结果是字符串', typeof text === 'string' && text.length > 0);
ok('文本以 "0\\nSECTION" 开头', norm.startsWith('0\nSECTION'), JSON.stringify(norm.slice(0, 30)));
ok('文本以 "0\\nEOF" 结尾', norm.trimEnd().endsWith('0\nEOF'), JSON.stringify(norm.slice(-30)));
ok('行尾统一为 \\r\\n（无裸 \\n）', !/(^|[^\r])\n/.test(text), '存在 LF 行尾');
ok('包含 $ACADVER 且值为 AC1009', text.includes('$ACADVER') && text.includes('AC1009'));
ok('HEADER 含 $INSBASE', text.includes('$INSBASE'));
ok('HEADER 含 $EXTMIN / $EXTMAX', text.includes('$EXTMIN') && text.includes('$EXTMAX'));
ok('HEADER 含 $MEASUREMENT 且为 1', text.includes('$MEASUREMENT') && /\$MEASUREMENT\r?\n70\r?\n1/.test(text));
ok('TABLES 含 LTYPE(CONTINUOUS)', text.includes('LTYPE') && text.includes('CONTINUOUS'));
ok('LTYPE 表在 LAYER 表之前', text.indexOf('LTYPE') < text.indexOf('LAYER'));
ok('LAYER 表含 "0" 与 "CONSTRUCTION"',
  /LAYER\r?\n2\r?\n0\r?\n/.test(text) && /LAYER\r?\n2\r?\nCONSTRUCTION\r?\n/.test(text));
ok('数值保留 6 位去尾零（不出现 1.000000）', !text.includes('1.000000'));
ok('ARC 起始角以「度」写入（30）', /ARC\r?\n8\r?\n0\r?\n10\r?\n-20\r?\n20\r?\n15\r?\n30\r?\n0\r?\n40\r?\n8\r?\n50\r?\n30\r?\n51\r?\n120/.test(text),
  '未找到 ARC 的 50=30 / 51=120');

/* 边界：$EXTMIN/$EXTMAX 覆盖所有几何（圆 -20? 见下：圆心 -20 半径 8 -> -28） */
const exMin = /EXTMIN\r?\n10\r?\n(-?[\d.]+)/.exec(text);
ok('$EXTMIN 的 X 覆盖到最左侧几何（-28）', exMin && near(Number(exMin[1]), -28), exMin && exMin[1]);

/* =============================================================================
   3. 往返读回
   ========================================================================== */
const back = importDXF(text);
const items = back.items;

ok('往返无 warning', back.warnings.length === 0, JSON.stringify(back.warnings));
ok('往返图元数量一致（' + doc.entities.size + '）', items.length === doc.entities.size,
  'items=' + items.length + ' entities=' + doc.entities.size);

const counts = items.reduce((m, it) => { m[it.type] = (m[it.type] || 0) + 1; return m; }, {});
const stats = doc.stats();
ok('类型计数一致 line=2 / circle=1 / arc=1 / point=6',
  counts.line === stats.line && counts.circle === stats.circle && counts.arc === stats.arc && counts.point === stats.point,
  JSON.stringify(counts) + ' vs ' + JSON.stringify(stats));

/* 按 doc.entities 的插入顺序构造期望值，逐项比对（导出/读入都保持顺序） */
const expected = [];
for (const e of doc.entities.values()) {
  if (e.type === 'point') {
    expected.push({ type: 'point', x: e.x, y: e.y, layer: '0' });
  } else if (e.type === 'line') {
    const a = doc.pointOf(e.p1); const b = doc.pointOf(e.p2);
    expected.push({
      type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      layer: e.construction === true ? 'CONSTRUCTION' : '0',
    });
  } else if (e.type === 'circle') {
    const c = doc.pointOf(e.center);
    expected.push({
      type: 'circle', cx: c.x, cy: c.y, r: e.r,
      layer: e.construction === true ? 'CONSTRUCTION' : '0',
    });
  } else if (e.type === 'arc') {
    const c = doc.pointOf(e.center);
    expected.push({
      type: 'arc', cx: c.x, cy: c.y, r: e.r,
      a0: deg(e.a0), a1: deg(e.a1), // 曲线角度：DXF 用度
      layer: e.construction === true ? 'CONSTRUCTION' : '0',
    });
  }
}

ok('期望表行数与图元数一致', expected.length === items.length,
  expected.length + ' vs ' + items.length);

let typeBad = 0;
let geoBad = 0;
let layerBad = 0;
const firstBad = [];
for (let i = 0; i < Math.min(expected.length, items.length); i++) {
  const ex = expected[i];
  const it = items[i];
  if (!it || it.type !== ex.type) { typeBad++; firstBad.push('#' + i + ' type ' + (it && it.type) + '!=' + ex.type); continue; }
  if (it.layer !== ex.layer) { layerBad++; firstBad.push('#' + i + ' layer ' + it.layer + '!=' + ex.layer); }
  if (ex.type === 'point') {
    if (!near(it.x, ex.x) || !near(it.y, ex.y)) { geoBad++; firstBad.push('#' + i + ' point'); }
  } else if (ex.type === 'line') {
    if (!near(it.x1, ex.x1) || !near(it.y1, ex.y1) || !near(it.x2, ex.x2) || !near(it.y2, ex.y2)) {
      geoBad++; firstBad.push('#' + i + ' line');
    }
  } else if (ex.type === 'circle') {
    if (!near(it.cx, ex.cx) || !near(it.cy, ex.cy) || !near(it.r, ex.r)) { geoBad++; firstBad.push('#' + i + ' circle'); }
  } else if (ex.type === 'arc') {
    if (!near(it.cx, ex.cx) || !near(it.cy, ex.cy) || !near(it.r, ex.r)
      || !near(it.a0, ex.a0) || !near(it.a1, ex.a1)) { geoBad++; firstBad.push('#' + i + ' arc'); }
  }
}
ok('逐项类型顺序一致', typeBad === 0, firstBad.join('; '));
ok('坐标/半径误差 < 1e-6', geoBad === 0, firstBad.join('; '));
ok('图层归属一致（构造线进 CONSTRUCTION、其余进 "0"）', layerBad === 0, firstBad.join('; '));

/* 显式点名几个关键量，便于回归时定位 */
const arcItem = items.filter((it) => it.type === 'arc')[0];
ok('圆的半径一致（12.5）', items.filter((it) => it.type === 'circle')[0].r === 12.5);
ok('弧半径一致（8）', near(arcItem.r, 8));
ok('弧起止角一致（度 30 -> 120）', near(arcItem.a0, 30) && near(arcItem.a1, 120),
  arcItem.a0 + ' / ' + arcItem.a1);
ok('弧的起止角等于 deg(rad(30/120))', near(arcItem.a0, deg(rad(30))) && near(arcItem.a1, deg(rad(120))));

/* 跨 0° 的弧：导出/读入都不归一化，保证往返一致 */
const docA = new Doc();
const ca = docA.addPoint(0, 0);
const aa = docA.addArc(ca.id, 5, rad(350), rad(10));
const backA = importDXF(exportDXF(docA));
const arcA = backA.items.filter((it) => it.type === 'arc')[0];
ok('跨 0° 弧往返：350 -> 10 保持不变', arcA && near(arcA.a0, 350) && near(arcA.a1, 10),
  arcA ? arcA.a0 + ' / ' + arcA.a1 : 'no arc');

/* =============================================================================
   4. opts.layers：自定义图层表 + 缺失层的兜底 + 图层名消毒
   ========================================================================== */
const custom = exportDXF(doc, { layers: [{ name: '0', color: 1 }, { name: 'AUX', color: 3 }] });
ok('opts.layers 生效（写入 AUX）', custom.includes('AUX'));
ok('实体用到的 CONSTRUCTION 层被自动补上', /LAYER\r?\n2\r?\nCONSTRUCTION\r?\n/.test(custom));
ok('opts.layers 未给 "0" 时也会补上', /\r?\n2\r?\nAUX\r?\n/.test(custom) && /LAYER\r?\n2\r?\n0\r?\n/.test(custom));

const sanitized = exportDXF(doc, { layers: [{ name: 'A B/C', color: 3 }] });
ok('图层名非法字符消毒（A B/C -> A_B_C）', sanitized.includes('A_B_C'), '未消毒');
ok('空 doc 也能导出（包围盒退化为 0）', (() => {
  const empty = new Doc();
  const t = exportDXF(empty);
  return t.startsWith('0\r\nSECTION') && t.trimEnd().endsWith('0\r\nEOF') && t.includes('$EXTMIN');
})());

/* =============================================================================
   5. 读取容错
   ========================================================================== */
const empty = importDXF('');
ok('空文本 -> 空 items + warning', empty.items.length === 0 && empty.warnings.length >= 1);

const blank = importDXF('  \r\n\r\n ');
ok('纯空白 -> 空 items + warning', blank.items.length === 0 && blank.warnings.length >= 1);

const noEnt = importDXF(E(['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC', '0', 'EOF']));
ok('缺 ENTITIES 段 -> 空 items + warning', noEnt.items.length === 0
  && noEnt.warnings.some((w) => w.includes('ENTITIES')));

const unsup = importDXF(entFile([
  '0', 'ELLIPSE', '8', '0', '10', '0', '20', '0', '40', '1',
  '0', '3DSOLID', '8', '0',
  '0', '3DSOLID', '8', '0',
  '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '1', '21', '1',
]));
ok('不支持实体不抛异常，其余实体照常返回', unsup.items.length === 1 && unsup.items[0].type === 'line');
ok('不支持实体告警措辞为「跳过实体 XXX n 个」',
  unsup.warnings.includes('跳过实体 ELLIPSE 1 个') && unsup.warnings.includes('跳过实体 3DSOLID 2 个'),
  JSON.stringify(unsup.warnings));

/* LWPOLYLINE：3 顶点开口 -> 2 段；闭合 -> 3 段 */
const lwOpen = importDXF(entFile([
  '0', 'LWPOLYLINE', '8', '0', '90', '3', '70', '0',
  '10', '0', '20', '0', '10', '10', '20', '0', '10', '10', '20', '10',
]));
ok('LWPOLYLINE 开口 3 顶点 -> 2 段直线', lwOpen.items.length === 2
  && lwOpen.items.every((it) => it.type === 'line') && near(lwOpen.items[1].x2, 10) && near(lwOpen.items[1].y2, 10));

const lwClosed = importDXF(entFile([
  '0', 'LWPOLYLINE', '8', '0', '90', '3', '70', '1',
  '10', '0', '20', '0', '10', '10', '20', '0', '10', '10', '20', '10',
]));
ok('LWPOLYLINE 闭合 3 顶点 -> 3 段直线', lwClosed.items.length === 3
  && near(lwClosed.items[2].x1, 10) && near(lwClosed.items[2].y1, 10)
  && near(lwClosed.items[2].x2, 0) && near(lwClosed.items[2].y2, 0));

const lwBulge = importDXF(entFile([
  '0', 'LWPOLYLINE', '8', 'WALL', '90', '2', '70', '0',
  '10', '0', '20', '0', '42', '0.5', '10', '10', '20', '0',
]));
ok('LWPOLYLINE 的 bulge 被忽略并记一句 warning', lwBulge.items.length === 1
  && lwBulge.warnings.some((w) => w.includes('bulge')),
  JSON.stringify(lwBulge.warnings));
ok('LWPOLYLINE 图层传递给每段', lwBulge.items[0].layer === 'WALL');

/* POLYLINE + VERTEX + SEQEND */
const poly = importDXF(entFile([
  '0', 'POLYLINE', '8', '0', '66', '1', '70', '0',
  '0', 'VERTEX', '8', '0', '10', '0', '20', '0',
  '0', 'VERTEX', '8', '0', '10', '5', '20', '5',
  '0', 'SEQEND', '8', '0',
]));
ok('POLYLINE+VERTEX(2) -> 1 段直线', poly.items.length === 1
  && near(poly.items[0].x1, 0) && near(poly.items[0].x2, 5) && near(poly.items[0].y2, 5));

const polyClosed = importDXF(entFile([
  '0', 'POLYLINE', '8', '0', '66', '1', '70', '1',
  '0', 'VERTEX', '8', '0', '10', '0', '20', '0',
  '0', 'VERTEX', '8', '0', '10', '5', '20', '0',
  '0', 'VERTEX', '8', '0', '10', '5', '20', '5',
  '0', 'SEQEND', '8', '0',
]));
ok('POLYLINE 闭合 3 顶点 -> 3 段直线', polyClosed.items.length === 3);

/* R2000 风格：句柄 5/330、子类标记 100 应被忽略 */
const r2000 = importDXF(entFile([
  '5', '2F', '330', '1F', '100', 'AcDbEntity', '8', '0', '100', 'AcDbLine',
  '0', 'LINE', '5', '30', '330', '1F', '100', 'AcDbEntity', '8', '0',
  '100', 'AcDbLine', '10', '0', '20', '0', '30', '0', '11', '7', '21', '8', '31', '0',
]));
ok('R2000 风格组码（5/330/100）被忽略后仍能解析 LINE',
  r2000.items.length === 1 && near(r2000.items[0].x2, 7) && near(r2000.items[0].y2, 8));

/* 缺组码的坏实体：跳过 + warning，不抛异常 */
const broken = importDXF(entFile([
  '0', 'LINE', '8', '0', '10', '0', '20', '0',       // 缺 11/21
  '0', 'CIRCLE', '8', '0', '10', '0', '20', '0', '40', '0', // r=0 无效
]));
ok('缺组码/非法几何的实体被跳过且不抛异常', broken.items.length === 0
  && broken.warnings.some((w) => w.includes('缺少必要组码')),
  JSON.stringify(broken.warnings));

/* 行尾与 BOM 容错：LF + BOM + 前导空行 */
const lfFile = '\uFEFF' + '\r\n' + entFile([
  '0', 'POINT', '8', '0', '10', '3', '20', '4',
]).replace(/\r\n/g, '\n');
const lf = importDXF(lfFile);
ok('LF 行尾 + BOM 仍能解析', lf.items.length === 1 && near(lf.items[0].x, 3) && near(lf.items[0].y, 4),
  JSON.stringify(lf.warnings));

/* 缺 ENDSEC 的截断文件：按文件末尾处理并 warning */
const truncated = importDXF(E(['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', '0',
  '10', '0', '20', '0', '11', '1', '21', '1']));
ok('缺 ENDSEC 的截断文件按末尾解析并 warning', truncated.items.length === 1
  && truncated.warnings.some((w) => w.includes('ENDSEC')),
  JSON.stringify(truncated.warnings));

/* =============================================================================
   汇总
   ========================================================================== */
console.log('');
console.log('== ' + pass + ' passed, ' + fail + ' failed, ' + (pass + fail) + ' total ==');

process.exit(fail > 0 ? 1 : 0);
