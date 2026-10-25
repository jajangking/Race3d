import * as THREE from 'three';

/**
 * Build a racing line and a speed profile for a closed track.
 *
 * The centreline is a safe but slow place to drive. This planner finds a
 * shorter line inside the road corridor with a smoothness penalty, which
 * naturally produces the classic outside-inside-outside line through corners
 * instead of a car glued to the middle. It then bakes a grip-limited speed
 * profile with a backwards braking pass, so the AI knows to brake before a
 * corner rather than while already in it.
 *
 * The result is cached on the track and shared by every car, so ten
 * opponents cost one plan, not ten.
 */

const N = 600;                 // samples around the lap (~2.2 m at this track)
const HALF_WIDTH = 4.30;       // metres from centreline, road half width is 7
const OFFSET_STEPS = 17;       // lateral candidates, 0.54 m apart
const SMOOTH_PENALTY = 0.35;   // discourages zig-zagging between candidates
const CENTRE_BIAS = 0.0035;    // stay near the middle unless a corner needs width
const SMOOTH_PASSES = 3;
const SMOOTH_RADIUS = 14;
const LINE_STRENGTH = 1.0;    // keep the line close to the centreline; the
                               // shortest path alone cuts too tightly through
                               // this track's long, constant-radius bends

const LAT_GRIP_G = 1.4;       // used lateral grip, tyres peak around 1.45 g
const BRAKE_MS2 = 9.0;
const MAX_SPEED_MS = 205 / 3.6;

