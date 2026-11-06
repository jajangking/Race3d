import * as THREE from 'three';
import { CAR } from '../vehicle/config.js';

/**
 * Spectator cameras for AI-vs-AI race mode. The player watches the field and
 * switches between four shots with C, and picks which car to follow with X:
 *
 *   tv        a pure broadcast feed like an F1 TV channel, directed by a
 *             Q-learning agent: it is NOT locked to one car - every cut it
 *             picks both the shot and its own subject from the whole field.
 *             Actions: a HELICOPTER shot - one of the two real broadcast
 *             helicopters holds a locked rear-quarter framing (22 m
 *             behind, 12 m up, slow side sway) on whoever is most
 *             interesting, free flight not tied to the track, its
 *             stabilized nose PTZ shooting the car with an occasional
 *             forward "from the heli" look; a CORNER PTZ camera standing
 *             at the mast of EVERY corner (fixed position, the head pans
 *             to follow the car through the corner while the lens zooms
 *             in at the apex and back out); a locked wide on the START
 *             GRID (the venue's identity shot, live when the pack
 *             crosses the line); a trackside PTZ on the main STRAIGHT
 *             (fixed low mast, damped pan following the car through,
 *             lens wide far / tight at the mast); and a CRASH shot - a
 *             FIFTH LEARNED action: a contact's value (the interest of
 *             the cars involved) feeds the table, a big fresh incident
 *             (worth >= 0.8) still cuts mid-shot like a real broadcast,
 *             minor brushes only score at a cut boundary (usually losing,
 *             so the camera does not chase them), and a 14 s cooldown
 *             after each crash shot keeps a flurry of contacts from
 *             spamming the feed. The incident heli flies at its own slow
 *             pace (12 m/s - a gentle glide, never a max-speed rush) and
 *             holds station high above the action while no incident is
 *             live, so a crash opens already framed; on air it drifts
 *             slowly above the contact point (about a 2 min period - an
 *             elegant hold, not a brisk circle; OBB detection on the
 *             same cuboid as the physics colliders, 0.6 m lead-in
 *             margin). The user can also take the director chair:
 *             manualCut()/setAuto() hard-cut to any feed camera and hold
 *             it (no auto cuts, no pre-emption, no Q learning) until the
 *             AUTO button hands back - and setFocusPos() points the
 *             WHOLE feed at a race position (1-5): every camera then
 *             shoots the car in that position and whoever is physically
 *             with it (a packed 1-2-3 is one group shot - the heli pulls
 *             back and lifts to frame the cluster - a lone leader a
 *             single car), 0 = AUTO.
 *             Shot selection is epsilon-greedy with a freshness bonus so
 *             near-tie shots rotate instead of one dominating the feed;
 *             the reward is rank-based (was the on-screen car the most
 *             interesting in the field?) scaled by corner coverage - for
 *             crash shots it is the incident's value - so the table learns
 *             which shot type actually serves the moment.
 *             State: leader gap bucket x pack density around the leader
 *             (12 states). Reward per shot: how interesting the on-screen
 *             car was (rank, battle gaps, corner approaches, recency) plus
 *             subject novelty, minus back-to-back same-camera repeats.
 *             Q starts from a hand-tuned "experienced director" prior,
 *             updates online every cut (alpha 0.08, gamma 0.5, epsilon
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

// the broadcast feed's cameras (the shot index IS the action index)
export const SHOTS = { HELI: 0, CORN: 1, START: 2, STRAIGHT: 3, CRASH: 4 };
const TV_SHOTS = [
  { name: 'HELI', fov: 48, dur: [12, 16] }, // the follow heli's nose PTZ
  { name: 'CORN', fov: 38, dur: [8, 12] }, // PTZ mast at every corner
  { name: 'START', fov: 40, dur: [8, 12] }, // locked wide on the start grid
  { name: 'STRAIGHT', fov: 42, dur: [8, 12] }, // trackside PTZ on the main straight
  { name: 'CRASH', fov: 55, dur: [6, 9] }, // the incident heli's nose PTZ (slow drift)
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
const _anchorPos = new THREE.Vector3();
const _anchorLook = new THREE.Vector3();
const _heliHoldPos = new THREE.Vector3();
const _heliHoldLook = new THREE.Vector3();
const _crashHoldPos = new THREE.Vector3();
const _crashHoldLook = new THREE.Vector3();
const _mastRight = new THREE.Vector3();
const _tA = new THREE.Vector3();
const _orbitDir = new THREE.Vector3();

const wrap = (u) => ((u % 1) + 1) % 1;

const _cQuatA = new THREE.Quaternion();
const _cQuatB = new THREE.Quaternion();
const _cFwdA = new THREE.Vector3();
const _cFwdB = new THREE.Vector3();

/**
 * 2-D separating-axis distance between two car cuboids (XZ plane; every
 * car is on the ground, so the Y overlap is a given). Positive = the
 * bodies are apart by that many metres, negative = overlapping.
 */
