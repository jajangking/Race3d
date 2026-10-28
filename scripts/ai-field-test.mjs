/**
 * Field test: 10 AI opponents on a staggered grid, racing together.
 * Checks that they all launch, stay on the road, make progress, and how much
 * CPU the whole field costs.
 *
 *   node scripts/ai-field-test.mjs [seconds]
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../src/vehicle/vehicle.js';
import { AIDriver } from '../src/ai/aiDriver.js';
import { buildTrackCurve } from '../src/trackLayout.js';

await RAPIER.init();
const DT = 1 / 120;
const SECONDS = Number(process.argv[2] ?? 120);
const N = 10;

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = DT;
world.createCollider(
  RAPIER.ColliderDesc.cuboid(2500, 0.5, 2500).setTranslation(0, -0.5, 0).setFriction(0.9),
);

// the game's actual circuit (src/trackLayout.js), not a test oval
const curve = buildTrackCurve();
const length = curve.getLength();
const start = curve.getPointAt(0);
const startTangent = curve.getTangentAt(0);
const startQuat = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 0, 1), startTangent.clone().setY(0).normalize());
const track = { curve, length, start, startQuat, startTangent };

const ROW_GAP = 12;
const COL = 3;
const PACE = [1.005, 1.02, 0.985, 1.03, 0.995, 1.015, 0.98, 1.025, 1.0, 1.01];
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

const byHandle = new Map();
cars.forEach((c, i) => byHandle.set(c.collider.handle, i));

const progress = new Array(N).fill(0);
const lastU = new Array(N).fill(0);
const maxLat = new Array(N).fill(0);
const offRoad = new Array(N).fill(0);
const recoveries = new Array(N).fill(0);
const prevMode = drivers.map((d) => d.mode);
const stuckAt = new Array(N).fill(-1);
const contactPairs = new Map();
const contactFirst = new Map();
const p = new THREE.Vector3();
const tgt = new THREE.Vector3();

const t0 = performance.now();
// Match the game loop: the world steps at 120 Hz, but the AI vehicles are
// refreshed at 60 Hz (their forces persist across the skipped step).
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
    if (d.mode === 'recover' && prevMode[i] !== 'recover') {
      recoveries[i]++;
      if (process.env.DEBUG_RECOVER) {
        console.log(`  rec car${i} t=${(step * DT).toFixed(1)} v=${cars[i].telemetry.speedKmh.toFixed(0)} ` +
          `lat=${lat.toFixed(1)} stuck=${d.stuckTime.toFixed(1)} blocked=${d.blockedTime.toFixed(1)} ` +
          `idle=${d.idleTime.toFixed(1)} phase=${d.recoverPhase} closing=${d._closing.toFixed(1)}`);
      }
    }
    prevMode[i] = d.mode;

    if (cars[i].telemetry.speedKmh < 2) {
      if (stuckAt[i] < 0) stuckAt[i] = step * DT;
    } else stuckAt[i] = -1;
  }

  // Actual contacts, not just broad-phase proximity. contactPairsWith()
  // reports every nearby pair, which made the first version look like the
  // cars were touching for seconds while they were metres apart.
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      let touching = false;
      world.contactPair(cars[i].collider, cars[j].collider, (manifold) => {
        if (manifold.numContacts() > 0) touching = true;
      });
      if (touching) {
        const key = `${i}-${j}`;
        contactPairs.set(key, (contactPairs.get(key) ?? 0) + 1);
        if (!contactFirst.has(key)) contactFirst.set(key, step * DT);
      }
    }
  }
}
const wall = (performance.now() - t0) / 1000;

console.log(`\nsimulated ${SECONDS}s with ${N} AI cars in ${wall.toFixed(1)}s wall time ` +
  `(${(SECONDS / wall).toFixed(2)}x real time)\n`);
console.log('car   dist(m)  laps   avg km/h  maxlat  offroad  recov  contacts  mode');
for (let i = 0; i < N; i++) {
  const contacts = [...contactPairs.entries()]
    .filter(([k]) => k.startsWith(`${i}-`) || k.endsWith(`-${i}`))
    .reduce((s, [, v]) => s + v, 0);
  const avg = ((progress[i] * length) / SECONDS) * 3.6;
  console.log(
    `${String(i).padStart(2)}    ` +
    `${(progress[i] * length).toFixed(0).padStart(6)}   ` +
    `${Math.floor(progress[i]).toString().padStart(2)}    ` +
    `${avg.toFixed(0).padStart(6)}    ` +
    `${maxLat[i].toFixed(1).padStart(5)}   ` +
    `${offRoad[i].toFixed(1).padStart(5)}   ` +
    `${String(recoveries[i]).padStart(5)}   ` +
    `${(contacts * DT).toFixed(2).padStart(6)}s   ${drivers[i].mode}`,
  );
}

const finished = progress.filter((x) => x >= 1).length;
const offTotal = offRoad.reduce((a, b) => a + b, 0);
const recTotal = recoveries.reduce((a, b) => a + b, 0);
const pairCount = contactPairs.size;
console.log(`\nfinished a lap : ${finished}/${N}`);
console.log(`off-road total : ${offTotal.toFixed(1)} s`);
console.log(`recoveries     : ${recTotal}`);
console.log(`cars that touched: ${pairCount > 0 ? 'yes, ' + pairCount + ' pair(s)' : 'none'}`);
if (pairCount > 0) {
  console.log('contact detail  : ' + [...contactPairs.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${(v * DT).toFixed(2)}s@${contactFirst.get(k).toFixed(1)}s`)
    .join('  '));
}
console.log(`slowest at end : ${Math.min(...cars.map((c) => c.telemetry.speedKmh)).toFixed(0)} km/h`);
console.log(`NaN            : ${cars.some((c) => !Number.isFinite(c.body.translation().x + c.telemetry.speedKmh)) ? 'YES' : 'no'}`);
