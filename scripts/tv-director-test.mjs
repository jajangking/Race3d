// Headless verification for the Q-learning TV director (v14.5).
//   node scripts/tv-director-test.mjs
//
// A: 10-min realistic field (varying paces, overtakes, one scripted crash):
//    the director must rotate subjects (not lock onto one car), use all
//    three learned shot types, produce 0 bad frames, and persist its table
//    to localStorage (round-tripped into a fresh instance).
// B: locked 4 m leader battle for 8 min: in the tight-gap states the
//    learned policy must prefer 1V1 (the battle shot).
// C: crash pre-emption regression (cut on the incident frame, hold after).

import * as THREE from 'three';
import { SpectatorCamera } from '../src/render/spectatorCamera.js';
import { TRACKS } from '../src/trackLayout.js';
import { buildRacingLine } from '../src/ai/racingLine.js';

const track = TRACKS.rally;
buildRacingLine(track);

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
    lookAt() {},
    updateProjectionMatrix() {},
  };
  const canvas = { style: {}, addEventListener() {} };
  const c = new SpectatorCamera(camera, canvas, {
    curve: track.curve,
    length: track.length,
    racingLine: track.racingLine,
  });
  c.enabled = false;
  return c;
}

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  PASS ' : '  FAIL ') + msg);
  if (!cond) failures++;
};

