import * as THREE from 'three';
import { buildRacingLine } from '../ai/racingLine.js';
import { buildTrackCurve } from '../trackLayout.js';

/**
 * Circuit + road surface. The physics is a single flat ground plane;
 * everything here is visual, which keeps the collider count at one and the
 * frame rate high on a phone.
 */

export const ROAD_HALF_WIDTH = 7;

/**
 * Flat ribbon following `curve`, offset sideways, with a constant width.
 * Returns a geometry in world space at height y.
 */
export function ribbon(curve, segments, offset, width, y, tile = 0, closed = true) {
  const pos = [];
  const uv = [];
  const nor = [];
  const idx = [];
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  const side = new THREE.Vector3();
  let dist = 0;
  let prev = null;

  for (let i = 0; i <= segments; i++) {
    const u = closed ? (i / segments) % 1 : i / segments;
    curve.getPointAt(u, p);
    curve.getTangentAt(u, t);
    side.set(t.z, 0, -t.x).normalize();

    if (prev) dist += p.distanceTo(prev);
    prev = prev ? prev.copy(p) : p.clone();

    const cx = p.x + side.x * offset;
    const cz = p.z + side.z * offset;
    const half = side.clone().multiplyScalar(width / 2);
    pos.push(cx - half.x, y, cz - half.z);
    pos.push(cx + half.x, y, cz + half.z);
    nor.push(0, 1, 0, 0, 1, 0);
    if (tile > 0) {
      const v = dist / tile;
      uv.push(offset / tile, v, (offset + width) / tile, v);
    } else {
      uv.push(0, u * 8, 1, u * 8);
    }

    if (i < segments) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/* ------------------------------------------------------------------ tex */

function noiseTexture(size, base, spread, dots = 9000) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < dots; i++) {
    const a = Math.random() * spread;
    const r = Math.random();
    g.fillStyle = `rgba(${r > 0.5 ? 255 : 0}, ${r > 0.5 ? 255 : 0}, ${r > 0.5 ? 255 : 0}, ${a})`;
    const s = 1 + Math.random() * 2.2;
    g.fillRect(Math.random() * size, Math.random() * size, s, s);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Asphalt: dark, low-contrast macadam with longitudinal tyre-wear bands.
 *  The old bright, heavily-speckled read like gravel/dirt, so the base is
 *  much darker, the speckle is sparse and dark-biased, and a few wide dark
 *  rubber bands sell the "used tarmac" look. */
function asphaltTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#232529';
  g.fillRect(0, 0, 512, 512);
  // sparse, dark-biased aggregate speckle (little highlight = no gravel look)
  for (let i = 0; i < 7000; i++) {
    const light = Math.random() > 0.72;
    const a = light ? Math.random() * 0.05 : Math.random() * 0.16;
    g.fillStyle = light
      ? `rgba(160, 165, 175, ${a})`
      : `rgba(0, 0, 0, ${a})`;
    const s = 1 + Math.random() * 1.4;
    g.fillRect(Math.random() * 512, Math.random() * 512, s, s);
  }
  // soft coarse patches, mostly darkening
  for (let i = 0; i < 380; i++) {
    const light = Math.random() > 0.7;
    const a = Math.random() * (light ? 0.035 : 0.09);
    g.fillStyle = light ? `rgba(150, 155, 165, ${a})` : `rgba(0, 0, 0, ${a})`;
    const s = 6 + Math.random() * 26;
    g.fillRect(Math.random() * 512, Math.random() * 512, s, s * (0.4 + Math.random()));
  }
  // wide dark rubber bands (where the field runs), canvas Y = along the road
  for (let i = 0; i < 5; i++) {
    const x = 40 + Math.random() * 432;
    const w = 18 + Math.random() * 40;
    const a = 0.10 + Math.random() * 0.12;
    const grad = g.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(0.35, `rgba(0, 0, 0, ${a})`);
    grad.addColorStop(0.65, `rgba(0, 0, 0, ${a})`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.fillStyle = grad;
    g.fillRect(x, 0, w, 512);
  }
  // thin longitudinal wear streaks
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * 512;
    const w = 1 + Math.random() * 2.5;
    const dark = Math.random() > 0.3;
    g.fillStyle = dark
      ? `rgba(0, 0, 0, ${0.04 + Math.random() * 0.07})`
      : `rgba(140, 145, 152, ${0.02 + Math.random() * 0.03})`;
    g.fillRect(x, 0, w, 512);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Grayscale streaks for the rubber racing line (tinted by the material). */
function rubberTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255, 255, 255, 0.55)';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * 128;
    const w = 1 + Math.random() * 2.5;
    g.fillStyle = `rgba(0, 0, 0, ${0.25 + Math.random() * 0.5})`;
    g.fillRect(x, 0, w, 128);
  }
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * 128;
    const w = 1 + Math.random() * 2;
    g.fillStyle = `rgba(255, 255, 255, ${0.15 + Math.random() * 0.3})`;
    g.fillRect(x, 0, w, 128);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Dashed centre line: white bar with a transparent gap. */
function dashTexture() {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 64;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 32, 64);
  g.fillStyle = '#e9edf1';
  g.fillRect(0, 0, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function checkerTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  const n = 8;
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 === 0 ? '#f2f2f2' : '#101010';
      g.fillRect((x * 256) / n, (y * 64) / 2, 256 / n, 32);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Starting grid boxes painted on the tarmac: 2 columns x 6 rows, matching
 * the game grid (12 m rows, +/-3 m columns). The canvas top ends up behind
 * the start line, so rows grow towards the bottom of the canvas.
 */
function gridTexture() {
  const W = 256;
  const H = 1376; // 16 px per metre
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgba(235, 240, 246, 0.85)';
  g.lineWidth = 5;
  const boxW = 4.6 * 16; // 73.6 px
  const boxH = 9.5 * 16; // 152 px
  for (let row = 0; row < 6; row++) {
    const d = (row + 1) * 12; // metres ahead of the line
    const cols = row < 5 ? [-3, 3] : [-3]; // 11th car alone on the last row
    for (const lat of cols) {
      const cx = (lat + 8) * 16;
      const cy = (d + 6) * 16;
      g.strokeRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** F1-style five-light board. */
function startLightsTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#0c0e12';
  g.fillRect(0, 0, 512, 128);
  g.fillStyle = '#171a20';
  g.fillRect(8, 8, 496, 112);
  for (let i = 0; i < 5; i++) {
    const x = 64 + i * 96;
    const grad = g.createRadialGradient(x, 64, 4, x, 64, 40);
    grad.addColorStop(0, '#ff8d80');
    grad.addColorStop(0.45, '#ff1f1f');
    grad.addColorStop(1, '#5c0505');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, 64, 40, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* -------------------------------------------------------------- track */

export function createTrack(scene) {
  const group = new THREE.Group();
  scene.add(group);

  // ---------------------------------------------------------------- ground
  const groundTex = noiseTexture(512, '#414d36', 0.16, 12000);
  groundTex.repeat.set(160, 160);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(8000, 8000),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  // ------------------------------------------------------------------ road
  const curve = buildTrackCurve();
  const length = curve.getLength();
  const segments = Math.min(1600, Math.max(500, Math.round(length / 2.2)));

  const asphalt = asphaltTexture();
  const road = new THREE.Mesh(
    ribbon(curve, segments, 0, ROAD_HALF_WIDTH * 2, 0.02, 7),
    new THREE.MeshStandardMaterial({
      map: asphalt,
      roughness: 0.93,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );
  road.receiveShadow = true;
  group.add(road);

  // shared track plan (racing line + curvature profile)
  const track = { curve, length };
  const line = buildRacingLine(track);

  // --- Z-fighting strategy ---------------------------------------------------
  // The chase camera has near=0.3 / far~6000, so depth precision a few metres
  // ahead is in the millimetres. Road markings only a few mm above the asphalt
  // would flicker in and out of the depth test as the car moves ("lines only
  // visible when the car passes"). We render every painted layer as a decal:
  // depthWrite:false (so it never loses a tie) + an explicit renderOrder (so
  // layering is deterministic). They still depth-TEST, so wheels, cones and
  // the car correctly occlude them.

  // worn rubber racing line baked onto the tarmac
  {
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    const linePts = [];
    for (let i = 0; i < line.n; i++) {
      curve.getPointAt(i / line.n, p);
      curve.getTangentAt(i / line.n, t);
      const inv = 1 / Math.max(Math.hypot(t.x, t.z), 1e-6);
      const nx = t.z * inv;
      const nz = -t.x * inv;
      linePts.push(new THREE.Vector3(p.x + nx * line.offsets[i], 0, p.z + nz * line.offsets[i]));
    }
    const lineCurve = new THREE.CatmullRomCurve3(linePts, true, 'catmullrom', 0.5);
    const rubber = new THREE.Mesh(
      ribbon(lineCurve, 900, 0, 2.7, 0.03, 5.5),
      new THREE.MeshBasicMaterial({
        map: rubberTexture(),
        color: 0x111214,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
    );
    rubber.renderOrder = 1;
    group.add(rubber);
  }

  // white edge lines
  // The asphalt carries polygonOffset(-1,-1) (to beat the grass below it),
  // which pushes its depth toward the camera and can steal the depth test
  // from markings only a couple of cm above it. Every painted layer gets a
  // stronger -3 offset so it is guaranteed to win that fight at any range.
  const lineMat = new THREE.MeshStandardMaterial({
    color: 0xd8dde2,
    roughness: 0.7,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  lineMat.depthWrite = false;
  for (const s of [-1, 1]) {
    const line = new THREE.Mesh(
      ribbon(curve, segments, s * (ROAD_HALF_WIDTH - 0.45), 0.16, 0.036),
      lineMat,
    );
    line.renderOrder = 3;
    group.add(line);
  }

  // centre dashes
  {
    const dashTex = dashTexture();
    const dash = new THREE.Mesh(
      ribbon(curve, segments, 0, 0.14, 0.032, 9),
      new THREE.MeshStandardMaterial({
        map: dashTex,
        transparent: true,
        opacity: 0.45,
        roughness: 0.8,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
    );
    dash.renderOrder = 2;
    group.add(dash);
  }

  // ------------------------------------------------------- start/finish line
  const start = curve.getPointAt(0);
  const startTan = curve.getTangentAt(0);
  const startQuat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    startTan.clone().setY(0).normalize(),
  );
  const rotY = Math.atan2(startTan.x, startTan.z);

  {
    const chk = checkerTexture();
    chk.repeat.set(7, 1);
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_HALF_WIDTH * 2, 2.2),
      new THREE.MeshStandardMaterial({
        map: chk,
        roughness: 0.7,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
    );
    line.material.depthWrite = false;
    line.renderOrder = 5; // painted over the lane lines at the start line
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = rotY;
    line.position.set(start.x, 0.045, start.z);
    group.add(line);
  }

  // painted starting grid boxes
  {
    const grid = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 86),
      new THREE.MeshBasicMaterial({
        map: gridTexture(),
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
    );
    grid.rotation.x = -Math.PI / 2;
    grid.rotateY(rotY);
    grid.position.set(start.x + startTan.x * 38, 0.05, start.z + startTan.z * 38);
    grid.renderOrder = 6;
    group.add(grid);
  }

  // gantry: posts + beam + F1 light board + banner
  {
    const steel = new THREE.MeshStandardMaterial({ color: 0x2b3037, roughness: 0.45, metalness: 0.8 });
    const side = new THREE.Vector3(startTan.z, 0, -startTan.x).normalize();
    const post = (s) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.36, 7.6, 0.36), steel);
      m.position.set(start.x + s.x * 9.4, 3.8, start.z + s.z * 9.4);
      m.castShadow = true;
      return m;
    };
    group.add(post(side));
    group.add(post(side.clone().negate()));

    const beam = new THREE.Mesh(new THREE.BoxGeometry(19.2, 0.5, 0.5), steel);
    beam.position.set(start.x, 7.2, start.z);
    beam.rotation.y = rotY + Math.PI / 2;
    beam.castShadow = true;
    group.add(beam);

    // F1-style five-light board under the beam, facing the incoming cars
    const lights = new THREE.Mesh(
      new THREE.PlaneGeometry(3.1, 0.78),
      new THREE.MeshStandardMaterial({
        map: startLightsTexture(),
        emissive: new THREE.Color(0xff2b20),
        emissiveMap: startLightsTexture(),
        emissiveIntensity: 0.85,
        roughness: 0.5,
        side: THREE.DoubleSide,
      }),
    );
    lights.position.set(start.x - startTan.x * 0.7, 6.55, start.z - startTan.z * 0.7);
    lights.rotation.y = rotY + Math.PI;
    group.add(lights);

    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 1024, 0);
    grad.addColorStop(0, '#14060a');
    grad.addColorStop(0.5, '#1b0a0e');
    grad.addColorStop(1, '#14060a');
    g.fillStyle = grad;
    g.fillRect(0, 0, 1024, 256);
    g.fillStyle = '#ff2f2f';
    g.font = '900 150px Inter, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('RACE3D', 512, 138);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 236, 1024, 8);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;

    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(19, 4.2),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, side: THREE.DoubleSide }),
    );
    banner.position.set(start.x, 4.6, start.z);
    banner.rotation.y = rotY + Math.PI;
    group.add(banner);
  }

  // ---------------------------------------------------------------- scenery
  // Cones along the outside of the road edge, instanced.
  {
    const coneGeo = new THREE.ConeGeometry(0.22, 0.52, 8);
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.65 });
    const baseGeo = new THREE.BoxGeometry(0.42, 0.05, 0.42);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.9 });

    const step = 14;
    const count = Math.floor(length / step) * 2;
    const cones = new THREE.InstancedMesh(coneGeo, coneMat, count);
    const bases = new THREE.InstancedMesh(baseGeo, baseMat, count);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    const side = new THREE.Vector3();
    let i = 0;
    for (let d = 0; d < length && i < count; d += step) {
      const u = d / length;
      curve.getPointAt(u, p);
      curve.getTangentAt(u, t);
      side.set(t.z, 0, -t.x).normalize();
      for (const s of [-1, 1]) {
        if (i >= count) break;
        const x = p.x + side.x * s * (ROAD_HALF_WIDTH + 2.4);
        const z = p.z + side.z * s * (ROAD_HALF_WIDTH + 2.4);
        m.makeTranslation(x, 0.28, z);
        cones.setMatrixAt(i, m);
        m.makeTranslation(x, 0.03, z);
        bases.setMatrixAt(i, m);
        i++;
      }
    }
    cones.count = i;
    bases.count = i;
    cones.castShadow = true;
    group.add(cones, bases);
  }

  return {
    group,
    curve,
    length,
    start,
    startQuat,
    startTangent: startTan,
    racingLine: line,
  };
}
