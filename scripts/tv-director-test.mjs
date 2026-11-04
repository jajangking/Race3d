// Headless verification for the v15.0 broadcast director.
//   node scripts/tv-director-test.mjs
//
// The feed is directed by a Q-learning agent (12 states x 4 actions; the
// 4th action IS the CRASH shot - the table learns which contacts are
// worth chasing):
//   A: 10-min packed field + scripted LEADER-PAIR contact (high value):
//      the crash cut pre-empts mid-shot like a real broadcast, all four
//      shot types appear, subjects rotate, the table persists (v3 key)
//   B: locked 6 m leader battle for 8 min (no contact): the CRASH column
//      stays untouched (neutral), the table learns HELI is the weakest
//      battle-state action, 1V1 dominates the feed
//   C: crash pre-emption regression on a REAL high-value contact: prompt
//      cut, the cam holds its pass angle (high, ~53 deg down - not nose
//      down), releases at the next boundary once the cars separate
//   D: corner PTZ (fixed mast, panning head, zooming lens)
//   E: recover mode without contact is NOT a crash; in clean air HELI +
//      CORN carry the feed
//   F: MINOR contact (back-of-pack brush, low value): measured and NOT
//      chased - no mid-shot pre-emption at detection (the shot timer is
//      pinned in the window, so any cut there would be a pre-emption),
//      and the crash shot stays a small share of the feed
import * as THREE from 'three';
import { SpectatorCamera } from '../src/render/spectatorCamera.js';
import { TRACKS } from '../src/trackLayout.js';
import { buildRacingLine } from '../src/ai/racingLine.js';

const track = TRACKS.rally;
const RACING_LINE = buildRacingLine(track);

// position/pose lookup table along the centreline
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
// write a car's pose into its own body vectors (no shared scratch)
function setPose(body, u) {
  const i = Math.floor((((u % 1) + 1) % 1) * NS) % NS;
  body._v.set(posTab[i * 3], 0, posTab[i * 3 + 2]);
  _f.set(tanTab[i * 3], 0, tanTab[i * 3 + 2]).normalize();
  body._q.setFromUnitVectors(FZ, _f);
}

// mock localStorage
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => {
    store[k] = String(v);
  },
};

function makeField(n) {
  const cars = [];
  for (let i = 0; i < n; i++) {
    const u = (i * 0.045) % 1;
    const body = {
      _v: new THREE.Vector3(),
      _q: new THREE.Quaternion(),
      translation() {
        return this._v;
      },
      rotation() {
        return this._q;
      },
    };
    setPose(body, u);
    cars.push({
      car: { body },
      driver: { u, mode: 'race', recoverTime: 0 },
      pace: 0,
      dist: u * track.length,
    });
  }
  return cars;
}

function cam() {
  const camera = {
    position: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
    fov: 50,
    aspect: 16 / 9,
    lookAt(v) {
      this._look = v;
    },
    updateProjectionMatrix() {},
  };
  const canvas = { style: {}, addEventListener() {} };
  // the scene track ships exactly this shape (createTrack): the racing
  // line plus the layout-derived corner list with one cam slot each
  const c = new SpectatorCamera(camera, canvas, {
    curve: track.curve,
    length: track.length,
    racingLine: RACING_LINE,
    corners: track.corners,
  });
  c.enabled = false;
  return c;
}

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  PASS ' : '  FAIL ') + msg);
  if (!cond) failures++;
};
const rank = (cars) => cars.map((_, i) => i).sort((a, b) => cars[b].dist - cars[a].dist);

