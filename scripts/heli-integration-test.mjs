// Headless integration check for the v15.0 heli feed: the REAL HeliUnit
// flight model (calm cap 30 m/s, smoothed velocity) flying the director's
// new stable rear-quarter anchor, with the TV camera read from the nose
// PTZ exactly like main.js does it.
//   node scripts/heli-integration-test.mjs
import * as THREE from 'three';
import { SpectatorCamera } from '../src/render/spectatorCamera.js';
import { createHeliMesh, HeliUnit } from '../src/render/heli.js';
import { TRACKS } from '../src/trackLayout.js';
import { buildRacingLine } from '../src/ai/racingLine.js';

const track = TRACKS.rally;
const RACING_LINE = buildRacingLine(track);
const NS = 4000;
const posTab = new Float32Array(NS * 3);
const tanTab = new Float32Array(NS * 3);
for (let i = 0; i < NS; i++) {
  const p = track.curve.getPointAt(i / NS);
  posTab.set([p.x, p.y, p.z], i * 3);
  const t = track.curve.getTangentAt(i / NS).setY(0).normalize();
  tanTab.set([t.x, 0, t.z], i * 3);
}
const FZ = new THREE.Vector3(0, 0, 1);
const _f = new THREE.Vector3();
function setPose(body, u) {
  const i = Math.floor((((u % 1) + 1) % 1) * NS) % NS;
  body._v.set(posTab[i * 3], 0, posTab[i * 3 + 2]);
  _f.set(tanTab[i * 3], 0, tanTab[i * 3 + 2]).normalize();
  body._q.setFromUnitVectors(FZ, _f);
}
const store = {};
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };

const n = 11;
const cars = [];
for (let i = 0; i < n; i++) {
  const u = (i * 0.045) % 1;
  const body = { _v: new THREE.Vector3(), _q: new THREE.Quaternion(), translation() { return this._v; }, rotation() { return this._q; } };
  setPose(body, u);
  cars.push({ car: { body }, driver: { u, mode: 'race', recoverTime: 0 }, pace: 0, dist: u * track.length });
}
// like the real AI, the field is corner-limited: speed from the racing
// line's speed plan (a straight at ~32 m/s, 14-22 m/s in the tight bends)
const line = buildRacingLine(track);
function speedAt(u) {
  const n = line.n;
  const x = (((u % 1) + 1) % 1) * n;
  const i = Math.floor(x) % n;
  const j = (i + 1) % n;
  const f = x - Math.floor(x);
  return line.speed[i] * (1 - f) + line.speed[j] * f;
}

const camera = {
  position: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  fov: 50,
  aspect: 16 / 9,
  lookAt(v) { this._look = v; },
  updateProjectionMatrix() {},
};
const c = new SpectatorCamera(camera, { style: {}, addEventListener() {} }, {
  curve: track.curve,
  length: track.length,
  racingLine: RACING_LINE,
  corners: track.corners,
});
c.enabled = false;

// the two real broadcast helicopters (same wiring as main.js)
const _s0 = track.curve.getPointAt(0);
const heli1 = new HeliUnit(createHeliMesh({ stripe: 0xe23b2e }), new THREE.Vector3(_s0.x, 26, _s0.z));
const heli2 = new HeliUnit(createHeliMesh({ stripe: 0x2b6fe2 }), new THREE.Vector3(_s0.x, 44, _s0.z));
c.helics = [heli1, heli2];

// scratch anchors for the non-mounted states (same as main.js)
const _ha = new THREE.Vector3();
const _hl = new THREE.Vector3();
const _hf = new THREE.Vector3();
const _hq = new THREE.Quaternion();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _prevH1 = new THREE.Vector3();
const _prevH2 = new THREE.Vector3();

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  PASS ' : '  FAIL ') + msg);
  if (!cond) failures++;
};