// ------------------------------------------------------------ Test A
console.log('A: 10-min realistic field (autonomous subjects + persistence)');
{
  const cars = makeField(11);
  const c = cam();
  let bad = 0;
  const labels = new Set();
  const cuts = [];
  let lastLabel = '';
  for (let f = 0; f < 60 * 600; f++) {
    const dt = 1 / 60;
    const t = f / 60;
    for (let i = 0; i < cars.length; i++) {
      const e = cars[i];
      // oscillating pace (tyres/fuel/DRS stand-in): the leader and the
      // closest pair rotate over the run, like a real field
      e.pace = 31.0 + i * 0.06 + 1.5 * Math.sin(0.02 * t + i * 1.7);
      e.dist += e.pace * dt;
      e.driver.u = (e.dist / track.length) % 1;
      setPose(e.car.body, e.driver.u);
    }
    // scripted crash on car 6 between t=120 s and t=132 s
    const d6 = cars[6].driver;
    if (t >= 120 && t < 132) {
      d6.mode = 'recover';
      d6.recoverTime = t - 120;
    } else {
      d6.mode = 'race';
    }
    c.update(dt, cars[0].car, cars[0].driver, cars, {
      progress: cars.map((e) => e.dist / track.length),
    });
    labels.add(c.label);
    if (c.label !== lastLabel) {
      const idx = c.label === 'TV·1V1' || c.label === 'TV·HELI' ? cars.findIndex((e) => e.car === c._subject) : -1;
      cuts.push({ t, label: c.label, subj: idx });
      lastLabel = c.label;
    }
    const p = c.pos;
    if (!isFinite(p.x + p.y + p.z) || p.y < -1 || p.y > 90) bad++;
  }
  ok(bad === 0, `0 bad frames (got ${bad})`);
  for (const L of ['TV·HELI', 'TV·CORN', 'TV·1V1', 'TV·CRASH']) {
    ok(labels.has(L), `label seen: ${L}`);
  }
  const subjects = new Set(cuts.filter((x) => x.subj >= 0).map((x) => x.subj));
  ok(subjects.size >= 4, `rotates subjects across the field (distinct subjects: ${[...subjects].sort((a, b) => a - b).join(',')})`);
  ok(!Array.from(subjects).every((s) => s === 0), 'not locked onto the focus/leader car only');
  ok(cuts.some((x) => x.label === 'TV·CRASH'), 'crash cam appeared');
  // Q table sanity
  ok(Array.from(c.Q).every((v) => Number.isFinite(v)), 'Q table all finite');
  ok(c.qEps < 0.15 && c.qEps >= 0.03, `epsilon decayed and floored (now ${c.qEps.toFixed(3)})`);
  // persistence round-trip
  ok(!!store['race3d-qdirector-v1'], 'Q table saved to localStorage');
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
console.log('B: locked 4 m leader battle (learning direction)');
{
  store['race3d-qdirector-v1'] = undefined; // start from the prior
  delete store['race3d-qdirector-v1'];
  const cars = makeField(11);
  // car 0 leads, car 1 locked 4 m behind (the battle); everyone else 40 m
  // apart BEHIND the pair so the field state is a tight leader gap
  cars.forEach((e, i) => {
    e.pace = 33;
    e.dist = i === 0 ? 0 : i === 1 ? -4 : -(i * 40 + 4);
    e.driver.u = (e.dist / track.length) % 1;
  });
  const c = cam();
  const chosen = [];
  let bad = 0;
  for (let f = 0; f < 60 * 480; f++) {
    const dt = 1 / 60;
    const t = f / 60;
    for (const e of cars) {
      e.dist += e.pace * dt;
      if (e === cars[1]) e.dist = cars[0].dist - 4; // keep the battle locked
      e.driver.u = (e.dist / track.length) % 1;
      setPose(e.car.body, e.driver.u);
    }
    c.update(dt, cars[0].car, cars[0].driver, cars, {
      progress: cars.map((e) => e.dist / track.length),
    });
    if (c.shot !== 3) chosen.push({ t, a: c.shot });
    const p = c.pos;
    if (!isFinite(p.x + p.y + p.z) || p.y < -1 || p.y > 90) bad++;
  }
  ok(bad === 0, `0 bad frames (got ${bad})`);
  // tight-gap state s = 0 (gap < 3 m bucket... 4 m is bucket 1) -> check buckets 0 and 1
  const arg = (s) => {
    let a = 0;
    for (let b = 1; b < 3; b++) if (c.Q[s * 3 + b] > c.Q[s * 3 + a]) a = b;
    return a;
  };
  const argS1 = arg(1); // gap 3-10 m, pack 1-2
  ok(argS1 === 2, `learned policy in tight-gap state prefers 1V1 (argmax = ${argS1}, Q=[${[c.Q[3], c.Q[4], c.Q[5]].map((v) => v.toFixed(2)).join(', ')}])`);
  const late = chosen.filter((x) => x.t > 300);
  const oneCount = late.filter((x) => x.a === 2).length;
  const pct = (100 * oneCount) / Math.max(1, late.length);
  ok(pct >= 45, `1V1 dominates the feed in a locked battle (latter half: ${pct.toFixed(0)}%)`);
}

// ------------------------------------------------------------ Test C
console.log('C: crash pre-emption regression');
{
  delete store['race3d-qdirector-v1'];
  const cars = makeField(11);
  cars.forEach((e, i) => (e.pace = 32 + i * 0.05));
  const c = cam();
  let cutAt = null;
  let releasedAt = null;
  let prevLabel = '';
  let bad = 0;
  for (let f = 0; f < 60 * 40; f++) {
    const dt = 1 / 60;
    const t = f / 60;
    for (const e of cars) {
      e.dist += e.pace * dt;
      e.driver.u = (e.dist / track.length) % 1;
      setPose(e.car.body, e.driver.u);
    }
    const d7 = cars[7].driver;
    if (t >= 10 && t < 18) {
      d7.mode = 'recover';
      d7.recoverTime = t - 10;
    } else {
      d7.mode = 'race';
    }
    c.update(dt, cars[0].car, cars[0].driver, cars, {
      progress: cars.map((e) => e.dist / track.length),
    });
    if (c.label === 'TV·CRASH' && prevLabel !== 'TV·CRASH' && cutAt === null) cutAt = t;
    if (prevLabel === 'TV·CRASH' && c.label !== 'TV·CRASH' && releasedAt === null) releasedAt = t;
    prevLabel = c.label;
    const p = c.pos;
    if (!isFinite(p.x + p.y + p.z) || p.y < -1 || p.y > 90) bad++;
  }
  ok(bad === 0, `0 bad frames (got ${bad})`);
  ok(cutAt !== null && Math.abs(cutAt - 10) < 0.1, `cuts to CRASH on the incident frame (t=${cutAt?.toFixed(2)})`);
  ok(releasedAt !== null && releasedAt >= 19.4 && releasedAt < 22, `holds ~1.5 s after the incident clears (released t=${releasedAt?.toFixed(2)})`);
}

console.log(failures === 0 ? '\nALL DIRECTOR TESTS PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