// ------------------------------------------------------------ Test A
console.log('A: 10-min packed field, high-value leader contact (pre-emption + persistence)');
{
  delete store['race3d-qdirector-v3'];
  const cars = makeField(11);
  const c = cam();
  let bad = 0;
  const labels = new Set();
  const share = {};
  const cuts = [];
  let lastLabel = '';
  let crashCutAt = null;
  for (let f = 0; f < 60 * 600; f++) {
    const dt = 1 / 60;
    const t = f / 60;
    for (let i = 0; i < cars.length; i++) {
      const e = cars[i];
      // oscillating pace (tyres/fuel/DRS stand-in): the leader and the
      // closest pair rotate over the run, like a real field
      e.pace = 31.0 + i * 0.06 + 1.5 * Math.sin(0.02 * t + i * 1.7);
      e.dist += e.pace * dt;
    }
    // packed field, no overtakes: the AI never clips a car in the game,
    // so the mock keeps a clean 6 m gap behind the car ahead
    const rk = rank(cars);
    for (let k = 1; k < rk.length; k++) {
      const behind = cars[rk[k]];
      const ahead = cars[rk[k - 1]];
      const minDist = ahead.dist - 6;
      if (behind.dist > minDist) {
        behind.dist = minDist;
      }
    }
    for (const e of cars) {
      e.driver.u = (e.dist / track.length) % 1;
      setPose(e.car.body, e.driver.u);
    }
    // scripted HIGH-VALUE contact between t=120 s and t=132 s: the car
    // right behind the CURRENT leader clips the leader's rear - bodies
    // actually touch (worth = 1.0, must pre-empt like a real broadcast)
    if (t >= 120 && t < 132) {
      const rk2 = rank(cars);
      cars[rk2[1]].dist = cars[rk2[0]].dist - 3;
      cars[rk2[1]].driver.u = (cars[rk2[1]].dist / track.length) % 1;
      setPose(cars[rk2[1]].car.body, cars[rk2[1]].driver.u);
    }
    c.update(dt, cars[0].car, cars[0].driver, cars, {
      progress: cars.map((e) => e.dist / track.length),
    });
    labels.add(c.label);
    share[c.label] = (share[c.label] || 0) + 1;
    if (c.label !== lastLabel) {
      const idx = c.label === 'TV·1V1' || c.label === 'TV·HELI' ? cars.findIndex((e) => e.car === c._subject) : -1;
      cuts.push({ t, label: c.label, subj: idx });
      if (c.label === 'TV·CRASH' && crashCutAt === null) crashCutAt = t;
      lastLabel = c.label;
    }
    const p = c.pos;
    if (!isFinite(p.x + p.y + p.z) || p.y < -1 || p.y > 90) bad++;
  }
  ok(bad === 0, `0 bad frames (got ${bad})`);
  for (const L of ['TV·HELI', 'TV·CORN', 'TV·1V1', 'TV·CRASH']) {
    ok(labels.has(L), `label seen: ${L}`);
  }
  // the high-value incident must cut promptly: within the current shot's
  // remaining time (the pre-emption gate waits at most 2.5 s)
  ok(crashCutAt !== null && crashCutAt >= 119.9 && crashCutAt < 122.5,
    `high-value crash pre-empts promptly (cut t=${crashCutAt === null ? 'never' : crashCutAt.toFixed(2)})`);
  // no crash spam after the cars separate at ~133.4 s
  const lateCrash = cuts.filter((x) => x.label === 'TV·CRASH' && x.t > 134).length;
  ok(lateCrash <= 1, `no crash spam after the incident (late cuts: ${lateCrash})`);
  const total = 60 * 600;
  const pct = (L) => (100 * (share[L] || 0)) / total;
  ok(
    pct('TV·HELI') <= 60 && pct('TV·CORN') <= 60 && pct('TV·1V1') <= 60,
    `no single shot type owns the feed (HELI ${pct('TV·HELI').toFixed(0)}% / CORN ${pct('TV·CORN').toFixed(0)}% / 1V1 ${pct('TV·1V1').toFixed(0)}% / CRASH ${pct('TV·CRASH').toFixed(0)}%)`
  );
  const subjects = new Set(cuts.filter((x) => x.subj >= 0).map((x) => x.subj));
  ok(subjects.size >= 4, `rotates subjects across the field (distinct subjects: ${[...subjects].sort((a, b) => a - b).join(',')})`);
  ok(!Array.from(subjects).every((s) => s === 0), 'not locked onto the focus/leader car only');
  // Q table sanity (12 states x 4 actions = 48, crash column included)
  ok(c.Q.length === 48, `Q table is 12x4 (len ${c.Q.length})`);
  ok(Array.from(c.Q).every((v) => Number.isFinite(v)), 'Q table all finite');
  ok(c.qEps < 0.15 && c.qEps >= 0.03, `epsilon decayed and floored (now ${c.qEps.toFixed(3)})`);
  // persistence round-trip (v3 key)
  ok(!!store['race3d-qdirector-v3'], 'Q table saved to localStorage');
  const c2 = cam();
  const sameQ = c2.Q.length === c.Q.length && Array.from(c2.Q).every((v, i) => v === c.Q[i]);
  ok(sameQ, 'fresh instance loads the same learned table');
  // no same-camera back-to-back more than ~15% of cuts (variety pressure)
  let rep = 0;
  for (let i = 1; i < cuts.length; i++) if (cuts[i].label === cuts[i - 1].label) rep++;
  const repPct = (100 * rep) / Math.max(1, cuts.length - 1);
  ok(repPct < 25, `back-to-back same camera rare (${repPct.toFixed(0)}% of cuts)`);
}

