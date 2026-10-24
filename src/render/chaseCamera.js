import * as THREE from 'three';

/**
 * Smooth chase camera. Position is critically damped toward a point behind and
 * above the car; the look target leads the car so corners open up before you
 * get to them. FOV widens with speed for a bit of theatre.
 */

const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _camQuat = new THREE.Quaternion();

export class ChaseCamera {
  constructor(camera, track) {
    this.camera = camera;
    this.track = track;
    this.mode = 0; // 0 = chase, 1 = far chase, 2 = bumper
    this.distance = 7.2;
    this.height = 2.35;
    this.lookAhead = 5.5;
    this.pos = new THREE.Vector3();
    this.targetFov = 58;
    this.shake = 0;
    this.initialised = false;
  }

  cycle() {
    this.mode = (this.mode + 1) % 3;
    if (this.mode === 0) {
      this.distance = 7.2;
      this.height = 2.35;
      this.lookAhead = 5.5;
    } else if (this.mode === 1) {
      this.distance = 12;
      this.height = 4.6;
      this.lookAhead = 3;
    } else {
      this.distance = 0.6;
      this.height = 0.75;
      this.lookAhead = 8;
    }
  }

  snap(car) {
    this.initialised = false;
    this.update(0.016, car, true);
  }

  update(dt, car, snap = false) {
    const t = car.body.translation();
    const q = car.body.rotation();
    const quat = _camQuat.set(q.x, q.y, q.z, q.w);
    _fwd.set(0, 0, 1).applyQuaternion(quat);
    _up.set(0, 1, 0).applyQuaternion(quat);

    const speed = Math.abs(car.telemetry.speed);
    const distance = this.distance + Math.min(speed * 0.045, 1.6);
    const height = this.height + Math.min(speed * 0.012, 0.5);

    if (this.mode === 2) {
      // bumper cam sits at the nose, on the body
      _desired.set(0, 0.62, 2.05).applyQuaternion(quat);
      _desired.x += t.x;
      _desired.y += t.y;
      _desired.z += t.z;
      _look.copy(_fwd).multiplyScalar(18).add(_desired);
      _look.y += 0.4;
    } else {
      // behind the car, but don't follow its roll (up stays mostly world-up)
      _desired.copy(_fwd).multiplyScalar(-distance).add(
        _vel.set(t.x, t.y, t.z),
      );
      _desired.y += height;
      _desired.x += _up.x * 0.12;
      _desired.z += _up.z * 0.12;

      _look.copy(_fwd).multiplyScalar(this.lookAhead).add(_vel.set(t.x, t.y, t.z));
      _look.y += 0.95;
    }

    // keep the camera out of the floor
    _desired.y = Math.max(_desired.y, 0.45);

    if (!this.initialised || snap) {
      this.pos.copy(_desired);
      this.initialised = true;
    } else {
      const k = this.mode === 2 ? 1 : 1 - Math.exp(-6.5 * dt);
      // smooth position, but keep the height snappier than the horizontal
      this.pos.x += (_desired.x - this.pos.x) * k;
      this.pos.z += (_desired.z - this.pos.z) * k;
      this.pos.y += (_desired.y - this.pos.y) * (1 - Math.exp(-9 * dt));
    }

    const cam = this.camera;
    cam.position.copy(this.pos);

    // aim with a tiny amount of lateral G so the horizon leans in corners
    const lean = THREE.MathUtils.clamp(car.telemetry.gLat, -1.6, 1.6);
    const roll = this.mode === 2 ? 0 : lean * 0.012;
    cam.up.set(0, 1, 0);
    cam.lookAt(_look);
    cam.rotateZ(roll);

    const fovTarget = 58 + THREE.MathUtils.clamp(speed * 0.55, 0, 18) + (this.mode === 2 ? 10 : 0);
    this.targetFov += (fovTarget - this.targetFov) * Math.min(1, dt * 3);
    if (Math.abs(cam.fov - this.targetFov) > 0.01) {
      cam.fov = this.targetFov;
      cam.updateProjectionMatrix();
    }

    // high-speed shake
    const rumble = Math.max(0, speed - 40) * 0.0006;
    if (rumble > 0.0001) {
      cam.position.x += (Math.random() - 0.5) * rumble * 4;
      cam.position.y += (Math.random() - 0.5) * rumble * 2;
    }
  }
}
