import * as THREE from 'three';
import { buildTrackCurve } from '../src/trackLayout.js';
import { buildRacingLine } from '../src/ai/racingLine.js';
import { writeFileSync } from 'fs';

const curve = buildTrackCurve();
const length = curve.getLength();
const line = buildRacingLine({ curve, length });

const W = 900, H = 430;
const buf = Buffer.alloc(W * H * 3);
const minX = -350, maxX = -110, minZ = 95, maxZ = 210;
const sx = (W - 40) / (maxX - minX), sy = (H - 40) / (maxZ - minZ);
const X = (x) => 20 + (x - minX) * sx;
const Z = (z) => 20 + (maxZ - z) * sy;

const set = (px, py, r, g, b) => {
  if (px < 0 || py < 0 || px >= W || py >= H) return;
  const i = (py * W + px) * 3;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
};
const disc = (cx, cy, rad, r, g, b) => {
  const ri = Math.ceil(rad);
  for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) {
    if (dx * dx + dy * dy <= rad * rad) set(cx + dx, cy + dy, r, g, b);
  }
};

// background
for (let i = 0; i < W * H; i++) { buf[i*3] = 34; buf[i*3+1] = 40; buf[i*3+2] = 29; }

const P = new THREE.Vector3(), T = new THREE.Vector3();
const N = 4000;
// road (grey, wide)
for (let i = 0; i < N; i++) {
  const u = i / N;
  curve.getPointAt(u, P);
  disc(Math.round(X(P.x)), Math.round(Z(P.z)), 13, 58, 64, 72);
}
// edges (lighter)
for (let i = 0; i < N; i += 2) {
  const u = i / N;
  curve.getPointAt(u, P); curve.getTangentAt(u, T); T.y = 0; T.normalize();
  for (const s of [-1, 1]) {
    const ex = P.x + T.z * s * 7, ez = P.z - T.x * s * 7;
    disc(Math.round(X(ex)), Math.round(Z(ez)), 2.2, 150, 158, 168);
  }
}
// kerbs (red) where curvature > 1/45
for (let i = 0; i < N; i += 2) {
  const u = i / N;
  const k = line.curvature[Math.round(u * line.n) % line.n];
  if (k <= 1 / 45) continue;
  curve.getPointAt(u, P); curve.getTangentAt(u, T); T.y = 0; T.normalize();
  for (const s of [-1, 1]) {
    const ex = P.x + T.z * s * 7.72, ez = P.z - T.x * s * 7.72;
    disc(Math.round(X(ex)), Math.round(Z(ez)), 2.8, 210, 40, 40);
  }
}
// racing line (yellow)
for (let i = 0; i < N; i += 4) {
  const u = i / N;
  curve.getPointAt(u, P); curve.getTangentAt(u, T); T.y = 0;
  const inv = 1 / Math.hypot(T.x, T.z);
  const off = line.offsets[Math.round(u * line.n) % line.n];
  const x = P.x + T.z * inv * off, z = P.z - T.x * inv * off;
  disc(Math.round(X(x)), Math.round(Z(z)), 1.8, 230, 178, 58);
}
// start point marker
curve.getPointAt(0, P); curve.getTangentAt(0, T);
disc(Math.round(X(P.x)), Math.round(Z(P.z)), 7, 255, 255, 255);

// write PPM (P6)
const fs2 = writeFileSync;
const header = `P6\n${W} ${H}\n255\n`;
const out = Buffer.alloc(header.length + W * H * 3);
Buffer.from(header).copy(out, 0);
buf.copy(out, header.length);
fs2('/home/user/track-zoom.ppm', out);
console.log('wrote /home/user/track-zoom.ppm', out.length, 'bytes');