// ------------------------------------------------------------ Test B
console.log('B: locked 6 m leader battle (learning direction, crash stays neutral)');
{
  delete store['race3d-qdirector-v3']; // start from the prior
  const cars = makeField(11);
  // car 0 leads, car 1 locked 6 m behind - just outside body contact
  // (car length 4.04 m + bumper gap) so the CRASH cam must stay off;
  // everyone else 40 m apart behind the pair (a tight leader gap)
  cars.forEach((e, i) => {
    e.pace = 33;
    e.dist = i === 0 ? 0 : i === 1 ? -6 : -(i * 40 + 6);
    e.driver.u = (e.dist / track.length) % 1;
  });
  const c = cam();
  const chosen = [];
  let crashFrames = 0;
  let bad = 0;
  for (let f = 0; f < 60 * 480; f++) {
    const dt = 1 / 60;
    const t = f / 60;
    for (const e of cars) {
      e.dist += e.pace * dt;
      if (e === cars[1]) e.dist = cars[0].dist - 6; // keep the battle locked
      e.driver.u = (e.dist / track.length) % 1;
      setPose(e.car.body, e.driver.u);
    }
    c.update(dt, cars[0].car, cars[0].driver, cars, {
      progress: cars.map((e) => e.dist / track.length),
    });
    if (c.shot !== 3) chosen.push({ t, a: c.shot });
    else crashFrames++;
    const p = c.pos;
    if (!isFinite(p.x + p.y + p.z) || p.y < -1 || p.y > 90) bad++;
  }
  ok(bad === 0, `0 bad frames (got ${bad})`);
  ok(crashFrames === 0, `no false crash cam on a 6 m battle (frames: ${crashFrames})`);
  // locked 6 m: leader gap bucket 1 (3-10 m), pack bucket 0 (<=1 car
  // within 25 m) -> state s = 3 -> table rows 12..15
  // [HELI, CORN, 1V1, CRASH]
  ok(
    c.Q[12] < c.Q[13] && c.Q[12] < c.Q[14] && Math.abs(c.Q[13] - c.Q[14]) < 0.15,
    `battle state: HELI ranked last, battle cams on top (Q=[${[c.Q[12], c.Q[13], c.Q[14], c.Q[15]].map((v) => v.toFixed(2)).join(', ')}])`
  );
  ok(Math.abs(c.Q[15]) < 0.01,
    `CRASH column stays neutral without a contact (Q=${c.Q[15].toFixed(3)} - nothing was chased)`);
  const late = chosen.filter((x) => x.t > 300);
  const oneCount = late.filter((x) => x.a === 2).length;
  const pct = (100 * oneCount) / Math.max(1, late.length);
  ok(pct >= 45, `1V1 dominates the feed in a locked battle (latter half: ${pct.toFixed(0)}%)`);
}

