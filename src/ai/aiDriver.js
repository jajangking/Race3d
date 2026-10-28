import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CAR, clamp } from '../vehicle/config.js';
import { AISensors } from './aiSensors.js';
import { buildRacingLine, sampleLine } from './racingLine.js';

const _pos = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _right = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _to = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _target = new THREE.Vector3();
const _local = new THREE.Vector3();
const _invQ = new THREE.Quaternion();

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

    // The AI shifts for itself. The road-car automatic changes up at the
    // redline but only changes down below 2700 rpm, which leaves it in a tall
    // gear out of slow corners. A racing driver keeps the engine in its torque
    // band; this is the single biggest reason the old AI felt sluggish.
    if (this.car.drivetrain) this.car.drivetrain.auto = false;

    this.sensors = new AISensors(car, world);

    // The racing line and its grip/braking profile are track-wide, so the
    // first car builds them and every other car reuses the same plan.
    this.line = buildRacingLine(track);

    // A shared, arc-length spaced centreline cache. Searching these points is
    // far cheaper than calling curve.getPointAt() 160 times per car per step,
    // which with a 10-car field was the dominant CPU cost.
    if (!track._aiSamples) {
      const n = 400;
      const samples = new Array(n);
      for (let i = 0; i < n; i++) samples[i] = track.curve.getPointAt(i / n);
      track._aiSamples = samples;
    }
    this._samples = track._aiSamples;

    // tuning. `pace` scales the shared speed profile, `lineScale` pulls a
    // driver towards the centre (or lets it use the full line), and
    // `laneBias` gives the field a little natural spread.
    this.previewBase = opts.previewBase ?? 4;
    this.previewSpeed = opts.previewSpeed ?? 0.28;
    this.maxSteer = opts.maxSteer ?? 1.0;
    this.pace = opts.pace ?? opts.speedFactor ?? 1.0;
    this.lineScale = opts.lineScale ?? 1.0;
    this.laneBias = opts.laneBias ?? 0.0;
    this.laneOffset = opts.laneOffset ?? 0;

    // state
    this.u = 0;
    this.stuckTime = 0;
    this.recoverTime = 0;
    this.reverseTime = 0;
    this.lastSpeed = 0;
    this.mode = 'race'; // race | reverse | recover | avoid
    this.reverseDir = 1;
    this.recoverPhase = 'reverse';
    this.flippedTime = 0;
    this._lastGear = 1;
    this.lastPos = null;
    this.blockedTime = 0;
    this.idleTime = 0;
    this.avoidSide = 0;
    this.avoidHold = 0;
    this.avoidTimer = 0;
    this.spawnGrace = 0;
    this.startMergeDone = false;
    this._lastBlocking = this.sensors.maxDist;
    this._closing = 0;

    // lightweight behaviour stats (read by the sim test scripts)
    this.stats = { recover: 0, right: 0, offTime: 0 };
  }

  _getNearestU(pos) {
    const samples = this._samples;
    const n = samples.length;
    const center = Math.floor(this.u * n);

    let bestD = Infinity;
    let bestIdx = center;
    for (let k = -28; k <= 28; k++) {
      const idx = (center + k + n) % n;
      const p = samples[idx];
      const dx = p.x - pos.x;
      const dz = p.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        bestIdx = idx;
      }
    }
    // The local window only spans ~+/-90 m. If nothing that close was found,
    // the car is far off the track (long slide, infield crossover) and the
    // window would return the nearest sample *somewhere else on the circuit*
    // - often the opposite side of it, which would steer the car the wrong
    // way home. Fall back to a global search, which is ~400 distance checks
    // and only happens in that rare case.
    if (bestD > 60 * 60) {
      bestD = Infinity;
      for (let idx = 0; idx < n; idx++) {
        const p = samples[idx];
        const dx = p.x - pos.x;
        const dz = p.z - pos.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          bestIdx = idx;
        }
      }
    }

    // Project onto the two chords that touch the best sample. Snapping to the
    // nearest sample alone would quantise u to 3.3 m and make the steering
    // jitter at speed; this gives a continuous position along the track.
    let bestU = bestIdx / n;
    let bestSegD = Infinity;
    const b = samples[bestIdx];
    const segA1 = samples[(bestIdx - 1 + n) % n];
    const segB2 = samples[(bestIdx + 1) % n];
    for (let s = 0; s < 2; s++) {
      const a = s === 0 ? segA1 : b;
      const c = s === 0 ? b : segB2;
      const base = s === 0 ? bestIdx - 1 : bestIdx;
      const abx = c.x - a.x;
      const abz = c.z - a.z;
      const len2 = abx * abx + abz * abz;
      const t = len2 > 0
        ? clamp(((pos.x - a.x) * abx + (pos.z - a.z) * abz) / len2, 0, 1)
        : 0;
      const px = a.x + abx * t;
      const pz = a.z + abz * t;
      const dx = pos.x - px;
      const dz = pos.z - pz;
      const d = dx * dx + dz * dz;
      if (d < bestSegD) {
        bestSegD = d;
        bestU = ((base + t + n) % n) / n;
      }
    }
    return bestU;
  }

  _getCurvature(u) {
    // curvature in rad per metre, sampled over ~4 m of arc. Using a fixed
    // step in u gives curvature per lap fraction, which is ~1300x too large
    // here and pins the speed limiter at its minimum everywhere.
    const du = 2.0 / this.length;
    const u1 = (u - du + 1) % 1;
    const u2 = (u + du) % 1;
    this.curve.getTangentAt(u1, _tan);
    const t1x = _tan.x, t1z = _tan.z;
    this.curve.getTangentAt(u2, _tan);
    const t2x = _tan.x, t2z = _tan.z;
    const dx = t2x - t1x;
    const dz = t2z - t1z;
    const d = Math.hypot(dx, dz);
    return d / (2 * du * this.length);
  }

  /**
   * Start a recovery. `lateral` is the signed distance from the centreline;
   * while reversing, steering towards the same side swings the nose back
   * towards the road. Only back up when the car is genuinely jammed - a car
   * that is merely facing the wrong way should drive out of it.
   */
  _enterRecover(lateral, reverse = false) {
    this.mode = 'recover';
    this.recoverTime = 0;
    this.recoverPhase = reverse ? 'reverse' : 'turn';
    this.flippedTime = 0;
    this.reverseDir = lateral >= 0 ? 1 : -1;
    this.stats.recover++;
    if (this.car.drivetrain) {
      this.car.drivetrain.gear = reverse ? -1 : 1;
      this.car.drivetrain.shiftTimer = 0;
      this.car.drivetrain.shiftCooldown = 0;
    }
  }

  /**
   * Right a flipped car IN PLACE: it keeps its position (no teleport to the
   * line, no reset of progress) and then drives itself back the way any car
   * does. A car on its roof genuinely cannot right itself with steering, so
   * this is the minimum physical intervention - the car then survives the
   * rest of the way on its own.
   */
  _rightInPlace() {
    const t = this.car.body.translation();
    const u = this._getNearestU(new THREE.Vector3(t.x, 0, t.z));
    this.curve.getTangentAt(u, _tan);
    _tan.y = 0;
    _tan.normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), _tan);
    this.car.reset(new THREE.Vector3(t.x, Math.max(t.y, 0.48), t.z), q);
    this.stats.right++;
    this.mode = 'recover';
    this.recoverTime = 0;
    this.recoverPhase = 'turn';
    this.flippedTime = 0;
    this.stuckTime = 0;
    this.blockedTime = 0;
    this.idleTime = 0;
    if (this.car.drivetrain) {
      this.car.drivetrain.gear = 1;
      this.car.drivetrain.shiftTimer = 0;
      this.car.drivetrain.shiftCooldown = 0;
    }
  }

  _shiftGears(speed) {
    const d = this.car.drivetrain;
    if (!d || d.gear <= 0 || d.shiftTimer > 0 || d.shiftCooldown > 0) return;
    const rpm = d.rpm;
    if (rpm > 7350 && d.gear < d.maxGear) {
      d.shiftUp();
      return;
    }
    if (rpm < 4200 && d.gear > 1) {
      // Never grab a gear that would over-rev the engine. The old check only
      // looked at current rpm, so a braking car could drop from third to first
      // at 90 km/h and lock the rear axle.
      const gb = d.cfg.gearbox;
      const nextRatio = gb.ratios[d.gear - 2] * gb.finalDrive;
      const wheelOmega = speed / Math.max(this.car.wheelRadius, 0.1);
      const nextRpm = (wheelOmega * nextRatio * 60) / (2 * Math.PI);
      if (nextRpm < 7000) d.shiftDown();
    }
  }

  update(dt) {
    if (!this.enabled) return { throttle: 0, brake: 0, steer: 0, handbrake: false };
    this.spawnGrace += dt;
    const body = this.car.body;
    const t = body.translation();
    const pos = new THREE.Vector3(t.x, t.y, t.z);
    if (!this.lastPos) this.lastPos = pos.clone();
    this.lastPos.copy(pos);

    const r = body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);

    // velocity
    const v = body.linvel();
    _vel.set(v.x, v.y, v.z);
    const speed = _vel.length();
    const speedKmh = speed * 3.6;
    if (this.mode !== 'recover') this._shiftGears(speed);

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
    const laneErr = lateral - this.laneOffset;

    // forward alignment
    const fwd = _fwd.set(0, 0, 1).applyQuaternion(q);
    fwd.y = 0;
    fwd.normalize();
    const align = fwd.dot(_tan); // 1 = same dir as track
    const cross = fwd.x * _tan.z - fwd.z * _tan.x; // >0 if to the right

    // blocked detection: the car is asking for throttle but the body speed
    // stays near zero. Using per-frame displacement here was wrong, because
    // a normal launch moves only a few millimetres per 1/120 s step.
    if (speed < 0.4 && Math.abs(this.car.telemetry?.throttle || 0) > 0.4) {
      this.blockedTime += dt;
    } else {
      this.blockedTime = Math.max(0, this.blockedTime - dt * 2);
    }
    // a racing AI should never sit still for seconds; this catches a car
    // wedged somewhere with too little throttle for the detector above
    if (speed < 0.5) this.idleTime += dt;
    else this.idleTime = 0;

    // Estimate how fast we are closing on whatever is directly ahead. The
    // sensor refreshes every few steps, so the difference between two
    // readings divided by that interval gives the closing speed. This is what
    // lets the driver brake for a stopped car at 110 km/h instead of relying
    // on steering alone.
    if (sense.frontCenter !== this._lastBlocking) {
      if (this._lastBlocking < this.sensors.maxDist - 0.5) {
        const close = (this._lastBlocking - sense.frontCenter) / (this.sensors.interval * dt);
        // Sensor rays can jump between two cars in a pack; a raw difference
        // then looks like a 40 m/s closing speed for one frame. Smooth it so
        // only a sustained approach triggers the early avoid move.
        this._closing = close >= 0
          ? Math.min(45, this._closing * 0.65 + close * 0.35)
          : Math.max(0, this._closing * 0.65 + close * 0.35);
      }
      this._lastBlocking = sense.frontCenter;
    }

    // obstacle avoidance: commit to one side until the road ahead is clear.
    // Re-picking a side every frame made the car weave left-right behind a
    // stopped car for 15 s instead of driving around it.
    let avoidSteer = 0;
    let avoidBrake = 0;
    const avoidRange = 26.0;
    // A steering nudge at 115 km/h throws the car much further than at 40.
    // Scale the avoidance authority down with speed; at pace, the smart
    // move is to brake and hold the line, not to swerve.
    const speedDamp = clamp(75 / Math.max(speedKmh, 10), 0.35, 1);
    // how much side clearance counts as "room to pass" at this speed
    const noRoom = speedKmh > 80 ? 3.4 : 2.0;
    // Only treat a car as an obstacle when it is actually in our lane. The
    // wide front fan also sees cars in the next column, and reacting to those
    // made a 10-car pack swerve into each other for no reason.
    const blocking = sense.frontCenter;
    if (blocking < avoidRange) {
      this.avoidHold = 1.2;
      if (this.avoidSide === 0) {
        if (sense.frontLeft > sense.frontRight + 0.8) this.avoidSide = -1;
        else if (sense.frontRight > sense.frontLeft + 0.8) this.avoidSide = 1;
        else this.avoidSide = lateral >= 0 ? -1 : 1;
      }
      // never pick the side that already has a car on it
      if (this.avoidSide === -1 && sense.left < 2.8) this.avoidSide = 1;
      else if (this.avoidSide === 1 && sense.right < 2.8) this.avoidSide = -1;
    } else {
      this.avoidHold = Math.max(0, this.avoidHold - dt);
      // hold a committed overtake until the car ahead is clearly behind us -
      // dropping the side early made cars weave back onto the line and into
      // the pack they had just dodged
      const passing = this.avoidSide !== 0 && blocking < 34 && this._closing < 1;
      if (this.avoidHold === 0 && !passing) this.avoidSide = 0;
    }
    // A car 12 m ahead running at the same speed is not an obstacle to
    // dodge; swerving around it at launch is what put half the field on the
    // grass in the first corner. Commit only when it is close or when the
    // gap is actually closing.
    if (this.avoidSide !== 0) {
      // Brake on time-to-collision first; only add steering when the obstacle
      // is genuinely close. A full-lock swerve around a car 12 m ahead at the
      // start is what caused the first-corner pile-ups.
      const ttc = this._closing > 2 ? blocking / this._closing : Infinity;
      if (ttc < 3.0 && this._closing > 6) {
        // Only a genuinely slower/stopped car needs an early committed move.
        // In a tight pack closing speeds are small; swerving there just starts
        // a chain reaction. Waiting until 9 m is too late for a stopped car.
        const urgency = clamp((3.0 - ttc) / 2.0, 0, 1);
        if (sense.left < noRoom && sense.right < noRoom) {
          avoidBrake = Math.max(avoidBrake, 0.45);
        } else {
          avoidSteer += this.avoidSide * (0.12 + 0.5 * urgency) * speedDamp;
          avoidBrake = Math.max(avoidBrake, clamp((3.0 - ttc) * 0.2, 0.08, 0.5));
        }
      }
      if (ttc < 1.2) {
        avoidBrake = Math.max(avoidBrake, clamp((1.2 - ttc) / 0.8, 0.1, 0.35));
      }
      if (blocking < 2.0 && speed > 12) avoidBrake = Math.max(avoidBrake, 0.5);
      if (blocking < 9.0) {
        const strength = clamp((9.0 - blocking) / 9.0, 0, 1);
        avoidSteer += this.avoidSide * 0.45 * strength * speedDamp;
      }
    }
    // side pressure: steer away from a car alongside. The old fixed 0.35
    // only started at 1.8 m, which is already touching width for two cars.
    if (sense.tightLeft) avoidSteer += clamp((2.8 - sense.left) * 0.22 + 0.08, 0.08, 0.32) * (0.5 + 0.5 * speedDamp);
    if (sense.tightRight) avoidSteer -= clamp((2.8 - sense.right) * 0.22 + 0.08, 0.08, 0.32) * (0.5 + 0.5 * speedDamp);
    // On the launch straight the field is still merging from the grid lanes:
    // here a car brakes and holds its lane instead of swerving. Swerving at
    // 100+ km/h on a 14 m wide straight is what sent the old AI onto the grass.
    if (!this.startMergeDone) avoidSteer *= 0.2;

    // stuck detection: only while actually asking to drive. A car sitting on
    // its own (no input) is not "stuck", and a launch from 0 is normal.
    if (speed < 1.0 && Math.abs(this.car.telemetry?.throttle || 0) > 0.3) {
      this.stuckTime += dt;
    } else {
      this.stuckTime = Math.max(0, this.stuckTime - dt * 2);
    }

    // if flipped or pointing mostly backwards
    _up.set(0, 1, 0).applyQuaternion(q);
    const upright = _up.y;

    // enter recovery only when it is genuinely jammed, flipped, way off the
    // road, or driving the wrong way - not during a normal standing start
    if (this.mode === 'race') {
      const jammed =
        (this.stuckTime > 1.2 && speed < 1.0) ||
        this.blockedTime > 1.2 ||
        this.idleTime > 2.5;
      const offTrack = Math.abs(lateral) > 8.0 || (speed < 3.0 && Math.abs(lateral) > 6.0);
      const wrongWay = align < -0.2 && speed > 3.0;
      if (this.spawnGrace > 1.0 && (jammed || upright < 0.25 || offTrack || wrongWay)) {
        this._enterRecover(lateral, jammed && upright >= 0.25);
      }
    }

    if (this.mode === 'recover') {
      this.recoverTime += dt;

      // A car on its roof cannot right itself with throttle and steering.
      // Let it struggle for a moment (rolling in the lean direction), then
      // right it IN PLACE: same position, no progress reset. The car then
      // drives itself back to the road like any other - no teleport restart.
      if (upright < 0.35) {
        this.flippedTime += dt;
        if (this.flippedTime > 2.2) {
          this._rightInPlace();
          this.flippedTime = 0;
        }
        return { throttle: 0.15, brake: 0, steer: this.reverseDir * 0.5, handbrake: false };
      } else {
        this.flippedTime = 0;
      }

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

      // Phase 1 (only when the car entered jammed or facing the wrong way):
      // back up with a constant steering direction until the nose has
      // actually swung most of the way around. A fixed 1 s was not enough
      // for a 180 deg car: it shifted to drive still facing backwards and
      // powered down the track the wrong way.
      if (this.recoverPhase === 'reverse') {
        const steer = clamp(this.reverseDir * 0.9, -this.maxSteer, this.maxSteer);
        const turnedEnough = this.recoverTime > 2.5 || (align2 > 0.3 && speed < 8);
        if (turnedEnough) {
          this.recoverPhase = 'turn';
          this.recoverTime = 0;
          if (this.car.drivetrain) {
            this.car.drivetrain.gear = 1;
            this.car.drivetrain.shiftTimer = 0;
            this.car.drivetrain.shiftCooldown = 0;
          }
        }
        return { throttle: 0.75, brake: 0, steer, handbrake: false };
      }

      // Phase 2: drive back to the road on its own.
      //
      // First problem: a car facing the wrong way. "Aim at the closest
      // reachable point" would pick a spot a few metres ahead of its nose -
      // zero steering cost - and the car would happily power down the track
      // backwards. So while it is pointing mostly against the track, it
      // turns around first (full-lock circle in drive) until the nose
      // points back along the line.
      if (align2 < 0.2) {
        const headCross = fwd2.x * _tan.z - fwd2.z * _tan.x;
        const headingErr = Math.atan2(headCross, align2);
        const d = this.car.drivetrain;
        if (d && d.gear !== 1) {
          d.gear = 1;
          d.shiftTimer = 0;
          d.shiftCooldown = 0;
        }
        const steer = clamp(-headingErr * 1.5, -this.maxSteer, this.maxSteer);
        // Full-lock circle in drive: from rest this rotates the car ~180
        // deg in a ~12 m arc and ends facing along the track again (the
        // handbrake cannot do that - it locks this car's driven rear
        // axle, so from standstill the pivot does nothing). The car ends
        // ~7 m to the side; phase 2 trims it back to the line.
        // Fast: brake hard while turning - weight transfer kicks the nose in.
        if (speed > 8) return { throttle: 0, brake: 0.85, steer, handbrake: false };
        return { throttle: 0.7, brake: 0, steer, handbrake: false };
      }
      // Aligned enough to drive forward - make sure we are in drive before
      // aiming at the road (a car arriving from the reverse phase is not).
      if (this.car.drivetrain && this.car.drivetrain.gear < 1) {
        this.car.drivetrain.gear = 1;
        this.car.drivetrain.shiftTimer = 0;
        this.car.drivetrain.shiftCooldown = 0;
      }

      // Otherwise pick the most reachable point of road near the car
      // (smallest steering angle, slight bias towards track-ahead) and aim
      // at it directly. The surface is flat, so the car can always get back
      // no matter how far off it slid - genuine survival, not a reset.
      let bestU = u2;
      let bestScore = Infinity;
      _invQ.copy(q).invert();
      for (let k = -2; k <= 12; k++) {
        // JS % keeps the sign of the dividend: near u=0 the backward
        // candidates go negative and crash the curve lookup.
        const uu = ((u2 + k * 0.004) % 1 + 1) % 1;
        this.curve.getPointAt(uu, _target);
        _local.subVectors(_target, pos);
        _local.y = 0;
        _local.applyQuaternion(_invQ);
        const dist = Math.hypot(_local.x, _local.z);
        if (dist < 0.5) continue;
        const err = Math.atan2(_local.x, _local.z);
        const score = Math.abs(err) + (k < 0 ? -k * 0.6 : 0);
        if (score < bestScore) {
          bestScore = score;
          bestU = uu;
        }
      }
      this.curve.getPointAt(bestU, _target);
      _local.subVectors(_target, pos);
      _local.y = 0;
      _local.applyQuaternion(_invQ);
      const steerErr = Math.atan2(_local.x, _local.z);
      const steer = clamp(steerErr * 1.5, -this.maxSteer, this.maxSteer);
      // power through the turn, ease off for a tight U-turn
      const throttle = Math.abs(steerErr) > 1.1 ? 0.5 : 0.85;
      const done = align2 > 0.8 && Math.abs(lat2) < 2.5 && speed > 4;
      if (done) {
        this.mode = 'race';
        this.stuckTime = 0;
        this.blockedTime = 0;
        this.idleTime = 0;
        this.recoverTime = 0;
        return { throttle: 0.7, brake: 0, steer: steer * 0.3, handbrake: false };
      }
      if (this.recoverTime > 25) {
        // pathological corner case (wedged against a car for half a minute):
        // right it in place and let it try again - still no position reset.
        this._rightInPlace();
        return { throttle: 0.5, brake: 0, steer: 0, handbrake: false };
      }
      return { throttle, brake: 0, steer, handbrake: false };
    }

    // ----- racing line + speed profile -----------------------------------
    // Both come from the shared track plan. Each driver uses a slightly
    // different line and pace, so the field spreads out and overtakes instead
    // of driving like ten clones of the same script.
    //
    // Steering is a preview controller rather than pure pursuit. The preview
    // curvature supplies the steering the corner actually needs, so the car
    // turns in on time, while the cross-track and heading terms only trim the
    // error. Chasing a lookahead point from far off-line made the old version
    // reach full lock, light up the front tyres and run wide.
    // Blend from the grid lane onto the racing line over the first couple of
    // seconds. The old code handed over abruptly after 1.5 s, while the pack
    // was still side by side; that was where most first-corner contact and
    // off-track time came from.
    let merge = 1;
    if (!this.startMergeDone) {
      merge = clamp((this.u - 0.075) / 0.055, 0, 1);
      if (merge >= 1) this.startMergeDone = true;
    }
    const plannedOff = sampleLine(this.line.offsets, this.u) * this.lineScale + this.laneBias;
    const lineOffNow = plannedOff * merge + this.laneOffset * (1 - merge);
    const crossTrack = lateral - lineOffNow;
    const previewU = (this.u + clamp(this.previewBase + speed * this.previewSpeed, 6, 16) / this.length) % 1;
    const kAhead = sampleLine(this.line.curvatureSigned, previewU);
    const pathTanX = sampleLine(this.line.tanX, this.u);
    const pathTanZ = sampleLine(this.line.tanZ, this.u);
    const headDot = fwd.x * pathTanX + fwd.z * pathTanZ;
    const headCross = fwd.x * pathTanZ - fwd.z * pathTanX;
    const headingErr = Math.atan2(headCross, headDot);

    const st = CAR.steering;
    const lock01 = clamp(
      (speedKmh - st.speedFullLockKmh) / (st.speedNoLockKmh - st.speedFullLockKmh),
      0, 1,
    );
    const maxAngle = st.maxAngle + (st.maxAngleHighSpeed - st.maxAngle) * lock01;

    const ffAngle = -Math.atan(CAR.wheel.wheelbase * kAhead);
    const crossAngle = -Math.atan((0.7 * crossTrack) / Math.max(speed, 5));
    const yawAngle = -clamp(headingErr * 0.45, -0.06, 0.06);
    let desiredAngle = ffAngle + clamp(crossAngle, -0.07, 0.07) + yawAngle;

    // Never ask the front tyres for more lateral force than they can make.
    // At 150 km/h a two-degree steering error is already a lot, and the old
    // pure-pursuit loop would command six degrees and slide the car wide.
    const kMax = (1.55 * 9.81) / Math.max(speed * speed, 1);
    const kCmd = Math.tan(clamp(desiredAngle, -1.4, 1.4)) / CAR.wheel.wheelbase;
    desiredAngle = Math.atan(CAR.wheel.wheelbase * clamp(kCmd, -kMax, kMax));
    desiredAngle = clamp(desiredAngle, -maxAngle * 0.9, maxAngle * 0.9);
    let steer = clamp(desiredAngle / Math.max(maxAngle, 0.03), -this.maxSteer, this.maxSteer);

    // Grip-limited target from the precomputed braking pass. Looking a couple
    // of metres ahead catches the start of a braking zone without cutting the
    // corner speed everywhere.
    let targetKmh = sampleLine(this.line.speed, this.u + 2 / this.length) * this.pace * 3.6;

    // Follow governor: when a car is ahead, match its pace so the gap is
    // held with speed instead of last-moment braking or a rear-end. Closing
    // at c m/s means "the car ahead runs at v - c", so aiming for v - c - 4
    // bleeds off the closing speed and settles into a stable following gap.
    // Skipped while actively passing with a clear lane - that is the moment
    // to keep the pace instead of matching the car being overtaken.
    const sideClear = this.avoidSide !== 0 &&
      ((this.avoidSide === -1 ? sense.left : sense.right) > 5);
    if (blocking < 40 && this._closing > 0.5 && !sideClear) {
      const followKmh = speedKmh - this._closing * 3.6 - 4;
      targetKmh = Math.min(targetKmh, Math.max(25, followKmh));
    }

    let throttle = 0;
    let brake = 0;
    const speedErr = targetKmh - speedKmh;
    if (speedErr > 2) {
      throttle = clamp(speedErr / 15, 0.45, 1);
    } else if (speedErr < -2) {
      brake = clamp(-speedErr / 10, 0.2, 1);
    } else {
      throttle = clamp(0.4 + speedErr / 20, 0.25, 0.65);
    }
    if (this.spawnGrace < 1.2 && speedKmh < 35) throttle = Math.min(throttle, 0.7);

    // if way off track laterally, brake a bit
    if (Math.abs(lateral) > 5.8) {
      throttle *= 0.6;
      brake = Math.max(brake, 0.3);
    }

    // apply avoidance, plus a hard push back towards the road whenever the
    // car is near the edge. Side-by-side traffic must never be able to shove
    // a car onto the grass: the track limit wins over the avoidance steer.
    let edgeSteer = 0;
    if (lateral > 5.0) edgeSteer = -clamp((lateral - 5.0) * 0.45, 0.12, 1.0);
    else if (lateral < -5.0) edgeSteer = clamp((-lateral - 5.0) * 0.45, 0.12, 1.0);
    steer = clamp(steer + avoidSteer + edgeSteer, -this.maxSteer, this.maxSteer);
    // Near the edge the track limit has the final say. Avoidance must not be
    // able to hold the car against the white line and push it onto the grass.
    if (lateral > 5.2) steer = Math.min(steer, edgeSteer);
    else if (lateral < -5.2) steer = Math.max(steer, edgeSteer);
    brake = Math.max(brake, avoidBrake);
    if (avoidBrake > 0.25 && throttle > 0.25) throttle *= 0.35;

    // if going backwards relative to track
    if (align < 0.1 && speed > 1) {
      this._enterRecover(lateral);
      return { throttle: 0.5, brake: 0, steer: -cross * 0.7, handbrake: false };
    }

    this.lastSpeed = speed;
    return { throttle, brake, steer, handbrake: false };
  }
}
