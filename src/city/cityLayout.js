/**
 * City layout: a 5x5 grid of intersections with two-way roads, right-hand
 * traffic. Pure data + math (no three.js) so the headless city-sim test can
 * run the exact same layout as the game.
 *
 * Coordinate frame: +X = east, +Z = south (screen down), Y up.
 * A car's local frame is +X right / +Z forward, so the right side of a
 * forward vector f is r = (f.z, -f.x).
 *
 * Nodes: intersection centres at ((i-2)*PITCH, (j-2)*PITCH), i,j in 0..N-1.
 * Edges: every pair of adjacent nodes shares one road (PITCH m centre to
 * centre; ROAD_HALF on each side).
 *
 * Lane convention (right-hand traffic): a car travelling direction f keeps
 * LANE metres to its right of the road centreline.
 */

export const CITY = {
  n: 5,            // intersections per side
  pitch: 72,       // m between intersection centres (60 m block + 12 m road)
  roadHalf: 6,     // m, half road width
  lane: 1.5,       // m, lane offset from the centreline
  turnR: 10,       // m, cornering radius through an intersection
  edgeStop: 9,     // m before the centre where a straight-through car stops
};

const DIRS = [
  { dx: 1, dz: 0, name: 'E' },
  { dx: 0, dz: 1, name: 'S' },
  { dx: -1, dz: 0, name: 'W' },
  { dx: 0, dz: -1, name: 'N' },
];

export const nodeIndex = (i, j, n = CITY.n) => i + j * n;
export const nodeIdX = (id, n = CITY.n) => id % n;
export const nodeIdY = (id, n = CITY.n) => Math.floor(id / n);

export function nodeName(id) {
  const n = CITY.n;
  return String.fromCharCode(65 + nodeIdX(id, n)) + (nodeIdY(id, n) + 1);
}

export function nodePos(id) {
  const n = CITY.n;
  return {
    x: (nodeIdX(id, n) - (n - 1) / 2) * CITY.pitch,
    z: (nodeIdY(id, n) - (n - 1) / 2) * CITY.pitch,
  };
}

/** The four neighbours of a node (null where the grid ends). */
export function neighbors(id) {
  const n = CITY.n;
  const i = nodeIdX(id, n);
  const j = nodeIdY(id, n);
  const out = [];
  if (i + 1 < n) out.push(nodeIndex(i + 1, j, n));
  if (j + 1 < n) out.push(nodeIndex(i, j + 1, n));
  if (i > 0) out.push(nodeIndex(i - 1, j, n));
  if (j > 0) out.push(nodeIndex(i, j - 1, n));
  return out;
}

/** Unit direction from node a to adjacent node b. */
export function dirBetween(a, b) {
  const pa = nodePos(a);
  const pb = nodePos(b);
  return Math.abs(pb.x - pa.x) > 0.1
    ? { dx: Math.sign(pb.x - pa.x), dz: 0 }
    : { dx: 0, dz: Math.sign(pb.z - pa.z) };
}

const rightOf = (f) => ({ x: f.dz, z: -f.dx });

/** 'S' | 'L' | 'R' for entering a node along fIn and leaving along fOut. */
export function turnType(fIn, fOut) {
  if (fIn.dx === fOut.dx && fIn.dz === fOut.dz) return 'S';
  // 180-degree reversal - NOT a 90 degree turn; the path builder has no
  // arc for it, so routes must avoid U legs (the driver yields/turns 90)
  if (fIn.dx === -fOut.dx && fIn.dz === -fOut.dz) return 'U';
  const cross = fIn.dx * fOut.dz - fIn.dz * fOut.dx;
  return cross > 0 ? 'L' : 'R';
}

/**
 * Traffic lights. Each intersection runs a 16 s cycle:
 *   Z-axis (N-S traffic) green 0-6, yellow 6-8
 *   X-axis (E-W traffic) green 8-14, yellow 14-16
 * with a per-intersection phase offset (checkerboard + jitter) so the grid
 * gets a partial green wave instead of lockstep stops.
 */
export function createCityLights() {
  const n = CITY.n;
  const phase = new Float32Array(n * n);
  // small per-intersection jitter (not a checkerboard!): adjacent
  // intersections stay within ~2 s of each other, so a car running a green
  // keeps finding green one node ahead (partial green wave). A checkerboard
  // offset would flip the phase 8 s per hop and make straight traffic stop
  // at every second light.
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      phase[i + j * n] = (i * 1.3 + j * 2.1) % 8;
    }
  }
  return {
    /** 'green' | 'yellow' | 'red' for a car approaching `node` on `axis`. */
    lightFor(node, axis, t) {
      const c = (t + phase[node]) % 16;
      if (axis === 'Z') return c < 6 ? 'green' : c < 8 ? 'yellow' : 'red';
      return c < 8 ? 'red' : c < 14 ? 'green' : c < 16 ? 'yellow' : 'red';
    },
  };
}

