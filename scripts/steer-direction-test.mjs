/**
 * Empirical steering-direction check.
 *
 * Drives straight, then applies input.steer = +1 and input.steer = -1
 * separately and measures which way the car's heading rotates.
 *
 * Vehicle convention (src/vehicle/vehicle.js):
 *   wheel.steer is applied as _fwd = (sin(steer), 0, cos(steer)) in body space,
 *   body +Z = forward, +X = right  =>  positive steer angle = wheel points RIGHT.
 *
 * AI convention (src/ai/aiDriver.js):
 *   ffAngle = -atan(wheelbase * kAhead), kAhead > 0 = LEFT-hand corner
 *   =>  AI commands NEGATIVE steer for a left turn.
 *
 * Input convention (src/input.js):
 *   KeyA / ArrowLeft  -> steer += 1  (POSITIVE)
 *   KeyD / ArrowRight -> steer -= 1  (NEGATIVE)
 *
 * If the car turns RIGHT when input.steer = +1, the vehicle+AI convention is
 * "negative = left" and the keyboard mapping is inverted.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../src/vehicle/vehicle.js';

await RAPIER.init();
const DT = 1 / 120;

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = DT;
world.createCollider(
  RAPIER.ColliderDesc.cuboid(4000, 0.5, 4000).setTranslation(0, -0.5, 0).setFriction(0.9),
);

function heading(q) {
  return new THREE.Vector3(0, 0, 1).applyQuaternion(q);
}

async function runTrial(steerInput) {
  const car = new Vehicle({
    RAPIER,
    world,
    position: new THREE.Vector3(0, 0.46, 0),
    quaternion: new THREE.Quaternion(),
  });
  world.step();

  const input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  const step = (seconds) => {
    for (let k = 0; k < Math.round(seconds / DT); k++) {
      car.update(DT, input);
      world.step();
    }
  };

  // get up to ~80 km/h on the straight
  input.throttle = 1;
  step(3.5);
  input.throttle = 0;
  const q0 = car.body.rotation();
  const h0 = heading(new THREE.Quaternion(q0.x, q0.y, q0.z, q0.w));

  // now steer full lock in the requested direction
  input.steer = steerInput;
  step(1.2);
  const q1 = car.body.rotation();
  const h1 = heading(new THREE.Quaternion(q1.x, q1.y, q1.z, q1.w));

  // h0 = (0,0,1). A right turn rotates the heading towards +X: h1 = (sin,0,cos)
  // so cross(h0,h1).y = -sin < 0. A left turn gives cross(h0,h1).y > 0.
  const crossY = h0.x * h1.z - h0.z * h1.x;
  return {
    steerInput,
    speedKmh: Math.abs(car.telemetry.speed) * 3.6,
    crossY,
    direction: crossY < -0.001 ? 'RIGHT' : crossY > 0.001 ? 'LEFT' : 'STRAIGHT',
  };
}

const a = await runTrial(1);
const b = await runTrial(-1);
console.log('input.steer = +1  ->', a.direction, `(${a.speedKmh.toFixed(0)} km/h at start of trial)`);
console.log('input.steer = -1  ->', b.direction, `(${b.speedKmh.toFixed(0)} km/h at start of trial)`);

const vehicleSaysPositiveIsRight = a.direction === 'RIGHT' && b.direction === 'LEFT';
console.log('');
if (vehicleSaysPositiveIsRight) {
  console.log('VERDICT: vehicle convention = "positive steer input turns RIGHT".');
  console.log('  AI sends negative steer for left corners  -> AI is CONSISTENT with the vehicle.');
  console.log('  Keyboard: A/left sends +1  -> A turns the car RIGHT  -> INVERTED BUG in src/input.js');
  console.log('  Keyboard: D/right sends -1 -> D turns the car LEFT   -> INVERTED BUG in src/input.js');
  console.log('  Gamepad left stick sends -1 for left -> gamepad is CORRECT.');
} else {
  console.log('VERDICT: unexpected behaviour, inspect manually:', a, b);
}
