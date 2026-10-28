import * as THREE from 'three';
import { buildTrackCurve } from '../src/trackLayout.js';
import { buildRacingLine } from '../src/ai/racingLine.js';

const curve = buildTrackCurve();
const length = curve.getLength();
const track = { curve, length };
const line = buildRacingLine(track);

const P = new THREE.Vector3(), T = new THREE.Vector3();
function path(uFrom, uTo, n, fn) {
  let d = '';
  for (let i = 0; i <= n; i++) {
    const u = uFrom + (uTo - uFrom) * (i / n);
    const [x, z] = fn(((u % 1) + 1) % 1);
    d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + (-z).toFixed(1) + ' ';
  }
  return d;
}
const edge = (u, off) => { curve.getPointAt(u, P); curve.getTangentAt(u, T); T.y=0; T.normalize(); return [P.x + T.z*off, P.z - T.x*off]; };
const center = (u) => { curve.getPointAt(u, P); return [P.x, P.z]; };

// kerb segments (curvature > 1/45)
let kerbL = '', kerbR = '';
const N = line.n;
for (let i = 0; i <= N; i++) {
  const u = (i % N) / N;
  if (line.curvature[i % N] > 1/45) {
    const [lx, lz] = edge(u, 7.72); const [rx, rz] = edge(u, -7.72);
    kerbL += `${lx.toFixed(1)},${(-lz).toFixed(1)} `;
    kerbR += `${rx.toFixed(1)},${(-rz).toFixed(1)} `;
  } else { kerbL += ''; kerbR += ''; }
}
// build kerb as separate polylines
let kerbLPoly = '', kerbRPoly = '';
{ let runL = '', runR = '';
  for (let i = 0; i <= N; i++) {
    const u = (i % N) / N;
    if (line.curvature[i % N] > 1/45) {
      const [lx, lz] = edge(u, 7.72); const [rx, rz] = edge(u, -7.72);
      runL += (runL ? ' ' : 'M') + lx.toFixed(1) + ',' + (-lz).toFixed(1);
      runR += (runR ? ' ' : 'M') + rx.toFixed(1) + ',' + (-rz).toFixed(1);
    } else { kerbLPoly += runL; runL = ''; kerbRPoly += runR; runR = ''; }
  }
  kerbLPoly += runL; kerbRPoly += runR;
}

// racing line
let linePts = '';
for (let i = 0; i <= 600; i++) {
  const u = i / 600;
  curve.getPointAt(u, P); curve.getTangentAt(u, T); T.y=0;
  const inv = 1/Math.hypot(T.x,T.z);
  const nx = T.z*inv, nz = -T.x*inv;
  const x = P.x + nx*line.offsets[i%600], z = P.z + nz*line.offsets[i%600];
  linePts += (i===0?'M':'L') + x.toFixed(1) + ',' + (-z).toFixed(1) + ' ';
}

// control points from trackLayout
import('./src/trackLayout.js').then(() => {});
let pts = '';
const cp = [ [0,0],[150,-40],[260,-120],[330,-260],[300,-400],[180,-480],[20,-460],[-80,-380],[-140,-240],[-196,-120],[-260,-160],[-330,-320],[-300,-470],[-196,168],[ -238,138] ];
// NOTE: placeholder, real points loaded below

const W = 1000, H = 1000;
const minX = -400, maxX = 400, minZ = -600, maxZ = 250;
const sx = W/(maxX-minX), sy = H/(maxZ-minZ);
const tx = (x) => (x-minX)*sx, tz = (z) => (maxZ-z)*sy;

const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="#20261d"/>
<path d="${path(0,1,1200,(u)=>{const[x,z]=center(u);return [tx(x),tz(z)];})}Z" fill="none" stroke="#3a4148" stroke-width="14" />
<path d="${path(0,1,1200,(u)=>{const[x,z]=edge(u,7);return [tx(x),tz(z)];})}Z" fill="none" stroke="#5a626b" stroke-width="1.5" />
<path d="${path(0,1,1200,(u)=>{const[x,z]=edge(u,-7);return [tx(x),tz(z)];})}Z" fill="none" stroke="#5a626b" stroke-width="1.5" />
<path d="${kerbLPoly}" fill="none" stroke="#c81c1c" stroke-width="2.5" />
<path d="${kerbRPoly}" fill="none" stroke="#c81c1c" stroke-width="2.5" />
<path d="${path(0,1,600,(u)=>{curve.getPointAt(u,P);curve.getTangentAt(u,T);T.y=0;const inv=1/Math.hypot(T.x,T.z);const x=P.x+T.z*inv*line.offsets[Math.round(u*600)%600], z=P.z-T.x*inv*line.offsets[Math.round(u*600)%600];return [tx(x),tz(z)];})}Z" fill="none" stroke="#e8b23a" stroke-width="1.5" stroke-dasharray="6,4"/>
<g id="marks"></g>
</svg>`;
import { writeFileSync } from 'fs';
writeFileSync('/tmp/track-map.svg', svg);
console.log('wrote /tmp/track-map.svg, length', length.toFixed(0));
