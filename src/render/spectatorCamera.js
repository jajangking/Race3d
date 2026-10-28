import * as THREE from 'three';

/**
 * Spectator cameras for AI-vs-AI race mode. The player watches the field and
 * switches between four shots with C, and picks which car to follow with X:
 *
 *   tv        broadcast-style wide shot, high behind the focus car (usually
 *             the leader), smooth pan, wide FOV
 *   orbit     auto-orbit around the focus car; drag to rotate, wheel to zoom
 *   cinematic low, slow, sweeping shot (letterboxed)
 *   drone     high, wide tracking shot from far behind
 *
 * Position is exponentially damped like the chase camera, but with per-mode
 * snappiness so TV pans feel slow and orbit feels tight.
 */

const MODES = ['tv', 'orbit', 'cinematic', 'drone'];
const LABELS = { tv: 'TV CAM', orbit: 'ORBIT', cinematic: 'CINEMATIC', drone: 'DRONE' };
const FOV = { tv: 46, orbit: 55, cinematic: 38, drone: 50 };

const _camQuat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _center = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();

export class SpectatorCamera {
  constructor(camera, canvas) {
    this.camera = camera;
    this.canvas = canvas;
    this.mode = 'tv';
    this.pos = new THREE.Vector3();
    this.initialised = false;
    this.enabled = false; // pointer interaction only in spectator mode
    this.orbitAngle = 0;
    this.cineAngle = Math.PI * 0.25;
    this.userAngle = 0; // manual drag offset (orbit / cinematic)
    this.radius = 9; // orbit radius, wheel-zoomable
    this.targetFov = FOV.tv;
    canvas.style.touchAction = 'none';
    this._attach();
  }

  get label() {
    return LABELS[this.mode];
  }

  cycle() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
    // re-centre on mode change so the new framing arrives instantly
    this.initialised = false;
    return this.mode;
  }

  /**
   * Re-target to a (possibly different) focus car. TV glides between cars
   * like a broadcast pan; the other shots snap when the new car is far away
   * so the camera doesn't fly across the track.
   */
  refocus(car) {
    const t = car.body.translation();
    if (this.mode === 'tv') return;
    const dx = this.pos.x - t.x;
    const dz = this.pos.z - t.z;
    if (dx * dx + dz * dz > 40 * 40) this.initialised = false;
  }

  _attach() {
    const canvas = this.canvas;
    let dragId = null;
    let lx = 0;
    let ly = 0;

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      dragId = e.pointerId;
      lx = e.clientX;
      ly = e.clientY;
      canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (dragId !== e.pointerId || !this.enabled) return;
      const dx = e.clientX - lx;
      lx = e.clientX;
      ly = e.clientY;
      if (this.mode === 'orbit' || this.mode === 'cinematic') {
        this.userAngle -= dx * 0.006;
      }
    });
    const end = (e) => {
      if (dragId === e.pointerId) dragId = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled || this.mode !== 'orbit') return;
        e.preventDefault();
        this.radius = THREE.MathUtils.clamp(this.radius + e.deltaY * 0.01, 4.5, 22);
      },
      { passive: false },
    );
  }

  update(dt, car) {
    const t = car.body.translation();
    const q = car.body.rotation();
    _camQuat.set(q.x, q.y, q.z, q.w);
    _fwd.set(0, 0, 1).applyQuaternion(_camQuat);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();
    _center.set(t.x, t.y + 0.7, t.z);

    let k;
    let kUp;
    if (this.mode === 'tv') {
      // wide broadcast shot: high and behind, car sits in the lower third
      _desired.copy(_fwd).multiplyScalar(-15).add(_center);
      _desired.y = Math.max(_desired.y, 10.5);
      _look.copy(_fwd).multiplyScalar(9).add(_center);
      k = 1 - Math.exp(-2.1 * dt);
      kUp = 1 - Math.exp(-2.8 * dt);
    } else if (this.mode === 'drone') {
      _desired.copy(_fwd).multiplyScalar(-24).add(_center);
      _desired.y = Math.max(_desired.y, 16);
      _look.copy(_fwd).multiplyScalar(8).add(_center);
      k = 1 - Math.exp(-1.6 * dt);
      kUp = 1 - Math.exp(-2.2 * dt);
    } else if (this.mode === 'orbit') {
      this.orbitAngle += dt * 0.35;
      const a = this.orbitAngle + this.userAngle;
      const r = this.radius;
      _right.set(_fwd.z, 0, -_fwd.x);
      _desired
        .copy(_center)
        .addScaledVector(_right, Math.cos(a) * r)
        .addScaledVector(_fwd, Math.sin(a) * r);
      _desired.y = _center.y + 2.4 + r * 0.22;
      _look.copy(_center);
      k = 1 - Math.exp(-8 * dt);
      kUp = k;
    } else {
      // cinematic: low, slow sweep at road level
      this.cineAngle += dt * 0.07;
      const a = this.cineAngle + this.userAngle;
      _right.set(_fwd.z, 0, -_fwd.x);
      _desired
        .copy(_center)
        .addScaledVector(_right, Math.cos(a) * 15)
        .addScaledVector(_fwd, Math.sin(a) * 15);
      _desired.y = Math.max(_center.y + 1.1, 1.0);
      _look.copy(_center).addScaledVector(_fwd, 3);
      k = 1 - Math.exp(-1.1 * dt);
      kUp = 1 - Math.exp(-1.5 * dt);
    }

    _desired.y = Math.max(_desired.y, 0.7);

    if (!this.initialised) {
      this.pos.copy(_desired);
      this.initialised = true;
    } else {
      this.pos.x += (_desired.x - this.pos.x) * k;
      this.pos.z += (_desired.z - this.pos.z) * k;
      this.pos.y += (_desired.y - this.pos.y) * kUp;
    }

    const cam = this.camera;
    cam.position.copy(this.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(_look);

    const fovTarget = FOV[this.mode];
    this.targetFov += (fovTarget - this.targetFov) * Math.min(1, dt * 3);
    if (Math.abs(cam.fov - this.targetFov) > 0.01) {
      cam.fov = this.targetFov;
      cam.updateProjectionMatrix();
    }
  }
}