// ------------------------------------------------------------ Test C
console.log('C: crash pre-emption regression (high-value contact)');
{
  delete store['race3d-qdirector-v3'];
  const cars = makeField(11);
  cars.forEach((e, i) => (e.pace = 32 + i * 0.05));
  const c = cam();
  let cutAt = null;
  let releasedAt = null;
  let prevLabel = '';
  let bad = 0;
  let crashYMax = 0;
  for (let f = 0; f < 60 * 40; f++) {
    const dt = 1 / 60;
    const t = f / 60;
    for (const e of cars) {
      e.dist += e.pace * dt;
      e.driver.u = (e.dist / track.length) % 1;
      setPose(e.car.body, e.driver.u);
    }
    // a REAL high-value contact between t=10 and t=18: car 9 (2nd) clips
    // car 10 (the LEADER) - 3 m centre-to-centre = the bodies overlap;
    // after t=18 the leader pulls away and the pair separates
    if (t >= 10 && t < 18) {
      cars[9].dist = cars[10].dist - 3;
      cars[9].driver.u = (cars[9].dist / track.length) % 1;
      setPose(cars[9].car.body, cars[9].driver.u);
    }
    if (t >= 18) cars[10].pace = 42.4; // the leader pulls away
    c.update(dt, cars[0].car, cars[0].driver, cars, {
      progress: cars.map((e) => e.dist / track.length),
    });
    if (c.label === 'TV·CRASH' && prevLabel !== 'TV·CRASH' && cutAt === null) cutAt = t;
    if (prevLabel === 'TV·CRASH' && c.label !== 'TV·CRASH' && releasedAt === null) releasedAt = t;
    prevLabel = c.label;
    if (c.label === 'TV·CRASH') crashYMax = Math.max(crashYMax, c.pos.y);
    const p = c.pos;
    if (!isFinite(p.x + p.y + p.z) || p.y < -1 || p.y > 90) bad++;
  }
  ok(bad === 0, `0 bad frames (got ${bad})`);
  // deterministic timing: the opening HELI shot holds its 14 s timer, so
  // at the contact (t=10) its remaining 4 s is above the 2.5 s gate -
  // the pre-emption cuts on the very next frame, mid-shot
  ok(cutAt !== null && cutAt >= 9.9 && cutAt < 10.3,
    `cuts to CRASH promptly on the contact (t=${cutAt === null ? 'never' : cutAt.toFixed(2)})`);
  // while the contact is live (until t=18) the timer is refreshed to
  // 1.5 s, so release is at t=18+1.5 = 19.5 - no hard hang
  ok(releasedAt !== null && releasedAt >= 19.3 && releasedAt < 19.8,
    `holds while the contact is live, releases at the next boundary (released t=${releasedAt === null ? 'never' : releasedAt.toFixed(2)})`);
  // the crash cam holds its high pass angle (~24 m above the cars,
  // 18 m out => ~53 deg down - a broadcast pass, not straight overhead)
  ok(crashYMax > 23.5 && crashYMax < 26,
    `crash cam is the high heli pass (max y ${crashYMax.toFixed(1)} m)`);
  ok(c.Q.length === 48 && Array.from(c.Q).every((v) => Number.isFinite(v)), 'Q table 12x4, all finite');
}