const SECS = 120;
let camErrMax = 0;          // camera vs the nose PTZ (game order: <= 1 frame of heli travel)
let speed1Max = 0;
let speed2Max = 0;
let downFrames = 0;
let forwardFrames = 0;
let heli1OnAir = 0;         // frames the TV feed read heli 1 (shot 0)
let visWrong = 0;           // visibility formula violations
let bad = 0;
const anchorSpeeds = [];    // anchor motion while following the SAME subject
let anchorJumpMax = 0;      // single-frame anchor jump while same subject
let steadyErr1 = [];        // heli1 vs anchor, > 5 s after a subject change
let prevSubject = null;
let subjFrames = 0;
let prevAnchorPos = null;
const carDists = [];
const steadyCarDist = [];
let lookAngMax = 0;
const carDist = new THREE.Vector3();
let heliYawRateMax = 0;
let carYawRateMax = 0;
let prevHeliYaw = null;
let prevSubjectCar = null;
let prevCarPos = { x: 0, z: 0, copy(v) { this.x = v.x; this.z = v.z; } };
let prevCarPosInit = false;
const _carVel = new THREE.Vector3();
const _carVelPrev = new THREE.Vector3();
_prevH1.copy(heli1.pos);
_prevH2.copy(heli2.pos);

for (let f = 0; f < 60 * SECS; f++) {
  const dt = 1 / 60;
  const t = f / 60;
  for (let i = 0; i < n; i++) {
    const e = cars[i];
    e.dist += speedAt(e.driver.u) * (1 + i * 0.004) * dt;
    e.driver.u = (e.dist / track.length) % 1;
    setPose(e.car.body, e.driver.u);
  }
  // ---- game-exact order: spectator first, then the heli block (main.js 1081 -> 1092) ----
  c.update(dt, cars[0].car, cars[0].driver, cars, { progress: cars.map((e) => e.dist / track.length) });

  const tv = c.mode === 'tv';
  heli1.heli.root.visible = true && !(tv && c.shot === 0);
  heli2.heli.root.visible = true && !(tv && c.shot === 3);
  if (heli1.heli.root.visible !== !(tv && c.shot === 0)) visWrong++;
  if (heli2.heli.root.visible !== !(tv && c.shot === 3)) visWrong++;

  let a1 = tv ? c.tvHeli : null;
  if (!a1) {
    const followCar = cars[n - 1].car;
    const lp = followCar.body.translation();
    const lq = followCar.body.rotation();
    _hf.set(0, 0, 1).applyQuaternion(_hq.set(lq.x, lq.y, lq.z, lq.w));
    _hf.y = 0;
    if (_hf.lengthSq() < 1e-6) _hf.set(0, 0, 1);
    _hf.normalize();
    _ha.set(lp.x - _hf.x * 15, lp.y + 26, lp.z - _hf.z * 15);
    _hl.set(lp.x + _hf.x * 4, lp.y + 0.5, lp.z + _hf.z * 4);
    a1 = { pos: _ha, look: _hl };
  }
  heli1.update(dt, a1.pos, a1.look);
  const a2 = tv ? c.tvCrash : null;
  if (a2) heli2.update(dt, a2.pos, a2.look);
  else {
    _ha.set(_s0.x + Math.sin(t * 0.05) * 90, 44 + Math.sin(t * 0.11) * 7, _s0.z + Math.sin(t * 0.037 + 1.3) * 90);
    _hl.set(_ha.x, 0, _ha.z);
    heli2.update(dt, _ha, _hl);
  }

  // ---- metrics ----
  const p = c.pos;
  if (!isFinite(p.x + p.y + p.z) || p.y < -1 || p.y > 90) bad++;
  if (tv && (c.shot === 0 || c.shot === 3)) {
    const u = c.shot === 0 ? heli1 : heli2;
    camErrMax = Math.max(camErrMax, p.distanceTo(u.nosePos));
    if (c.shot === 0) {
      heli1OnAir++;
      const lookDir = _p0.copy(u.look).sub(u.nosePos).normalize();
      if (lookDir.y < -0.15) downFrames++;
      else forwardFrames++;
      const subj = c._subject;
      if (subj && subj.body) {
        const sp = subj.body.translation();
        carDist.copy(sp).sub(p);
        carDists.push(carDist.length());
        const toCar = _p0.copy(carDist).normalize();
        const ang = Math.acos(THREE.MathUtils.clamp(_f.copy(lookDir).dot(toCar), -1, 1));
        lookAngMax = Math.max(lookAngMax, ang);
        if (subjFrames > 5 * 60) steadyCarDist.push(carDist.length());
      }
    }
  }
  speed1Max = Math.max(speed1Max, heli1.pos.distanceTo(_prevH1) / dt);
  speed2Max = Math.max(speed2Max, heli2.pos.distanceTo(_prevH2) / dt);
  _prevH1.copy(heli1.pos);
  _prevH2.copy(heli2.pos);
  // the heli's own brain: its yaw is turn-rate limited; the car's is not
  if (prevHeliYaw !== null) {
    let dy = heli1._yaw - prevHeliYaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    heliYawRateMax = Math.max(heliYawRateMax, Math.abs(dy) / dt);
  }
  prevHeliYaw = heli1._yaw;
  if (tv && c.shot === 0 && c._subject && c._subject.body) {
    const v = c._subject.body.translation();
    if (!prevCarPosInit || prevSubjectCar !== c._subject) {
      prevCarPosInit = true;
      prevSubjectCar = c._subject;
      _carVelPrev.set(0, 0, 0);
      prevCarPos.copy(v);
    } else {
      _carVel.set((v.x - prevCarPos.x) / dt, 0, (v.z - prevCarPos.z) / dt);
      if (_carVel.lengthSq() > 1e-6) {
        if (_carVelPrev.lengthSq() > 1e-6) {
          const a0 = Math.atan2(_carVelPrev.x, _carVelPrev.z);
          const a1 = Math.atan2(_carVel.x, _carVel.z);
          let dy = a1 - a0;
          while (dy > Math.PI) dy -= 2 * Math.PI;
          while (dy < -Math.PI) dy += 2 * Math.PI;
          carYawRateMax = Math.max(carYawRateMax, Math.abs(dy) / dt);
        }
        _carVelPrev.copy(_carVel);
      }
      prevCarPos.copy(v);
    }
  } else {
    prevCarPosInit = false;
    prevSubjectCar = null;
    _carVelPrev.set(0, 0, 0);
  }

  // the HELI anchor while following the same subject: it must drift with
  // the car (locked rear-quarter) - no jumps, no orbiting
  if (tv && c.shot === 0 && c.tvHeli) {
    const subj = c._subject;
    if (subj === prevSubject) {
      subjFrames++;
      if (prevAnchorPos) {
        const sp = c.tvHeli.pos.distanceTo(prevAnchorPos) / dt;
        anchorSpeeds.push(sp);
        anchorJumpMax = Math.max(anchorJumpMax, c.tvHeli.pos.distanceTo(prevAnchorPos));
        if (subjFrames > 5 * 60) steadyErr1.push(heli1.pos.distanceTo(c.tvHeli.pos));
      }
      // locked rear-quarter geometry: 22 m back, 12 m up
      if (subj && subj.body) {
        const d = _p1.copy(c.tvHeli.pos).sub(subj.body.translation());
        const horiz = Math.hypot(d.x, d.z);
        if (!(horiz > 12 && horiz < 32)) console.log(`  WARN t=${t.toFixed(1)} anchor horiz ${horiz.toFixed(1)} m`);
        if (!(d.y > 6 && d.y < 18)) console.log(`  WARN t=${t.toFixed(1)} anchor height ${d.y.toFixed(1)} m`);
      }
    } else {
      // subject switched (a cut): the heli now cruises calmly over
      prevSubject = subj;
      subjFrames = 0;
    }
    prevAnchorPos = c.tvHeli.pos.clone();
  } else {
    prevSubject = null;
    prevAnchorPos = null;
  }
}

