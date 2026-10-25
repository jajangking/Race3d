/**
 * Traffic test: the only real obstacle in the game is the player's car.
 * Park one on the racing line and make sure the AI goes around it instead of
 * rear-ending it or stopping behind it forever.
 *
 *   node scripts/ai-traffic-test.mjs
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../src/vehicle/vehicle.js';
import { AIDriver } from '../src/ai/aiDriver.js';

await RAPIER.init();
const DT = 1 / 120;
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = DT;
world.createCollider(
  RAPIER.ColliderDesc.cuboid(2500, 0.5, 2500).setTranslation(0, -0.5, 0).setFriction(0.9),
);

const pts = [];
for (let i = 0; i < 18; i++) {
  const a = (i / 18) * Math.PI * 2;
  const r = 158 + 46 * Math.sin(3 * a + 0.4) + 20 * Math.sin(5 * a + 1.1);
  pts.push(new THREE.Vector3(Math.cos(a) * r * 1.28, 0, Math.sin(a) * r * 0.82));
}
const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
const length = curve.getLength();
const start = curve.getPointAt(0);
const startTangent = curve.getTangentAt(0);
const startQuat = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 0, 1), startTangent.clone().setY(0).normalize());
const track = { curve, length, start, startQuat, startTangent };

const _p = new THREE.Vector3();
const _t = new THREE.Vector3();

function poseAt(u, lateral = 0) {
  curve.getPointAt(u, _p);
  curve.getTangentAt(u, _t);
  _t.y = 0;
  _t.normalize();
  const right = new THREE.Vector3(_t.z, 0, -_t.x);
  const pos = _p.clone().addScaledVector(right, lateral).setY(0.48);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), _t);
  return { pos, q };
}

// AI starts `LEAD` metres behind a stopped car sitting on the centreline
const START_U = 0.10;
const LEAD = Number(process.argv[2] ?? 20);
const OBS_U = START_U + LEAD / length;
const aiPose = poseAt(START_U);
const obsPose = poseAt(OBS_U);

const car = new Vehicle({ RAPIER, world, position: aiPose.pos, quaternion: aiPose.q });
const obstacle = new Vehicle({ RAPIER, world, position: obsPose.pos, quaternion: obsPose.q });
world.step();
const ai = new AIDriver(car, track, { enabled: true }, world);
ai.u = START_U;

let minDist = Infinity;
let progress = 0;
let lastProgress = 0;
let prevMode = ai.mode;
let recoveries = 0;
let touched = false;
let contactSteps = 0;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

// Match the game loop: AI vehicles refresh at 60 Hz, world steps at 120 Hz.
for (let i = 0; i <= 120 * 30; i++) {
  if (i % 2 === 0) {
    const aiState = ai.update(DT * 2);
    car.update(DT * 2, aiState);
  }
  obstacle.update(DT, { throttle: 0, brake: 0, steer: 0, handbrake: false });
  world.step();

  const a = car.body.translation();
  const o = obstacle.body.translation();
  _a.set(a.x, a.y, a.z);
  _b.set(o.x, o.y, o.z);
  minDist = Math.min(minDist, _a.distanceTo(_b));
  // Real physics contact. contactPairsWith() only tells us the narrow phase
  // is tracking a nearby pair, so read the manifold and count actual contacts.
  let touchingThisStep = false;
  world.contactPair(car.collider, obstacle.collider, (manifold) => {
    if (manifold.numContacts() > 0) touchingThisStep = true;
  });
  if (touchingThisStep) {
    touched = true;
    contactSteps++;
  }

  // progress along the AI's own path, measured from the nearest centre point
  let best = Infinity, bu = 0;
  for (let k = 0; k < 300; k++) {
    curve.getPointAt(k / 300, _p);
    const d = _p.distanceToSquared(_a);
    if (d < best) { best = d; bu = k / 300; }
  }
  let du = (bu - START_U + 1) % 1;
  if (du > 0.5) du = 0;
  progress += du * length;
  // do not double count: recompute absolute distance from start instead
  lastProgress = Math.max(lastProgress, du * length);

  if (ai.mode === 'recover' && prevMode !== 'recover') recoveries++;
  prevMode = ai.mode;

  if (i % 120 === 0) {
    curve.getPointAt(bu, _p);
    const right = new THREE.Vector3(_t.z, 0, -_t.x);
    const lat = _a.clone().sub(_p).dot(right);
    const front = ai.sensors.lastReading?.front ?? -1;
    console.log(
      `t=${String(i / 120).padStart(2)}s v=${car.telemetry.speedKmh.toFixed(0).padStart(3)} km/h ` +
      `dist=${_a.distanceTo(_b).toFixed(1).padStart(5)} m front=${front.toFixed(1).padStart(4)} ` +
      `lat=${lat.toFixed(1).padStart(5)} mode=${ai.mode.padEnd(7)} gear=${car.telemetry.gear}`,
    );
  }
}

const a = car.body.translation();
const o = obstacle.body.translation();
const finalDist = new THREE.Vector3(a.x, a.y, a.z).distanceTo(new THREE.Vector3(o.x, o.y, o.z));
const passed = lastProgress > 32;
console.log(`\nlead             : ${LEAD} m`);
console.log(`closest approach : ${minDist.toFixed(2)} m`);
console.log(`contact with car : ${touched ? `YES (${(contactSteps * DT).toFixed(2)} s)` : 'none'}`);
console.log(`distance now     : ${finalDist.toFixed(1)} m`);
console.log(`progress past car: ${lastProgress.toFixed(0)} m`);
console.log(`recoveries       : ${recoveries}`);
console.log(`result           : ${passed ? 'PASSED the stopped car' : 'FAILED to get past'}`);
process.exit(passed && !touched ? 0 : 1);
