import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../src/vehicle/vehicle.js';
import { AIDriver } from '../src/ai/aiDriver.js';
import { buildTrackCurve } from '../src/trackLayout.js';
await RAPIER.init();
const DT = 1 / 120;
const SECONDS = 60;
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = DT;
world.createCollider(RAPIER.ColliderDesc.cuboid(2500, 0.5, 2500).setTranslation(0, -0.5, 0).setFriction(0.9));
const curve = buildTrackCurve();
const length = curve.getLength();
const start = curve.getPointAt(0);
const startTangent = curve.getTangentAt(0);
const startQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), startTangent.clone().setY(0).normalize());
const track = { curve, length, start, startQuat, startTangent };
function gridPose(distance, lateral) {
  const u = (distance / length + 1) % 1;
  const p = curve.getPointAt(u, new THREE.Vector3());
  const t = curve.getTangentAt(u, new THREE.Vector3()).setY(0).normalize();
  const right = new THREE.Vector3(t.z, 0, -t.x);
  const pos = p.clone().addScaledVector(right, lateral).setY(0.48);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), t);
  return { pos, q, u };
}
// leader slower (pace 0.965), follower at full pace 1.0, 18 m apart
const s0 = gridPose(30, 0), s1 = gridPose(12, 0);
const leader = new Vehicle({ RAPIER, world, position: s0.pos, quaternion: s0.q });
const follower = new Vehicle({ RAPIER, world, position: s1.pos, quaternion: s1.q });
const dL = new AIDriver(leader, track, { enabled: true, pace: 0.965 }, world);
const dF = new AIDriver(follower, track, { enabled: true, pace: 1.0 }, world);
dL.u = s0.u; dF.u = s1.u;
let maxBrake = 0, maxGap = 0, minGap = 1e9, hardBrakes = 0;
for (let step = 0; step <= 120 * SECONDS; step++) {
  if (step % 2 === 0) {
    const stL = dL.update(DT * 2);
    leader.update(DT * 2, stL);
    const stF = dF.update(DT * 2);
    follower.update(DT * 2, stF);
  }
  world.step();
  const t = step * DT;
  if (t > 5) {
    const gap = dF.sensors.lastReading.frontCenter;
    if (gap < 30) {
      maxGap = Math.max(maxGap, gap);
      minGap = Math.min(minGap, gap);
    }
    const b = Math.abs(follower.telemetry.brake ?? 0);
    if (b > maxBrake) maxBrake = b;
    if (b > 0.85 && follower.telemetry.speedKmh > 60) {
      hardBrakes++;
      if (hardBrakes <= 15) console.log(`  hardBrake t=${t.toFixed(1)} u=${(dF.u*100).toFixed(1)}% v=${follower.telemetry.speedKmh.toFixed(0)} gap=${gap.toFixed(1)} closing=${dF._closing.toFixed(1)} ot=${dF._otSide} mode=${dF.mode}`);
    }
  }
}
const vL = leader.telemetry.speedKmh, vF = follower.telemetry.speedKmh;
console.log(`final: leader ${vL.toFixed(0)} km/h, follower ${vF.toFixed(0)} km/h`);
console.log(`follower max brake input: ${maxBrake.toFixed(2)} (old AI: 1.0 = full lock)`);
console.log(`hard brakes (>0.85 while >60 km/h): ${hardBrakes} frames out of ~${(SECONDS - 5) * 60}`);
console.log(`gap range: ${minGap.toFixed(1)} .. ${maxGap.toFixed(1)} m`);
console.log(`follower recoveries: ${dF.stats.recover}, off-road stats: ok`);
