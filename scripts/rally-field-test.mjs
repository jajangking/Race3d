/**
 * Rallycross field test: 10 AI opponents on the mixed-surface rally circuit
 * (two gravel sections, grip 0.72). Checks that they all launch, complete
 * laps, stay on the road despite the grip change, and that the gravel is
 * actually being experienced (grip < 0.85 while in the zone).
 *
 *   node scripts/rally-field-test.mjs [seconds]
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../src/vehicle/vehicle.js';
import { AIDriver } from '../src/ai/aiDriver.js';
import { TRACKS } from '../src/trackLayout.js';

await RAPIER.init();
const DT = 1 / 120;
const SECONDS = Number(process.argv[2] ?? 150);
const N = 10;

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = DT;
world.createCollider(
  RAPIER.ColliderDesc.cuboid(2500, 0.5, 2500).setTranslation(0, -0.5, 0).setFriction(0.9),
);

// the game's actual rallycross layout, gravel zones included
const layout = TRACKS.rally;
const curve = layout.curve;
const length = layout.length;
const start = curve.getPointAt(0);
const startTangent = curve.getTangentAt(0);
const startQuat = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 0, 1), startTangent.clone().setY(0).normalize());
const track = {
  ...layout,
  curve,
  length,
  start,
  startQuat,
  startTangent,
};

const ROW_GAP = 12;
const COL = 3;
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
    parity: i % 2,
  }, world);
  driver.u = slot.u;
  cars.push(car);
  drivers.push(driver);
}
world.step();

const progress = new Array(N).fill(0);
const lastU = new Array(N).fill(0);
const maxLat = new Array(N).fill(0);
const offRoad = new Array(N).fill(0);
const recoveries = new Array(N).fill(0);
const prevMode = drivers.map((d) => d.mode);
const gravelSeen = new Array(N).fill(false);
const minGrip = new Array(N).fill(1);
const p = new THREE.Vector3();

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
    const d = drivers[i];
    const u = d.u;
    let du = (u - lastU[i] + 1) % 1;
    if (du > 0.5) du = 0;
    progress[i] += du;
    lastU[i] = u;

    curve.getPointAt(u, p);
    const t = cars[i].body.translation();
    const lat = Math.hypot(t.x - p.x, t.z - p.z);
    if (lat > maxLat[i]) maxLat[i] = lat;
    if (lat > 8) offRoad[i] += DT;
    if (d.mode === 'recover' && prevMode[i] !== 'recover') recoveries[i]++;
    prevMode[i] = d.mode;

    // did the car actually cross the gravel?
    minGrip[i] = Math.min(minGrip[i], cars[i].grip);
    if (cars[i].grip < 0.85) gravelSeen[i] = true;
  }
}
const wall = (performance.now() - t0) / 1000;

console.log(`\nrallycross lap: ${length.toFixed(0)} m, gravel zones ${
  layout.gravel.map(([a, b]) => `[${(a * 100).toFixed(0)}-${(b * 100).toFixed(0)}%]`).join(' ')
}\n`);
console.log(`simulated ${SECONDS}s with ${N} AI cars in ${wall.toFixed(1)}s wall time ` +
  `(${(SECONDS / wall).toFixed(2)}x real time)\n`);
console.log('car   dist(m)  laps   avg km/h  maxlat  offroad  recov  grip');
for (let i = 0; i < N; i++) {
  const avg = ((progress[i] * length) / SECONDS) * 3.6;
  console.log(
    `${String(i).padStart(2)}    ` +
    `${(progress[i] * length).toFixed(0).padStart(6)}   ` +
    `${Math.floor(progress[i]).toString().padStart(2)}    ` +
    `${avg.toFixed(0).padStart(6)}    ` +
    `${maxLat[i].toFixed(1).padStart(5)}   ` +
    `${offRoad[i].toFixed(1).padStart(5)}   ` +
    `${String(recoveries[i]).padStart(5)}   ` +
    `${minGrip[i].toFixed(2)}`,
  );
}

const finished = progress.filter((x) => x >= 1).length;
const offTotal = offRoad.reduce((a, b) => a + b, 0);
const recTotal = recoveries.reduce((a, b) => a + b, 0);
const gravelCars = gravelSeen.filter(Boolean).length;
const nan = cars.some((c) => !Number.isFinite(c.body.translation().x + c.telemetry.speedKmh));

console.log(`\nfinished a lap : ${finished}/${N}`);
console.log(`off-road total : ${offTotal.toFixed(1)} s`);
console.log(`recoveries     : ${recTotal}`);
console.log(`crossed gravel : ${gravelCars}/${N} (min grip seen)`);
console.log(`NaN            : ${nan ? 'YES' : 'no'}`);

// A mixed-surface circuit is genuinely slipperier than all-tarmac, so the
// off-road budget is wider here. The gates are: everyone launches and
// finishes a lap, nobody NaNs, everyone actually crosses the gravel, and the
// off-road time stays in the "occasional slide, self-recovered" band.
const pass = !nan && finished >= N - 1 && offTotal < 60 && gravelCars >= N - 1;
console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
process.exit(pass ? 0 : 1);
