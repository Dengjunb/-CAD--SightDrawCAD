/* =============================================================================
   AI 3D · 轻量 Canvas 渲染器（零依赖，画家算法 + 平面着色）
   ========================================================================== */

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mesh = null;
    this.yaw = -0.6;
    this.pitch = 0.5;
    this.zoom = 1;
    this.center = [0, 0, 0];
    this.radius = 10;
    this._bind();
  }

  _bind() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.yaw += (e.clientX - drag.x) * 0.008;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + (e.clientY - drag.y) * 0.008));
      drag = { x: e.clientX, y: e.clientY };
      this.render();
    });
    c.addEventListener('pointerup', () => { drag = null; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom *= e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.zoom = Math.max(0.2, Math.min(6, this.zoom));
      this.render();
    }, { passive: false });
  }

  setMesh(mesh) {
    this.mesh = mesh;
    if (!mesh || !mesh.verts.length) return;
    this._fit();
    this.render();
  }

  _fit() {
    const v = this.mesh.verts;
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of v) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]);
    }
    this.center = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
    let r = 0;
    for (const p of v) r = Math.max(r, Math.hypot(p[0] - this.center[0], p[1] - this.center[1], p[2] - this.center[2]));
    this.radius = r || 10;
    this.zoom = 1;
  }

  _project(p, w, h) {
    // 绕 Y 轴 yaw，再绕 X 轴 pitch
    let x = p[0] - this.center[0], y = p[1] - this.center[1], z = p[2] - this.center[2];
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    let x1 = x * cy - z * sy, z1 = x * sy + z * cy;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    let y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    const scale = (Math.min(w, h) / (this.radius * 2.6)) * this.zoom;
    return { x: w / 2 + x1 * scale, y: h / 2 - y1 * scale, z: z2 };
  }

  render() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // 背景渐变
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#f4f7fc'); g.addColorStop(1, '#e6ecf6');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    if (!this.mesh || !this.mesh.verts.length) return;

    const pts = this.mesh.verts.map((p) => this._project(p, w, h));
    const faces = this.mesh.faces.map((f) => {
      const a = pts[f[0]], b = pts[f[1]], d = pts[f[2]];
      return { f, depth: (a.z + b.z + d.z) / 3 };
    }).sort((p, q) => q.depth - p.depth); // 远的先画

    const light = [-0.35, 0.75, 0.55];
    for (const item of faces) {
      const [i0, i1, i2] = item.f;
      const a = this.mesh.verts[i0], b = this.mesh.verts[i1], c2 = this.mesh.verts[i2];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c2[0] - a[0], c2[1] - a[1], c2[2] - a[2]];
      let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      n = n.map((k) => k / len);
      const lum = Math.abs(n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
      const shade = 0.42 + 0.58 * lum;
      const r = Math.round(70 * shade + 30), gg = Math.round(120 * shade + 25), bb = Math.round(185 * shade + 20);
      ctx.beginPath();
      const p0 = pts[i0], p1 = pts[i1], p2 = pts[i2];
      ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.closePath();
      ctx.fillStyle = `rgb(${r},${gg},${bb})`;
      ctx.globalAlpha = 0.96;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (lum > 0.08) {
        ctx.strokeStyle = 'rgba(20,50,90,0.35)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    }
    // 地面网格（参考用）
    ctx.strokeStyle = 'rgba(120,140,170,0.18)';
    ctx.lineWidth = 1;
    const baseY = h - 46;
    for (let i = 0; i <= 12; i++) {
      const x = (w / 12) * i;
      ctx.beginPath(); ctx.moveTo(x, baseY); ctx.lineTo(x, baseY + 10); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(0, baseY + 5); ctx.lineTo(w, baseY + 5); ctx.stroke();
  }
}