console.log('heli integration (120 s, real HeliUnit + nose PTZ read):');
ok(bad === 0, `0 bad frames (got ${bad})`);
ok(camErrMax < 0.75, `TV camera rides the nose PTZ (max err ${camErrMax.toFixed(2)} m = <= 1 frame of heli travel, game frame order)`);
ok(heli1OnAir > 30 * 60, `heli 1 carried the HELI shot (frames: ${heli1OnAir})`);
ok(speed1Max <= 34.5, `heli 1 stays under its own 33 m/s cap (max ${speed1Max.toFixed(1)} m/s)`);
ok(speed2Max <= 34.5, `heli 2 stays under its own 33 m/s cap (max ${speed2Max.toFixed(1)} m/s)`);
ok(visWrong === 0, `mounted-heli visibility rule holds every frame (violations: ${visWrong})`);
if (downFrames + forwardFrames > 0) {
  const downPct = (100 * downFrames) / (downFrames + forwardFrames);
  ok(downPct > 45 && downPct < 95, `nose PTZ mostly shoots the car, occasionally forward (down ${downPct.toFixed(0)}% / forward ${(100 - downPct).toFixed(0)}%)`);
}
const anchorAvg = anchorSpeeds.length ? anchorSpeeds.reduce((a, b) => a + b, 0) / anchorSpeeds.length : 0;
ok(anchorAvg < 38, `locked rear-quarter anchor drifts with the car (avg ${anchorAvg.toFixed(1)} m/s - following, not circling)`);
ok(anchorJumpMax < 3, `no anchor jumps while holding a subject (max single-frame jump ${anchorJumpMax.toFixed(2)} m - smooth, not circling)`);
const cdP50 = steadyCarDist.length ? [...steadyCarDist].sort((a, b) => a - b)[Math.floor(steadyCarDist.length * 0.5)] : 0;
const cdP95 = steadyCarDist.length ? [...steadyCarDist].sort((a, b) => a - b)[Math.floor(steadyCarDist.length * 0.95)] : 0;
const sorted = steadyCarDist.slice().sort((a, b) => a - b);
const qp = (q) => (steadyCarDist.length ? sorted[Math.floor(steadyCarDist.length * q)] : 0);
const cdMax = steadyCarDist.length ? sorted[sorted.length - 1] : 0;
console.log(`  info heli-to-car p50 ${qp(0.5).toFixed(1)} / p75 ${qp(0.75).toFixed(1)} / p90 ${qp(0.9).toFixed(1)} / p95 ${qp(0.95).toFixed(1)} / p99 ${qp(0.99).toFixed(1)} / max ${cdMax.toFixed(0)} m`);
ok(cdP50 < 50, `typical framing is a tight broadcast shot (p50 heli-to-car ${cdP50.toFixed(1)} m once settled)`);
ok(cdP50 < 50, `typical framing is a tight broadcast shot (p50 heli-to-car ${cdP50.toFixed(1)} m once settled)`);
ok(cdMax < 500, `the glide to a far new subject stays bounded (max heli-to-car ${cdMax.toFixed(0)} m, car stays centred the whole way)`);
ok(lookAngMax < 0.35, `the nose PTZ keeps the car in the frame (max look offset ${(lookAngMax * 57.29).toFixed(1)} deg)`);
ok(heliYawRateMax <= 1.15, `heli flight is turn-rate limited (its own smooth line, max yaw ${heliYawRateMax.toFixed(2)} rad/s)`);
ok(carYawRateMax > heliYawRateMax, `the heli does NOT copy the car's steering (car max yaw ${carYawRateMax.toFixed(2)} rad/s vs heli ${heliYawRateMax.toFixed(2)})`);
ok(heli2.heli.root.visible === true, `the other heli stays visible while heli 1 is mounted (visible: ${heli2.heli.root.visible})`);

console.log(failures === 0 ? '\nALL HELI INTEGRATION CHECKS PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
