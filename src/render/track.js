import * as THREE from 'three';

/**
 * Circuit + environment. The physics is a single flat ground plane; everything
 * here is visual, which keeps the collider count at one and the frame rate high
 * on a phone.
 */

export const ROAD_HALF_WIDTH = 7;

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

/** Alternating red/white bands along the V axis (kerbs run along the road). */
function kerbTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#e9e9e9';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#c81c1c';
  g.fillRect(0, 0, 64, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
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
 * Flat ribbon following `curve`, offset sideways, with a constant width.
 * Returns a geometry in world space at height y.
 */
function ribbon(curve, segments, offset, width, y, tile = 0) {
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
    const u = i / segments;
    curve.getPointAt(u % 1, p);
    curve.getTangentAt(u % 1, t);
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

function buildCurve() {
  const pts = [];
  const N = 18;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 158 + 46 * Math.sin(3 * a + 0.4) + 20 * Math.sin(5 * a + 1.1);
    pts.push(new THREE.Vector3(Math.cos(a) * r * 1.28, 0, Math.sin(a) * r * 0.82));
  }
  return new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
}

export function createTrack(scene) {
  const group = new THREE.Group();
  scene.add(group);

  // ---------------------------------------------------------------- ground
  const groundTex = noiseTexture(512, '#46523a', 0.16, 12000);
  groundTex.repeat.set(160, 160);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(8000, 8000),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  // ------------------------------------------------------------------ road
  const curve = buildCurve();
  const length = curve.getLength();
  const segments = Math.min(1400, Math.max(500, Math.round(length / 2.5)));

  const asphalt = noiseTexture(512, '#33353a', 0.13, 16000);
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

  // white edge lines
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.7 });
  for (const s of [-1, 1]) {
    const line = new THREE.Mesh(
      ribbon(curve, segments, s * (ROAD_HALF_WIDTH - 0.45), 0.16, 0.035),
      lineMat,
    );
    group.add(line);
  }

  // centre dashes
  {
    const dashTex = dashTexture();
    const dash = new THREE.Mesh(
      ribbon(curve, segments, 0, 0.14, 0.033, 9),
      new THREE.MeshStandardMaterial({
        map: dashTex,
        transparent: true,
        opacity: 0.5,
        roughness: 0.8,
        depthWrite: false,
      }),
    );
    group.add(dash);
  }

  // kerbs
  {
    const kerbTex = kerbTexture();
    const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.75 });
    for (const s of [-1, 1]) {
      const kerb = new THREE.Mesh(
        ribbon(curve, segments, s * (ROAD_HALF_WIDTH + 0.72), 1.3, 0.028, 2.4),
        kerbMat,
      );
      group.add(kerb);
    }
  }

  // ------------------------------------------------------- start/finish line
  const start = curve.getPointAt(0);
  const startTan = curve.getTangentAt(0);
  const startQuat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    startTan.clone().setY(0).normalize(),
  );

  {
    const chk = checkerTexture();
    chk.repeat.set(7, 1);
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_HALF_WIDTH * 2, 2.2),
      new THREE.MeshStandardMaterial({ map: chk, roughness: 0.7 }),
    );
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = Math.atan2(startTan.x, startTan.z);
    line.position.set(start.x, 0.045, start.z);
    group.add(line);
  }

  // gantry
  {
    const steel = new THREE.MeshStandardMaterial({ color: 0x2b3037, roughness: 0.45, metalness: 0.8 });
    const side = new THREE.Vector3(startTan.z, 0, -startTan.x).normalize();
    const post = (s) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.36, 7, 0.36), steel);
      m.position.set(start.x + s.x * 9.4, 3.5, start.z + s.z * 9.4);
      m.castShadow = true;
      return m;
    };
    group.add(post(side));
    group.add(post(side.clone().negate()));

    const beam = new THREE.Mesh(new THREE.BoxGeometry(19.2, 0.5, 0.5), steel);
    beam.position.set(start.x, 6.6, start.z);
    beam.rotation.y = Math.atan2(startTan.x, startTan.z) + Math.PI / 2;
    beam.castShadow = true;
    group.add(beam);

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
    banner.position.set(start.x, 5.6, start.z);
    banner.rotation.y = Math.atan2(startTan.x, startTan.z) + Math.PI;
    group.add(banner);
  }

  // ---------------------------------------------------------------- scenery
  // Cones along the outside of the kerbs, instanced.
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

  // marker boards / distance posts every 50 m on the outside
  {
    const postGeo = new THREE.BoxGeometry(0.14, 1.5, 0.14);
    const postMat = new THREE.MeshStandardMaterial({ color: 0xe8eef4, roughness: 0.6 });
    const n = Math.floor(length / 50);
    const inst = new THREE.InstancedMesh(postGeo, postMat, n);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    const side = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      const u = (k * 50) / length;
      curve.getPointAt(u, p);
      curve.getTangentAt(u, t);
      side.set(t.z, 0, -t.x).normalize();
      m.makeTranslation(
        p.x + side.x * (ROAD_HALF_WIDTH + 4.2),
        0.75,
        p.z + side.z * (ROAD_HALF_WIDTH + 4.2),
      );
      inst.setMatrixAt(k, m);
    }
    inst.castShadow = true;
    group.add(inst);
  }

  return {
    group,
    curve,
    length,
    start,
    startQuat,
    startTangent: startTan,
  };
}
