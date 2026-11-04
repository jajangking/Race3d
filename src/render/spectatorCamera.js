import * as THREE from 'three';

/**
 * Spectator cameras for AI-vs-AI race mode. The player watches the field and
 * switches between four shots with C, and picks which car to follow with X:
 *
 *   tv        a pure broadcast feed like an F1 TV channel, directed by a
 *             Q-learning agent: it is NOT locked to one car - every cut it
 *             picks both the shot and its own subject from the whole field.
 *             Actions: a long slowly-orbiting HELICOPTER pass on whoever is
 *             most interesting, a static CORNER camera at the next big
 *             corner a car is about to take, a 1V1 close-up on the closest
 *             pair in the field (their battle), and a CRASH camera that
 *             pre-empts everything the moment a car goes off track (driver
 *             recover/reverse mode) and holds until it is cleared.
 *             State: leader gap bucket x pack density around the leader
 *             (12 states). Reward per shot: how interesting the on-screen
 *             car was (rank, battle gaps, corner approaches, recency) plus
 *             subject novelty, minus back-to-back same-camera repeats.
 *             Q starts from a hand-tuned "experienced director" prior,
 *             updates online every cut (alpha 0.06, gamma 0.9, epsilon
 *             0.15 -> 0.03) and is persisted to localStorage.
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
  { name: 'HELI', fov: 55, dur: [12, 17] },
  { name: 'CORN', fov: 38, dur: [6, 9] },
  { name: '1V1', fov: 36, dur: [6, 8] },
  { name: 'CRASH', fov: 40, dur: [3, 6] },
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

    // tv director (broadcast feed: HELI / CORN / 1V1 / CRASH)
    this.shot = 0;
    this.shotTimer = 12;
    this._focus = null;
    this._shotGen = 0; // bumped on every hard cut
    this._field = null;
    this._race = null;
    this._corners = null; // cached major-corner list, built lazily
    this.oneIdx = -1; // parity for the 1V1 side flip
    this.oneCar = null; // object reference to the car 1V1 is on
    this.oneGen = -1; // shot generation 1V1 was picked in
    this._crashHold = 0; // seconds the CRASH shot must stay on screen
    this._crashTarget = null; // the car the crash camera is on

    // Q-learning director: 12 states (leader-gap x pack) x 3 actions
    // (0 HELI, 1 CORN, 2 1V1); CRASH (3) is forced, never learned
    this.Q = new Float64Array(36);
    const prior = [
      [0.35, 0.5, 0.45, 0.6], // HELI by leader-gap bucket
      [0.55, 0.6, 0.65, 0.55], // CORN
      [1.0, 0.95, 0.55, 0.25], // 1V1
    ];
    for (let s = 0; s < 12; s++) {
      const g = (s / 3) | 0;
      for (let a = 0; a < 3; a++) this.Q[s * 3 + a] = prior[a][g];
    }
    this.qEps = 0.15;
    this._subject = null; // the car the current shot is on
    this._subjectEntry = null; // {car, driver} for fast u access
    this._prevSubject = null;
    this._prevShot = -1;
    this._pendS = null; // (state, action) of the last decision
    this._pendA = null;
    this._shotSum = 0; // accumulated on-screen interest of the current shot
    this._shotFrames = 0;
    this._seen = new Map(); // car -> time it last was the on-screen subject
    this._loadDirector();

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
    this.shotTimer = 12;
    this._shotGen++;
    this._crashHold = 0;
    this._crashTarget = null;
    this._subject = null;
    this._subjectEntry = null;
    this._prevSubject = null;
    this._prevShot = -1;
    this._pendS = null;
    this._pendA = null;
    this._shotSum = 0;
    this._shotFrames = 0;
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
    const line = this.track.racingLine;
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

  update(dt, car, driver, field, race) {
    this.time += dt;
    this._field = field;
    this._race = race;
    // in TV mode the Q-director owns the subject, so a focus change
    // (lead change / X key) must not re-seat the camera; the other modes
    // still snap on re-focus
    if (car !== this._focus) {
      this._focus = car;
      if (this.mode !== 'tv') {
        this.initialised = false;
        this.oneCar = null;
        this.oneGen = -1;
      }
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
      this._tvShot(dt, driver, car);
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
    this._k = 1 - Math.exp(-(this._kx || 2) * dt);
    this._kUp = 1 - Math.exp(-(this._ky || 2.6) * dt);
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
  _tvShot(dt, driver, focusCar) {
    // ------------------------------------------------ crash pre-emption
    // the feed cuts to the incident the moment any car goes off track
    // (driver recover/reverse mode) and holds until it is cleared
    let incident = null;
    const f = this._field;
    if (f) {
      for (let i = 0; i < f.length; i++) {
        const d = f[i].driver;
        if (d && (d.mode === 'recover' || d.mode === 'reverse')) {
          if (!incident || (d.recoverTime || 0) > (incident.driver.recoverTime || 0)) incident = f[i];
        }
      }
    }
    if (incident) {
      this._crashTarget = incident.car;
      this._crashHold = Math.max(this._crashHold, 1.5);
      if (this.shot !== 3) {
        this.shot = 3;
        this.initialised = false; // hard cut to the incident
        this._shotGen++;
        // the crash cam is outside the Q action space: drop the pending
        // decision so its (meaningless) reward is never applied
        this._pendA = null;
        this._pendS = null;
        this._shotSum = 0;
        this._shotFrames = 0;
      }
    } else {
      this._crashHold -= dt;
    }
    if (this.shot === 3) {
      // stay on the crash cam while the hold lasts; when it expires and the
      // incident is over, let the normal rotation take over
      if (!incident && this._crashHold <= 0) {
        this.shot = 0;
        this.shotTimer = 3;
        this.initialised = false;
        this._shotGen++;
        this._crashTarget = null;
        this._subject = null; // re-seat a fresh subject for the heli pass
      } else {
        this._crashShot(dt);
        return;
      }
    }
    // ------------------------------------------------ the Q-learning cut
    const S = this._scene();
    if (this._subject === null && S) {
      // first frame in TV: seat the subject for the opening shot (no cut)
      this._subject = this._pickSubject(this.shot, S, focusCar);
      this._seatSubject();
    }
    // reward accumulation: how interesting is the car on screen right now
    if (S && this._subject) {
      this._shotSum += S.interests.get(this._subject) || 0;
      this._shotFrames++;
    }
    this.shotTimer -= dt;
    if (this.shotTimer <= 0) {
      let next;
      if (S) {
        const s = S.state;
        // reward of the shot that just ended: average on-screen interest,
        // plus subject novelty, minus back-to-back same-camera repeats
        const avg = this._shotFrames ? this._shotSum / this._shotFrames : 0;
        const r =
          avg +
          (this._subject && this._prevSubject && this._subject !== this._prevSubject ? 0.15 : 0) -
          (this._prevShot >= 0 && this.shot === this._prevShot ? 0.3 : 0);
        // Q-update for the decision taken at the previous cut
        if (this._pendA !== null && this._pendS !== null) {
          const idx = this._pendS * 3 + this._pendA;
          let maxQ = -Infinity;
          for (let b = 0; b < 3; b++) maxQ = Math.max(maxQ, this.Q[s * 3 + b]);
          this.Q[idx] = Math.max(-2, Math.min(3, this.Q[idx] + 0.06 * (r + 0.9 * maxQ - this.Q[idx])));
        }
        // epsilon-greedy on the current state
        if (Math.random() < this.qEps) {
          next = (Math.random() * 3) | 0;
        } else {
          next = 0;
          for (let b = 1; b < 3; b++) if (this.Q[s * 3 + b] > this.Q[s * 3 + next]) next = b;
        }
        this.qEps = Math.max(0.03, this.qEps * 0.9985);
        this._pendS = s;
        this._pendA = next;
        this._saveDirector();
      } else {
        // no field data: fall back to plain random rotation
        do {
          next = (Math.random() * 3) | 0;
        } while (next === this.shot);
      }
      this._prevSubject = this._subject;
      this._prevShot = this.shot;
      this.shot = next;
      const d = TV_SHOTS[next].dur;
      this.shotTimer = d[0] + Math.random() * (d[1] - d[0]);
      // new subject for the new shot - picked by the director, not the X key
      this._subject = S ? this._pickSubject(next, S, focusCar) : focusCar;
      this._seatSubject();
      this.initialised = false; // hard cut, like a real broadcast
      this._shotGen++;
      this._shotSum = 0;
      this._shotFrames = 0;
    }
    if (this.shot === 0) {
      // heli: high, slowly orbiting around its subject, wide angle
      this._subjectPose();
      this._heliShot();
      return;
    } else if (this.shot === 1) {
      // corn: static trackside camera at the next big corner ahead of the
      // subject car - it drives into the frame
      this._cornerShot(this._subjectU());
      return;
    }
    // 1v1: close-up on the closest pair, from behind the trailing car
    this._subjectPose();
    this._oneShot(focusCar);
  }

  // ------------------------------------------------ Q director helpers
  _scene() {
    // per-frame field analysis: rank order, leader gap, pack density and a
    // per-car "interesting" score (rank + battle gaps + corner approach +
    // recency - all the signals a human director uses)
    const f = this._field;
    const r = this._race;
    if (!f || !f.length || !r || !Array.isArray(r.progress) || r.progress.length !== f.length) return null;
    const n = f.length;
    const L = this.track.length;
    const order = f.map((_, i) => i).sort((a, b) => r.progress[b] - r.progress[a]);
    const rankOf = new Array(n);
    for (let k = 0; k < n; k++) rankOf[order[k]] = k;
    let gapLead = 99;
    let pack = 0;
    for (let i = 1; i < n; i++) {
      let g = (r.progress[order[0]] - r.progress[order[i]]) * L;
      if (g < 0) g += L;
      if (i === 1) gapLead = g;
      if (g < 25) pack++;
    }
    const sGap = gapLead < 3 ? 0 : gapLead < 10 ? 1 : gapLead < 30 ? 2 : 3;
    const sPack = pack <= 1 ? 0 : pack <= 3 ? 1 : 2;
    const corners = this._ensureCorners();
    const now = this.time;
    const interests = new Map();
    for (let i = 0; i < n; i++) {
      const e = f[i];
      let it = 1.0 - 0.08 * rankOf[i];
      // battle: how close this car is to the car in front of it
      const ahead = rankOf[i] > 0 ? order[rankOf[i] - 1] : order[n - 1];
      let gap = (r.progress[ahead] - r.progress[i]) * L;
      if (gap <= 0) gap += L;
      if (gap < 8) it += 0.6;
      else if (gap < 25) it += 0.3;
      else if (gap > 70) it -= 0.15;
      // corner approach: any major corner within the next ~120 m
      const uu = e.driver ? e.driver.u : 0;
      for (let c = 0; c < corners.length; c++) {
        if (wrap(corners[c].u - uu) < 0.07) {
          it += 0.2;
          break;
        }
      }
      // recency: the feed should not stay glued to one car
      const last = this._seen.get(e.car);
      if (last !== undefined) {
        const age = now - last;
        if (age < 12) it -= 0.5 * Math.exp(-age / 8);
      }
      interests.set(e.car, Math.max(0.05, Math.min(1.5, it)));
    }
    return { state: sGap * 3 + sPack, interests, order };
  }

  _pickSubject(a, S, focusCar) {
    const f = this._field;
    if (!f || !f.length) return focusCar;
    if (a === 2) {
      // 1V1: always the closest pair in the field - show its trailing car
      const n = f.length;
      const L = this.track.length;
      let best = Infinity;
      let trailer = null;
      for (let i = 0; i < n; i++) {
        const A = S.order[i];
        const B = S.order[(i + 1) % n];
        let g = (this._race.progress[A] - this._race.progress[B]) * L;
        if (g <= 0) g += L;
        if (g < best) {
          best = g;
          trailer = f[B].car;
        }
      }
      if (trailer) return trailer;
    }
    // HELI / CORN: whoever is most interesting right now
    let best = -1;
    let bestCar = focusCar;
    for (let i = 0; i < f.length; i++) {
      const it = S.interests.get(f[i].car) || 0;
      if (it > best) {
        best = it;
        bestCar = f[i].car;
      }
    }
    return bestCar;
  }

  _seatSubject() {
    const car = this._subject;
    if (!car) return;
    if (this._field) {
      for (const e of this._field) {
        if (e.car === car) {
          this._subjectEntry = e;
          break;
        }
      }
    }
    this._seen.set(car, this.time);
    if (this.shot === 2) {
      this.oneCar = car;
      this.oneGen = this._shotGen;
      this.oneIdx = (this.oneIdx + 1) | 0; // alternate the side flip
    }
  }

  _subjectU() {
    return this._subjectEntry && this._subjectEntry.driver ? this._subjectEntry.driver.u : 0;
  }

  _subjectPose() {
    // point the shared pose scratch at the current subject, not the focus car
    const car = this._subject || this._focus;
    if (!car) return;
    const t = car.body.translation();
    const q = car.body.rotation();
    _camQuat.set(q.x, q.y, q.z, q.w);
    _fwd.set(0, 0, 1).applyQuaternion(_camQuat);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();
    _center.set(t.x, t.y + 0.7, t.z);
  }

  _loadDirector() {
    // the director remembers what it learned between sessions
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem('race3d-qdirector-v1');
      if (!raw) return;
      const d = JSON.parse(raw);
      if (Array.isArray(d.q) && d.q.length === 36) {
        for (let i = 0; i < 36; i++) {
          const v = Number(d.q[i]);
          if (Number.isFinite(v)) this.Q[i] = Math.max(-2, Math.min(3, v));
        }
        const e = Number(d.e);
        if (Number.isFinite(e) && e >= 0.01) this.qEps = Math.min(0.15, e);
      }
    } catch {
      /* corrupted blob - keep the prior */
    }
  }

  _saveDirector() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem('race3d-qdirector-v1', JSON.stringify({ v: 1, q: Array.from(this.Q), e: this.qEps }));
    } catch {
      /* storage unavailable - learning is still in-memory */
    }
  }

  _crashShot(dt) {
    const target = this._crashTarget && this._crashTarget.body ? this._crashTarget : this._focus;
    const t = target.body.translation();
    const q = target.body.rotation();
    _camQuat.set(q.x, q.y, q.z, q.w);
    _fwd.set(0, 0, 1).applyQuaternion(_camQuat);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();
    _center.set(t.x, t.y + 0.7, t.z);
    // elevated trackside broadcast mast on the inside of the incident
    const curve = this.track.curve;
    let side = this.sideFlip;
    if (this._field) {
      for (let i = 0; i < this._field.length; i++) {
        if (this._field[i].car === target) {
          const d = this._field[i].driver;
          const uu = d ? d.u : 0;
          curve.getPointAt(uu, _trackPos);
          curve.getTangentAt(uu, _trackTan);
          _trackTan.y = 0;
          _trackTan.normalize();
          _trackRight.set(_trackTan.z, 0, -_trackTan.x);
          const lat = (t.x - _trackPos.x) * _trackRight.x + (t.z - _trackPos.z) * _trackRight.z;
          if (Math.abs(lat) > 2) side = lat > 0 ? -1 : 1; // inside of the incident
          _desired.copy(_trackPos).addScaledVector(_trackRight, side * 12.5);
          _desired.y = Math.max(_desired.y, 6.5);
          _look.copy(_center);
          this._setDamp(2.2, 2.8);
          return;
        }
      }
    }
    _desired.copy(_fwd).multiplyScalar(-12).add(_center);
    _desired.y = Math.max(_desired.y, 6.5);
    _look.copy(_center);
    this._setDamp(2.2, 2.8);
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


  // ---- corner detection: merge curvature peaks of the AI line into the
  // biggest corners, cached for the whole session (static per track).
  _ensureCorners() {
    if (this._corners) return this._corners;
    // layout-derived: one camera slot at EVERY designed corner (both
    // tracks ship their corner list); the curvature detector below stays
    // as a fallback for tracks without layout data
    if (Array.isArray(this.track.corners) && this.track.corners.length) {
      this._corners = this.track.corners;
      return this._corners;
    }
    const line = this.track.racingLine;
    const out = [];
    if (line && line.curvatureSigned) {
      const n = line.n;
      const c = line.curvatureSigned;
      // adaptive threshold: corners are 35%+ of the track's sharpest bend
      // (R ~ 13 m on the rally gauntlet, R ~ 20 m on the flowing circuit)
      let maxC = 0;
      for (let k = 0; k < n; k++) maxC = Math.max(maxC, Math.abs(c[k]));
      const THR = Math.max(0.014, 0.35 * maxC);
      let run = null;
      const flush = () => {
        if (!run) return;
        // short spikes are spline artifacts / AI-line weaving, not corners
        if (run.u1 - run.u0 < 4) { run = null; return; }
        let mid = run.u0;
        for (let k = run.u0; k <= run.u1; k++) {
          if (Math.abs(c[k % n]) >= run.max) mid = k % n;
        }
        out.push({
          u: (run.u0 + run.u1) / 2 / n,
          side: Math.sign(c[mid]) || 1,
          strength: run.max,
        });
        run = null;
      };
      for (let k = 0; k < n; k++) {
        const v = Math.abs(c[k]);
        if (v > THR) {
          if (!run) run = { u0: k, u1: k, max: v };
          else { run.u1 = k; if (v > run.max) run.max = v; }
        } else if (run && k - run.u1 > 5) {
          flush(); // 5-sample tolerance: the AI line weaves inside hairpins
        }
      }
      flush();
      out.sort((a, b) => b.strength - a.strength);
    }
    this._corners = out.slice(0, 13);
    return this._corners;
  }

  _cornerShot(u) {
    const corners = this._ensureCorners();
    if (corners.length === 0) {
      // no line data yet - fall back to the trackside slider
      this._sideFallback(u);
      return;
    }
    // the nearest major corner ahead of the focus car (wrap-aware)
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < corners.length; i++) {
      const d = wrap(corners[i].u - u);
      if (d < bestDist) { bestDist = d; best = corners[i]; }
    }
    const curve = this.track.curve;
    curve.getPointAt(best.u, _trackPos);
    curve.getTangentAt(best.u, _trackTan);
    _trackTan.y = 0;
    _trackTan.normalize();
    _trackRight.set(_trackTan.z, 0, -_trackTan.x);
    // outside of the corner, just past the tyre line, at mast height
    _desired.copy(_trackPos).addScaledVector(_trackRight, best.side * 12.5);
    _desired.y = Math.max(_desired.y, 2.4);
    // look ~17 m before the apex so the car enters the frame early
    curve.getPointAt(wrap(best.u - 0.010), _look);
    _look.y = Math.max(_look.y, 0.9);
    this._setDamp(1.5, 2.0); // slow re-seat, then it just waits
  }

  _sideFallback(u) {
    const curve = this.track.curve;
    const uu = wrap(u + 0.006);
    curve.getPointAt(uu, _trackPos);
    curve.getTangentAt(uu, _trackTan);
    _trackTan.y = 0;
    _trackTan.normalize();
    _trackRight.set(_trackTan.z, 0, -_trackTan.x);
    const side = this._sideFor(uu);
    _desired.copy(_trackPos).addScaledVector(_trackRight, side * 11);
    _desired.y = Math.max(_desired.y, 2.2);
    _look.copy(_center).addScaledVector(_fwd, 4);
    this._setDamp(3.2, 4);
  }

  _heliShot() {
    const t = this.time;
    const ang = t * 0.24 + this.drift; // one slow orbit every ~26 s
    const r = 18 + 1.6 * Math.sin(t * 0.19);
    _right.set(_fwd.z, 0, -_fwd.x);
    _desired
      .copy(_center)
      .addScaledVector(_right, Math.cos(ang) * r)
      .addScaledVector(_fwd, Math.sin(ang) * r);
    _desired.y = _center.y + 21 + 2.2 * Math.sin(t * 0.16);
    // lead the car a bit so it sits in the lower third of the frame
    _look.copy(_center).addScaledVector(_fwd, 9);
    this._setDamp(1.2, 1.8);
  }

  _oneShot(focusCar) {
    // the director pre-picked the closest pair's trailing car as the subject
    const target = this._subject && this._subject.body ? this._subject : focusCar;
    const t = target.body.translation();
    const q = target.body.rotation();
    _camQuat.set(q.x, q.y, q.z, q.w);
    _fwd.set(0, 0, 1).applyQuaternion(_camQuat);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();
    _right.set(_fwd.z, 0, -_fwd.x);
    _center.set(t.x, t.y + 0.7, t.z);
    // tight broadcast close-up: low, behind-side; look ahead so the car
    // being chased fills the frame too
    const side = this.oneIdx % 2 === 0 ? 1 : -1;
    _desired
      .copy(_fwd)
      .multiplyScalar(-7)
      .add(_center)
      .addScaledVector(_right, side * 4.4);
    _desired.y = Math.max(_desired.y, 1.8);
    _look.copy(_center).addScaledVector(_fwd, 10);
    this._setDamp(2.8, 3.4);
  }

  _setDamp(kx, ky) {
    // rates only - update() converts them with the real frame dt
    this._kx = kx;
    this._ky = ky;
  }
}
