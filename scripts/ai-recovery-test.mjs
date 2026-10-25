/**
 * Recovery-mode checks for the AI: wrong way, flipped, and way off the road.
 * Each scenario drops the car into a bad pose and checks that the driver gets
 * itself back to racing within a reasonable time.
 *
 *   node scripts/ai-recovery-test.mjs
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

const car = new Vehicle({ RAPIER, world, position: new THREE.Vector3(start.x, 0.46, start.z), quaternion: startQuat });
world.step();
const ai = new AIDriver(car, track, { enabled: true }, world);

const _p = new THREE.Vector3();
const _tan = new THREE.Vector3();

function trackPose(u) {
  curve.getPointAt(u, _p);
  curve.getTangentAt(u, _tan);
  _tan.y = 0;
  _tan.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), _tan);
  return { p: _p.clone(), tan: _tan.clone(), q };
}

function nearestU(pos) {
  let best = Infinity, bu = 0;
  for (let i = 0; i < 400; i++) {
    curve.getPointAt(i / 400, _p);
    const d = _p.distanceToSquared(pos);
    if (d < best) { best = d; bu = i / 400; }
  }
  return bu;
}

function state() {
  const t = car.body.translation();
  const r = car.body.rotation();
  const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  const pos = new THREE.Vector3(t.x, t.y, t.z);
  const u = nearestU(pos);
  const { p, tan } = trackPose(u);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q).setY(0).normalize();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const right = new THREE.Vector3(tan.z, 0, -tan.x);
  return {
    u,
    pos,
    lat: new THREE.Vector3(t.x - p.x, 0, t.z - p.z).dot(right),
    align: fwd.dot(tan),
    upright: up.y,
    speed: car.telemetry.speedKmh,
  };
}

function runScenario(name, setup, seconds = 40, aiHook = null) {
  const { p, tan, q } = trackPose(0.1);
  const right = new THREE.Vector3(tan.z, 0, -tan.x);
  const pose = setup({ p, tan, q, right });

  car.reset(pose.position, pose.quaternion);
  ai.mode = 'race';
  ai.spawnGrace = 0;
  ai.stuckTime = 0;
  ai.blockedTime = 0;
  ai.recoverTime = 0;
  ai.reverseTime = 0;
  ai.prevError = 0;
  if (aiHook) aiHook(ai, car);
  world.step();

  let recoveredAt = null;
  let recoveries = 0;
  let prevMode = ai.mode;
  let history = [];
  for (let i = 0; i <= 120 * seconds; i++) {
    if (i % 2 === 0) {
      const st = ai.update(DT * 2);
      car.update(DT * 2, st);
    }
    world.step();
    if (ai.mode === 'recover' && prevMode !== 'recover') recoveries++;
    prevMode = ai.mode;
    const s = state();
    if (i % 120 === 0) {
      history.push(
        `  t=${String(i / 120).padStart(2)}s mode=${ai.mode.padEnd(7)} gear=${car.telemetry.gear.padStart(2)} ` +
        `v=${s.speed.toFixed(0).padStart(3)} km/h align=${s.align.toFixed(2).padStart(5)} ` +
        `lat=${s.lat.toFixed(1).padStart(6)} upright=${s.upright.toFixed(2).padStart(5)}`,
      );
    }
    if (recoveredAt === null && ai.mode === 'race' && s.align > 0.7 && Math.abs(s.lat) < 7 && s.upright > 0.9 && s.speed > 10) {
      recoveredAt = i * DT;
    }
  }
  const s = state();
  console.log(`\n== ${name} ==`);
  console.log(history.slice(0, 12).join('\n'));
  console.log(
    `  result: ${recoveredAt !== null ? `recovered in ${recoveredAt.toFixed(1)} s` : 'NOT RECOVERED'} | ` +
    `mode=${ai.mode} align=${s.align.toFixed(2)} lat=${s.lat.toFixed(1)} upright=${s.upright.toFixed(2)} ` +
    `recoveries=${recoveries}`,
  );
  return { recoveredAt, s, recoveries };
}

// ---------------------------------------------------------------- scenarios
runScenario('wrong way (180 deg)', ({ p, q }) => ({
  position: p.clone().setY(0.46),
  quaternion: q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)),
}));

runScenario('flipped on its roof', ({ p, q }) => ({
  position: p.clone().setY(1.1),
  quaternion: q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)),
}));

runScenario('15 m off the road', ({ p, q, right }) => ({
  position: p.clone().addScaledVector(right, 15).setY(0.46),
  quaternion: q.clone(),
}));

runScenario('sideways across the track', ({ p, q }) => ({
  position: p.clone().setY(0.46),
  quaternion: q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)),
}));

// exercises the "back out first" path that a wedged car uses
runScenario('jammed, forced reverse phase', ({ p, q }) => ({
  position: p.clone().setY(0.46),
  quaternion: q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)),
}), 40, (ai, car) => {
  ai.mode = 'recover';
  ai.recoverPhase = 'reverse';
  ai.reverseDir = 1;
  ai.recoverTime = 0;
  car.drivetrain.gear = -1;
});
