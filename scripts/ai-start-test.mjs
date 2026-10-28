/**
 * Launch check from many points around the lap. The old AI only worked from
 * the start line; this drops it at 8 different places and makes sure it gets
 * up to speed and stays on the road every time.
 *
 *   node scripts/ai-start-test.mjs
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../src/vehicle/vehicle.js';
import { AIDriver } from '../src/ai/aiDriver.js';
import { buildTrackCurve } from '../src/trackLayout.js';

await RAPIER.init();
const DT = 1 / 120;
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

const car = new Vehicle({ RAPIER, world, position: new THREE.Vector3(start.x, 0.46, start.z), quaternion: startQuat });
world.step();
const ai = new AIDriver(car, track, { enabled: true }, world);

const _p = new THREE.Vector3();
const _t = new THREE.Vector3();

function nearestU(pos) {
  let best = Infinity, bu = 0;
  for (let i = 0; i < 400; i++) {
    curve.getPointAt(i / 400, _p);
    const d = _p.distanceToSquared(pos);
    if (d < best) { best = d; bu = i / 400; }
  }
  return bu;
}

function resetAi(u) {
  ai.mode = 'race';
  ai.u = u;
  ai.spawnGrace = 0;
  ai.stuckTime = 0;
  ai.blockedTime = 0;
  ai.idleTime = 0;
  ai.recoverTime = 0;
  ai.recoverPhase = 'reverse';
  ai.prevError = 0;
  ai.reverseTime = 0;
  ai.lastSpeed = 0;
}

console.log('  spawn                    t=5s    t=10s   t=20s   maxlat  offroad  recov  mode');
let failures = 0;

for (let s = 0; s < 8; s++) {
  const u0 = s / 8;
  curve.getPointAt(u0, _p);
  curve.getTangentAt(u0, _t);
  _t.y = 0;
  _t.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), _t);
  car.reset(new THREE.Vector3(_p.x, 0.48, _p.z), q);
  resetAi(u0);
  world.step();

  let v5 = 0, v10 = 0, v20 = 0;
  let latMax = 0, offRoad = 0, recoveries = 0, prevMode = ai.mode;
  for (let i = 0; i <= 120 * 20; i++) {
    if (i % 2 === 0) {
      const st = ai.update(DT * 2);
      car.update(DT * 2, st);
    }
    world.step();
    const t = car.body.translation();
    const pos = new THREE.Vector3(t.x, t.y, t.z);
    const u = nearestU(pos);
    curve.getPointAt(u, _p);
    const lat = Math.hypot(pos.x - _p.x, pos.z - _p.z);
    latMax = Math.max(latMax, lat);
    if (lat > 8) offRoad += DT;
    if (ai.mode === 'recover' && prevMode !== 'recover') recoveries++;
    prevMode = ai.mode;
    if (i === 120 * 5) v5 = car.telemetry.speedKmh;
    if (i === 120 * 10) v10 = car.telemetry.speedKmh;
    if (i === 120 * 20) v20 = car.telemetry.speedKmh;
  }
  const ok = v20 > 40 && offRoad < 3 && latMax < 9;
  if (!ok) failures++;
  console.log(
    `  u=${u0.toFixed(3)}  ${ok ? 'PASS' : 'FAIL'}   ` +
    `${v5.toFixed(0).padStart(5)}   ${v10.toFixed(0).padStart(5)}   ${v20.toFixed(0).padStart(5)}   ` +
    `${latMax.toFixed(1).padStart(5)}   ${offRoad.toFixed(1).padStart(5)}   ${String(recoveries).padStart(5)}  ${ai.mode}`,
  );
}

console.log(`\n${failures === 0 ? 'ALL SPAWNS PASSED' : failures + ' SPAWN(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
