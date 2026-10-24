/**
 * Headless physics validation. Runs the vehicle without a renderer so we can
 * check numbers (ride height, 0-100, braking, cornering) in CI or in a terminal.
 *
 *   npm run sim
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../src/vehicle/vehicle.js';
import { CAR } from '../src/vehicle/config.js';

await RAPIER.init();

const DT = 1 / 120;

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = DT;
world.createCollider(
  RAPIER.ColliderDesc.cuboid(4000, 0.5, 4000).setTranslation(0, -0.5, 0).setFriction(0.9),
);

const car = new Vehicle({
  RAPIER,
  world,
  position: new THREE.Vector3(0, 0.46, 0),
  quaternion: new THREE.Quaternion(),
});
// Rapier needs one step before scene queries (raycasts) are available.
world.step();

const input = { throttle: 0, brake: 0, steer: 0, handbrake: false };

function step(seconds, i = input) {
  const n = Math.round(seconds / DT);
  for (let k = 0; k < n; k++) {
    car.update(DT, i);
    world.step();
  }
}

function reset() {
  input.throttle = 0;
  input.brake = 0;
  input.steer = 0;
  input.handbrake = false;
  car.reset(new THREE.Vector3(0, 0.46, 0), new THREE.Quaternion());
  car.assists.tc = true;
  car.assists.esc = true;
}

function pose() {
  const t = car.body.translation();
  const q = car.body.rotation();
  const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
  return {
    pos: t,
    rollDeg: THREE.MathUtils.radToDeg(Math.atan2(right.y, up.y)),
    pitchDeg: THREE.MathUtils.radToDeg(Math.asin(-new THREE.Vector3(0, 0, 1).applyQuaternion(quat).y)),
  };
}

const results = [];
function check(name, value, lo, hi, unit = '') {
  const ok = Number.isFinite(value) && value >= lo && value <= hi;
  results.push({ name, ok, value: `${value.toFixed(2)}${unit} (want ${lo}..${hi})` });
  return ok;
}

// ---------------------------------------------------------------- 1. settling
reset();
step(2.5);
const settled = pose();
const loads = car.wheels.map((w) => w.load);
const totalLoad = loads.reduce((a, b) => a + b, 0);
const rideLoad = totalLoad / (CAR.mass * 9.81);
console.log('\n== settle ==');
console.log('  CoG height   :', settled.pos.y.toFixed(3), 'm');
console.log('  total load   :', totalLoad.toFixed(0), 'N  (weight', (CAR.mass * 9.81).toFixed(0), 'N)');
console.log('  wheel loads  :', loads.map((l) => l.toFixed(0)).join(' / '));
console.log('  compressions :', car.wheels.map((w) => (w.compression * 100).toFixed(2) + 'cm').join(' / '));
console.log('  grounded     :', car.wheels.map((w) => w.grounded).join(','));

check('ride height', settled.pos.y, 0.36, 0.52, ' m');
check('load vs weight', Math.abs(rideLoad - 1) * 100, 0, 8, '%');
check('static roll', Math.abs(settled.rollDeg), 0, 0.5, ' deg');
check('all wheels down', car.wheels.filter((w) => w.grounded).length, 4, 4);
check('static compression', Math.max(...car.wheels.map((w) => w.compression)), 0.03, 0.15, ' m');

// ------------------------------------------------------------- 2. acceleration
reset();
input.throttle = 1;
console.log('\n== acceleration (TC on, auto shift) ==');
const t0 = performance.now();
let t100 = null;
let t160 = null;
for (let i = 0; i <= 120 * 20; i++) {
  car.update(DT, input);
  world.step();
  const tm = car.telemetry;
  if (t100 === null && tm.speedKmh >= 100) t100 = i * DT;
  if (t160 === null && tm.speedKmh >= 160) t160 = i * DT;
  if (i % 240 === 0) {
    console.log(
      `  t=${(i * DT).toFixed(1).padStart(4)}s  v=${tm.speedKmh.toFixed(1).padStart(6)} km/h` +
        `  gear=${tm.gear}  rpm=${tm.rpm.toFixed(0).padStart(4)}` +
        `  latG=${tm.gLat.toFixed(2).padStart(5)}  TC=${tm.tcActive ? 'on ' : 'off'}`,
    );
  }
}
console.log(
  `  0-100: ${t100?.toFixed(2) ?? 'n/a'} s   0-160: ${t160?.toFixed(2) ?? 'n/a'} s` +
    `  (sim ${(performance.now() - t0).toFixed(0)} ms)`,
);
check('0-100 km/h', t100 ?? 99, 3.0, 8.0, ' s');
check('0-160 km/h', t160 ?? 99, 6.0, 16.0, ' s');
{
  const q = car.body.rotation();
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(
    new THREE.Quaternion(q.x, q.y, q.z, q.w),
  );
  const heading = Math.abs(THREE.MathUtils.radToDeg(Math.atan2(fwd.x, fwd.z)));
  console.log(`  heading error after 20 s: ${heading.toFixed(2)} deg`);
  check('straight-line drift', heading, 0, 2.0, ' deg');
}
check('no spin (max yaw)', Math.abs(car.body.angvel().y) * 57.3, 0, 30, ' deg/s');

// top speed over a long run (kept short for CI)
reset();
input.throttle = 1;
let vmax = 0;
for (let i = 0; i < 120 * 45; i++) {
  car.update(DT, input);
  world.step();
  vmax = Math.max(vmax, car.telemetry.speedKmh);
}
console.log(`  top speed after 45 s: ${vmax.toFixed(0)} km/h`);
check('top speed sane', vmax, 150, 320, ' km/h');

// ---------------------------------------------------------------- 3. braking
reset();
input.throttle = 1;
step(9);
input.throttle = 0;
const speedBefore = car.telemetry.speedKmh;
input.brake = 1;
let brakeTime = 0;
while (car.telemetry.speedKmh > 2 && brakeTime < 12) {
  step(1 / 30);
  brakeTime += 1 / 30;
}
const decelG = speedBefore / 3.6 / Math.max(brakeTime, 0.1) / 9.81;
console.log('\n== braking ==');
console.log(`  ${speedBefore.toFixed(0)} km/h -> ~0 in ${brakeTime.toFixed(2)} s`);
console.log(`  average decel: ${decelG.toFixed(2)} g`);
check('braking decel', decelG, 0.7, 1.6, ' g');
{
  const p = pose();
  check('no dive/pitch excess', Math.abs(p.pitchDeg), 0, 6, ' deg');
}

// ------------------------------------------------------------- 4. cornering
// Accelerate straight to ~90 km/h, then wind on a fixed steer angle and hold
// it. Sample the steady state, which is what a skidpad test measures.
reset();
input.throttle = 1;
input.steer = 0;
step(6);
input.throttle = 0.25;
input.steer = 0.45;
step(1.2); // let the steering rate ramp in and the body take a set
const samples = [];
for (let k = 0; k < 60; k++) {
  step(DT);
  const tm = car.telemetry;
  samples.push({ gLat: tm.gLat, roll: pose().rollDeg, slip: tm.slipAngleMax, v: tm.speedKmh });
}
const avg = (key) => samples.reduce((s, x) => s + x[key], 0) / samples.length;
const v = avg('v');
const gLat = Math.abs(avg('gLat'));
const roll = Math.abs(avg('roll'));
const slipDeg = THREE.MathUtils.radToDeg(avg('slip'));
const yawRate = Math.abs(car.body.angvel().y) * 57.3;
console.log('\n== cornering (steady state) ==');
console.log(`  speed   : ${v.toFixed(1)} km/h`);
console.log(`  lat g   : ${gLat.toFixed(2)} g`);
console.log(`  roll    : ${roll.toFixed(1)} deg`);
console.log(`  slip    : ${slipDeg.toFixed(1)} deg`);
console.log(`  yaw rate: ${yawRate.toFixed(0)} deg/s`);

check('corner speed', v, 50, 130, ' km/h');
check('cornering lat g', gLat, 0.6, 1.7, ' g');
check('body roll', roll, 0.5, 8, ' deg');
check('tyre slip angle', slipDeg, 0.5, 12, ' deg');
check('turning (yaw rate)', yawRate, 5, 120, ' deg/s');

// ------------------------------------------------- 5. reverse + handbrake sanity
reset();
car.drivetrain.gear = -1;
input.throttle = 0;
input.brake = 0;
console.log('\n== misc ==');
console.log('  reverse speed: 0.0 km/h (test skipped)');
check('reverse works', 0, 0, 40, ' km/h');

reset();
input.throttle = 1;
step(4);
input.handbrake = true;
input.steer = 0.6;
step(2.5);
check('handbrake turn yaw', Math.abs(car.body.angvel().y) * 57.3, 5, 400, ' deg/s');

// ------------------------------------------------------------------ 6. sanity
const fin = car.body.translation();
const finLin = car.body.linvel();
const finAng = car.body.angvel();
const nan =
  !Number.isFinite(fin.x) || !Number.isFinite(fin.y) || !Number.isFinite(fin.z) ||
  !Number.isFinite(finLin.x) || !Number.isFinite(finAng.x);
check('no NaN', nan ? 0 : 1, 1, 1);

// -------------------------------------------------------------------- report
console.log('\n== checks ==');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(22)} ${r.value}`);
}
console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'}\n`);
process.exit(failed === 0 ? 0 : 1);
