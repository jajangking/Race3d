/**
 * City renderer: ground, road grid, lane markings, crosswalks, sidewalks,
 * buildings and traffic lights for the 5x5 layout in cityLayout.js.
 *
 * Everything is InstancedMesh (roads, dashes, bars, buildings, poles,
 * lenses) so the whole city is a few dozen draw calls.
 *
 * Signal heads sit at the four corners of each intersection, on the corner
 * of the approaching driver's quadrant, facing back at the driver:
 *   (x-8, z-8) faces -X : eastbound approach  (X axis)
 *   (x+8, z+8) faces +X : westbound approach  (X axis)
 *   (x-8, z+8) faces +Z : northbound approach (Z axis)
 *   (x+8, z-8) faces -Z : southbound approach (Z axis)
 */
import * as THREE from 'three';
import { CITY, nodePos } from './cityLayout.js';

const PITCH = CITY.pitch;
const ROAD_HALF = CITY.roadHalf;
const N = CITY.n;

// per-approach data: corner offset from node centre + the traffic axis
const APPROACHES = [
  { ox: -8, oz: -8, nx: -1, nz: 0, axis: 'X' }, // faces -X, eastbound
  { ox: 8, oz: 8, nx: 1, nz: 0, axis: 'X' }, // faces +X, westbound
  { ox: -8, oz: 8, nx: 0, nz: 1, axis: 'Z' }, // faces +Z, northbound
  { ox: 8, oz: -8, nx: 0, nz: -1, axis: 'Z' }, // faces -Z, southbound
];

const C_RED = new THREE.Color(0xff3b30);
const C_YEL = new THREE.Color(0xffc21a);
const C_GRN = new THREE.Color(0x39e07d);
const C_OFF = new THREE.Color(0x181a1c);

