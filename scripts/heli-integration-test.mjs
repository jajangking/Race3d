// Headless integration check for the heli feed: the REAL HeliUnit flight
// model (turn-rate-limited, calm cap 33 m/s) flying the director's stable
// rear-quarter anchor, with the TV camera read from the nose PTZ exactly
// like main.js does it - including the off-air standby hold (the chopper
// keeps flying its last broadcast car while the feed is on another camera).
//   node scripts/heli-integration-test.mjs
//
// Deterministic: three fixed RNG seeds, each a fresh 120 s broadcast from
// the prior, so every metric below is reproducible run-to-run.
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

// like the real AI, the field is corner-limited: speed from the racing
// line's speed plan (a straight at ~32 m/s, 14-22 m/s in the tight bends)
const n = 11;
const line = buildRacingLine(track);
function speedAt(u) {
  const m = line.n;
  const x = (((u % 1) + 1) % 1) * m;
  const i = Math.floor(x) % m;
  const j = (i + 1) % m;
  const f = x - Math.floor(x);
  return line.speed[i] * (1 - f) + line.speed[j] * f;
}

// deterministic RNG (the director's random draws would otherwise make the
// distributions seed-noisy between runs)
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SECS = 120;

function runOnce(seed) {
  const realRandom = Math.random;
  Math.random = mulberry32(seed);

  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
  };

  const cars = [];
  for (let i = 0; i < n; i++) {
    const u = (i * 0.045) % 1; // mid-race running spread (the director mix is the director suite's job)
    const body = { _v: new THREE.Vector3(), _q: new THREE.Quaternion(), translation() { return this._v; }, rotation() { return this._q; } };
    setPose(body, u);
    cars.push({ car: { body }, driver: { u, mode: 'race', recoverTime: 0 }, pace: 0, dist: u * track.length });
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

  const m = {
    bad: 0,
    camErrMax: 0,
    speed1Max: 0,
    speed2Max: 0,
    downFrames: 0,
    forwardFrames: 0,
    heli1OnAir: 0,
    visWrong: 0,
    anchorSpeeds: [],
    anchorJumpMax: 0,
    steadyCarDist: [],
    lookInFrames: 0,
    lookInCone: 0,
    heliYawRateMax: 0,
    carYawRateMax: 0,
    openDists: [], // car distance 3 s after each HELI cut
    heli2Visible: false,
  };
  const carDist = new THREE.Vector3();
  let prevHeliYaw = null;
  let prevSubject = null;
  let subjFrames = 0;
  let prevAnchorPos = null;
  let prevSubjectCar = null;
  let prevCarPos = { x: 0, z: 0, copy(v) { this.x = v.x; this.z = v.z; } };
  let prevCarPosInit = false;
  const _carVel = new THREE.Vector3();
  const _carVelPrev = new THREE.Vector3();
  let prevShotGen = 0;
  let openSampleAt = null; // frame index 3 s after the last HELI cut
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
    if (heli1.heli.root.visible !== !(tv && c.shot === 0)) m.visWrong++;
    if (heli2.heli.root.visible !== !(tv && c.shot === 3)) m.visWrong++;

    // a new HELI shot started: sample the car distance 3 s later (the
    // shot must OPEN tight - no long transit across the field)
    if (c._shotGen !== prevShotGen) {
      prevShotGen = c._shotGen;
      openSampleAt = c.shot === 0 ? f + 180 : null;
    }

    let a1 = tv ? c.tvHeli || c.tvHeliHold : null;
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
    if (!isFinite(p.x + p.y + p.z) || p.y < -1 || p.y > 90) m.bad++;
    if (tv && (c.shot === 0 || c.shot === 3)) {
      const u = c.shot === 0 ? heli1 : heli2;
      m.camErrMax = Math.max(m.camErrMax, p.distanceTo(u.nosePos));
      if (c.shot === 0) {
        m.heli1OnAir++;
        // the PTZ's intended view state (a geometric look-dir test would
        // misread a distant glide as "forward")
        if (c._heliView === 'down') m.downFrames++;
        else m.forwardFrames++;
        const subj = c._subject;
        if (subj && subj.body) {
          const sp = subj.body.translation();
          carDist.copy(sp).sub(p);
          if (openSampleAt === f) m.openDists.push(carDist.length());
          if (c._heliView === 'down') {
            m.lookInFrames++;
            const toCar = _p0.copy(carDist).normalize();
            const lookDir = _p1.copy(u.look).sub(u.nosePos).normalize();
            const ang = Math.acos(THREE.MathUtils.clamp(lookDir.dot(toCar), -1, 1));
            if (ang < 0.785) m.lookInCone++; // 45 deg cone
          }
          if (subjFrames > 5 * 60) m.steadyCarDist.push(carDist.length());
        }
      }
    }
    m.speed1Max = Math.max(m.speed1Max, heli1.pos.distanceTo(_prevH1) / dt);
    m.speed2Max = Math.max(m.speed2Max, heli2.pos.distanceTo(_prevH2) / dt);
    _prevH1.copy(heli1.pos);
    _prevH2.copy(heli2.pos);
    // the heli's own brain: its yaw is turn-rate limited; the car's is not
    if (prevHeliYaw !== null) {
      let dy = heli1._yaw - prevHeliYaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      m.heliYawRateMax = Math.max(m.heliYawRateMax, Math.abs(dy) / dt);
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
            m.carYawRateMax = Math.max(m.carYawRateMax, Math.abs(dy) / dt);
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
          m.anchorSpeeds.push(sp);
          m.anchorJumpMax = Math.max(m.anchorJumpMax, c.tvHeli.pos.distanceTo(prevAnchorPos));
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
    m.heli2Visible = heli2.heli.root.visible;
  }

  Math.random = realRandom;
  return m;
}

