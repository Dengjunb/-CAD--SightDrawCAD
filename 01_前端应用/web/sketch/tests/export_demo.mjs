/* 生成一份带标注的示例 DXF（供 ezdxf / AutoCAD 校验结构） */
import fs from 'node:fs';
import { Doc } from '../js/model.js';
import { createConstraint } from '../js/constraints.js';
import { exportDXF } from '../js/dxf.js';

const doc = new Doc();
const A = doc.addPoint(0, 0, { fixed: true });
const B = doc.addPoint(120, 0);
const C = doc.addPoint(120, 80);
const D = doc.addPoint(0, 80);
const AB = doc.addLine(A.id, B.id);
const BC = doc.addLine(B.id, C.id);
const CD = doc.addLine(C.id, D.id);
const DA = doc.addLine(D.id, A.id);
const O = doc.addPoint(60, 40);
const hole = doc.addCircle(O.id, 15);
const arcC = doc.addPoint(140, 40);
const arc = doc.addArc(arcC.id, 20, Math.PI * 0.25, Math.PI * 1.25);

const cons = [
  createConstraint('horizontal', { line: AB.id }),
  createConstraint('vertical', { line: BC.id }),
  createConstraint('horizontal', { line: CD.id }),
  createConstraint('vertical', { line: DA.id }),
  createConstraint('distanceX', { a: A.id, b: B.id }, 120),
  createConstraint('distanceY', { a: B.id, b: C.id }, 80),
  createConstraint('distanceX', { a: A.id, b: O.id }, 60),
  createConstraint('distanceY', { a: A.id, b: O.id }, 40),
  createConstraint('radius', { circle: hole.id }, 15),
  createConstraint('radius', { circle: arc.id }, 20),
];
for (const c of cons) { if (!c.id) c.id = doc.newId('k'); doc.constraints.set(c.id, c); }

const text = exportDXF(doc, { skipReferencedPoints: true, dimensions: true });
fs.writeFileSync(new URL('./demo-sketch.dxf', import.meta.url), text, 'utf8');
console.log('written demo-sketch.dxf, bytes=', text.length);
console.log('entities:', doc.stats());