export function createCity(scene) {
  const group = new THREE.Group();
  group.name = 'city';

  const totalNodes = N * N;
  const segH = N - 1; // gaps per row

  // ------------------------------------------------------------- materials
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 1 });
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.92 });
  const sideMat = new THREE.MeshStandardMaterial({ color: 0x3d4145, roughness: 0.95 });
  const lineMat = new THREE.MeshBasicMaterial({
    color: 0xe9edf1,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const barMat = new THREE.MeshBasicMaterial({
    color: 0xdfe4ea,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const buildMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.6, metalness: 0.4 });
  const lensMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  const plane = new THREE.PlaneGeometry(1, 1);
  plane.rotateX(-Math.PI / 2); // lies in XZ, +Y up

  const setInstances = (mesh, count) => {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = count;
    return mesh;
  };

  // ---------------------------------------------------------------- ground
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 700).rotateX(-Math.PI / 2), groundMat);
  ground.position.y = 0;
  group.add(ground);

  // -------------------------------------------------------------- sidewalks
  // one slab per block (the 16 cells between the roads)
  const blocks = (N - 1) * (N - 1);
  const sides = setInstances(new THREE.InstancedMesh(plane, sideMat, blocks), blocks);
  {
    const m = new THREE.Matrix4();
    let k = 0;
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const cx = (i - (N - 1) / 2) * PITCH + PITCH / 2;
        const cz = (j - (N - 1) / 2) * PITCH + PITCH / 2;
        m.makeScale(PITCH - 2 * ROAD_HALF, 1, PITCH - 2 * ROAD_HALF);
        m.setPosition(cx, 0.012, cz);
        sides.setMatrixAt(k++, m);
      }
    }
  }
  group.add(sides);

  // ------------------------------------------------------------------ roads
  // 40 segments (60 m long, 12 m wide, ends 6 m short of node centres)
  const roads = setInstances(new THREE.InstancedMesh(plane, roadMat, segH * N * 2), segH * N * 2);
  {
    const m = new THREE.Matrix4();
    let k = 0;
    for (let j = 0; j < N; j++) {
      const z = (j - (N - 1) / 2) * PITCH;
      for (let i = 0; i < N - 1; i++) {
        const x = (i - (N - 1) / 2) * PITCH + PITCH / 2;
        m.makeScale(PITCH - 2 * ROAD_HALF, 1, ROAD_HALF * 2);
        m.setPosition(x, 0.02, z);
        roads.setMatrixAt(k++, m);
      }
    }
    for (let i = 0; i < N; i++) {
      const x = (i - (N - 1) / 2) * PITCH;
      for (let j = 0; j < N - 1; j++) {
        const z = (j - (N - 1) / 2) * PITCH + PITCH / 2;
        m.makeScale(ROAD_HALF * 2, 1, PITCH - 2 * ROAD_HALF);
        m.setPosition(x, 0.02, z);
        roads.setMatrixAt(k++, m);
      }
    }
  }
  group.add(roads);

  // intersection plates (slightly higher so they win over road edges)
  const plates = setInstances(new THREE.InstancedMesh(plane, roadMat, totalNodes), totalNodes);
  {
    const m = new THREE.Matrix4();
    for (let id = 0; id < totalNodes; id++) {
      const p = nodePos(id);
      m.makeScale(ROAD_HALF * 2 + 0.01, 1, ROAD_HALF * 2 + 0.01);
      m.setPosition(p.x, 0.021, p.z);
      plates.setMatrixAt(id, m);
    }
  }
  group.add(plates);

  // ------------------------------------------------------ lane centre dashes
  // 4 m period, 2 m dash, 0.16 m wide
  const DASH = 2, PERIOD = 4, SEG_LEN = PITCH - 2 * ROAD_HALF; // 60
  const perSeg = Math.floor(SEG_LEN / PERIOD); // 15
  const dashes = setInstances(new THREE.InstancedMesh(plane, lineMat, segH * N * 2 * perSeg), segH * N * 2 * perSeg);
  {
    const m = new THREE.Matrix4();
    let k = 0;
    for (let j = 0; j < N; j++) {
      const z = (j - (N - 1) / 2) * PITCH;
      for (let i = 0; i < N - 1; i++) {
        const x0 = (i - (N - 1) / 2) * PITCH + ROAD_HALF;
        for (let d = 0; d < perSeg; d++) {
          m.makeScale(DASH, 1, 0.16);
          m.setPosition(x0 + DASH / 2 + d * PERIOD, 0.035, z);
          dashes.setMatrixAt(k++, m);
        }
      }
    }
    for (let i = 0; i < N; i++) {
      const x = (i - (N - 1) / 2) * PITCH;
      for (let j = 0; j < N - 1; j++) {
        const z0 = (j - (N - 1) / 2) * PITCH + ROAD_HALF;
        for (let d = 0; d < perSeg; d++) {
          m.makeScale(0.16, 1, DASH);
          m.setPosition(x, 0.035, z0 + DASH / 2 + d * PERIOD);
          dashes.setMatrixAt(k++, m);
        }
      }
    }
  }
  dashes.renderOrder = 2;
  group.add(dashes);

  // --------------------------------------------------------------- edge lines
  const edges = setInstances(new THREE.InstancedMesh(plane, lineMat, segH * N * 4), segH * N * 4);
  {
    const m = new THREE.Matrix4();
    let k = 0;
    for (let j = 0; j < N; j++) {
      const z = (j - (N - 1) / 2) * PITCH;
      for (let i = 0; i < N - 1; i++) {
        const x = (i - (N - 1) / 2) * PITCH + PITCH / 2;
        for (const s of [-1, 1]) {
          m.makeScale(SEG_LEN, 1, 0.12);
          m.setPosition(x, 0.035, z + s * (ROAD_HALF - 0.4));
          edges.setMatrixAt(k++, m);
        }
      }
    }
    for (let i = 0; i < N; i++) {
      const x = (i - (N - 1) / 2) * PITCH;
      for (let j = 0; j < N - 1; j++) {
        const z = (j - (N - 1) / 2) * PITCH + PITCH / 2;
        for (const s of [-1, 1]) {
          m.makeScale(0.12, 1, SEG_LEN);
          m.setPosition(x + s * (ROAD_HALF - 0.4), 0.035, z);
          edges.setMatrixAt(k++, m);
        }
      }
    }
  }
  edges.renderOrder = 2;
  group.add(edges);

  // ------------------------------------------------------- crosswalks + stops
  // 4 approaches per node: 6 bars (1.7 x 0.45) at +/-6.5 m, stop bar at 9.5 m
  const crosses = setInstances(new THREE.InstancedMesh(plane, barMat, totalNodes * 4 * 6), totalNodes * 4 * 6);
  const stopsBar = setInstances(new THREE.InstancedMesh(plane, barMat, totalNodes * 4), totalNodes * 4);
  {
    const m = new THREE.Matrix4();
    let kc = 0;
    let ks = 0;
    for (let id = 0; id < totalNodes; id++) {
      const p = nodePos(id);
      // eastbound stop on the -X side, bars span z
      for (let b = 0; b < 6; b++) {
        m.makeScale(0.45, 1, 1.7);
        m.setPosition(p.x - 6.5, 0.035, p.z + (b - 2.5) * 2);
        crosses.setMatrixAt(kc++, m);
      }
      m.makeScale(0.35, 1, 5.5);
      m.setPosition(p.x - 9.5, 0.035, p.z - 2.25);
      stopsBar.setMatrixAt(ks++, m);
      // westbound
      for (let b = 0; b < 6; b++) {
        m.makeScale(0.45, 1, 1.7);
        m.setPosition(p.x + 6.5, 0.035, p.z + (b - 2.5) * 2);
        crosses.setMatrixAt(kc++, m);
      }
      m.makeScale(0.35, 1, 5.5);
      m.setPosition(p.x + 9.5, 0.035, p.z + 2.25);
      stopsBar.setMatrixAt(ks++, m);
      // northbound (coming from +Z, lane on -X side)
      for (let b = 0; b < 6; b++) {
        m.makeScale(1.7, 1, 0.45);
        m.setPosition(p.x + (b - 2.5) * 2, 0.035, p.z + 6.5);
        crosses.setMatrixAt(kc++, m);
      }
      m.makeScale(5.5, 1, 0.35);
      m.setPosition(p.x - 2.25, 0.035, p.z + 9.5);
      stopsBar.setMatrixAt(ks++, m);
      // southbound
      for (let b = 0; b < 6; b++) {
        m.makeScale(1.7, 1, 0.45);
        m.setPosition(p.x + (b - 2.5) * 2, 0.035, p.z - 6.5);
        crosses.setMatrixAt(kc++, m);
      }
      m.makeScale(5.5, 1, 0.35);
      m.setPosition(p.x + 2.25, 0.035, p.z - 9.5);
      stopsBar.setMatrixAt(ks++, m);
    }
  }
  crosses.renderOrder = 2;
  stopsBar.renderOrder = 2;
  group.add(crosses, stopsBar);

  // --------------------------------------------------------------- buildings
  const BUILD_N = 64;
  const builds = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), buildMat, BUILD_N);
  {
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    // deterministic-ish variety
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const palette = [0x4a4f58, 0x5a6069, 0x6a7078, 0x77706a, 0x59626e, 0x8a8578, 0x46525e, 0x9a9484];
    let k = 0;
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const bx = (i - (N - 1) / 2) * PITCH;
        const bz = (j - (N - 1) / 2) * PITCH;
        for (let sxx = 0; sxx < 2; sxx++) {
          for (let szz = 0; szz < 2; szz++) {
            const lotCx = bx + 6 + 15 + sxx * 30;
            const lotCz = bz + 6 + 15 + szz * 30;
            if (rnd() < 0.18) continue; // open lot / plaza
            const w = 10 + rnd() * 10;
            const d = 10 + rnd() * 10;
            const h = 8 + rnd() * 37;
            const ox = lotCx + (rnd() - 0.5) * (30 - w - 4);
            const oz = lotCz + (rnd() - 0.5) * (30 - d - 4);
            m.makeScale(w, h, d);
            m.setPosition(ox, h / 2 + 0.02, oz);
            builds.setMatrixAt(k, m);
            c.setHex(palette[Math.floor(rnd() * palette.length)]);
            c.multiplyScalar(0.85 + rnd() * 0.3);
            builds.setColorAt(k, c);
            k++;
          }
        }
      }
    }
    builds.count = k;
    if (builds.instanceColor) builds.instanceColor.needsUpdate = true;
  }
  group.add(builds);

  // -------------------------------------------------------- traffic light poles
  const poles = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.09, 0.09, 3.2, 8), poleMat, totalNodes * 4,
  );
  const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.66, 0.16), poleMat, totalNodes * 4);
  {
    const m = new THREE.Matrix4();
    let k = 0;
    for (let id = 0; id < totalNodes; id++) {
      const p = nodePos(id);
      for (const a of APPROACHES) {
        m.identity();
        m.setPosition(p.x + a.ox, 1.6, p.z + a.oz);
        poles.setMatrixAt(k, m);
        m.identity();
        m.setPosition(p.x + a.ox + a.nx * 0.08, 2.98, p.z + a.oz + a.nz * 0.08);
        heads.setMatrixAt(k, m);
        k++;
      }
    }
  }
  group.add(poles, heads);

  // lenses: R (top) / Y (mid) / G (bottom) - one InstancedMesh per colour
  const lensGeo = new THREE.SphereGeometry(0.085, 10, 8);
  const lensR = new THREE.InstancedMesh(lensGeo, lensMat, totalNodes * 4);
  const lensY = new THREE.InstancedMesh(lensGeo, lensMat, totalNodes * 4);
  const lensG = new THREE.InstancedMesh(lensGeo, lensMat, totalNodes * 4);
  const headState = new Array(totalNodes * 4);
  {
    const m = new THREE.Matrix4();
    let k = 0;
    for (let id = 0; id < totalNodes; id++) {
      const p = nodePos(id);
      for (const a of APPROACHES) {
        const hx = p.x + a.ox + a.nx * 0.17;
        const hz = p.z + a.oz + a.nz * 0.17;
        m.identity();
        m.setPosition(hx, 3.1, hz);
        lensR.setMatrixAt(k, m);
        m.setPosition(hx, 2.98, hz);
        lensY.setMatrixAt(k, m);
        m.setPosition(hx, 2.86, hz);
        lensG.setMatrixAt(k, m);
        headState[k] = { node: id, axis: a.axis, state: null, k };
        k++;
      }
    }
  }
  lensR.renderOrder = 3;
  lensY.renderOrder = 3;
  lensG.renderOrder = 3;
  group.add(lensR, lensY, lensG);

  group.traverse((o) => {
    if (o.isInstancedMesh) o.frustumCulled = false;
  });

  // ------------------------------------------------------------ light updates
  const _col = new THREE.Color();
  let lights = null;
  let lastT = -1e9;
  const updateLights = (cityLights, t) => {
    if (!lights) {
      lights = cityLights;
      lensR.setColorAt(0, C_OFF);
      lensY.setColorAt(0, C_OFF);
      lensG.setColorAt(0, C_OFF);
      for (let k = 0; k < headState.length; k++) {
        _col.copy(C_OFF);
        lensR.setColorAt(k, _col);
        lensY.setColorAt(k, _col);
        lensG.setColorAt(k, _col);
      }
    }
    if (Math.abs(t - lastT) < 1e-4) return;
    lastT = t;
    for (const h of headState) {
      const state = lights.lightFor(h.node, h.axis, t);
      if (state === h.state) continue;
      h.state = state;
      _col.copy(state === 'red' ? C_RED : C_OFF);
      lensR.setColorAt(h.k, _col);
      _col.copy(state === 'yellow' ? C_YEL : C_OFF);
      lensY.setColorAt(h.k, _col);
      _col.copy(state === 'green' ? C_GRN : C_OFF);
      lensG.setColorAt(h.k, _col);
    }
    lensR.instanceColor.needsUpdate = true;
    lensY.instanceColor.needsUpdate = true;
    lensG.instanceColor.needsUpdate = true;
  };

  scene.add(group);
  return {
    group,
    updateLights,
    nodes: totalNodes,
  };
}
