/**
 * Scratch probe (not a real test): identical setup to ai-field-test.mjs, but
 * whenever a physical contact event fires it also dumps the two drivers'
 * sensor/jam state so we can see WHY a lock forms and whether the yield
 * logic even sees it.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../src/vehicle/vehicle.js';
import { AIDriver } from '../src/ai/aiDriver.js';
import { buildTrackCurve } from '../src/trackLayout.js';

await RAPIER.init();
const DT = 1 / 120;
const SECONDS = Number(process.argv[2] ?? 60);
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

const p = new THREE.Vector3();
const latOf = (i) => {
  const u = drivers[i].u;
  curve.getPointAt(u, p);
  const t = cars[i].body.translation();
  return Math.hypot(t.x - p.x, t.z - p.z);
};

const MAX_LOGS = 140;
let logs = 0;
const logJam = (i, j, t) => {
  if (logs >= MAX_LOGS) return;
  logs++;
  const a = drivers[i], b = drivers[j];
  const s = (d) => `L${d._jamL.toFixed(1)}R${d._jamR.toFixed(1)}y${(d._jamYield * 100 | 0)}`;
  console.log(
    `t=${t.toFixed(1)} car${i} vs car${j}  ` +
    `i[lat=${latOf(i).toFixed(1)} L=${a.sensors.lastReading.left.toFixed(2)} R=${a.sensors.lastReading.right.toFixed(2)} ` +
    `FL=${a.sensors.lastReading.frontLeft.toFixed(1)} FR=${a.sensors.lastReading.frontRight.toFixed(1)} F=${a.sensors.lastReading.front.toFixed(1)} ${s(a)} v=${cars[i].telemetry.speedKmh.toFixed(0)}] ` +
    `j[lat=${latOf(j).toFixed(1)} L=${b.sensors.lastReading.left.toFixed(2)} R=${b.sensors.lastReading.right.toFixed(2)} ` +
    `FL=${b.sensors.lastReading.frontLeft.toFixed(1)} FR=${b.sensors.lastReading.frontRight.toFixed(1)} F=${b.sensors.lastReading.front.toFixed(1)} ${s(b)} v=${cars[j].telemetry.speedKmh.toFixed(0)}]`,
  );
};

let lastLogStep = new Map();
for (let step = 0; step <= 120 * SECONDS; step++) {
  if (step % 2 === 0) {
    for (let i = 0; i < N; i++) {
      const st = drivers[i].update(DT * 2);
      cars[i].update(DT * 2, st);
    }
  }
  world.step();

  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      let touching = false;
      world.contactPair(cars[i].collider, cars[j].collider, (manifold) => {
        if (manifold.numContacts() > 0) touching = true;
      });
      if (touching) {
        const key = `${i}-${j}`;
        const last = lastLogStep.get(key) ?? -1;
        if (step - last > 40) {
          lastLogStep.set(key, step);
          logJam(i, j, step * DT);
        }
      }
    }
  }
}
console.log(`\n(probe done, ${logs} contact samples logged)`);