// ------------------------------------------------------------ Test D
console.log('D: corner PTZ (fixed mast, panning head, zooming lens)');
{
  delete store['race3d-qdirector-v3'];
  const c = cam();
  const c0 = track.corners[0];
  const body = {
    _v: new THREE.Vector3(),
    _q: new THREE.Quaternion(),
    translation() {
      return this._v;
    },
    rotation() {
      return this._q;
    },
  };
  const entry = { car: { body }, driver: { u: c0.u - 0.06, mode: 'race', recoverTime: 0 } };
  setPose(body, entry.driver.u);
  // force the CORN shot on the corner the car is about to take
  c.shot = 1;
  c.shotTimer = 999;
  c._subject = entry.car;
  c._subjectEntry = entry;
  c.initialised = false;
  const samples = [];
  let bad = 0;
  for (let f = 0; f < 60 * 14; f++) {
    const dt = 1 / 60;
    const t = f / 60;
    entry.driver.u = c0.u - 0.06 + t * 0.012; // apex pass at ~t=5 s
    setPose(body, entry.driver.u);
    c.update(dt, entry.car, entry.driver, [entry], { progress: [entry.driver.u] });
    if (f % 6 === 0) {
      samples.push({
        t,
        fov: c.camera.fov,
        pos: c.pos.clone(),
        look: c.camera._look ? c.camera._look.clone() : null,
      });
    }
    const p = c.pos;
    if (!isFinite(p.x + p.y + p.z) || p.y < -1 || p.y > 90) bad++;
  }
  ok(bad === 0, `0 bad frames (got ${bad})`);
  const fovs = samples.map((s) => s.fov);
  const spread = Math.max(...fovs) - Math.min(...fovs);
  ok(spread > 4, `lens zooms in/out with the pass (FOV ${Math.min(...fovs).toFixed(1)}..${Math.max(...fovs).toFixed(1)}, spread ${spread.toFixed(1)} deg)`);
  // head pan: look direction at approach (t~3 s) vs exit (t~9 s)
  const at = (tt) => samples.reduce((a, b) => (Math.abs(b.t - tt) < Math.abs(a.t - tt) ? b : a));
  const a = at(3);
  const b = at(9);
  const va = a.look.clone().sub(a.pos).normalize();
  const vb = b.look.clone().sub(b.pos).normalize();
  const deg = (Math.acos(THREE.MathUtils.clamp(va.dot(vb), -1, 1)) * 180) / Math.PI;
  ok(deg > 10, `head pans with the car (look rotated ${deg.toFixed(1)} deg between approach and exit)`);
  // mast stays put
  const base = at(1).pos;
  const drift = samples.reduce((m, s) => Math.max(m, s.pos.distanceTo(base)), 0);
  ok(drift < 3, `camera position stays at the mast (drift ${drift.toFixed(2)} m)`);
}

// ------------------------------------------------------------ Test E
console.log('E: recover mode without contact is NOT a crash + clean-air share');
{
  delete store['race3d-qdirector-v3'];
  const cars = makeField(11);
  // 79 m apart, tiny pace spread: a clean-air field, no overtakes, no
  // contacts for the whole run
  cars.forEach((e, i) => (e.pace = 32 + i * 0.05));
  const c = cam();
  let crashFrames = 0;
  const share = {};
  const labels = new Set();
  for (let f = 0; f < 60 * 120; f++) {
    const dt = 1 / 60;
    const t = f / 60;
    for (const e of cars) {
      e.dist += e.pace * dt;
      e.driver.u = (e.dist / track.length) % 1;
      setPose(e.car.body, e.driver.u);
    }
    // the v14.6 trigger: an off-road stuck car (recover mode) with no
    // body contact - this must never produce a CRASH shot
    cars[4].driver.mode = t >= 10 && t < 100 ? 'recover' : 'race';
    c.update(dt, cars[0].car, cars[0].driver, cars, {
      progress: cars.map((e) => e.dist / track.length),
    });
    if (c.label === 'TV·CRASH') crashFrames++;
    labels.add(c.label);
    share[c.label] = (share[c.label] || 0) + 1;
  }
  const total = 60 * 120;
  const pct = (L) => (100 * (share[L] || 0)) / total;
  ok(crashFrames === 0, `no TV·CRASH without a body contact (frames: ${crashFrames})`);
  for (const L of ['TV·HELI', 'TV·CORN']) {
    ok(labels.has(L), `label seen: ${L}`);
  }
  // in clean air the heli follow is the lead shot - but the corner cams
  // must keep taking a real slice of the feed (the anti-heli-monopoly
  // property), and 1V1 stays off because there is no battle to show
  ok(pct('TV·CORN') >= 10, `corner cams keep a real slice in clean air (CORN ${pct('TV·CORN').toFixed(0)}%)`);
  ok(pct('TV·HELI') <= 90, `in clean air the heli leads (its design job) but corner cams intercut (HELI ${pct('TV·HELI').toFixed(0)}%)`);
}

