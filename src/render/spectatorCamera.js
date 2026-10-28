import * as THREE from 'three';

/**
 * Spectator cameras for AI-vs-AI race mode. The player watches the field and
 * switches between four shots with C, and picks which car to follow with X:
 *
 *   tv        a mini broadcast "director": hard-cuts between four different
 *             camera positions (high chase, overhead bird, road-level
 *             trackside, low front 3/4) every 5-8 s, and cuts again when
 *             the lead changes - like a real F1 feed
 *   orbit     fully player-driven: drag to rotate (yaw + pitch), wheel or
 *             pinch to zoom. Auto-rotation only kicks in after the player
 *             has stopped touching it
 *   cinematic slow montage of choreographed shots (trackside dolly, rising
 *             crane, high aerial sweep, low front 3/4) with sliding
 *             transitions, letterboxed
 *   drone     high, wide tracking shot from far behind, with a slow drift
 *
 * TV cuts snap (initialised = false); every other move is exponentially
 * damped so pans feel like a human operator.
 */

const MODES = ['tv', 'orbit', 'cinematic', 'drone'];
const BASE_LABELS = { tv: 'TV', orbit: 'ORBIT', cinematic: 'CINEMATIC', drone: 'DRONE' };

const TV_SHOTS = [
  { name: 'CHASE', fov: 46 },
  { name: 'BIRD', fov: 55 },
  { name: 'SIDE', fov: 40 },
  { name: 'FRONT', fov: 42 },
];

const CINE_SHOTS = [
  { name: 'DOLLY', fov: 36, dur: [9, 12] },
  { name: 'CRANE', fov: 40, dur: [10, 13] },
  { name: 'AERIAL', fov: 48, dur: [9, 12] },
  { name: 'FRONT', fov: 34, dur: [8, 11] },
];

const _camQuat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _center = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _trackPos = new THREE.Vector3();
const _trackTan = new THREE.Vector3();
const _trackRight = new THREE.Vector3();
const _to = new THREE.Vector3();

const wrap = (u) => ((u % 1) + 1) % 1;

export class SpectatorCamera {
  constructor(camera, canvas, track) {
    this.camera = camera;
    this.canvas = canvas;
    this.track = track;
    this.mode = 'tv';
    this.pos = new THREE.Vector3();
    this.initialised = false;
    this.enabled = false; // pointer interaction only in spectator mode
    this.time = 0;

    // free orbit
    this.orbitYaw = 0;
    this.orbitPitch = 0.42;
    this.radius = 9;
    this.lastTouch = -1e9;

    // tv director
    this.shot = 0;
    this.shotTimer = 6;
    this._focus = null;

    // cinematic
    this.cineShot = 0;
    this.cineT = 0;
    this.cineDur = 10;
    this.userAngle = 0; // manual drag offset (cinematic)
    this.sideFlip = 1; // which side of the car the lateral shots sit on
    this.drift = Math.random() * 100;
    this.targetFov = TV_SHOTS[0].fov;

    canvas.style.touchAction = 'none';
    this._attach();
  }

  get label() {
    if (this.mode === 'tv') return 'TV·' + TV_SHOTS[this.shot].name;
    if (this.mode === 'cinematic') return 'CINE·' + CINE_SHOTS[this.cineShot % 4].name;
    return BASE_LABELS[this.mode];
  }