function _obbSeparation(bodyA, bodyB, hx, hz) {
  const pa = bodyA.translation();
  const pb = bodyB.translation();
  const qa = bodyA.rotation();
  const qb = bodyB.rotation();
  _cQuatA.set(qa.x, qa.y, qa.z, qa.w);
  _cQuatB.set(qb.x, qb.y, qb.z, qb.w);
  const fa = _cFwdA.set(0, 0, 1).applyQuaternion(_cQuatA);
  const fb = _cFwdB.set(0, 0, 1).applyQuaternion(_cQuatB);
  if (fa.lengthSq() < 1e-6) fa.set(0, 0, 1);
  if (fb.lengthSq() < 1e-6) fb.set(0, 0, 1);
  fa.normalize();
  fb.normalize();
  const dx = pb.x - pa.x;
  const dz = pb.z - pa.z;
  let best = -Infinity;
  const testAxis = (ax, az) => {
    const proj = dx * ax + dz * az;
    // half-width of a cuboid along (ax, az): its right is (f.z, -f.x)
    const wA = hx * Math.abs(fa.z * ax - fa.x * az) + hz * Math.abs(fa.x * ax + fa.z * az);
    const wB = hx * Math.abs(fb.z * ax - fb.x * az) + hz * Math.abs(fb.x * ax + fb.z * az);
    const sep = Math.abs(proj) - (wA + wB);
    if (sep > best) best = sep;
  };
  testAxis(fa.x, fa.z);
  testAxis(fa.z, -fa.x);
  testAxis(fb.x, fb.z);
  testAxis(fb.z, -fb.x);
  return best;
}

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
    this.shot = SHOTS.HELI;
    this.shotTimer = 14;
    this._focus = null;
    this._shotGen = 0; // bumped on every hard cut
    this._field = null;
    this._race = null;
    this._corners = null; // cached major-corner list, built lazily
    this._crashTarget = null; // the car the crash camera is on

    // Q-learning director: 12 states (leader-gap x pack) x 5 actions
    // (HELI, CORN, START, STRAIGHT, CRASH); CRASH is the learned 5th
    // action - the table decides which contacts are worth chasing
    this.Q = new Float64Array(60);
    const prior = [
      [0.55, 0.6, 0.5, 0.45], // HELI - the chase cam (battles are its job)
      [0.55, 0.6, 0.65, 0.55], // CORN
      [0.45, 0.45, 0.45, 0.45], // START - the venue's identity shot
      [0.5, 0.55, 0.45, 0.4], // STRAIGHT - trackside on the main straight
      [0, 0, 0, 0], // CRASH: neutral - the table learns when a contact
      // is worth chasing (a minor brush should not be)
    ];
    for (let s = 0; s < 12; s++) {
      const g = (s / 3) | 0;
      for (let a = 0; a < 5; a++) this.Q[s * 5 + a] = prior[a][g];
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
    // corner PTZ: smoothed look target + distance-driven FOV
    this._cornLook = new THREE.Vector3();
    this._cornGen = -1;
    this._cornCorner = null; // the corner locked for the current shot
    this._dynFov = 0; // non-zero while the corner cam is driving the FOV
    // freshness bonus: when each shot type was last on air
    this._shotLastSeen = [-1e9, -1e9, -1e9, -1e9, -1e9];
    // per-shot corner coverage (did the car actually drive through it)
    this._shotCovSum = 0;
    this._shotCovFrames = 0;
    // per-shot incident value (how worth-shooting the contact was)
    this._shotWorthSum = 0;
    this._shotWorthFrames = 0;
    // crash: the contact point the incident camera orbits
    this._crashPos = new THREE.Vector3();
    this._crashPosSet = false;
    // the situation-fit the current shot had when it was chosen
    this._activeFit = 0.5;
    // the physical broadcast helicopters (created in main.js): when
    // present, the HELI / CRASH feed is read from their own smoothed
    // poses - the camera is the helicopter, so the footage glides
    this.helics = null;
    // per-frame anchors for the helicopters (main.js flies them to these)
    this.tvHeli = null; // { pos, look } while the HELI shot is live
    this.tvHeliHold = null; // { pos, look } standby anchor while the feed is elsewhere
    this._heliHoldEntry = null; // the field entry the heli holds over while waiting
    this.tvCrash = null; // { pos, look } while the CRASH shot is live
    // the incident heli's circle angle (slow, continuous)
    this._crashAng = 0;
    // incident value of the live contact (0 = none) + the car to frame
    this._incidentWorth = 0;
    this._incidentRawWorth = 0;
    this._incidentLead = null;
    // anti-spam: no crash shot while this lasts (a flurry of brushes
    // must not chase the camera)
    this._crashCoolUntil = -1e9;
    // the follow heli's slow side-sway phase (locked rear-quarter framing)
    this._heliSway = 0;
    this._heliSwayPhase = Math.random() * Math.PI * 2;
    // the trackside straight cam (mast + damped PTZ look)
    this._straight = null; // longest low-curvature run of the racing line
    this._straightMast = null; // its fixed mast position
    this._strLook = new THREE.Vector3();
    this._strGen = -1;
    // the locked start-grid cam
    this._gridCam = null;
    // manual director: the user is the sutradara (no auto cuts)
    this.manual = false;
    this._lastScene = null; // last _scene() result (for button-driven cuts)
    this._lastFocus = null;
    this._incidentLive = false; // a body contact is live right now
    // USER FOCUS: the race position the feed revolves around (1-based;
    // 0 = AUTO = the director picks from the whole field). With a focus
    // set, every camera shoots the car in that position and whoever is
    // physically with it - a packed 1-2-3 reads as one group shot, a
    // lone leader as a single car
    this.focusPos = 0;
    this.tvCrashHold = null; // incident heli standby anchor (pos/look)
    // the nose PTZ's pointing: a stable rear-quarter shot at the car,
    // with an occasional forward "from the heli" look for variety
    this._heliView = 'down';
    this._heliViewT = 8 + Math.random() * 8;
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
    if (this.mode === 'tv')
      return (
        'TV·' +
        TV_SHOTS[this.shot].name +
        (this.manual ? ' (MANUAL)' : '') +
        (this.focusPos > 0 ? ' ·POS ' + this.focusPos : '')
      );
    if (this.mode === 'cinematic') return 'CINE·' + CINE_SHOTS[this.cineShot % 4].name;
    return BASE_LABELS[this.mode];
  }

  cycle() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
    // re-centre on mode change so the new framing arrives instantly
    this.initialised = false;
    this.shot = SHOTS.HELI;
    this.shotTimer = 14;
    this._shotGen++;
    this._crashTarget = null;
    this._subject = null;
    this._subjectEntry = null;
    this._prevSubject = null;
    this._prevShot = -1;
    this._pendS = null;
    this._pendA = null;
    this._shotSum = 0;
    this._shotFrames = 0;
    this._shotCovSum = 0;
    this._shotCovFrames = 0;
    this._shotWorthSum = 0;
    this._shotWorthFrames = 0;
    this._crashPosSet = false;
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
    if (this.mode !== 'tv') {
      this.tvHeli = null;
      this.tvCrash = null;
    }
    if (!Array.isArray(field) || !field.length) this._heliHoldEntry = null;
    // in TV mode the Q-director owns the subject, so a focus change
    // (lead change / X key) must not re-seat the camera; the other modes
    // still snap on re-focus
    if (car !== this._focus) {
      this._focus = car;
      if (this.mode !== 'tv') {
        this.initialised = false;
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
      // the corner PTZ drives its own lens (zoom in/out with distance)
      fov =
        (this.shot === SHOTS.CORN || this.shot === SHOTS.STRAIGHT) && this._dynFov
          ? this._dynFov
          : TV_SHOTS[this.shot].fov;
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

    // the TV heli/crash feed is read from the physical helicopter's
    // stabilized nose PTZ (nosePos + look): the camera sits in front of
    // the nose, level, so the airframe never enters the picture and the
    // footage cannot zigzag
    const hu = this.helics;
    if (hu && this.mode === 'tv' && (this.shot === SHOTS.HELI || this.shot === SHOTS.CRASH)) {
      const u = this.shot === SHOTS.HELI ? hu[0] : hu[1];
      if (u) {
        this.pos.copy(u.nosePos);
        _look.copy(u.look);
      }
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
    // per-frame helicopter anchors (set by the live shot, cleared here)
    this.tvHeli = null;
    this.tvHeliHold = null;
    this.tvCrash = null;
    this.tvCrashHold = null;
    // heli standby: while the feed is on another camera, the chopper
    // keeps flying the anchor of its last broadcast car (a real heli
    // holds station over its target and waits) - the next HELI cut
    // opens with the framing already established, no long transit
    // across the field
    if (
      this.shot !== SHOTS.HELI &&
      this._heliHoldEntry &&
      this._heliHoldEntry.car &&
      this._heliHoldEntry.driver
    ) {
      this._subjectPose(this._heliHoldEntry.car);
      this._heliAnchor(this._heliHoldEntry, dt, _heliHoldPos, _heliHoldLook);
      this.tvHeliHold = { pos: _heliHoldPos, look: _heliHoldLook };
    }
    // ------------------------------------------------ the Q-learning cut
    const f = this._field;
    const S = this._scene();
    this._lastScene = S;
    this._lastFocus = focusCar;
    // a crash = two car bodies touching (OBB on the same cuboid as the
    // physics colliders, 0.6 m lead-in; a packed field running 6 m apart
    // never dips below ~1.3 m, so normal racing stays clean). The
    // DIRECTOR now decides whether it is worth shooting: the incident's
    // value is the interest of the cars involved, the Q table (4th
    // action) learns which contacts earn a cut, and a cooldown keeps a
    // flurry of brushes from chasing the camera. Only a big, fresh
    // incident (worth >= 0.8) still cuts mid-shot, like a real broadcast.
    const cp = this._contactPair();
    const incident = cp && cp.sep < 0.6 ? cp : null;
    let worth = 0;
    if (incident && S) {
      const r = this._race;
      let lead = incident.i;
      if (r && Array.isArray(r.progress) && r.progress[incident.j] > r.progress[incident.i]) lead = incident.j;
      const pa = f[incident.i].car.body.translation();
      const pb = f[incident.j].car.body.translation();
      this._crashPos.set((pa.x + pb.x) / 2, Math.max(pa.y, pb.y) + 0.7, (pa.z + pb.z) / 2);
      this._crashPosSet = true;
      const it = Math.max(S.interests.get(f[incident.i].car) || 0, S.interests.get(f[incident.j].car) || 0);
      this._incidentRawWorth = THREE.MathUtils.clamp(it / 1.2, 0.35, 1);
      worth = this._incidentRawWorth;
      if (this.time < this._crashCoolUntil) worth *= 0.25;
      this._incidentLead = f[lead].car;
      this._crashTarget = f[lead].car;
    }
    this._incidentWorth = worth;
    this._incidentLive = !!incident;
    // big + fresh incident: cut now (a broadcast always shows a real
    // crash); minor brushes wait for a normal cut decision, where they
    // usually lose - the camera does not chase them. In manual mode the
    // USER is the director: no auto cut, not even for a big crash.
    if (
      !this.manual &&
      incident &&
      worth >= 0.8 &&
      this.shot !== SHOTS.CRASH &&
      this.shotTimer > 2.5
    ) {
      this._prevSubject = this._subject;
      this._prevShot = this.shot;
      this.shot = SHOTS.CRASH;
      this.shotTimer = 6 + Math.random() * 3;
      this.initialised = false; // hard cut to the incident
      this._shotGen++;
      this._crashCoolUntil = this.time + 14;
      this._pendA = null; // the cut itself is not a Q decision
      this._pendS = null;
      this._activeFit = worth;
      this._subject = this._incidentLead;
      this._seatSubject();
      this._shotLastSeen[SHOTS.CRASH] = this.time;
      this._shotSum = 0;
      this._shotFrames = 0;
      this._shotCovSum = 0;
      this._shotCovFrames = 0;
      this._shotWorthSum = 0;
      this._shotWorthFrames = 0;
    }
    if (this.shot === SHOTS.CRASH) {
      // the crash shot plays out its timer; while a serious contact is
      // still live (a real pile-up) it stays on the air, and when it
      // clears the timer runs out and the normal rotation decides the
      // next shot. A minor brush is NOT refreshed - it gets its short
      // look and the feed moves on (measured, not chased)
      if (incident && this._incidentRawWorth >= 0.8) this.shotTimer = Math.max(this.shotTimer, 1.5);
      // the incident heli drifts SLOWLY high above the contact point
      // (about a 2 min period - an elegant hold, not a brisk circle);
      // the feed is read from its nose PTZ (see update())
      this._crashAng += dt * 0.05;
      this._crashShot(dt);
      _anchorPos.set(
        _center.x + Math.cos(this._crashAng) * 18,
        _center.y + 24,
        _center.z + Math.sin(this._crashAng) * 18,
      );
      _anchorLook.copy(_center);
      this.tvCrash = { pos: _anchorPos, look: _anchorLook };
    }
    // the incident heli's standby: while no crash is live it holds
    // station high above the action the user cares about (the focus
    // cluster's lead, else the current subject, else the leader) - so a
    // real crash opens with the heli ALREADY over the action, gliding
    // in gently at its slow pace instead of rushing across the field
    if (this.shot !== SHOTS.CRASH && S) {
      let holdEntry = null;
      const cl = this._focusCluster(S);
      if (cl) holdEntry = f[cl.idx];
      else if (this._subjectEntry && this._subjectEntry.car) holdEntry = this._subjectEntry;
      else holdEntry = f[S.order[0]];
      if (holdEntry && holdEntry.car && holdEntry.car.body) {
        this._subjectPose(holdEntry.car);
        _crashHoldPos.set(
          _center.x + Math.sin(this.time * 0.05 + 2.1) * 12,
          _center.y + 30,
          _center.z + Math.cos(this.time * 0.041) * 12,
        );
        _crashHoldLook.copy(_center);
        this.tvCrashHold = { pos: _crashHoldPos, look: _crashHoldLook };
      }
    }
    if (this._subject === null && S) {
      // first frame in TV: seat the subject for the opening shot (no cut)
      this._subject = this._pickSubject(this.shot, S, focusCar);
      this._seatSubject();
      if (this.shot === SHOTS.HELI) this._heliHoldEntry = this._subjectEntry;
    }
    // MANUAL DIRECTOR: the user chose this shot - hold it; no auto cuts,
    // no pre-emption, no Q learning. The shot method below still drives
    // the camera and the heli anchors.
    if (this.manual) {
      if (this.shot === SHOTS.HELI) {
        this._subjectPose();
        this._heliShot(dt);
      } else if (this.shot === SHOTS.CORN) {
        this._cornerShot(dt, this._subjectU());
      } else if (this.shot === SHOTS.START) {
        this._startShot(dt);
      } else if (this.shot === SHOTS.STRAIGHT) {
        this._straightShot(dt);
      }
      return;
    }
    // reward accumulation: was the on-screen car the one the field was
    // talking about? rank 0 (top interest) pays full, lower ranks less.
    // a corner cam also only pays if the car actually drives through it
    if (S && this._subject) {
      const it = S.interests.get(this._subject) || 0;
      let rank = 0;
      for (let i = 0; i < f.length; i++) {
        if ((S.interests.get(f[i].car) || 0) > it) rank++;
      }
      let pay = rank === 0 ? 1 : rank === 1 ? 0.7 : rank === 2 ? 0.45 : 0.25;
      if (this.focusPos > 0 && this.shot !== SHOTS.CRASH) {
        // user focus: going off the chosen cluster is off-brief, so it
        // is penalised in the table (the director learns to stay put)
        const cl = this._focusCluster(S);
        if (cl) {
          let inCl = false;
          for (let k = 0; k < cl.cars.length; k++) {
            if (f[cl.cars[k]].car === this._subject) {
              inCl = true;
              break;
            }
          }
          if (!inCl) pay *= 0.4;
        }
      }
      this._shotSum += pay;
      this._shotFrames++;
      if (this.shot === SHOTS.CRASH) {
        this._shotWorthSum += this._incidentWorth;
        this._shotWorthFrames++;
      }
      if (this.shot === SHOTS.CORN && this._cornCorner) {
        const tp = this._subject.body ? this._subject.body.translation() : null;
        let cov = 0;
        if (tp) {
          this.track.curve.getPointAt(this._cornCorner.u, _trackPos);
          cov = Math.hypot(tp.x - _trackPos.x, tp.z - _trackPos.z) < 110 ? 1 : 0;
        }
        this._shotCovSum += cov;
      } else {
        this._shotCovSum += 1;
      }
      this._shotCovFrames++;
    }
    this.shotTimer -= dt;
    if (this.shotTimer <= 0) {
      let next;
      const fit = this._shotFit(S, worth);
      if (S) {
        const s = S.state;
        // reward of the shot that just ended: for a crash shot it is the
        // incident's average value (was the contact worth chasing?), for
        // the others the rank-based on-screen value plus the situation-fit
        // the shot had when chosen; plus subject novelty, minus back-to-back
        // same-camera repeats; centered by 0.5 so the table stores an
        // advantage, not a running total
        const avg = this._shotFrames ? this._shotSum / this._shotFrames : 0;
        const cov = this._shotCovFrames ? this._shotCovSum / this._shotCovFrames : 1;
        const worthAvg = this._shotWorthFrames ? this._shotWorthSum / this._shotWorthFrames : this._activeFit;
        const base =
          this._prevShot === SHOTS.CRASH
            ? 0.5 * worthAvg + 0.5 * this._activeFit
            : 0.5 * avg * (0.4 + 0.6 * cov) + 0.5 * this._activeFit;
        const r =
          base +
          (this._subject && this._prevSubject && this._subject !== this._prevSubject ? 0.15 : 0) -
          (this._prevShot >= 0 && this.shot === this._prevShot ? 0.3 : 0) - 0.5;
        // Q-update for the decision taken at the previous cut
        if (this._pendA !== null && this._pendS !== null) {
          const idx = this._pendS * 5 + this._pendA;
          let maxQ = -Infinity;
          for (let b = 0; b < 5; b++) maxQ = Math.max(maxQ, this.Q[s * 5 + b]);
          // gamma 0.5 keeps the converged values (≈2x the reward) inside
          // the clamp so the table's argmax still reflects the ranking
          this.Q[idx] = Math.max(-1.1, Math.min(1.1, this.Q[idx] + 0.08 * (r + 0.5 * maxQ - this.Q[idx])));
        }
        // pick: situation fit first (a crash only scores while an incident
        // is live and the cooldown has passed), the learned table as a
        // modifier, freshness so near-ties rotate instead of looping
        if (Math.random() < this.qEps) {
          next = (Math.random() * 5) | 0;
          if (next === SHOTS.CRASH && !incident) next = (Math.random() * 4) | 0;
        } else {
          next = 0;
          let bestScore =
            fit[0] + 0.5 * this.Q[s * 5] + 0.4 * THREE.MathUtils.clamp((this.time - this._shotLastSeen[0]) / 30, 0, 1);
          for (let b = 1; b < 5; b++) {
            if (b === SHOTS.CRASH && !incident) continue; // no contact: no crash shot
            const score =
              fit[b] + 0.5 * this.Q[s * 5 + b] + 0.4 * THREE.MathUtils.clamp((this.time - this._shotLastSeen[b]) / 30, 0, 1);
            if (score > bestScore) {
              bestScore = score;
              next = b;
            }
          }
        }
        this.qEps = Math.max(0.03, this.qEps * 0.9985);
        this._pendS = s;
        this._pendA = next;
        if (next === SHOTS.CRASH) this._crashCoolUntil = this.time + 14;
        this._saveDirector();
      } else {
        // no field data: fall back to plain random rotation
        do {
          next = (Math.random() * 4) | 0; // HELI/CORN/START/STRAIGHT
        } while (next === this.shot);
      }
      this._prevSubject = this._subject;
      this._prevShot = this.shot;
      this.shot = next;
      this._activeFit = fit[next];
      const d = TV_SHOTS[next].dur;
      this.shotTimer = d[0] + Math.random() * (d[1] - d[0]);
      // new subject for the new shot - picked by the director, not the X key
      this._subject = S ? this._pickSubject(next, S, focusCar) : focusCar;
      this._seatSubject();
      if (next === SHOTS.HELI) this._heliHoldEntry = this._subjectEntry;
      this.initialised = false; // hard cut, like a real broadcast
      this._shotGen++;
      this._shotLastSeen[next] = this.time;
      this._shotSum = 0;
      this._shotFrames = 0;
      this._shotCovSum = 0;
      this._shotCovFrames = 0;
      this._shotWorthSum = 0;
      this._shotWorthFrames = 0;
    }
    if (this.shot === SHOTS.HELI) {
      // heli: the follow heli's nose PTZ, locked rear-quarter framing
      this._subjectPose();
      this._heliShot(dt);
      return;
    } else if (this.shot === SHOTS.CORN) {
      // corn: PTZ camera at the mast of the next corner ahead of the
      // subject car - pans with the car, zooms at the apex
      this._cornerShot(dt, this._subjectU());
      return;
    } else if (this.shot === SHOTS.CRASH) {
      // crash: the camera is already the high pass from _crashShot above
      return;
    } else if (this.shot === SHOTS.START) {
      // start: locked wide on the start grid
      this._startShot(dt);
      return;
    }
    // straight: trackside PTZ on the main straight
    this._straightShot(dt);
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
        if (age < 20) it -= 0.5 * Math.exp(-age / 10);
      }
      interests.set(e.car, Math.max(0.05, Math.min(1.5, it)));
    }
    return { state: sGap * 3 + sPack, interests, order };
  }

  _focusCluster(S) {
    // the cars the user's focus position revolves around: the car in
    // that position plus everyone physically with it (<= 35 m along the
    // track either way) - a packed 1-2-3 is one group, a lone leader is
    // just one car
    if (!this.focusPos || !S || !S.order.length) return null;
    const r = this._race;
    const L = this.track.length;
    const idx = S.order[Math.min(this.focusPos, S.order.length) - 1];
    const cars = [idx];
    let spread = 0;
    let relSum = 0;
    let cnt = 1;
    for (let i = 0; i < S.order.length; i++) {
      if (i === idx) continue;
      let d = (r.progress[i] - r.progress[idx]) * L;
      if (d > L / 2) d -= L;
      else if (d < -L / 2) d += L;
      if (Math.abs(d) <= 35) {
        cars.push(i);
        relSum += d;
        cnt++;
        if (Math.abs(d) > spread) spread = Math.abs(d);
      }
    }
    return { idx, cars, spread, relSum, cnt };
  }

  _pickSubject(a, S, focusCar) {
    const f = this._field;
    if (!f || !f.length) return focusCar;
    if (a === SHOTS.CRASH) {
      // CRASH: frame the more advanced car of the contacting pair
      return this._incidentLead || focusCar;
    }
    // broadcast rotation rule: a car that was just on screen (last 20 s)
    // is skipped so the feed never locks onto one car
    const now = this.time;
    const cooling = (car) => {
      const last = this._seen.get(car);
      return last !== undefined && now - last < 20;
    };
    // USER FOCUS: every camera (the incident cam is the exception - it
    // follows the contact) shoots the cluster around the chosen
    // position. The rotation/cooling rules step aside: the user is
    // pointing the feed
    if (this.focusPos > 0 && a !== SHOTS.CRASH) {
      const cl = this._focusCluster(S);
      if (cl) {
        if (a === SHOTS.START) {
          // the grid cam frames the cluster member crossing the line
          let best = Infinity;
          let car = f[cl.idx].car;
          for (let k = 0; k < cl.cars.length; k++) {
            const i = cl.cars[k];
            const uu = f[i].driver ? f[i].driver.u : 0;
            const d = Math.min(wrap(uu), wrap(1 - uu)) * this.track.length;
            if (d < best) {
              best = d;
              car = f[i].car;
            }
          }
          return car;
        }
        if (a === SHOTS.STRAIGHT) {
          // the straight cam: the cluster member actually on the
          // straight (if the cluster is not there yet, the focus car)
          const st = this._ensureStraight();
          if (st) {
            let best = -Infinity;
            let car = null;
            for (let k = 0; k < cl.cars.length; k++) {
              const i = cl.cars[k];
              const e = f[i];
              const it = S.interests.get(e.car) || 0;
              const uu = e.driver ? e.driver.u : 0;
              if (st.contains(uu) && it > best) {
                best = it;
                car = e.car;
              }
            }
            if (car) return car;
          }
          return f[cl.idx].car;
        }
        // HELI / CORN: the car sitting in the chosen position
        return f[cl.idx].car;
      }
    }
    if (a === SHOTS.START) {
      // grid cam: frame the car crossing the line
      let best = Infinity;
      let car = null;
      for (let i = 0; i < f.length; i++) {
        const uu = f[i].driver ? f[i].driver.u : 0;
        const d = Math.min(wrap(uu), wrap(1 - uu)) * this.track.length;
        if (d < best) {
          best = d;
          car = f[i].car;
        }
      }
      return car || focusCar;
    }
    if (a === SHOTS.STRAIGHT) {
      // straight cam: the most interesting car actually ON the straight
      // (panning at the horizon for a car 300 m away would read as a bug)
      const st = this._ensureStraight();
      if (st) {
        let best = -Infinity;
        let car = null;
        let fb = -Infinity;
        let fbCar = null;
        for (let i = 0; i < f.length; i++) {
          const e = f[i];
          const c = e.car;
          const it = S.interests.get(c) || 0;
          if (it > fb) {
            fb = it;
            fbCar = c;
          }
          const uu = e.driver ? e.driver.u : 0;
          if (st.contains(uu) && !cooling(c) && it > best) {
            best = it;
            car = c;
          }
        }
        if (car) return car;
        if (fbCar) return fbCar; // nobody on the straight yet: the next one
      }
      return focusCar;
    }
    // HELI / CORN: whoever is most interesting right now. The HELI is
    // also limited by reach: the chopper frames cars near where it is
    // holding (distance softens the interest score), so every HELI cut
    // opens tight instead of panning across the whole field; if every
    // candidate is still cooling it frames the closest car to it - a
    // broadcast shows what is under the heli, not a car across the map
    const hold = this._heliHoldEntry;
    const hp = a === SHOTS.HELI && hold && hold.car && hold.car.body ? hold.car.body.translation() : null;
    let best = -Infinity;
    let bestCar = null;
    let fb = -Infinity;
    let fbCar = null;
    for (let i = 0; i < f.length; i++) {
      const car = f[i].car;
      const it = S.interests.get(car) || 0;
      if (it > fb) {
        fb = it;
        fbCar = car;
      }
      const cp = car.body.translation();
      const score = hp ? it - Math.hypot(cp.x - hp.x, cp.z - hp.z) * 0.002 : it;
      if (!cooling(car) && score > best) {
        best = score;
        bestCar = car;
      }
    }
    if (bestCar) return bestCar;
    if (hp) {
      // all cooling: frame the car under the heli (interest breaks ties)
      let d = Infinity;
      let near = null;
      for (let i = 0; i < f.length; i++) {
        const car = f[i].car;
        const cp = car.body.translation();
        const dd = Math.hypot(cp.x - hp.x, cp.z - hp.z) - (S.interests.get(car) || 0) * 20;
        if (dd < d) {
          d = dd;
          near = car;
        }
      }
      if (near) return near;
    }
    return fbCar || focusCar;
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
  }

  _subjectU() {
    return this._subjectEntry && this._subjectEntry.driver ? this._subjectEntry.driver.u : 0;
  }

  _subjectPose(car) {
    // point the shared pose scratch at the given car, or the current
    // subject, or the focus car
    const c = car || this._subject || this._focus;
    if (!c) return;
    const t = c.body.translation();
    const q = c.body.rotation();
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
      const raw = localStorage.getItem('race3d-qdirector-v4');
      if (!raw) return;
      const d = JSON.parse(raw);
      if (Array.isArray(d.q) && d.q.length === 60) {
        for (let i = 0; i < 60; i++) {
          const v = Number(d.q[i]);
          if (Number.isFinite(v)) this.Q[i] = Math.max(-1.1, Math.min(1.1, v));
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
      localStorage.setItem('race3d-qdirector-v4', JSON.stringify({ v: 4, q: Array.from(this.Q), e: this.qEps }));
    } catch {
      /* storage unavailable - learning is still in-memory */
    }
  }

  _crashShot(dt) {
    // incident coverage: a low, wide pass around the contact point - both
    // cars stay in frame and the cam reads as a side-rear follow, never
    // a high pass above the contact point
    const target =
      this._crashTarget && this._crashTarget.body
        ? this._crashTarget
        : this._subject && this._subject.body
          ? this._subject
          : this._focus;
    if (!target) return;
    this._subjectPose(target);
    if (this._crashPosSet) {
      _center.set(this._crashPos.x, this._crashPos.y, this._crashPos.z);
    }
    // a slow world-basis pass high above the contact point (~53 deg
    // down, not nose-down); the same angle drives the physical incident
    // heli's anchor, so the fallback camera (headless tests) and the
    // heli frame identically
    _orbitDir.set(Math.cos(this._crashAng), 0, Math.sin(this._crashAng));
    _desired.copy(_center).addScaledVector(_orbitDir, 18);
    _desired.y = _center.y + 24;
    _look.copy(_center);
    this._setDamp(1.1, 1.6);
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
  // closest pair of car bodies in the field: { i, j, sep } with sep in m
  // (negative = the bodies are overlapping). O(n^2) over 11 cars is cheap.
  _contactPair() {
    const f = this._field;
    if (!f || f.length < 2) return null;
    const hx = CAR.halfExtents.x;
    const hz = CAR.halfExtents.z;
    let best = null;
    let bestSep = Infinity;
    for (let i = 0; i < f.length; i++) {
      for (let j = i + 1; j < f.length; j++) {
        const sep = _obbSeparation(f[i].car.body, f[j].car.body, hx, hz);
        if (sep < bestSep) {
          bestSep = sep;
          best = { i, j, sep };
          if (sep < 0.1) break; // touching already - a closer pair won't change the cut
        }
      }
    }
    return best;
  }

  // ------------------------------------------------- situation fit
  // how well each shot type serves the current moment, 0..1. This is the
  // play-by-play signal: a battle is a 1V1 story, the last moments before
  // a corner are a CORN story, and a car running in clean air is exactly
  // what the HELI follow was made for. The Q table refines this over time
  // but can't fight it by more than half a point.
  _shotFit(S, worth) {
    const fit = [0.5, 0.35, 0.3, 0.3, worth > 0 ? worth : -1]; // -1 = unavailable
    if (!S || !this._race || !Array.isArray(this._race.progress)) return fit;
    const f = this._field;
    const n = f.length;
    if (n < 2) return fit;
    const L = this.track.length;
    // closest pair in the field + how interesting that pair is
    let gap = Infinity;
    let pairIt = 0;
    for (let i = 0; i < n; i++) {
      const A = S.order[i];
      const B = S.order[(i + 1) % n];
      let g = (this._race.progress[A] - this._race.progress[B]) * L;
      if (g <= 0) g += L;
      if (g < gap) {
        gap = g;
        pairIt = Math.max(S.interests.get(f[A].car) || 0, S.interests.get(f[B].car) || 0);
      }
    }
    // corner approach: how close is the subject to its next corner
    const u = this._subject ? this._subjectU() : 0;
    let dCorner = Infinity;
    const corners = this._ensureCorners();
    for (let i = 0; i < corners.length; i++) {
      const d = wrap(corners[i].u - u) * L;
      if (d < dCorner) dCorner = d;
    }
    // location cams: only fit when the pack is actually in front of them
    let nearStart = false;
    const st = this._ensureStraight();
    let nearStraight = false;
    for (let i = 0; i < n; i++) {
      const uu = f[i].driver ? f[i].driver.u : 0;
      const dStart = Math.min(wrap(uu), wrap(1 - uu)) * L;
      if (dStart < 150) nearStart = true;
      if (st && st.contains(uu)) nearStraight = true;
    }
    fit[SHOTS.START] = nearStart ? 0.9 : 0.3;
    fit[SHOTS.STRAIGHT] = nearStraight ? 0.85 : 0.3;
    // battle: with the 1V1 cam gone, the HELI is the battle cam
    if (gap < 8) {
      fit[SHOTS.HELI] = THREE.MathUtils.clamp(pairIt / 1.2, 0.5, 1);
    } else if (gap < 25) {
      fit[SHOTS.HELI] = 0.7 * THREE.MathUtils.clamp(pairIt / 1.2, 0.5, 1);
    }
    // corner approach
    if (dCorner < 45) {
      fit[1] = 0.95;
      fit[0] = Math.min(fit[0], 0.4);
    } else if (dCorner < 90) {
      fit[1] = Math.max(fit[1], 0.5);
    }
    // clean air: this is the heli's job
    if (gap >= 25 && dCorner >= 90) fit[0] = 1.0;
    return fit;
  }

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

  _cornerShot(dt, u) {
    const corners = this._ensureCorners();
    if (corners.length === 0) {
      // no corner data yet - fall back to the trackside slider
      this._sideFallback(u);
      return;
    }
    const curve = this.track.curve;
    // the corner is locked at cut time and held for the whole shot: once
    // the car passes the apex the cam keeps panning it out on the exit,
    // and the NEXT cut picks the next corner (a real broadcast hand-off)
    if (this._cornGen !== this._shotGen) {
      this._cornGen = this._shotGen;
      let best = null;
      let bestDist = Infinity;
      for (let i = 0; i < corners.length; i++) {
        const d = wrap(corners[i].u - u);
        if (d < bestDist) {
          bestDist = d;
          best = corners[i];
        }
      }
      this._cornCorner = best;
      curve.getPointAt(wrap(best.u - 0.010), this._cornLook);
      this._cornLook.y = Math.max(this._cornLook.y, 0.9);
    }
    const best = this._cornCorner;
    // the camera stands at its mast: outside of the corner, just past the
    // tyre line - the same slot the visible mast is built at
    curve.getPointAt(best.u, _trackPos);
    curve.getTangentAt(best.u, _trackTan);
    _trackTan.y = 0;
    _trackTan.normalize();
    _trackRight.set(_trackTan.z, 0, -_trackTan.x);
    _desired.copy(_trackPos).addScaledVector(_trackRight, best.side * 12.5);
    _desired.y = Math.max(_desired.y, 2.4);
    // PTZ head: wait ~17 m before the apex, then the look target follows
    // the subject car as it drives through the corner
    curve.getPointAt(wrap(best.u - 0.010), _look);
    _look.y = Math.max(_look.y, 0.9);
    const car = this._subject || this._focus;
    if (car && car.body) {
      const tp = car.body.translation();
      const dCorner = Math.hypot(tp.x - _trackPos.x, tp.z - _trackPos.z);
      if (dCorner < 130) {
        // blend from the waiting point onto the car as it enters the zone
        const w = THREE.MathUtils.clamp((130 - dCorner) / 40, 0, 1);
        _to.set(tp.x, tp.y + 0.7, tp.z);
        _look.lerp(_to, w);
      }
    }
    // damped pan, like a real PTZ head
    const k = 1 - Math.exp(-4.5 * dt);
    this._cornLook.lerp(_look, k);
    _look.copy(this._cornLook);
    // lens: wide while the car is far, tight at the apex, wide on the exit
    const d = Math.hypot(this._cornLook.x - _desired.x, this._cornLook.z - _desired.z);
    this._dynFov = THREE.MathUtils.clamp(30 + ((d - 14) / 80) * 20, 30, 52);
    this._setDamp(1.5, 2.0);
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

  _heliAnchor(entry, dt, outPos, outLook) {
    // the broadcast heli's anchor: a LOCKED rear-quarter framing - 22 m
    // BEHIND THE SUBJECT'S TRACK POSITION (along the racing arc, not a
    // trailing arm - on a tight corner a trailing arm whips fast, an arc
    // point moves with the car at the same speed) - 12 m up (~28 deg
    // below horizontal, a classic broadcast follow, not overhead, not
    // nose-down), with a very slow side sway (about a 45 s period) so the
    // framing stays stable and the heli's flight is calm. Shared by the
    // live HELI shot and the off-air standby hold.
    this._heliSway += dt;
    // USER FOCUS GROUP SHOT: when the chosen position has company (a
    // packed 1-2-3), frame the whole cluster - fly behind the pack's
    // centre of mass, pulled back and lifted by how wide the pack is;
    // a lone car keeps the classic 22 m / 12 m rear-quarter
    let uu = entry.driver.u;
    let back = 22;
    let up = 12;
    const S = this._lastScene;
    const cl = this.focusPos > 0 && S ? this._focusCluster(S) : null;
    if (cl && cl.cars.length > 1) {
      const s = Math.min(45, cl.spread);
      uu = uu + cl.relSum / cl.cnt / this.track.length;
      back = 22 + s * 1.15;
      up = 12 + s * 0.35;
    }
    const uB = wrap(uu - back / this.track.length);
    this.track.curve.getPointAt(uB, outPos);
    this.track.curve.getTangentAt(uB, _tA);
    _tA.y = 0;
    _tA.normalize();
    const side = Math.sin(this._heliSway * ((2 * Math.PI) / 45) + this._heliSwayPhase) * 5;
    outPos.x += _tA.z * side;
    outPos.z += -_tA.x * side;
    outPos.y = _center.y + up;
    // the nose PTZ: a stable shot at the car, with an occasional forward
    // "from the heli" look down the track
    this._heliViewT -= dt;
    if (this._heliViewT <= 0) {
      if (this._heliView === 'down') {
        this._heliView = 'forward';
        this._heliViewT = 2.5 + Math.random() * 2;
      } else {
        this._heliView = 'down';
        this._heliViewT = 10 + Math.random() * 8;
      }
    }
    if (this._heliView === 'down') {
      // lead the car a bit so it sits in the lower third of the frame
      outLook.copy(_center).addScaledVector(_fwd, 6);
    } else {
      // "from the heli": the pilot's view, ahead down the track
      outLook.copy(_center).addScaledVector(_fwd, 120);
      outLook.y = _center.y + 4;
    }
  }

  _heliShot(dt) {
    const e = this._subjectEntry;
    if (!e || !e.driver) return; // no field yet: main.js parks the heli
    this._heliAnchor(e, dt, _anchorPos, _anchorLook);
    this.tvHeli = { pos: _anchorPos, look: _anchorLook };
    // fallback camera (headless tests / no physical heli): the same
    // anchor + look
    _desired.copy(_anchorPos);
    _look.copy(_anchorLook);
    this._setDamp(1.2, 1.8);
  }

  // ---- the main straight: the longest low-curvature run of the racing
  // line (cached per track). The trackside cam stands on its mast.
  _ensureStraight() {
    if (this._straight) return this._straight;
    const line = this.track.racingLine;
    if (!line || !line.curvature || !line.n) {
      this._straight = null;
      return null;
    }
    const n = line.n;
    const c = line.curvature;
    let maxC = 0;
    for (let i = 0; i < n; i++) maxC = Math.max(maxC, c[i]);
    const thr = maxC * 0.15;
    let bestLen = 0;
    let bestStart = 0;
    let curLen = 0;
    let curStart = 0;
    for (let i = 0; i < 2 * n; i++) {
      if (c[i % n] <= thr) {
        if (curLen === 0) curStart = i;
        curLen++;
        if (curLen > bestLen) {
          bestLen = curLen;
          bestStart = curStart;
        }
      } else curLen = 0;
    }
    if (bestLen < n * 0.05) {
      this._straight = null; // no real straight on this track
      return null;
    }
    const len = Math.min(bestLen, n);
    const L = this.track.length;
    this._straight = {
      uA: (bestStart % n) / n,
      length: (len / n) * L,
      uMid: ((bestStart + len / 2) % n) / n,
      contains(u) {
        const d = wrap(u - this.uA) * L;
        return d < this.length + 40 || wrap(this.uA - u) * L < 40;
      },
    };
    return this._straight;
  }

  _ensureStraightMast() {
    if (this._straightMast) return this._straightMast;
    const st = this._ensureStraight();
    if (!st) {
      this._straightMast = null;
      return null;
    }
    const curve = this.track.curve;
    const p = curve.getPointAt(st.uMid);
    const t = curve.getTangentAt(st.uMid).setY(0).normalize();
    const r = _mastRight.set(t.z, 0, -t.x);
    this._straightMast = new THREE.Vector3(p.x + r.x * 13, 3.2, p.z + r.z * 13);
    return this._straightMast;
  }

  // ---- the start grid: one locked elevated wide (static per track)
  _ensureGridCam() {
    if (this._gridCam) return this._gridCam;
    const curve = this.track.curve;
    const p0 = curve.getPointAt(0);
    const t0 = curve.getTangentAt(0).setY(0).normalize();
    const r0 = _mastRight.set(t0.z, 0, -t0.x);
    const pos = new THREE.Vector3(p0.x - r0.x * 22, 15, p0.z - r0.z * 22);
    const l0 = curve.getPointAt(0.018);
    this._gridCam = { pos, look: new THREE.Vector3(l0.x, 0.7, l0.z) };
    return this._gridCam;
  }

  _startShot(dt) {
    const g = this._ensureGridCam();
    if (!g) {
      this._sideFallback(this._subjectU());
      return;
    }
    _desired.copy(g.pos);
    _look.copy(g.look);
    this._setDamp(4, 5);
  }

  // ---- trackside PTZ on the main straight: fixed low mast, damped pan
  // that follows the subject as it runs through (same pattern as the
  // corner cam), lens wide when the car is far, tight at the mast
  _straightShot(dt) {
    const st = this._ensureStraight();
    const mast = this._ensureStraightMast();
    if (!st || !mast) {
      this._sideFallback(this._subjectU());
      return;
    }
    if (this._strGen !== this._shotGen) {
      this._strGen = this._shotGen;
      this.track.curve.getPointAt(st.uMid, this._strLook);
      this._strLook.y = Math.max(this._strLook.y, 0.9);
    }
    _desired.copy(mast);
    this.track.curve.getPointAt(st.uMid, _look);
    _look.y = Math.max(_look.y, 0.9);
    const car = this._subject || this._focus;
    if (car && car.body && st.contains(this._subjectU())) {
      const tp = car.body.translation();
      const d = Math.hypot(tp.x - mast.x, tp.z - mast.z);
      if (d < 150) {
        // blend from the waiting point onto the car as it enters the zone
        const w = THREE.MathUtils.clamp((150 - d) / 60, 0, 1);
        _to.set(tp.x, tp.y + 0.7, tp.z);
        _look.lerp(_to, w);
      }
    }
    const k = 1 - Math.exp(-4.5 * dt);
    this._strLook.lerp(_look, k);
    _look.copy(this._strLook);
    const d = Math.hypot(this._strLook.x - mast.x, this._strLook.z - mast.z);
    this._dynFov = THREE.MathUtils.clamp(30 + ((d - 14) / 80) * 20, 30, 52);
    this._setDamp(1.5, 2.0);
  }

  // ================================================= manual director
  // the user is the sutradara: hard-cut to the chosen camera, hold it,
  // no auto cuts and no pre-emption until they hand back to AUTO
  manualCut(idx) {
    const S = this._lastScene;
    if (!S || idx < 0 || idx >= TV_SHOTS.length) return;
    if (idx === SHOTS.CRASH && !this._incidentLive) return; // nothing to show
    const focusCar = this._lastFocus;
    this.manual = true;
    this._prevSubject = this._subject;
    this._prevShot = this.shot;
    this.shot = idx;
    this._subject = this._pickSubject(idx, S, focusCar);
    this._seatSubject();
    if (idx === SHOTS.HELI) this._heliHoldEntry = this._subjectEntry;
    this.shotTimer = TV_SHOTS[idx].dur[1]; // manual: held until handed back
    this.initialised = false; // hard cut, like a real broadcast
    this._shotGen++;
    this._shotLastSeen[idx] = this.time;
    this._pendA = null; // user cuts are not Q decisions
    this._pendS = null;
    this._activeFit = 0.5;
    this._shotSum = 0;
    this._shotFrames = 0;
    this._shotCovSum = 0;
    this._shotCovFrames = 0;
    this._shotWorthSum = 0;
    this._shotWorthFrames = 0;
    if (idx === SHOTS.CRASH) this._crashCoolUntil = this.time + 14;
  }

  setAuto() {
    this.manual = false;
    // a fresh duration: the next boundary is a normal director decision
    this.shotTimer = TV_SHOTS[this.shot].dur[0];
  }

  /**
   * USER FOCUS: point the whole feed at a race position (1-based;
   * 0 = AUTO, the q-learning director picks from the field again). The
   * feed then revolves around the car in that position and whoever is
   * physically with it - a packed 1-2-3 is one group shot, a lone
   * leader a single car. The live shot re-seats its subject
   * immediately (a smooth reframe, not a hard cut); every later cut -
   * auto or manual - keeps shooting the cluster.
   */
  setFocusPos(p) {
    const n = this._field ? this._field.length : 5;
    const np = THREE.MathUtils.clamp(Math.round(p) || 0, 0, Math.min(5, n));
    if (np === this.focusPos) return;
    this.focusPos = np;
    const S = this._lastScene;
    if (S && this.mode === 'tv' && this.shot !== SHOTS.CRASH) {
      this._prevSubject = this._subject;
      this._subject = this._pickSubject(this.shot, S, this._lastFocus);
      this._seatSubject();
      if (this.shot === SHOTS.HELI) this._heliHoldEntry = this._subjectEntry;
    }
  }

  _setDamp(kx, ky) {
    // rates only - update() converts them with the real frame dt
    this._kx = kx;
    this._ky = ky;
  }
}
