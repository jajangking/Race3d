import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { clamp } from '../vehicle/config.js';
import { AISensors } from './aiSensors.js';
import { AILearner } from './aiLearner.js';

const _pos = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _right = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _to = new THREE.Vector3();
const _up = new THREE.Vector3();

/**
 * Simple but robust AI for the custom raycast vehicle.
 * - Path follows the track centerline with lookahead
 * - Speed adapts to curvature
 * - Detects being stuck / going backwards relative to track -> reverses & turns around naturally
 * - Tries to re-align to track direction
 */
export class AIDriver {
  constructor(car, track, opts = {}, world = null) {
    this.car = car;
    this.track = track;
    this.curve = track.curve;
    this.length = track.length;
    this.world = world;

    this.enabled = opts.enabled !== false;

    // sensors + learner
    this.sensors = new AISensors(car, world);
    this.learner = new AILearner();

    // tuning
    this.lookaheadBase = opts.lookaheadBase ?? 16;
    this.lookaheadSpeed = opts.lookaheadSpeed ?? 0.42;
    this.steerP = opts.steerP ?? 0.02;
    this.steerD = opts.steerD ?? 0.01;
    this.maxSteer = opts.maxSteer ?? 0.98;
    this.speedFactor = opts.speedFactor ?? 1.0;

    // state
    this.u = 0;
    this.prevError = 0;
    this.stuckTime = 0;
    this.recoverTime = 0;
    this.reverseTime = 0;
    this.lastSpeed = 0;
    this.mode = 'race'; // race | reverse | recover | avoid
    this.reverseDir = 1;
    this._lastGear = 1;
    this.lastPos = null;
    this.blockedTime = 0;
    this.avoidTimer = 0;
    this.spawnGrace = 0;
  }

