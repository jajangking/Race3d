/**
 * Long-run AI check: does it complete laps without getting stuck, spinning
 * or wandering off the road?
 *
 *   node scripts/ai-lap-test.mjs [seconds]
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../src/vehicle/vehicle.js';
import { AIDriver } from '../src/ai/aiDriver.js';
import { buildTrackCurve } from '../src/trackLayout.js';

await RAPIER.init();
const DT = 1 / 120;
const SECONDS = Number(process.argv[2] ?? 180);

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = DT;
world.createCollider(RAPIER.ColliderDesc.cuboid(2500, 0.5, 2500).setTranslation(0, -0.5, 0).setFriction(0.9));

// the game's actual circuit (src/trackLayout.js), not a test oval
const curve = buildTrackCurve();
const length = curve.getLength();
const start = curve.getPointAt(0);
const startTangent = curve.getTangentAt(0);
const startQuat = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 0, 1), startTangent.clone().setY(0).normalize());
const track = { curve, length, start, startQuat, startTangent };

const car = new Vehicle({ RAPIER, world, position: new THREE.Vector3(start.x, 0.46, start.z), quaternion: startQuat });
world.step();
const ai = new AIDriver(car, track, { enabled: true }, world);

const _p = new THREE.Vector3();
function nearestU(pos) {
  let best = Infinity, bu = 0;
  for (let i = 0; i < 400; i++) {
    curve.getPointAt(i / 400, _p);
    const d = _p.distanceToSquared(pos);
    if (d < best) { best = d; bu = i / 400; }
  }
  return bu;
}

let lastU = 0, progress = 0, laps = 0;
let latMax = 0, vMax = 0, vSum = 0, samples = 0;
let recoveries = 0, prevMode = 'race', offRoadTime = 0;
let stuckStart = -1;
let nanSeen = false;

for (let i = 0; i <= 120 * SECONDS; i++) {
  if (i % 2 === 0) {
    const st = ai.update(DT * 2);
    car.update(DT * 2, st);
  }
  world.step();

  const tr = car.body.translation();
  const pos = new THREE.Vector3(tr.x, tr.y, tr.z);
  if (!Number.isFinite(tr.x + tr.y + tr.z + car.telemetry.speedKmh)) nanSeen = true;
  const u = nearestU(pos);
  curve.getPointAt(u, _p);
  const lat = Math.hypot(pos.x - _p.x, pos.z - _p.z);
  latMax = Math.max(latMax, lat);
  const v = car.telemetry.speedKmh;
  vMax = Math.max(vMax, v);
  vSum += v; samples++;
  if (lat > 8) offRoadTime += DT;

  const du = (u - lastU + 1) % 1;
  if (du < 0.5) progress += du; else progress -= 1 - du;
  if (progress >= 1) { progress -= 1; laps++; }
  lastU = u;

  if (ai.mode === 'recover' && prevMode !== 'recover') recoveries++;
  prevMode = ai.mode;

  if (v < 2) { if (stuckStart < 0) stuckStart = i * DT; }
  else stuckStart = -1;
  if (stuckStart >= 0 && i * DT - stuckStart > 5) {
    console.log(`STUCK for 5 s at t=${(i * DT).toFixed(1)} u=${u.toFixed(3)} lat=${lat.toFixed(1)}`);
    stuckStart = -1e9;
  }
}

console.log(`\nsimulated      : ${SECONDS} s`);
console.log(`laps           : ${laps}`);
console.log(`progress       : ${(progress * 100).toFixed(0)} % of a lap`);
console.log(`distance       : ${((laps + progress) * length).toFixed(0)} m`);
console.log(`avg speed      : ${(vSum / samples).toFixed(1)} km/h`);
console.log(`max speed      : ${vMax.toFixed(1)} km/h`);
console.log(`max lateral    : ${latMax.toFixed(2)} m  (road half width 7 m)`);
console.log(`off-road time  : ${offRoadTime.toFixed(1)} s`);
console.log(`recoveries     : ${recoveries}`);
console.log(`NaN seen       : ${nanSeen ? 'YES' : 'no'}`);
