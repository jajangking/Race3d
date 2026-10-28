/**
 * Probe: does the AI field hold as one pack?
 * 120 s sim, every 20 s prints the front-to-back gaps (m), max gap,
 * field length (leader -> tail) and cluster count (gap > 100 m).
 * Scratch diagnostic (dotfile) - not part of the test suite.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../src/vehicle/vehicle.js';
import { AIDriver } from '../src/ai/aiDriver.js';
import { buildTrackCurve } from '../src/trackLayout.js';

await RAPIER.init();
const DT = 1 / 120;
const SECONDS = 120;
const N = 10;

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = DT;
world.createCollider(
  RAPIER.ColliderDesc.cuboid(2500, 0.5, 2500).setTranslation(0, -0.5, 0).setFriction(0.9),
);

const curve = buildTrackCurve();
const length = curve.getLength();
const start = curve.getPointAt(0);
const startTangent = curve.getTangentAt(0);
const startQuat = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 0, 1), startTangent.clone().setY(0).normalize());
const track = { curve, length, start, startQuat, startTangent };

const ROW_GAP = 12;
const COL = 3;
// mirror src/main.js OPPONENT_*
const PACE = [1.002, 1.004, 0.998, 1.005, 1.001, 1.003, 0.997, 1.004, 1.0, 1.002];
const LINE = [0.96, 1.0, 0.92, 0.99, 0.94, 0.97, 0.9, 0.98, 0.95, 0.93];
const BIAS = [0.2, -0.25, -0.4, 0.4, 0.0, -0.1, 0.35, -0.35, 0.1, -0.2];

function gridPose(distance, lateral) {
  const u = (distance / length + 1) % 1;
  const p = curve.getPointAt(u, new THREE.Vector3());
  const t = curve.getTangentAt(u, new THREE.Vector3()).setY(0).normalize();
  const right = new THREE.Vector3(t.z, 0, -t.x);
  const pos = p.clone().addScaledVector(right, lateral).setY(0.48);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), t);
  return { pos, q, u };
}

const cars = [];
const drivers = [];
for (let i = 0; i < N; i++) {
  const row = Math.floor(i / 2);
  const col = i % 2;
  const slot = gridPose(ROW_GAP * (row + 1), col === 0 ? -COL : COL);
  const car = new Vehicle({ RAPIER, world, position: slot.pos, quaternion: slot.q });
  const driver = new AIDriver(car, track, {
    enabled: true,
    pace: PACE[i],
    lineScale: LINE[i],
    laneBias: BIAS[i],
    laneOffset: (col === 0 ? -COL : COL) + (((i * 5) % 7) - 3) * 0.18,
  }, world);
  driver.u = slot.u;
  cars.push(car);
  drivers.push(driver);
}
world.step();

const progress = new Array(N).fill(0);
const lastU = new Array(N).fill(0);
const p = new THREE.Vector3();

function gapsAt(t) {
  // sort by race progress, compute forward gaps (leader -> tail)
  const order = [...Array(N).keys()].sort((a, b) => progress[b] - progress[a]);
  const gaps = [];
  for (let k = 0; k < N - 1; k++) {
    let g = (progress[order[k]] - progress[order[k + 1]]) * length;
    g = ((g % length) + length) % length;
    if (g > length / 2) g = length - g;
    gaps.push(g);
  }
  const maxGap = Math.max(...gaps);
  const field = gaps.reduce((a, b) => a + b, 0);
  const clusters = 1 + gaps.filter((g) => g > 100).length;
  const gapStr = gaps.map((g) => g.toFixed(0)).join(' ');
  console.log(`t=${t.toFixed(0).padStart(3)}s | maxGap=${maxGap.toFixed(0).padStart(3)}m field=${field.toFixed(0).padStart(3)}m clusters=${clusters} | gaps(m): ${gapStr}`);
  return maxGap;
}

let maxGapEver = 0;
const t0 = performance.now();
for (let step = 0; step <= 120 * SECONDS; step++) {
  if (step % 2 === 0) {
    for (let i = 0; i < N; i++) {
      const st = drivers[i].update(DT * 2);
      cars[i].update(DT * 2, st);
    }
  }
  world.step();
  for (let i = 0; i < N; i++) {
    const u = drivers[i].u;
    let du = (u - lastU[i] + 1) % 1;
    if (du > 0.5) du = 0;
    progress[i] += du;
    lastU[i] = u;
  }
  const t = step * DT;
  if (t > 0 && Math.abs(t % 20) < DT) {
    maxGapEver = Math.max(maxGapEver, gapsAt(t));
  }
}
const wall = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`\n120s in ${wall}s wall | worst maxGap: ${maxGapEver.toFixed(0)} m`);
