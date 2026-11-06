/**
 * Track geometry analysis: corner radii, worst kinks, self-intersection.
 *
 *   node scripts/track-geo.mjs              -> analyze the built TRACKS (circuit + rally)
 *   node scripts/track-geo.mjs file.json    -> analyze candidate layouts:
 *        { "NAME": { "pts": [[x, z], ...], "gravel": [[i0,i1], ...] } }
 *
 * Reports per layout: length, tightest corner radius + where, corner list
 * (turn angle + min radius), and the closest approach of non-adjacent
 * centerline points (road overlap when < 2 * ROAD_HALF_WIDTH = 14 m).
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

const ROAD_HALF_WIDTH = 7;
const N = 4000;

function analyze(name, curve, opts = {}) {
  const pts = curve.getSpacedPoints(N);
  const length = curve.getLength();
  const v0 = new THREE.Vector3(),
    v1 = new THREE.Vector3();
  // curvature radius at each sample (central difference of tangent)
  const radii = new Array(N + 1).fill(Infinity);
  for (let i = 1; i < N; i++) {
    const a = pts[i - 1],
      b = pts[i],
      c = pts[i + 1];
    const t0 = v0.set(b.x - a.x, 0, b.z - a.z).normalize();
    const t1 = v1.set(c.x - b.x, 0, c.z - b.z).normalize();
    const cross = t0.x * t1.z - t0.z * t1.x; // signed 2D cross (y=0 plane)
    const dot = t0.x * t1.x + t0.z * t1.z;
    const dTheta = Math.atan2(cross, dot);
    const ds = b.distanceTo(c) || b.distanceTo(a);
    if (Math.abs(dTheta) > 1e-6) radii[i] = ds / Math.abs(dTheta);
  }

  // worst radius (only meaningful if < 100 m; straights are Infinity)
  let worst = Infinity,
    worstI = 0;
  for (let i = 0; i <= N; i++)
    if (radii[i] < worst) {
      worst = radii[i];
      worstI = i;
    }

  // corners: contiguous regions where radius < 60 m
  const corners = [];
  let run = null;
  for (let i = 0; i <= N; i++) {
    if (radii[i] < 60) {
      if (!run) run = { start: i, minR: Infinity };
      run.end = i;
      run.minR = Math.min(run.minR, radii[i]);
    } else if (run) {
      // integrate turn angle over the corner
      let angle = 0;
      for (let k = run.start + 1; k <= run.end; k++) {
        const a = pts[k - 1],
          b = pts[k],
          c = pts[k + 1] || pts[k];
        const t0 = v0.set(b.x - a.x, 0, b.z - a.z).normalize();
        const t1 = v1.set(c.x - b.x, 0, c.z - b.z).normalize();
        angle += Math.abs(Math.atan2(t0.x * t1.z - t0.z * t1.x, t0.x * t1.x + t0.z * t1.z));
      }
      run.angle = angle;
      run.u = run.start / N;
      corners.push(run);
      run = null;
    }
  }
  if (run) corners.push(run);

  // closest approach of non-adjacent centerline points (wrap-aware via a
  // doubled point array; period = N since pts[0] == pts[N] on a closed curve)
  const MIN_SEP = 150; // samples (~3.75% of lap) considered "adjacent"
  const P = new Array(2 * N + 1);
  for (let i = 0; i <= 2 * N; i++) P[i] = pts[i % (N + 1)];
  let minD = Infinity,
    pa = 0,
    pb = 0;
  for (let i = 0; i < N; i += 4) {
    for (let j = i + MIN_SEP; j < i + N - MIN_SEP; j += 4) {
      const d = P[i].distanceTo(P[j]);
      if (d < minD) {
        minD = d;
        pa = i;
        pb = j;
      }
    }
  }

  const fmt = (c) =>
    `u${(c.u * 100).toFixed(0)}% ${c.angle > 2.2 ? 'HAIRPIN' : c.angle > 1.2 ? 'tight' : 'sweeper'} ` +
    `${((c.angle * 180) / Math.PI).toFixed(0)}deg Rmin=${c.minR.toFixed(1)}m`;

  const overlap = minD < 2 * ROAD_HALF_WIDTH ? '  <-- ROAD OVERLAP!' : minD < 16 ? '  <-- narrow gap' : '';
  console.log(`\n=== ${name} ===`);
  console.log(`length: ${length.toFixed(0)} m`);
  console.log(`worst radius: ${worst.toFixed(1)} m at u=${((worstI / N) * 100).toFixed(1)}%`);
  console.log(`corners (${corners.length}):`);
  corners.forEach((c, i) => console.log(`  T${i + 1}: ${fmt(c)}`));
  console.log(
    `extreme (Rmin<14m): ${corners.filter((c) => c.minR < 14).length} | tight (Rmin<20m): ${corners.filter((c) => c.minR < 20).length}`,
  );
  console.log(
    `closest non-adjacent centerline: ${minD.toFixed(1)} m (u${((pa / N) * 100).toFixed(0)}% vs u${((pb / N) * 100).toFixed(0)}%)${overlap}`,
  );
  return { length, worst, corners, minD };
}

const arg = process.argv[2];
if (!arg) {
  const { TRACKS } = await import('../src/trackLayout.js');
  for (const key of Object.keys(TRACKS)) {
    const t = TRACKS[key];
    analyze(`${t.name} (${t.label})`, t.curve);
  }
} else {
  const data = JSON.parse(readFileSync(arg, 'utf8'));
  for (const [name, def] of Object.entries(data)) {
    const pts = def.pts.map(([x, z]) => new THREE.Vector3(x, 0, z));
    const ct = def.curveType || 'catmullrom';
    const curve = ct === 'centripetal' ? new THREE.CatmullRomCurve3(pts, true, 'centripetal') : new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
    analyze(name, curve);
  }
}