/**
 * Shortest path (in hops) on the grid from `from` to `to`. Optional
 * `skipFirst` excludes one neighbour of `from` from the first step (used to
 * avoid an immediate U-turn after arriving somewhere). Returns the node id
 * sequence INCLUDING both endpoints, or null if unreachable.
 */
export function findPath(from, to, skipFirst = null) {
  const n = CITY.n;
  const total = n * n;
  if (from === to) return [from];
  const dist = new Int32Array(total).fill(999);
  const prev = new Int32Array(total).fill(-1);
  const done = new Uint8Array(total);
  dist[from] = 0;
  for (let step = 0; step < total; step++) {
    let u = -1;
    let best = 999;
    for (let k = 0; k < total; k++) {
      if (!done[k] && dist[k] < best) { best = dist[k]; u = k; }
    }
    if (u < 0 || u === to) break;
    done[u] = 1;
    for (const v of neighbors(u)) {
      if (step === 0 && u === from && v === skipFirst) continue;
      if (dist[u] + 1 < dist[v]) {
        dist[v] = dist[u] + 1;
        prev[v] = u;
      }
    }
  }
  if (dist[to] >= 999) return null;
  const path = [];
  for (let c = to; c >= 0; c = prev[c]) {
    path.push(c);
    if (c === from) break;
  }
  path.reverse();
  return path[0] === from ? path : null;
}

/**
 * Build the dense driving path for a route.
 *
 * `from` is the node the car is currently approaching (the car sits on the
 * lane of the edge leading into `from`, heading `fIn`). The route is
 * from -> ... -> dest, and the path ends at the ENTRY point of `dest`
 * (the car "arrives" there and plans its next route).
 *
 * Returns { px, pz, tx, tz, curv, vprof, s, length, stops, maneuvers, dest }
 * - stops:     [{ s, node, axis }] - where the car must stop for a red light
 * - maneuvers: [{ s, type, node }] - node-centre s, for the turn-signal logic
 */
/**
 * Nearest point on the road network centreline. Returns
 * { x, z, dev, dx, dz } (dev = distance, dx/dz = segment direction) or
 * null when the point is not near any road.
 */
export function nearestRoadPoint(x, z) {
  const n = CITY.n;
  const off = (n - 1) / 2;
  let bx = 0, bz = 0, bdev = Infinity, bdx = 1, bdz = 0, found = false;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n - 1; i++) {
      // horizontal segment: constant z
      const z0 = (j - off) * CITY.pitch;
      const x0 = (i - off) * CITY.pitch;
      const x1 = (i + 1 - off) * CITY.pitch;
      const t = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
      const px = x0 + (x1 - x0) * t;
      const dev = Math.hypot(px - x, z0 - z);
      if (dev < bdev) { bdev = dev; bx = px; bz = z0; bdx = 1; bdz = 0; found = true; }
      // vertical segment: constant x
      const x2 = (i - off) * CITY.pitch;
      const z2 = (j - off) * CITY.pitch;
      const z3 = (j + 1 - off) * CITY.pitch;
      const tv = Math.min(1, Math.max(0, (z - z2) / (z3 - z2)));
      const pz = z2 + (z3 - z2) * tv;
      const devv = Math.hypot(x2 - x, pz - z);
      if (devv < bdev) { bdev = devv; bx = x2; bz = pz; bdx = 0; bdz = 1; found = true; }
    }
  }
  return found ? { x: bx, z: bz, dev: bdev, dx: bdx, dz: bdz } : null;
}

/**
 * Build the driveable path for a route.
 *
 * @param head optional current car heading {dx,dz} (unit). When the car is
 *   off the road and its heading is far from the road-join direction, the
 *   connector starts with a forward turn ARC (radius capped by the space
 *   to the city edge) instead of a straight line - a straight connector
 *   would point backwards and the car (still carrying momentum) could not
 *   swing around in time, so it wander-looped outside the grid while the
 *   off-path replan timer kept rebuilding the same backwards route.
 */
