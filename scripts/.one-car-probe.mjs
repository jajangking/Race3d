import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../src/vehicle/vehicle.js';
import { AIDriver } from '../src/ai/aiDriver.js';
import { buildTrackCurve } from '../src/trackLayout.js';

await RAPIER.init();
const DT = 1 / 120;
const SECONDS = 30;
const N = 10;
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = DT;
world.createCollider(RAPIER.ColliderDesc.cuboid(2500, 0.5, 2500).setTranslation(0, -0.5, 0).setFriction(0.9));
const curve = buildTrackCurve();
const length = curve.getLength();
const start = curve.getPointAt(0);
const startTangent = curve.getTangentAt(0);
const startQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), startTangent.clone().setY(0).normalize());
const track = { curve, length, start, startQuat, startTangent };
const ROW_GAP = 12, COL = 3;
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
const cars = [], drivers = [];
for (let i = 0; i < N; i++) {
  const row = Math.floor(i / 2), col = i % 2;
  const slot = gridPose(ROW_GAP * (row + 1), col === 0 ? -COL : COL);
  const car = new Vehicle({ RAPIER, world, position: slot.pos, quaternion: slot.q });
  const driver = new AIDriver(car, track, { enabled: true, pace: PACE[i], lineScale: LINE[i], laneBias: BIAS[i], laneOffset: (col === 0 ? -COL : COL) + (((i * 5) % 7) - 3) * 0.18 }, world);
  driver.u = slot.u;
  cars.push(car); drivers.push(driver);
}
world.step();
const WATCH = [9, 5];
for (let step = 0; step <= 120 * SECONDS; step++) {
  if (step % 2 === 0) {
    for (let i = 0; i < N; i++) {
      const st = drivers[i].update(DT * 2);
      cars[i].update(DT * 2, st);
    }
  }
  world.step();
  const t = step * DT;
  if (t >= 10 && t <= 28 && Math.abs(t * 2 - Math.round(t * 2)) < 1e-6) {
    for (const i of WATCH) {
      const d = drivers[i];
      const s = d.sensors.lastReading;
      console.log(
        `t=${t.toFixed(1)} car=${i} u=${(d.u * 100).toFixed(1)}% v=${cars[i].telemetry.speedKmh.toFixed(0)} mode=${d.mode} phase=${d.recoverPhase ?? ''} blk=${s.frontCenter.toFixed(1)} close=${d._closing.toFixed(1)} follow=${d._following} ot=${d._otSide} thr=${(d._lastThr ?? 0).toFixed(2)}`
      );
    }
  }
}