export function buildRacingLine(track) {
  if (track._aiLine) return track._aiLine;

  const curve = track.curve;
  const length = track.length;
  const ds = length / N;

  const offs = new Float32Array(OFFSET_STEPS);
  for (let j = 0; j < OFFSET_STEPS; j++) {
    offs[j] = -HALF_WIDTH + (2 * HALF_WIDTH * j) / (OFFSET_STEPS - 1);
  }

  const cx = new Float64Array(N);
  const cz = new Float64Array(N);
  const nx = new Float64Array(N);
  const nz = new Float64Array(N);
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    curve.getPointAt(i / N, p);
    curve.getTangentAt(i / N, t);
    const inv = 1 / Math.max(Math.hypot(t.x, t.z), 1e-6);
    cx[i] = p.x;
    cz[i] = p.z;
    nx[i] = t.z * inv;
    nz[i] = -t.x * inv;
  }

  // Dynamic programming for a closed path through the corridor. parents is
  // [start][sample][offset] and only stores one byte per node.
  const parents = new Int8Array(OFFSET_STEPS * N * OFFSET_STEPS).fill(-1);
  const dp = new Float64Array(OFFSET_STEPS);
  const ndp = new Float64Array(OFFSET_STEPS);
  let bestCost = Infinity;
  let bestStart = 0;
  let bestEnd = 0;

  // Bias the optimiser to start in the middle of the road at the start/finish.
  // The grid is laid out symmetrically around the centreline there; letting it
  // choose a 3 m outside start made both columns converge across the road on
  // the first corner, which is where most of the field's early contact and
  // off-track excursions came from.
  const START_OFFSET = (OFFSET_STEPS - 1) >> 1;
  for (let s = START_OFFSET; s <= START_OFFSET; s++) {
    dp.fill(Infinity);
    dp[s] = 0;

    for (let i = 1; i < N; i++) {
      ndp.fill(Infinity);
      const cxi = cx[i];
      const czi = cz[i];
      const nxi = nx[i];
      const nzi = nz[i];
      const pcx = cx[i - 1];
      const pcz = cz[i - 1];
      const pnx = nx[i - 1];
      const pnz = nz[i - 1];
      const parentBase = (s * N + i) * OFFSET_STEPS;

      for (let j = 0; j < OFFSET_STEPS; j++) {
        const oj = offs[j];
        const xj = cxi + nxi * oj;
        const zj = czi + nzi * oj;
        const nodeCost = CENTRE_BIAS * oj * oj;
        let best = Infinity;
        let bestK = -1;
        for (let k = 0; k < OFFSET_STEPS; k++) {
          const prev = dp[k];
          if (prev === Infinity) continue;
          const ok = offs[k];
          const dx = xj - (pcx + pnx * ok);
          const dz = zj - (pcz + pnz * ok);
          const cost = prev + Math.sqrt(dx * dx + dz * dz)
            + SMOOTH_PENALTY * (oj - ok) * (oj - ok)
            + nodeCost;
          if (cost < best) {
            best = cost;
            bestK = k;
          }
        }
        ndp[j] = best;
        if (bestK >= 0) parents[parentBase + j] = bestK;
      }
      dp.set(ndp);
    }

    // close the loop back to the chosen starting offset
    for (let j = 0; j < OFFSET_STEPS; j++) {
      if (dp[j] === Infinity) continue;
      const os = offs[s];
      const dx = (cx[0] + nx[0] * os) - (cx[N - 1] + nx[N - 1] * offs[j]);
      const dz = (cz[0] + nz[0] * os) - (cz[N - 1] + nz[N - 1] * offs[j]);
      const cost = dp[j] + Math.hypot(dx, dz)
        + SMOOTH_PENALTY * (os - offs[j]) * (os - offs[j])
        + CENTRE_BIAS * os * os;
      if (cost < bestCost) {
        bestCost = cost;
        bestStart = s;
        bestEnd = j;
      }
    }
  }

  const path = new Int8Array(N);
  path[N - 1] = bestEnd;
  let j = bestEnd;
  for (let i = N - 1; i > 0; i--) {
    j = parents[(bestStart * N + i) * OFFSET_STEPS + j];
    path[i - 1] = j;
  }

  let offsets = new Float32Array(N);
  for (let i = 0; i < N; i++) offsets[i] = offs[path[i]];

  // Relax the DP result. The shortest path is a good geometric base but has
  // abrupt direction changes at corner entry; a short circular blur makes the
  // line smooth enough to track at racing speed.
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const src = offsets.slice();
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let k = -SMOOTH_RADIUS; k <= SMOOTH_RADIUS; k++) {
        sum += src[(i + k + N) % N];
      }
      offsets[i] = sum / (SMOOTH_RADIUS * 2 + 1);
    }
  }
  for (let i = 0; i < N; i++) {
    offsets[i] = Math.max(-HALF_WIDTH, Math.min(HALF_WIDTH, offsets[i])) * LINE_STRENGTH;
  }

  const lx = new Float64Array(N);
  const lz = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    lx[i] = cx[i] + nx[i] * offsets[i];
    lz[i] = cz[i] + nz[i] * offsets[i];
  }

  // The Catmull-Rom track has a few very short, very tight corners (down to
  // R~12 m at the sample resolution). Measuring curvature on the 2.2 m AI
  // samples blurs those peaks out, so build a 4x-resolution copy of the line
  // and take the worst curvature inside each AI sample. The signed value
  // drives steering feed-forward: positive is a left-hand bend.
  const M = N * 4;
  const hcx = curve.getSpacedPoints(M);
  const hx = new Float64Array(M);
  const hz = new Float64Array(M);
  for (let j = 0; j < M; j++) {
    const t = (j / M) * N;
    const i0 = Math.floor(t) % N;
    const i1 = (i0 + 1) % N;
    const f = t - Math.floor(t);
    const off = offsets[i0] + (offsets[i1] - offsets[i0]) * f;
    const p0 = hcx[(j - 1 + M) % M];
    const p1 = hcx[(j + 1) % M];
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const inv = 1 / Math.max(Math.hypot(dx, dz), 1e-6);
    const nrx = dz * inv;
    const nrz = -dx * inv;
    hx[j] = hcx[j].x + nrx * off;
    hz[j] = hcx[j].z + nrz * off;
  }
  const kHigh = new Float64Array(M);
  const hds = length / M;
  for (let j = 0; j < M; j++) {
    const a = (j - 2 + M) % M;
    const b = (j + 2) % M;
    const v1x = hx[j] - hx[a];
    const v1z = hz[j] - hz[a];
    const v2x = hx[b] - hx[j];
    const v2z = hz[b] - hz[j];
    const angle = Math.atan2(v1x * v2z - v1z * v2x, v1x * v2x + v1z * v2z);
    kHigh[j] = angle / (2 * hds);
  }
  const curvature = new Float32Array(N);
  const curvatureSigned = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let peak = 0;
    let signed = 0;
    const base = i * 4;
    for (let q = 0; q < 4; q++) signed += kHigh[base + q];
    curvatureSigned[i] = signed / 4;
    for (let q = -2; q < 6; q++) {
      peak = Math.max(peak, Math.abs(kHigh[(base + q + M) % M]));
    }
    curvature[i] = peak;
  }
  // A final short max window keeps a corner from slipping between samples.
  const curvaturePeak = curvature.slice();
  for (let i = 0; i < N; i++) {
    let peak = 0;
    for (let k = -2; k <= 2; k++) peak = Math.max(peak, curvaturePeak[(i + k + N) % N]);
    curvature[i] = peak;
  }

  // Direction of the racing line itself. The car follows a path offset from
  // the centreline, so its tangent is not exactly the centreline tangent.
  const tanX = new Float32Array(N);
  const tanZ = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - 1 + N) % N;
    const b = (i + 1) % N;
    const dx = lx[b] - lx[a];
    const dz = lz[b] - lz[a];
    const inv = 1 / Math.max(Math.hypot(dx, dz), 1e-6);
    tanX[i] = dx * inv;
    tanZ[i] = dz * inv;
  }

  const speed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const vCorner = Math.sqrt((LAT_GRIP_G * 9.81) / Math.max(curvature[i], 1e-6));
    speed[i] = Math.min(MAX_SPEED_MS, vCorner);
  }
  // Two passes because the loop is closed and braking can span the start line.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = N - 1; i >= 0; i--) {
      const next = speed[(i + 1) % N];
      speed[i] = Math.min(speed[i], Math.sqrt(next * next + 2 * BRAKE_MS2 * ds));
    }
  }

  track._aiLine = {
    n: N,
    length,
    offsets,
    curvature,
    curvatureSigned,
    tanX,
    tanZ,
    speed,
  };
  return track._aiLine;
}

/** Linear lookup in a circular per-sample array. */
export function sampleLine(arr, u) {
  const n = arr.length;
  let x = u * n;
  x -= Math.floor(x / n) * n;
  const i = Math.floor(x);
  const f = x - i;
  const a = arr[i];
  const b = arr[i + 1 === n ? 0 : i + 1];
  return a + (b - a) * f;
}