export function buildRoutePath(from, to, x, z, fIn, skipFirst = null, head = null) {
  // skipFirst: the neighbour of `from` the route must not take as its
  // first leg (a 180-degree U-turn back the way we came). The caller
  // picks destinations based on this same constraint, so the builder
  // must honour it too - re-running findPath without it silently
  // rediscovered the U-turn route (same length, different tie-break).
  const seq = findPath(from, to, skipFirst);
  if (!seq) return null;

  const L = CITY.lane;
  const R = CITY.turnR;
  const DS = 0.5;

  // geometry accumulators
  const pts = [];
  const pushPt = (px, pz, kind) => pts.push({ x: px, z: pz, kind });

  // approach: the k=0 connector below runs densely from the car's position
  // to the entry point of seq[0]
  let f = { ...fIn };
  let entryD = seq.length > 1 ? entryDistFor(turnType(f, dirBetween(seq[0], seq[1]))) : CITY.edgeStop;
  pushPt(x, z, 'drive');

  // If the car is off the road, bring the path back ONTO the road first:
  // the straight connector to the node would otherwise cut through the
  // block (buildings) and the car would visibly drive through the city.
  const road = nearestRoadPoint(x, z);
  let RarcCap = 0; // radius of the recovery arc below (0 = none)
  if (road && road.dev > 3) {
    const rj = rightOf(fIn);
    const jx = road.x + rj.x * L;
    const jz = road.z + rj.z * L;
    const d = Math.hypot(jx - x, jz - z);
    let joined = false;
    // RECOVERY ARC: a straight connector only works when the car already
    // faces roughly toward the road join. After a knock the car usually
    // carries momentum AWAY from the road - the straight connector then
    // points backwards, the path follower cannot swing 180 degrees in the
    // off-path window, and the car wander-looped outside the grid while
    // every replan rebuilt the same backwards route. Instead, sweep a
    // forward arc from the car's real heading around to the join; the car
    // follows it from s=0 with a small cross-track and a speed profile
    // matched to the arc radius.
    if (head && d > 5) {
      const jdx = (jx - x) / d;
      const jdz = (jz - z) / d;
      const dot = head.dx * jdx + head.dz * jdz;
      const crs = head.dx * jdz - head.dz * jdx;
      const angL = Math.atan2(crs, dot); // + = join is left of the heading
      if (Math.abs(angL) > 0.9) {
        const sgn = angL > 0 ? 1 : -1; // +1 left turn, -1 right turn
        const A = Math.abs(angL);
        // cap the radius by the space between the car and the city edge
        // (road edge 150 + 6 m margin): the arc bulges toward the
        // bisector of heading and join direction, worst case 2R deep
        const bvx = head.dx + jdx;
        const bvz = head.dz + jdz;
        const bvl = Math.hypot(bvx, bvz);
        const ux = bvx / bvl;
        const uz = bvz / bvl;
        const M = 156;
        let avail = Infinity;
        if (ux > 1e-4) avail = Math.min(avail, (M - x) / ux);
        else if (ux < -1e-4) avail = Math.min(avail, (-M - x) / ux);
        if (uz > 1e-4) avail = Math.min(avail, (M - z) / uz);
        else if (uz < -1e-4) avail = Math.min(avail, (-M - z) / uz);
        const Rarc = Math.min(12, Math.max(2.5, avail / 2));
        RarcCap = Rarc;
        const hx = head.dx;
        const hz = head.dz;
        const nA = Math.max(8, Math.round((Rarc * A) / DS));
        let ax = x;
        let az = z;
        for (let i = 1; i <= nA; i++) {
          const t = A * (i / nA);
          ax = x + Rarc * (hx * Math.sin(t) - sgn * hz * (1 - Math.cos(t)));
          az = z + Rarc * (hz * Math.sin(t) + sgn * hx * (1 - Math.cos(t)));
          const p = { x: ax, z: az, kind: 'turn', arc: true };
          pushPt(ax, az, 'turn');
          pts[pts.length - 1].arc = true;
        }
        // short tangent straight from the arc end to the join point
        const d2j = Math.hypot(jx - ax, jz - az);
        if (d2j > 0.3) {
          const nJ2 = Math.max(1, Math.round(d2j / DS));
          for (let i = 1; i <= nJ2; i++) {
            const t2 = i / nJ2;
            pushPt(ax + (jx - ax) * t2, az + (jz - az) * t2, 'drive');
          }
        }
        joined = true;
      }
    }
    if (!joined) {
      const nJ = Math.max(2, Math.round(d / DS));
      for (let i = 1; i <= nJ; i++) {
        const t = i / nJ;
        pushPt(x + (jx - x) * t, z + (jz - z) * t, 'drive');
      }
    }
  }

  const stops = [];
  const maneuvers = [];

  for (let k = 0; k < seq.length; k++) {
    const A = nodePos(seq[k]);
    const isLast = k === seq.length - 1;
    // entry point of this node on the route (where a red light makes us stop)
    const rin = rightOf(f);
    const entry = {
      x: A.x - f.dx * entryD + rin.x * L,
      z: A.z - f.dz * entryD + rin.z * L,
    };
    stops.push({
      s: -1, // filled below once arc lengths are known
      node: seq[k],
      axis: f.dz !== 0 ? 'Z' : 'X',
      x: entry.x,
      z: entry.z,
    });

    // straight connector from the previous element's end to this entry
    const last = pts[pts.length - 1];
    {
      const d = Math.hypot(entry.x - last.x, entry.z - last.z);
      if (d > 0.3) {
        const nS = Math.max(1, Math.round(d / DS));
        for (let i = 1; i <= nS; i++) {
          const t = i / nS;
          const qx = last.x + (entry.x - last.x) * t;
          const qz = last.z + (entry.z - last.z) * t;
          pushPt(qx, qz, Math.hypot(qx - A.x, qz - A.z) < 8 ? 'node' : 'drive');
        }
      }
    }

    if (isLast) break; // arrival: the path ends at the entry point

    const fOut = dirBetween(seq[k], seq[k + 1]);
    const tt = turnType(f, fOut);
    maneuvers.push({ s: -1, node: seq[k], type: tt, cx: A.x, cz: A.z });

    if (tt === 'U') {
      // defensive: the planner skips 180-degree legs (skipFirst). If one
      // slips through, a single circular arc cannot span a lane-width U,
      // so drive straight through the intersection and let the driver
      // replan at the end of the route.
      const rout = rightOf(f);
      const X = {
        x: A.x + f.dx * CITY.edgeStop + rout.x * L,
        z: A.z + f.dz * CITY.edgeStop + rout.z * L,
      };
      const d = Math.hypot(X.x - entry.x, X.z - entry.z);
      const nS = Math.max(2, Math.round(d / DS));
      for (let i = 1; i <= nS; i++) {
        const t = i / nS;
        const qx = entry.x + (X.x - entry.x) * t;
        const qz = entry.z + (X.z - entry.z) * t;
        pushPt(qx, qz, Math.hypot(qx - A.x, qz - A.z) < 8 ? 'node' : 'drive');
      }
      // f intentionally unchanged (keep the approach direction)
    } else if (tt === 'S') {
      // straight through the intersection along the lane
      const rout = rightOf(fOut);
      const X = {
        x: A.x + fOut.dx * CITY.edgeStop + rout.x * L,
        z: A.z + fOut.dz * CITY.edgeStop + rout.z * L,
      };
      const d = Math.hypot(X.x - entry.x, X.z - entry.z);
      const nS = Math.max(2, Math.round(d / DS));
      for (let i = 1; i <= nS; i++) {
        const t = i / nS;
        const qx = entry.x + (X.x - entry.x) * t;
        const qz = entry.z + (X.z - entry.z) * t;
        pushPt(qx, qz, Math.hypot(qx - A.x, qz - A.z) < 8 ? 'node' : 'drive');
      }
      f = fOut;
    } else {
      // 90 degree turn: circular arc of radius R. entryD === D for both
      // turn types (right: R + lane, left: R - lane), so entry is the arc start.
      const D = tt === 'R' ? R + L : R - L;
      const E = entry;
      const rout = rightOf(fOut);
      const X = { x: A.x + fOut.dx * D + rout.x * L, z: A.z + fOut.dz * D + rout.z * L };
      const O = tt === 'R'
        ? { x: E.x + R * rin.x, z: E.z + R * rin.z }
        : { x: E.x - R * rin.x, z: E.z - R * rin.z };
      const th0 = Math.atan2(E.z - O.z, E.x - O.x);
      const th1 = Math.atan2(X.z - O.z, X.x - O.x);
      let d = th1 - th0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      // keep the quarter arc that bulges away from the arc centre O
      const midX = (E.x + X.x) / 2;
      const midZ = (E.z + X.z) / 2;
      const Mx = O.x + R * Math.cos(th0 + d / 2);
      const Mz = O.z + R * Math.sin(th0 + d / 2);
      if ((Mx - midX) * (O.x - midX) + (Mz - midZ) * (O.z - midZ) > 0) d = -d;
      const arcLen = Math.abs(d) * R;
      const nS = Math.max(8, Math.round(arcLen / DS));
      for (let i = 1; i <= nS; i++) {
        const th = th0 + d * (i / nS);
        pushPt(O.x + R * Math.cos(th), O.z + R * Math.sin(th), 'turn');
      }
      f = fOut;
    }
    entryD = seq[k + 2] !== undefined
      ? entryDistFor(turnType(fOut, dirBetween(seq[k + 1], seq[k + 2])))
      : CITY.edgeStop;
  }

  // build the sample arrays (pts are already densely spaced at ~DS)
  const pts2 = [];
  for (const pt of pts) {
    const l = pts2.length - 1;
    if (l >= 0 && Math.abs(pts2[l].x - pt.x) < 1e-4 && Math.abs(pts2[l].z - pt.z) < 1e-4) {
      if (pt.kind !== 'drive') pts2[l].kind = pt.kind;
      continue;
    }
    pts2.push({ ...pt });
  }
  const n = pts2.length;
  const px = new Float32Array(n);
  const pz = new Float32Array(n);
  const kind = new Uint8Array(n); // 0 drive, 1 node, 2 turn
  let length = 0;
  for (let i = 0; i < n; i++) {
    px[i] = pts2[i].x;
    pz[i] = pts2[i].z;
    kind[i] = pts2[i].kind === 'turn' ? 2 : pts2[i].kind === 'node' ? 1 : 0;
    if (i > 0) length += Math.hypot(px[i] - px[i - 1], pz[i] - pz[i - 1]);
  }
  const tx = new Float32Array(n);
  const tz = new Float32Array(n);
  const curv = new Float32Array(n);
  const vprof = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const dx = px[b] - px[a];
    const dz = pz[b] - pz[a];
    const inv = 1 / Math.max(Math.hypot(dx, dz), 1e-6);
    tx[i] = dx * inv;
    tz[i] = dz * inv;
  }
  for (let i = 1; i < n - 1; i++) {
    const cross = tx[i] * tz[i + 1] - tz[i] * tx[i + 1];
    const seg = Math.hypot(px[i + 1] - px[i], pz[i + 1] - pz[i]);
    curv[i] = seg > 1e-4 ? cross / seg : 0;
  }
  // speed profile: city speeds (m/s). Cruise is kept low enough that a car
  // can always stop inside ~11 m when a light turns red in the approach.
  const V_DRIVE = 8.5;   // ~31 km/h on the straights - leaves room for the
                         // red-light brake profile and keeps knock-ons soft
  const V_NODE = 7.0;    // through an intersection
  const V_TURN = 5.5;    // the cornering arc (~0.3g at R=10 - the tyres can
                         // hold the line, the car does not cut wide)
  const BRAKE = 5.0;     // comfortable deceleration
  for (let i = 0; i < n; i++) {
    vprof[i] = kind[i] === 2 ? V_TURN : kind[i] === 1 ? V_NODE : V_DRIVE;
  }
  // recovery-arc points: the turn speed is set by the ARC radius (a tight
  // 2.5 m hairpin after a deep knock cannot be taken at the 5.5 m/s of
  // the 10 m intersection arcs)
  if (RarcCap > 0) {
    const cap = Math.sqrt(3.5 * RarcCap);
    for (let i = 0; i < n; i++) {
      if (pts2[i].arc) vprof[i] = Math.min(vprof[i], cap);
    }
  }
  for (let i = n - 2; i >= 0; i--) {
    const nxt = vprof[i + 1];
    const ds = Math.hypot(px[i + 1] - px[i], pz[i + 1] - pz[i]);
    vprof[i] = Math.min(vprof[i], Math.sqrt(nxt * nxt + 2 * BRAKE * ds));
  }

  // cumulative s
  const sArr = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    sArr[i] = sArr[i - 1] + Math.hypot(px[i] - px[i - 1], pz[i] - pz[i - 1]);
  }

  // fill stop/maneuver s by nearest sample
  const nearestS = (xq, zq) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < n; i += 2) {
      const dx = px[i] - xq;
      const dz = pz[i] - zq;
      const dd = dx * dx + dz * dz;
      if (dd < bd) { bd = dd; bi = i; }
    }
    return sArr[bi];
  };
  for (const st of stops) st.s = nearestS(st.x, st.z);
  for (const m of maneuvers) {
    m.s = nearestS(m.cx, m.cz);
    delete m.cx;
    delete m.cz;
  }

  return {
    px, pz, tx, tz, curv, vprof, s: sArr, kind,
    n, length, stops, maneuvers,
    dest: { node: to, name: nodeName(to), ...nodePos(to) },
  };
}

function entryDistFor(tt) {
  if (tt === 'S' || tt === 'U') return CITY.edgeStop;
  return tt === 'R' ? CITY.turnR + CITY.lane : CITY.turnR - CITY.lane;
}