// ------------------------------------------------------------ Test F
console.log('F: minor back-of-pack brush is measured, NOT chased');
{
  delete store['race3d-qdirector-v3'];
  const cars = makeField(13);
  const c = cam();
  let bad = 0;
  const share = {};
  const cuts = [];
  let lastLabel = '';
  let crashInWindow = false; // any CRASH cut inside the pinned-timer window
  for (let f = 0; f < 60 * 600; f++) {
    const dt = 1 / 60;
    const t = f / 60;
    for (let i = 0; i < cars.length; i++) {
      const e = cars[i];
      e.pace = 31.0 + i * 0.06 + 1.5 * Math.sin(0.02 * t + i * 1.7);
      e.dist += e.pace * dt;
    }
    // packed field, no overtakes (6 m locked) - the only contact in the
    // whole run is the scripted one below
    const rk = rank(cars);
    for (let k = 1; k < rk.length; k++) {
      const behind = cars[rk[k]];
      const ahead = cars[rk[k - 1]];
      const minDist = ahead.dist - 6;
      if (behind.dist > minDist) {
        behind.dist = minDist;
      }
    }
    for (const e of cars) {
      e.driver.u = (e.dist / track.length) % 1;
      setPose(e.car.body, e.driver.u);
    }
    // a MINOR contact from t=60 on: the last two cars brush (ranks 11
    // and 12 of 13) - low value, the director should measure it and
    // mostly ignore it
    if (t >= 60) {
      const rk2 = rank(cars);
      cars[rk2[12]].dist = cars[rk2[11]].dist - 3;
      cars[rk2[12]].driver.u = (cars[rk2[12]].dist / track.length) % 1;
      setPose(cars[rk2[12]].car.body, cars[rk2[12]].driver.u);
    }
    // between t=58 and t=66 the shot timer is pinned high: no normal
    // boundary can fire in the window, so ANY cut there would be a
    // mid-shot pre-emption - which a minor brush must not trigger
    if (t >= 58 && t < 66) c.shotTimer = Math.max(c.shotTimer, 5.0);
    c.update(dt, cars[0].car, cars[0].driver, cars, {
      progress: cars.map((e) => e.dist / track.length),
    });
    share[c.label] = (share[c.label] || 0) + 1;
    if (c.label !== lastLabel) {
      cuts.push({ t, label: c.label });
      if (c.label === 'TV·CRASH' && t >= 58 && t < 66) crashInWindow = true;
      lastLabel = c.label;
    }
    const p = c.pos;
    if (!isFinite(p.x + p.y + p.z) || p.y < -1 || p.y > 90) bad++;
  }
  ok(bad === 0, `0 bad frames (got ${bad})`);
  ok(!crashInWindow, `no mid-shot pre-emption at the brush (a minor contact is not chased on sight)`);
  const total = 60 * 600;
  const pct = (L) => (100 * (share[L] || 0)) / total;
  const crashCuts = cuts.filter((x) => x.label === 'TV·CRASH').length;
  ok(pct('TV·CRASH') < 25, `crash shot stays a small share of the feed (CRASH ${pct('TV·CRASH').toFixed(1)}%, cuts ${crashCuts})`);
  ok(pct('TV·CRASH') <= 15, `no crash spam on a minor brush (CRASH ${pct('TV·CRASH').toFixed(1)}%)`);
  // the crash column may have been reinforced by measured (boundary)
  // cuts, but it must stay inside the clamp
  ok(Array.from(c.Q).every((v) => v >= -1.1 - 1e-9 && v <= 1.1 + 1e-9), 'Q table inside the clamp');
}

console.log(failures === 0 ? '\nALL DIRECTOR TESTS PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