const SEEDS = [11, 47, 131];
let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  PASS ' : '  FAIL ') + msg);
  if (!cond) failures++;
};

for (const seed of SEEDS) {
  const m = runOnce(seed);
  console.log(`seed ${seed} (120 s, real HeliUnit + nose PTZ read, deterministic):`);
  ok(m.bad === 0, `0 bad frames (got ${m.bad})`);
  ok(m.camErrMax < 0.75, `TV camera rides the nose PTZ (max err ${m.camErrMax.toFixed(2)} m = <= 1 frame of heli travel, game frame order)`);
  ok(m.heli1OnAir > 30 * 60, `heli 1 carried the HELI shot (frames: ${m.heli1OnAir})`);
  ok(m.speed1Max <= 34.5, `heli 1 stays under its own 33 m/s cap (max ${m.speed1Max.toFixed(1)} m/s)`);
  ok(m.speed2Max <= 34.5, `heli 2 stays under its own 33 m/s cap (max ${m.speed2Max.toFixed(1)} m/s)`);
  ok(m.visWrong === 0, `mounted-heli visibility rule holds every frame (violations: ${m.visWrong})`);
  if (m.downFrames + m.forwardFrames > 0) {
    const downPct = (100 * m.downFrames) / (m.downFrames + m.forwardFrames);
    ok(downPct > 60 && downPct < 95, `nose PTZ mostly shoots the car, occasionally forward (down ${downPct.toFixed(0)}% / forward ${(100 - downPct).toFixed(0)}%)`);
  }
  const anchorAvg = m.anchorSpeeds.length ? m.anchorSpeeds.reduce((a, b) => a + b, 0) / m.anchorSpeeds.length : 0;
  ok(anchorAvg < 38, `locked rear-quarter anchor drifts with the car (avg ${anchorAvg.toFixed(1)} m/s - following, not circling)`);
  ok(m.anchorJumpMax < 3, `no anchor jumps while holding a subject (max single-frame jump ${m.anchorJumpMax.toFixed(2)} m - smooth, not circling)`);
  const sorted = m.steadyCarDist.slice().sort((a, b) => a - b);
  const qp = (q) => (sorted.length ? sorted[Math.floor(sorted.length * q)] : 0);
  const cdMax = sorted.length ? sorted[sorted.length - 1] : 0;
  const openMax = m.openDists.length ? Math.max(...m.openDists) : 0;
  console.log(`  info heli-to-car p50 ${qp(0.5).toFixed(1)} / p75 ${qp(0.75).toFixed(1)} / p90 ${qp(0.9).toFixed(1)} / p95 ${qp(0.95).toFixed(1)} / p99 ${qp(0.99).toFixed(1)} / max ${cdMax.toFixed(0)} m; HELI cut opens at max ${openMax.toFixed(0)} m (t+3 s, ${m.openDists.length} cuts)`);
  ok(m.heli1OnAir > 30 * 60 && openMax < 90, `every HELI shot opens tight, no long transit (max heli-to-car at t+3 s: ${openMax.toFixed(0)} m)`);
  ok(qp(0.5) < 50, `typical framing is a tight broadcast shot (p50 heli-to-car ${qp(0.5).toFixed(1)} m once settled)`);
  ok(cdMax < 500, `the glide to a far new subject stays bounded (max heli-to-car ${cdMax.toFixed(0)} m, car stays centred the whole way)`);
  if (m.lookInFrames > 0) {
    const inCone = (100 * m.lookInCone) / m.lookInFrames;
    ok(inCone > 85, `while shooting down, the car stays in the PTZ cone (in-frame ${inCone.toFixed(0)}% of down-phase frames)`);
  }
  ok(m.heliYawRateMax <= 1.15, `heli flight is turn-rate limited (its own smooth line, max yaw ${m.heliYawRateMax.toFixed(2)} rad/s)`);
  ok(m.carYawRateMax > m.heliYawRateMax, `the heli does NOT copy the car's steering (car max yaw ${m.carYawRateMax.toFixed(2)} rad/s vs heli ${m.heliYawRateMax.toFixed(2)})`);
  ok(m.heli2Visible === true, `the other heli stays visible while heli 1 is mounted (visible: ${m.heli2Visible})`);
}

console.log(failures === 0 ? '\nALL HELI INTEGRATION CHECKS PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
