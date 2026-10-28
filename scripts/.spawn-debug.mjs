import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../src/vehicle/vehicle.js';
import { AIDriver } from '../src/ai/aiDriver.js';
import { buildTrackCurve } from '../src/trackLayout.js';
await RAPIER.init();
const DT = 1 / 120;
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = DT;
world.createCollider(RAPIER.ColliderDesc.cuboid(2500, 0.5, 2500).setTranslation(0, -0.5, 0).setFriction(0.9));
const curve = buildTrackCurve();
const length = curve.getLength();
const start = curve.getPointAt(0);
const startTangent = curve.getTangentAt(0);
const startQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), startTangent.clone().setY(0).normalize());
const track = { curve, length, start, startQuat, startTangent };
console.log('track start (u=0):', start.x.toFixed(1), start.z.toFixed(1), 'len', length.toFixed(0));
const P = new THREE.Vector3();
for (const d of [12, 60]) {
  const u = (d / length + 1) % 1;
  curve.getPointAt(u, P);
  console.log(`grid ${d}m: u=${u.toFixed(4)} pos=(${P.x.toFixed(1)},${P.z.toFixed(1)}) s=${(u*length).toFixed(0)}`);
}
// spawn one car like the field test does (car 8)
const ROW_GAP = 12, COL = 3;
const i = 8, row = 4, col = 0;
const distance = ROW_GAP * (row + 1);
const u = (distance / length + 1) % 1;
const p = curve.getPointAt(u, new THREE.Vector3());
const t = curve.getTangentAt(u, new THREE.Vector3()).setY(0).normalize();
const right = new THREE.Vector3(t.z, 0, -t.x);
const pos = p.clone().addScaledVector(right, col === 0 ? -COL : COL).setY(0.48);
const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), t);
const car = new Vehicle({ RAPIER, world, position: pos, quaternion: q });
const driver = new AIDriver(car, track, { enabled: true }, world);
driver.u = u;
console.log('car8 spawn pos:', pos.x.toFixed(1), pos.z.toFixed(1), 'driver.u', u.toFixed(4));
for (let s = 0; s < 10; s++) {
  const st = driver.update(DT * 2);
  car.update(DT * 2, st);
  world.step();
}
const tp = car.body.translation();
console.log('after 0.16s: pos', tp.x.toFixed(1), tp.z.toFixed(1), 'driver.u', driver.u.toFixed(4), 'v', car.telemetry.speedKmh.toFixed(1), 'mode', driver.mode);