  _getNearestU(pos) {
    // coarse search
    let best = Infinity;
    let bestU = this.u;
    const start = Math.floor((this.u - 0.08) * 400 + 400) % 400;
    for (let i = 0; i < 160; i++) {
      const idx = (start + i) % 400;
      const u = idx / 400;
      this.curve.getPointAt(u, _pos);
      const dx = _pos.x - pos.x;
      const dz = _pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        bestU = u;
      }
    }
    return bestU;
  }

  _getCurvature(u) {
    const u1 = (u - 0.002 + 1) % 1;
    const u2 = (u + 0.002) % 1;
    this.curve.getTangentAt(u1, _tan);
    const t1x = _tan.x, t1z = _tan.z;
    this.curve.getTangentAt(u2, _tan);
    const t2x = _tan.x, t2z = _tan.z;
    const dx = t2x - t1x;
    const dz = t2z - t1z;
    const d = Math.hypot(dx, dz);
    return d / 0.004;
  }

  update(dt) {
    if (!this.enabled) return { throttle: 0, brake: 0, steer: 0, handbrake: false };
    if (this.spawnGrace < 2.0) this.spawnGrace += dt;
    const body = this.car.body;
    const t = body.translation();
    const pos = new THREE.Vector3(t.x, t.y, t.z);
    if (!this.lastPos) this.lastPos = pos.clone();
    const moved = pos.distanceTo(this.lastPos);
    this.lastPos.copy(pos);

    const r = body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);

    // velocity
    const v = body.linvel();
    _vel.set(v.x, v.y, v.z);
    const speed = _vel.length();
    const speedKmh = speed * 3.6;

    // sensors
    const sense = this.sensors.sense();

    // find nearest on track
    this.u = this._getNearestU(pos);
    this.curve.getPointAt(this.u, _pos);
    this.curve.getTangentAt(this.u, _tan);
    _tan.y = 0;
    _tan.normalize();

    // lateral error
    _to.subVectors(pos, _pos);
    _to.y = 0;
    _right.set(_tan.z, 0, -_tan.x);
    const lateral = _to.dot(_right);

    // forward alignment
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    fwd.y = 0;
    fwd.normalize();
    let align = fwd.dot(_tan); // 1 = same dir as track
    // always prefer going in track direction
    if (align < 0) align = Math.abs(align);
    const cross = fwd.x * _tan.z - fwd.z * _tan.x; // >0 if to the right

    // blocked detection
    if (moved < 0.01 && Math.abs(this.car.telemetry?.throttle || 0) > 0.01) {
      this.blockedTime += dt;
    } else {
      this.blockedTime = Math.max(0, this.blockedTime - dt * 2);
    }

    // smart obstacle avoidance from sensors
    let avoidSteer = 0;
    let avoidBrake = 0;
    if (sense.blockedFront || sense.front < 4) {
      const strength = clamp((4 - sense.front) / 4, 0, 1);
      // go to side with more room
      if (sense.left > sense.right + 0.4) {
        avoidSteer += 0.8 * strength;
      } else if (sense.right > sense.left + 0.4) {
        avoidSteer -= 0.8 * strength;
      } else {
        // pick based on track side or history
        avoidSteer += (cross > 0 ? 0.6 : -0.6) * strength;
      }
      if (sense.front < 2.8) avoidBrake = Math.max(avoidBrake, strength * 0.95);
    }
    if (sense.tightLeft) avoidSteer -= 0.4;
    if (sense.tightRight) avoidSteer += 0.4;

    // stuck detection
    if (speed < 1.2 && Math.abs(this.car.telemetry?.throttle || 0) > 0.02) {
      this.stuckTime += dt;
    } else if (speed < 0.3) {
      this.stuckTime += dt * 0.8;
    } else {
      this.stuckTime = Math.max(0, this.stuckTime - dt * 4);
    }

    // if flipped or pointing mostly backwards
    _up.set(0, 1, 0).applyQuaternion(q);
    const upright = _up.y;

    // enter recovery if stuck or going wrong way
    if (this.mode === 'race') {
      if (this.spawnGrace > 0.5 && ((this.stuckTime > 0.3 && speed < 6) || this.blockedTime > 0.5 || upright < 0.25 || Math.abs(lateral) > 10.0 || (speed < 3.0 && Math.abs(lateral) > 4.0) || sense.front < 0.3)) {
        this.mode = 'recover';
        this.recoverTime = 0;
        this.reverseTime = 0;
        if (this.car.drivetrain && this.car.drivetrain.gear > 0 && Math.abs(speed) < 40) {
          try { this.car.drivetrain.gear = -1; this.car.drivetrain.shiftTimer = 0; } catch (e) {}
        }
      }
    }

    if (this.mode === 'recover') {
      this.recoverTime += dt;
      // find closest point on track again to know direction
      const u2 = this._getNearestU(pos);
      this.curve.getPointAt(u2, _pos);
      this.curve.getTangentAt(u2, _tan);
      _tan.y = 0;
      _tan.normalize();
      _to.subVectors(pos, _pos);
      _to.y = 0;
      _right.set(_tan.z, 0, -_tan.x);
      const lat2 = _to.dot(_right);
      const fwd2 = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      fwd2.y = 0;
      fwd2.normalize();
      const align2 = fwd2.dot(_tan);
      const cross2 = fwd2.x * _tan.z - fwd2.z * _tan.x;
      
      if (this.car.drivetrain && this.car.drivetrain.gear === -1) {
        // steer to point towards track direction while reversing - HARD turn
        let steer = cross2 > 0 ? -1.0 : 1.0;
        if (Math.abs(cross2) < 0.3) steer = lat2 > 0 ? -1.0 : 1.0;
        steer = clamp(steer, -this.maxSteer, this.maxSteer);
        let throttle = 1.0, brake = 0;
        // if facing roughly same direction as track, switch to drive
        if (align2 > 0.7 && this.recoverTime > 0.2) {
          try { this.car.drivetrain.gear = 1; this.car.drivetrain.shiftTimer = 0; this.car.drivetrain.shiftCooldown = 0; } catch (e) {}
          this.mode = 'race';
          this.stuckTime = 0;
          this.recoverTime = 0;
          this.blockedTime = 0;
          return { throttle: 1.0, brake: 0, steer: -cross2 * 0.3, handbrake: false };
        }
        if (this.recoverTime > 2.5) {
          try { this.car.drivetrain.gear = 1; this.car.drivetrain.shiftTimer = 0; } catch (e) {}
          this.mode = 'race';
          this.stuckTime = 0;
          this.recoverTime = 0;
          this.blockedTime = 0;
        }
        return { throttle, brake, steer, handbrake: false };
      } else {
        let steer = lat2 > 0 ? -1.0 : 1.0;
        steer = clamp(steer, -this.maxSteer, this.maxSteer);
        if (this.recoverTime > 0.05 && speed < 15) {
          try { this.car.drivetrain.gear = -1; this.car.drivetrain.shiftTimer = 0; } catch (e) {}
        }
        return { throttle: 1.0, brake: 1.0, steer, handbrake: true };
      }
    }

    // race mode
    if (this.spawnGrace < 150.0) {
      if (align < 0.01) align = 1.0;
      if (this.car.drivetrain && this.car.drivetrain.gear === -1) {
        try { this.car.drivetrain.gear = 1; this.car.drivetrain.shiftTimer = 0; this.car.drivetrain.shiftCooldown = 0; } catch (e) {}
      }
      let throttle = 0.7, brake = 0;
      // steer towards centerline - stable
      let steer = -lateral * 0.03;
      steer += -cross * 0.015;
      steer = clamp(steer, -0.4, 0.4);
      if (speed > 30) {
        steer = clamp(steer, -0.25, 0.25);
      }
      if (Math.abs(lateral) > 10.0) {
        this.mode = 'recover';
        this.recoverTime = 0;
        if (this.car.drivetrain && this.car.drivetrain.gear > 0) {
          try { this.car.drivetrain.gear = -1; this.car.drivetrain.shiftTimer = 0; } catch (e) {}
        }
        return { throttle: 0.8, brake: 0, steer: lateral > 0 ? -0.8 : 0.8, handbrake: false };
      }
      return { throttle, brake, steer, handbrake: false };
    }
    // curvature
    const curv = Math.abs(this._getCurvature(this.u));
    const speedLimit = clamp(90 / (1 + curv * 120), 40, 95) * this.speedFactor;
    const targetSpeed = speedLimit;

    // lookahead
    const lookahead = clamp(this.lookaheadBase + speed * this.lookaheadSpeed, 12, 28);
    const lookU = (this.u + lookahead / this.length) % 1;
    this.curve.getPointAt(lookU, _pos);
    this.curve.getTangentAt(lookU, _tan);
    _tan.y = 0;
    _tan.normalize();

    // steering to lookahead point
    const target = _pos.clone();
    const local = target.sub(pos).applyQuaternion(q.clone().invert());
    local.y = 0;
    const steerErr = Math.atan2(local.x, local.z);
    let steer = steerErr * this.steerP * 60 + (-lateral / 8) * 0.4;
    // derivative
    const dErr = (steerErr - this.prevError) / Math.max(dt, 1e-3);
    steer += dErr * this.steerD;
    this.prevError = steerErr;
    steer = clamp(steer, -this.maxSteer, this.maxSteer);

    // throttle/brake
    let throttle = 0, brake = 0;
    if (speedKmh < targetSpeed - 5) {
      throttle = clamp((targetSpeed - speedKmh) / 15, 0.4, 0.9);
      brake = 0;
    } else if (speedKmh > targetSpeed + 8) {
      throttle = 0;
      brake = clamp((speedKmh - targetSpeed) / 20, 0.2, 0.6);
    } else {
      // coast
      throttle = clamp((targetSpeed - speedKmh) / 10, 0.1, 0.6);
      brake = 0;
    }

    // if way off track laterally, brake a bit
    if (Math.abs(lateral) > 4) {
      throttle *= 0.6;
      brake = Math.max(brake, 0.3);
    }

    // apply avoidance
    steer = clamp(steer + avoidSteer, -this.maxSteer, this.maxSteer);
    brake = Math.max(brake, avoidBrake);
    if (avoidBrake > 0.25 && throttle > 0.25) throttle *= 0.35;

    // learner
    this.learner.learn({
      front: sense.front,
      left: sense.left,
      right: sense.right,
      frontLeft: sense.frontLeft,
      frontRight: sense.frontRight,
      speed,
      lateral,
      align,
    }, dt);

    // if going backwards relative to track
    if (align < 0.1 && speed > 1) {
      this.mode = 'recover';
      this.recoverTime = 0;
      if (this.car.drivetrain && this.car.drivetrain.gear > 0) {
        try { this.car.drivetrain.toggleReverse(speed); } catch (e) {}
      }
      return { throttle: 0.5, brake: 0, steer: -cross * 0.7, handbrake: false };
    }

    this.lastSpeed = speed;
    return { throttle, brake, steer, handbrake: false };
  }
}