  cycle() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
    // re-centre on mode change so the new framing arrives instantly
    this.initialised = false;
    this.shot = 0;
    this.shotTimer = 6;
    this.cineShot = 0;
    this.cineT = 0;
    return this.mode;
  }

  /**
   * Re-target to a (possibly different) focus car. TV snaps on the next
   * update (a broadcast cut when the lead changes); the other shots keep
   * their angles and only re-seat the camera when the new car is far away.
   */
  refocus(car) {
    if (this.mode === 'tv') return;
    const t = car.body.translation();
    const dx = this.pos.x - t.x;
    const dz = this.pos.z - t.z;
    if (dx * dx + dz * dz > 40 * 40) this.initialised = false;
  }

  _attach() {
    const canvas = this.canvas;
    const pts = new Map(); // pointerId -> {x, y}
    let pinchDist = 0;

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture?.(e.pointerId);
      this.lastTouch = this.time;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.enabled || !pts.has(e.pointerId)) return;
      const p = pts.get(e.pointerId);
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      this.lastTouch = this.time;
      if (pts.size === 2) {
        // two fingers: pinch zoom (orbit)
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.mode === 'orbit' && pinchDist > 0 && d > 0) {
          this.radius = THREE.MathUtils.clamp(this.radius * (pinchDist / d), 4.5, 24);
        }
        pinchDist = d;
        return;
      }
      if (this.mode === 'orbit') {
        // one finger / left drag: full free rotation
        this.orbitYaw -= dx * 0.006;
        this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + dy * 0.004, 0.06, 1.35);
      } else if (this.mode === 'cinematic') {
        this.userAngle -= dx * 0.005;
      }
    });
    const end = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinchDist = 0;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled || this.mode !== 'orbit') return;
        e.preventDefault();
        this.radius = THREE.MathUtils.clamp(this.radius + e.deltaY * 0.012, 4.5, 24);
        this.lastTouch = this.time;
      },
      { passive: false },
    );
    canvas.addEventListener('contextmenu', (e) => {
      if (this.enabled) e.preventDefault();
    });
  }

  /** Which side of the track a trackside camera sits on: outside of the
   *  corner, or opposite the car's lateral bias on a straight. */
  _sideFor(u) {
    const line = this.track._aiLine;
    let side = 0;
    if (line) {
      const i = Math.round(u * line.n) % line.n;
      const c = line.curvatureSigned[i];
      if (Math.abs(c) > 0.004) side = c > 0 ? 1 : -1; // left bend -> outside right
    }
    if (side === 0) {
      // on a straight: sit opposite the car so it frames against the track
      this.track.curve.getPointAt(u, _trackPos);
      _to.subVectors(_center, _trackPos);
      _to.y = 0;
      _trackTan.y = 0;
      _trackRight.set(_trackTan.z, 0, -_trackTan.x);
      const lat = _to.dot(_trackRight);
      side = lat > 0.5 ? -1 : lat < -0.5 ? 1 : this.sideFlip;
    }
    return side;
  }

  update(dt, car, driver) {
    this.time += dt;
    // a broadcast cuts when the focus car changes (the lead changes)
    if (car !== this._focus) {
      this._focus = car;
      this.initialised = false;
    }

    const t = car.body.translation();
    const q = car.body.rotation();
    _camQuat.set(q.x, q.y, q.z, q.w);
    _fwd.set(0, 0, 1).applyQuaternion(_camQuat);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();
    _center.set(t.x, t.y + 0.7, t.z);

    let fov;
    if (this.mode === 'tv') {
      this._tvShot(dt, driver);
      fov = TV_SHOTS[this.shot].fov;
    } else if (this.mode === 'orbit') {
      this._orbitShot(dt);
      fov = 55;
    } else if (this.mode === 'cinematic') {
      this._cineShot(dt);
      fov = CINE_SHOTS[this.cineShot % 4].fov;
    } else {
      this._droneShot(dt);
      fov = 50;
    }
    // Portrait phones: keep the broadcast frame from being cropped
    // horizontally the same way the chase cam widens (same math).
    if (this.camera.aspect < 1) {
      const tanH = Math.tan(THREE.MathUtils.degToRad(fov / 2)) / this.camera.aspect;
      fov = Math.min(95, THREE.MathUtils.radToDeg(2 * Math.atan(tanH)));
    }
    const k = this._k;
    const kUp = this._kUp;

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

    this.targetFov += (fov - this.targetFov) * Math.min(1, dt * 3);
    if (Math.abs(cam.fov - this.targetFov) > 0.01) {
      cam.fov = this.targetFov;
      cam.updateProjectionMatrix();
    }
  }

  // ------------------------------------------------------------ TV shots
  _tvShot(dt, driver) {
    this.shotTimer -= dt;
    const i = this.shot;
    if (this.shotTimer <= 0) {
      let next;
      do {
        next = (Math.random() * TV_SHOTS.length) | 0;
      } while (next === i);
      this.shot = next;
      this.shotTimer = 5 + Math.random() * 3;
      this.initialised = false; // hard cut, like a real broadcast
    }
    const u = driver ? driver.u : 0;
    if (i === 0) {
      // chase: high behind, car sits in the lower third
      _desired.copy(_fwd).multiplyScalar(-15).add(_center);
      _desired.y = Math.max(_desired.y, 10.5);
      _look.copy(_fwd).multiplyScalar(9).add(_center);
      this._setDamp(2.2, 2.8, dt);
    } else if (i === 1) {
      // bird: overhead, slightly behind, looking down the track
      _desired.copy(_fwd).multiplyScalar(-7).add(_center);
      _desired.y = Math.max(_desired.y, 21);
      _look.copy(_fwd).multiplyScalar(11).add(_center);
      this._setDamp(1.8, 2.4, dt);
    } else if (i === 2) {
      // side: road-level trackside cam, sliding along the track edge
      const curve = this.track.curve;
      const uu = wrap(u + 0.006);
      curve.getPointAt(uu, _trackPos);
      curve.getTangentAt(uu, _trackTan);
      _trackTan.y = 0;
      _trackTan.normalize();
      _trackRight.set(_trackTan.z, 0, -_trackTan.x);
      const side = this._sideFor(uu);
      // 11 m out keeps the cam outside the tyre barrier line (9.9 m)
      _desired.copy(_trackPos).addScaledVector(_trackRight, side * 11);
      _desired.y = Math.max(_desired.y, 2.2);
      _look.copy(_center).addScaledVector(_fwd, 4);
      this._setDamp(3.2, 4, dt);
    } else {
      // front: low 3/4, the car chases the camera
      _desired
        .copy(_fwd)
        .multiplyScalar(13)
        .add(_center)
        .addScaledVector(_right, this.sideFlip * 6.5);
      _desired.y = Math.max(_desired.y, 1.9);
      _look.copy(_center).addScaledVector(_fwd, 1);
      this._setDamp(2.6, 3.2, dt);
    }
  }

  // ---------------------------------------------------------- orbit shot
  _orbitShot(dt) {
    // auto-rotation only when the player has left it alone for a while -
    // while dragging the camera must stay exactly where the player puts it
    if (this.time - this.lastTouch > 4) this.orbitYaw += dt * 0.35;
    const r = this.radius;
    const cp = Math.cos(this.orbitPitch);
    _right.set(_fwd.z, 0, -_fwd.x);
    _desired
      .copy(_center)
      .addScaledVector(_right, Math.cos(this.orbitYaw) * r * cp)
      .addScaledVector(_fwd, Math.sin(this.orbitYaw) * r * cp);
    _desired.y = _center.y + 0.6 + r * Math.sin(this.orbitPitch);
    _look.copy(_center);
    this._setDamp(8, 8, dt);
  }

  // ------------------------------------------------------- cine montage
  _cineShot(dt) {
    this.cineT += dt;
    const i = this.cineShot;
    const t = Math.min(this.cineT / this.cineDur, 1);
    if (this.cineT >= this.cineDur) {
      let next;
      do {
        next = (Math.random() * CINE_SHOTS.length) | 0;
      } while (next === i);
      this.cineShot = next;
      this.cineT = 0;
      this.cineDur =
        CINE_SHOTS[next].dur[0] + Math.random() * (CINE_SHOTS[next].dur[1] - CINE_SHOTS[next].dur[0]);
      this.sideFlip = -this.sideFlip;
      // no hard cut: the slow damping below slides between shots
    }
    const a = this.userAngle;
    if (i % 4 === 0) {
      // dolly: low trackside, drifting around the car at road level
      const r = 13 - 4 * t;
      const ang = a + Math.PI * 0.5 + t * 1.2;
      _desired
        .copy(_center)
        .addScaledVector(_right, Math.cos(ang) * r)
        .addScaledVector(_fwd, Math.sin(ang) * r);
      _desired.y = 1.3 + t * 0.5;
      _look.copy(_center).addScaledVector(_fwd, 3);
    } else if (i % 4 === 1) {
      // crane: rises from road level to high over the car
      _desired.copy(_center).addScaledVector(_fwd, -13 + 9 * t);
      _desired.y = 1.3 + 13 * t * t;
      _look.copy(_center).addScaledVector(_fwd, 3.5);
    } else if (i % 4 === 2) {
      // aerial: slow wide sweep from high up
      const ang = a + this.time * 0.16;
      const r = 17 + 3 * Math.sin(t * Math.PI);
      _desired
        .copy(_center)
        .addScaledVector(_right, Math.cos(ang) * r)
        .addScaledVector(_fwd, Math.sin(ang) * r);
      _desired.y = 13.5 + 3 * Math.sin(t * Math.PI);
      _look.copy(_center).addScaledVector(_fwd, 2);
    } else {
      // front 3/4: low camera the car chases, drifting sideways
      _desired
        .copy(_fwd)
        .multiplyScalar(15 - 3 * t)
        .add(_center)
        .addScaledVector(_right, this.sideFlip * (7 + 2.5 * Math.sin(t * Math.PI)));
      _desired.y = 1.6;
      _look.copy(_center).addScaledVector(_fwd, -1);
    }
    this._setDamp(1.8, 2.2, dt);
  }

  // ---------------------------------------------------------- drone shot
  _droneShot(dt) {
    this.drift += dt;
    const d = this.drift;
    _desired
      .copy(_fwd)
      .multiplyScalar(-24 + 3 * Math.sin(d * 0.11))
      .add(_center)
      .addScaledVector(_right, 2.5 * Math.sin(d * 0.07 + 1.7));
    _desired.y = Math.max(_desired.y, 16);
    _look.copy(_fwd).multiplyScalar(8).add(_center);
    this._setDamp(1.6, 2.2, dt);
  }

  _setDamp(kx, ky, dt) {
    // stored so the caller's k/kUp pick up the right snappiness per shot
    this._k = 1 - Math.exp(-kx * dt);
    this._kUp = 1 - Math.exp(-ky * dt);
  }
}
