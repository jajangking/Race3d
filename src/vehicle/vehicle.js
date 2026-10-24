import * as THREE from 'three';
import { CAR, clamp } from './config.js';
import { TireModel } from './tire.js';
import { Drivetrain } from './drivetrain.js';

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _lin = new THREE.Vector3();
const _ang = new THREE.Vector3();
const _mount = new THREE.Vector3();
const _down = new THREE.Vector3();
const _up = new THREE.Vector3();
const _contact = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _vPoint = new THREE.Vector3();
const _r = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _lat = new THREE.Vector3();
const _vContact = new THREE.Vector3();
const _force = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _fwdBody = new THREE.Vector3();
const _latBody = new THREE.Vector3();

/**
 * Raycast vehicle.
 *
 * The chassis is a single Rapier rigid body. Everything below it is custom
 * simulation, because raycast-vehicle modules in physics engines are usually
 * arcade-tuned:
 *
 *   - 4 raycasts down the suspension hard points
 *   - spring + bump/rebound damper + progressive bump stop + anti-roll bars
 *   - per-wheel angular velocity, so wheelspin and lock-up are emergent
 *   - combined-slip Pacejka-style tyre forces with load sensitivity
 *   - engine / gearbox torque applied as wheel torque
 *   - aero drag + front/rear downforce
 *
 * All forces are applied at the contact patch, so weight transfer, roll and
 * pitch are not scripted, they fall out of the maths.
 */
export class Vehicle {
  constructor({ RAPIER, world, position, quaternion }) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.cfg = CAR;
    this.tire = new TireModel(CAR.tyre);
    this.drivetrain = new Drivetrain(CAR);

    // ------------------------------------------------------------- rigid body
    const rb = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w })
      .setLinearDamping(0.02)
      .setAngularDamping(0.05)
      .setCanSleep(false)
      .setCcdEnabled(true);
    this.body = world.createRigidBody(rb);

    const he = CAR.halfExtents;
    const co = CAR.colliderOffset;
    const col = RAPIER.ColliderDesc.cuboid(he.x, he.y, he.z)
      .setTranslation(co.x, co.y, co.z)
      .setMass(CAR.mass)
      .setFriction(0.6)
      .setRestitution(0.05)
      .setContactSkin(0.005);
    this.collider = world.createCollider(col, this.body);

    // ---------------------------------------------------------------- wheels
    const s = CAR.suspension;
    const w = CAR.wheel;
    const halfBase = w.wheelbase / 2;
    const halfFront = w.trackFront / 2;
    const halfRear = w.trackRear / 2;

    const makeWheel = (name, x, z, isFront, driven) => ({
      name,
      isFront,
      driven,
      mount: new THREE.Vector3(x, s.hardpointY, z),
      steer: 0,
      omega: 0,                 // rad/s, + = rolling forward
      spinAngle: 0,
      driveTorque: 0,
      escBrake: 0,
      suspLen: s.restLength,
      compression: 0,
      compVel: 0,
      load: 0,
      grounded: false,
      contact: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      slipRatio: 0,
      slipAngle: 0,
      fx: 0,
      fy: 0,
      vLong: 0,
      vLat: 0,
      usage: 0,
      frictionMu: 0,
      localY: s.hardpointY - s.restLength,
    });

    this.wheels = [
      makeWheel('FL', -halfFront, halfBase, true, false),
      makeWheel('FR', halfFront, halfBase, true, false),
      makeWheel('RL', -halfRear, -halfBase, false, true),
      makeWheel('RR', halfRear, -halfBase, false, true),
    ];

    this.wheelRadius = w.radius;
    this.wheelInertia = 0.5 * w.mass * w.radius * w.radius;
    this.minSuspLen = s.restLength - s.bumpStopAt;   // hard stop
    this.maxSuspLen = s.restLength + s.maxDroop;
    this.rayLength = this.maxSuspLen + w.radius;

    this.steerAngle = 0;
    this.reverseHold = 0;

    // Driver aids. A modern road car has these; switch them off for pure sim.
    this.assists = { tc: true, esc: true };

    this.telemetry = {
      speedKmh: 0,
      speed: 0,
      rpm: CAR.engine.idleRpm,
      gear: '1',
      shifting: false,
      throttle: 0,
      brake: 0,
      handbrake: false,
      steer: 0,
      wheels: this.wheels,
      slipAngleMax: 0,
      gLat: 0,
      gLong: 0,
      tcActive: false,
      escActive: false,
    };

    this._lastSpeed = 0;
  }

  // ------------------------------------------------------------------ helpers

  _velocityAt(point, out) {
    out.copy(_lin).add(_tmp.copy(_ang).cross(_r.copy(point).sub(_pos)));
    return out;
  }

  _brakeTorque(wheel, brakeInput, handbrake) {
    const b = CAR.brakes;
    const axleShare = (wheel.isFront ? b.biasFront : 1 - b.biasFront) / 2;
    let t = brakeInput * b.maxTorque * axleShare;
    if (!wheel.isFront && handbrake) t += b.handbrakeTorque / 2;
    t += wheel.escBrake || 0;
    return t;
  }

  // ------------------------------------------------------------------- update

  update(dt, input) {
    const body = this.body;
    const R = this.wheelRadius;
    const cfg = this.cfg;
    const sus = cfg.suspension;

    const rot = body.rotation();
    _q.set(rot.x, rot.y, rot.z, rot.w);
    const t = body.translation();
    _pos.set(t.x, t.y, t.z);
    const lv = body.linvel();
    _lin.set(lv.x, lv.y, lv.z);
    const av = body.angvel();
    _ang.set(av.x, av.y, av.z);

    // Rapier keeps user forces until they are reset, and we re-apply every
    // substep. Without this the suspension would stack up and launch the car.
    body.resetForces(false);
    body.resetTorques(false);

    _up.copy(UP).applyQuaternion(_q);
    _down.copy(DOWN).applyQuaternion(_q);

    // forward speed (for steering gain, gearbox and HUD)
    _fwdBody.set(0, 0, 1).applyQuaternion(_q);
    _latBody.set(1, 0, 0).applyQuaternion(_q);
    let speed = _lin.dot(_fwdBody);

    // treat brake as throttle in reverse
    if (this.drivetrain.gear === -1) {
      speed = -speed;
    }

    // ------------------------------------------------------------- steering
    const st = cfg.steering;
    const kmh = Math.abs(speed) * 3.6;
    const t01 = clamp(
      (kmh - st.speedFullLockKmh) / (st.speedNoLockKmh - st.speedFullLockKmh),
      0,
      1,
    );
    const maxSteer = st.maxAngle + (st.maxAngleHighSpeed - st.maxAngle) * t01;
    const target = clamp(input.steer, -1, 1) * maxSteer;
    const rate = Math.abs(input.steer) > 0.02 ? st.rate : st.returnRate;
    this.steerAngle = moveTowards(this.steerAngle, target, rate * dt);

    // Ackermann geometry: inner wheel turns tighter than the outer one
    const wb = cfg.wheel.wheelbase;
    const track = cfg.wheel.trackFront;
    const steerAbs = Math.abs(this.steerAngle);
    const sign = Math.sign(this.steerAngle);
    let inner = steerAbs;
    let outer = steerAbs;
    if (steerAbs > 0.01) {
      const radius = wb / Math.tan(steerAbs);
      inner = Math.atan(wb / Math.max(radius - track / 2, 0.4));
      outer = Math.atan(wb / (radius + track / 2));
      inner = steerAbs + (inner - steerAbs) * st.ackermann;
      outer = steerAbs + (outer - steerAbs) * st.ackermann;
    }
    for (const wheel of this.wheels) {
      if (!wheel.isFront) {
        wheel.steer = 0;
        continue;
      }
      // positive steer = turning right, so the right wheel is the inner one
      const isInner = sign > 0 ? wheel.mount.x > 0 : wheel.mount.x < 0;
      wheel.steer = sign * (isInner ? inner : outer);
    }

    // ------------------------------------------------------------ drivetrain
    // handle reverse toggle from input
    if (input.reverse !== undefined && typeof this._lastReverse === 'undefined') this._lastReverse = this.drivetrain.gear === -1;
    if (input.reverse !== undefined && input.reverse !== this._lastReverse) {
      // force toggle regardless of speed
      this.drivetrain.gear = this.drivetrain.gear === -1 ? 1 : -1;
      this.drivetrain.shiftTimer = 0;
      this.drivetrain.shiftCooldown = 0;
      this._lastReverse = input.reverse;
    } else if (input.reverse !== undefined) {
      this._lastReverse = input.reverse;
    }

    const driven = this.wheels.filter((w) => w.driven);
    const drivenOmega =
      driven.reduce((sum, w) => sum + w.omega, 0) / Math.max(driven.length, 1);
    const drive = this.drivetrain.update(dt, input, drivenOmega, speed);
    let axleTorque = drive.axleTorque;
    if (Math.abs(speed) < 1.2 && input.throttle < 0.01 && input.brake < 0.01 && !input.handbrake && this.drivetrain.gear !== -1) {
      axleTorque = 0;
    }
    if (this.drivetrain.gear === -1 && Math.abs(speed) < 0.3 && input.throttle < 0.01 && input.brake < 0.01 && !input.handbrake) {
      axleTorque = 0;
    }

    // ------------------------------------------------------ traction control
    // Clamp how far the driven wheels may spin past the road speed. Holding
    // them at the tyre's peak slip gives maximum drive force and, unlike a
    // torque-cut controller, cannot oscillate frame to frame.
    let tcActive = false;
    const slipTargetFor = (v) => 0.10 + 0.12 * Math.abs(v); // m/s of slip

    // ------------------------------------------- stability control (ESC)
    // Oversteer = the car yaws more than the steering angle asks for. Brake
    // the outer front wheel, which is exactly what a production ESC does.
    for (const wheel of this.wheels) wheel.escBrake = 0;
    let escActive = false;
    if (this.assists.esc && Math.abs(speed) > 8) {
      const desiredYaw = (speed * Math.tan(this.steerAngle)) / Math.max(wb, 0.1);
      const yawError = _ang.y - desiredYaw;
      const excess = Math.abs(yawError) - 0.18;
      if (excess > 0) {
        const brake = clamp(excess * 1200, 0, 320);
        // braking the left front yaws the car left, and vice versa
        if (yawError > 0) this.wheels[0].escBrake = brake;
        else this.wheels[1].escBrake = brake;
        escActive = brake > 30;
      }
    }

    // -------------------------------------------------- 1. suspension raycast
    for (const wheel of this.wheels) {
      _mount.copy(wheel.mount).applyQuaternion(_q).add(_pos);

      const k = wheel.isFront ? sus.stiffnessFront : sus.stiffnessRear;
      const bump = wheel.isFront ? sus.bumpFront : sus.bumpRear;
      const rebound = wheel.isFront ? sus.reboundFront : sus.reboundRear;
      const bumpStopK = wheel.isFront ? sus.bumpStopFront : sus.bumpStopRear;

      const ray = new this.RAPIER.Ray(_mount, _down);
      const hit = this.world.castRayAndGetNormal(
        ray,
        this.rayLength,
        true,
        undefined,
        undefined,
        this.collider,
      );

      wheel.grounded = false;
      wheel.load = 0;
      wheel.baseForce = 0;

      if (!hit) {
        wheel.suspLen = this.maxSuspLen;
        wheel.compression = 0;
        wheel.compVel = 0;
        wheel.localY = wheel.mount.y - wheel.suspLen;
        continue;
      }

      const toi = hit.timeOfImpact;
      wheel.grounded = true;
      wheel.suspLen = clamp(toi - R, this.minSuspLen, this.maxSuspLen);
      wheel.compression = Math.max(0, sus.restLength - wheel.suspLen);
      _contact.copy(_mount).addScaledVector(_down, toi);
      wheel.contact.copy(_contact);
      wheel.normal.set(hit.normal.x, hit.normal.y, hit.normal.z).normalize();
      if (this.debugRay) {
        console.log(
          wheel.name,
          'mountY', _mount.y.toFixed(3), 'toi', toi.toFixed(3),
          'suspLen', wheel.suspLen.toFixed(3), 'comp', wheel.compression.toFixed(3),
          'normal', wheel.normal.toArray().map((n) => n.toFixed(2)).join(','),
        );
      }

      // vertical velocity of the hard point along the suspension axis
      this._velocityAt(_mount, _vPoint);
      wheel.compVel = _vPoint.dot(_down);

      let force = 0;
      if (wheel.compression > 0) {
        force = k * wheel.compression;
        force += (wheel.compVel > 0 ? bump : rebound) * wheel.compVel;
        if (wheel.compression > sus.bumpStopAt) {
          const over = wheel.compression - sus.bumpStopAt;
          force += bumpStopK * over * over;
        }
      }
      wheel.baseForce = clamp(force, 0, 60000);
      wheel.localY = wheel.mount.y - wheel.suspLen;
    }

    // ------------------------------------------------- 2. anti-roll bars
    const arbFront = this._antiRoll(this.wheels[0], this.wheels[1], sus.antiRollFront);
    const arbRear = this._antiRoll(this.wheels[2], this.wheels[3], sus.antiRollRear);
    this._applyArb(this.wheels[0], this.wheels[1], arbFront);
    this._applyArb(this.wheels[2], this.wheels[3], arbRear);

    // -------------------------------------- 3. tyre forces + wheel dynamics
    const tarmac = cfg.tyre;
    let maxSlip = 0;

    for (const wheel of this.wheels) {
      wheel.driveTorque = wheel.driven ? axleTorque / driven.length : 0;
    }
    // Welded (spool) differential: both driven wheels get the same torque.
    // A speed-sensing LSD here made the car snap into a spin under wheelspin,
    // because on the limiter the wheel-speed difference is dominated by yaw.
    // A spool is what a lot of track cars actually run.

    for (const wheel of this.wheels) {
      if (!wheel.grounded || wheel.baseForce <= 0) {
        wheel.slipRatio = 0;
        wheel.slipAngle = 0;
        wheel.usage = 0;
        wheel.load = 0;
        wheel.fx = 0;
        wheel.fy = 0;
        // free-spinning wheel: apply drive torque and a little drag
        let omega = wheel.omega;
        omega += (wheel.driveTorque / this.wheelInertia) * dt;
        omega *= 1 - 0.8 * dt;
        const limit = wheel.driven ? (this.drivetrain.gear === -1 ? 500 : Math.min(drive.maxWheelOmega, 300)) : 300;
        wheel.omega = clamp(omega, -limit, limit);
        wheel.spinAngle += wheel.omega * dt;
        continue;
      }
      wheel.load = wheel.baseForce;

      // contact-plane basis
      _fwd.set(Math.sin(wheel.steer), 0, Math.cos(wheel.steer)).applyQuaternion(_q);
      _normal.copy(wheel.normal);
      _fwd.addScaledVector(_normal, -_fwd.dot(_normal));
      if (_fwd.lengthSq() < 1e-6) {
        _fwd.set(0, 0, 1).applyQuaternion(_q);
      }
      _fwd.normalize();
      _lat.crossVectors(_normal, _fwd).normalize();

      // velocity of the contact patch
      _vPoint.copy(wheel.contact);
      this._velocityAt(_vPoint, _vContact);
      const vLong = _vContact.dot(_fwd);
      const vLat = _vContact.dot(_lat);

      // the 1 m/s floor tames the slip ratio at walking pace
      const denom = Math.max(Math.abs(vLong), 1.0);
      let kappa = (wheel.omega * R - vLong) / denom;
      const alpha = Math.atan2(vLat, denom);

      // At a standstill the slip-ratio ODE is ill-conditioned (tiny vLong),
      // so the wheel can chatter between grip and slip and walk the car.
      // Treat low-speed free rolling as pure rolling instead.
      const freeRoll =
        Math.abs(vLong) < 0.4 &&
        input.brake < 0.02 &&
        !input.handbrake &&
        Math.abs(wheel.driveTorque) < 8;
      if (freeRoll) kappa = 0;

      wheel.slipRatio = kappa;
      wheel.slipAngle = alpha;
      wheel.vLong = vLong;
      wheel.vLat = vLat;

      const res = this.tire.evaluate(wheel.load, kappa, alpha);
      wheel.usage = res.usage;
      wheel.frictionMu = res.mu;
      wheel.vLong = vLong;
      wheel.vLat = vLat;
      maxSlip = Math.max(maxSlip, Math.abs(alpha));

      // Tyre relaxation length: the carcass needs ~0.5 m of travel before the
      // slip force fully develops. That lag is what keeps the wheel-spin ODE
      // stable (without it a free wheel oscillates grip/lock every frame).
      const tau = clamp(0.45 / Math.max(Math.abs(vLong), 1.0), 0.025, 0.12);
      const blend = 1 - Math.exp(-dt / tau);
      wheel.fx += (res.fx - wheel.fx) * blend;
      wheel.fy += (res.fy - wheel.fy) * blend;
      const fx = wheel.fx;
      const fy = wheel.fy;

      // rolling resistance
      const rr = -Math.sign(vLong) * tarmac.rollingResistance * wheel.load;

      _force.copy(_fwd).multiplyScalar(fx + rr).addScaledVector(_lat, fy);
      this.body.addForceAtPoint(_force, wheel.contact, true);

      // suspension force pushes the car up at the contact patch
      _force.copy(_up).multiplyScalar(wheel.baseForce);
      this.body.addForceAtPoint(_force, wheel.contact, true);

      // ---- wheel spin: drive torque - tyre reaction - brakes.
      // Semi-implicit: linearise Fx around the current wheel speed and solve.
      // Purely explicit integration is stiff here (a wheel can gain 30 m/s of
      // surface speed in a frame) and oscillates until the tyres let go.
      const inertia = this.wheelInertia;
      const eps = 0.5;
      const k1 = ((wheel.omega + eps) * R - vLong) / denom;
      const f1 = this.tire.evaluate(wheel.load, k1, alpha);
      const dFdOmega = (f1.fx - res.fx) / eps;
      const denomW = Math.max(inertia / dt + R * dFdOmega, inertia / dt);
      let omega = freeRoll
        ? vLong / R
        : wheel.omega + (wheel.driveTorque - fx * R) / denomW;

      if (!freeRoll) {
        const brakeTorque = this._brakeTorque(wheel, input.brake, input.handbrake);
        const brakeDw = (brakeTorque / inertia) * dt;
        if (Math.abs(omega) <= brakeDw) omega = 0;
        else omega -= Math.sign(omega) * brakeDw;
      }

      const limit = wheel.driven ? (this.drivetrain.gear === -1 ? 500 : Math.min(drive.maxWheelOmega, 300)) : 300;
      let omegaClamped = clamp(omega, -limit, limit);

      // traction control: never let a driven wheel run more than peak slip
      // ahead of the road. Reverse handled by the sign of the contact speed.
      if (this.assists.tc && wheel.driven && input.throttle > 0.05 && this.drivetrain.gear !== -1) {
        const dir = vLong < -0.2 ? -1 : 1;
        const target = (vLong + dir * slipTargetFor(vLong)) / R;
        if (dir > 0 && omegaClamped > target) {
          omegaClamped = target;
          tcActive = true;
        } else if (dir < 0 && omegaClamped < target) {
          omegaClamped = target;
          tcActive = true;
        }
      }

      wheel.omega = omegaClamped;
      wheel.spinAngle += wheel.omega * dt;
    }

    // ------------------------------------------------------------- 4. aero
    const aero = cfg.aero;
    const v2 = _lin.lengthSq();
    if (v2 > 0.01) {
      const qDyn = 0.5 * aero.airDensity * v2;
      // drag, applied at CoG
      const speedAbs = Math.sqrt(v2);
      _force.copy(_lin).multiplyScalar(-(qDyn * aero.dragCdA) / speedAbs);
      this.body.addForce(_force, true);

      // downforce at the axles (negative lift = pushing down)
      _tmp.set(0, qDyn * aero.frontLiftClA, aero.frontAxleZ).applyQuaternion(_q).add(_pos);
      _force.copy(_up).multiplyScalar(qDyn * aero.frontLiftClA);
      this.body.addForceAtPoint(_force, _tmp, true);

      _tmp.set(0, qDyn * aero.rearLiftClA, aero.rearAxleZ).applyQuaternion(_q).add(_pos);
      _force.copy(_up).multiplyScalar(qDyn * aero.rearLiftClA);
      this.body.addForceAtPoint(_force, _tmp, true);
    }

    // ---------------------------------------------------------- 5. telemetry
    // real accelerations measured from the body velocity, in body axes
    const tm = this.telemetry;
    if (!this._lastVel) {
      this._lastVel = new THREE.Vector3().copy(_lin);
    }
    _tmp.copy(_lin).sub(this._lastVel).divideScalar(Math.max(dt, 1e-4));
    tm.gLat = _tmp.dot(_latBody) / 9.81;
    tm.gLong = _tmp.dot(_fwdBody) / 9.81;
    this._lastVel.copy(_lin);

    this.telemetry.speed = speed;
    this.telemetry.speedKmh = Math.abs(speed) * 3.6;
    this.telemetry.rpm = drive.rpm;
    this.telemetry.gear = this.drivetrain.gearLabel;
    this.telemetry.shifting = drive.shifting;
    this.telemetry.throttle = input.throttle;
    this.telemetry.brake = input.brake;
    this.telemetry.handbrake = !!input.handbrake;
    this.telemetry.steer = this.steerAngle;
    this.telemetry.slipAngleMax = maxSlip;
    this.telemetry.tcActive = tcActive;
    this.telemetry.escActive = escActive;
  }

  _antiRoll(left, right, stiffness) {
    if (!stiffness) return 0;
    const cl = left.grounded ? left.compression : 0;
    const cr = right.grounded ? right.compression : 0;
    return stiffness * (cl - cr);
  }

  _applyArb(left, right, force) {
    left.baseForce = clamp(left.baseForce + force, 0, 60000);
    right.baseForce = clamp(right.baseForce - force, 0, 60000);
  }

  /** Put the car back on its wheels at a given pose. */
  reset(position, quaternion) {
    this.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.body.setRotation(
      { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
      true,
    );
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.drivetrain.gear = 1;
    this.drivetrain.rpm = this.cfg.engine.idleRpm;
    this.drivetrain.shiftTimer = 0;
    this.steerAngle = 0;
    this.reverseHold = 0;
    this._lastSpeed = 0;
    if (this._lastVel) this._lastVel.set(0, 0, 0);
    for (const wheel of this.wheels) {
      wheel.omega = 0;
      wheel.spinAngle = 0;
      wheel.suspLen = this.cfg.suspension.restLength;
      wheel.localY = wheel.mount.y - wheel.suspLen;
      wheel.fx = 0;
      wheel.fy = 0;
      wheel.slipRatio = 0;
      wheel.slipAngle = 0;
      wheel.escBrake = 0;
      wheel.driveTorque = 0;
      wheel.load = 0;
      wheel.baseForce = 0;
    }
  }
}

function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}
