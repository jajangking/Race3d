import * as THREE from 'three';
import { ribbon, ROAD_HALF_WIDTH } from './track.js';
import { buildRacingLine } from '../ai/racingLine.js';

/**
 * Everything around the track: pit lane, pit building, tyre barriers,
 * grandstands, timing tower, trees, distant hills and the sun.
 *
 * `teamColors` is the paint of every car in the field (index 0 = the player,
 * blue), used to line the pit boxes and the building facade so the pit lane
 * actually belongs to the teams on screen.
 */
export function createScenery(scene, track, teamColors = []) {
  const group = new THREE.Group();
  scene.add(group);

  const curve = track.curve;
  const length = track.length;
  const line = buildRacingLine(track);
  const start = track.start;

  /* ------------------------------------------------------------- pit area */
  {
    const pitPts = [
      new THREE.Vector3(-152, 0, 174.5),
      new THREE.Vector3(-140, 0, 196),
      new THREE.Vector3(140, 0, 196),
      new THREE.Vector3(178, 0, 174.5),
    ];
    const pitCurve = new THREE.CatmullRomCurve3(pitPts, false, 'catmullrom', 0.5);

    const pitTex = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.95 });
    group.add(new THREE.Mesh(ribbon(pitCurve, 60, 0, 4.2, 0.02, 0, false), pitTex));

    const edgeMat = new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.7 });
    for (const s of [-1, 1]) {
      group.add(
        new THREE.Mesh(ribbon(pitCurve, 60, s * 2.05, 0.12, 0.03, 0, false), edgeMat),
      );
    }

    // painted pit boxes, one per car
    const bays = teamColors.length || 11;
    const W = 2048;
    const H = 96;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#15171b';
    g.fillRect(0, 0, W, H);
    const laneX0 = -140;
    const laneW = 290; // metres covered by the canvas
    const px = (x) => ((x - laneX0) / laneW) * W;
    for (let i = 0; i < bays; i++) {
      const bx0 = laneX0 + (i * laneW) / bays;
      const bw = (laneW / bays) * (W / laneW); // px
      const color = `#${(teamColors[i] ?? 0x888888).toString(16).padStart(6, '0')}`;
      g.fillStyle = color;
      g.globalAlpha = 0.85;
      g.fillRect(px(bx0) + bw * 0.18, H * 0.22, bw * 0.64, H * 0.56);
      g.globalAlpha = 1;
      g.strokeStyle = 'rgba(240, 244, 248, 0.8)';
      g.lineWidth = 3;
      g.strokeRect(px(bx0) + 2, 4, bw - 4, H - 8);
    }
    const boxesTex = new THREE.CanvasTexture(c);
    boxesTex.colorSpace = THREE.SRGBColorSpace;
    const boxes = new THREE.Mesh(
      new THREE.PlaneGeometry(laneW, 9),
      new THREE.MeshBasicMaterial({ map: boxesTex, transparent: false, depthWrite: false }),
    );
    boxes.rotation.x = -Math.PI / 2;
    boxes.position.set(7.5, 0.024, 196);
    boxes.renderOrder = 1;
    group.add(boxes);

    // pit wall (armco) between track and pit lane, with entry/exit gaps
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.85 });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(300, 0.85, 0.3), wallMat);
    wall.position.set(15, 0.425, 183.5);
    wall.castShadow = true;
    group.add(wall);
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(300, 0.3, 0.34),
      new THREE.MeshStandardMaterial({ color: 0xcf3a2c, roughness: 0.7 }),
    );
    stripe.position.set(15, 1.0, 183.5);
    group.add(stripe);

    // pit building behind the lane
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.8 });
    const fc = document.createElement('canvas');
    fc.width = 2048;
    fc.height = 256;
    const fg = fc.getContext('2d');
    fg.fillStyle = '#1c1f24';
    fg.fillRect(0, 0, 2048, 256);
    for (let i = 0; i < bays; i++) {
      const color = `#${(teamColors[i] ?? 0x888888).toString(16).padStart(6, '0')}`;
      fg.fillStyle = color;
      fg.globalAlpha = 0.9;
      fg.fillRect((i / bays) * 2048 + 4, 150, 2048 / bays - 8, 64);
      fg.globalAlpha = 1;
    }
    fg.fillStyle = '#f2f5f8';
    fg.font = '900 96px Inter, system-ui, sans-serif';
    fg.textAlign = 'center';
    fg.textBaseline = 'middle';
    fg.fillText('RACE3D  PITS', 1024, 74);
    const facadeTex = new THREE.CanvasTexture(fc);
    facadeTex.colorSpace = THREE.SRGBColorSpace;
    const facadeMat = new THREE.MeshStandardMaterial({ map: facadeTex, roughness: 0.7 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.9 });
    const building = new THREE.Mesh(
      new THREE.BoxGeometry(320, 9, 8),
      [sideMat, sideMat, roofMat, sideMat, sideMat, facadeMat],
    );
    building.position.set(0, 4.5, 213);
    building.castShadow = true;
    group.add(building);
  }

  /* ----------------------------------------------------- tyre barriers */
  {
    const N = line.n;
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    const side = new THREE.Vector3();

    // collect barrier stations on the OUTSIDE of every corner (radius < 110 m)
    const stations = [];
    const stepU = 1 / N;
    for (let i = 0; i < N; i++) {
      const k = line.curvature[i];
      if (k < 1 / 110) continue;
      const u = (i + 0.5) * stepU;
      curve.getPointAt(u, p);
      curve.getTangentAt(u, t);
      side.set(t.z, 0, -t.x).normalize();
      const sgn = line.curvatureSigned[i] >= 0 ? 1 : -1; // outside of the bend
      const ox = side.x * sgn * (ROAD_HALF_WIDTH + 2.9);
      const oz = side.z * sgn * (ROAD_HALF_WIDTH + 2.9);
      stations.push({ x: p.x + ox, z: p.z + oz, tx: t.x, tz: t.z });
    }
    // thin out to one barrier every ~1.4 m of track
    const picks = [];
    let lastS = -10;
    let s = 0;
    for (const st of stations) {
      s += stepU * length;
      if (s - lastS >= 1.4) {
        picks.push(st);
        lastS = s;
      }
    }
    if (picks.length > 0) {
      const tyreMat = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.88 });
      const baseMat = new THREE.MeshStandardMaterial({ color: 0x565b62, roughness: 0.95 });
      const tyres = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.42, 0.42, 0.6, 12), tyreMat, picks.length);
      const bases = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 0.26, 0.5), baseMat, picks.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const one = new THREE.Vector3(1, 1, 1);
      const up = new THREE.Vector3(0, 1, 0);
      const T = new THREE.Vector3();
      const X = new THREE.Vector3();
      for (let i = 0; i < picks.length; i++) {
        const st = picks[i];
        const ry = Math.atan2(st.tx, st.tz);
        // tyre: cylinder axis (local Y) along the track, lying on its side
        T.set(st.tx, 0, st.tz).normalize();
        X.set(0, 1, 0).cross(T);
        m.makeBasis(X, T, up);
        m.setPosition(st.x, 0.42, st.z);
        tyres.setMatrixAt(i, m);
        // base block: 0.9 m along the track, 0.5 m across
        m.compose(new THREE.Vector3(st.x, 0.13, st.z), q.setFromAxisAngle(up, ry), one);
        bases.setMatrixAt(i, m);
      }
      tyres.castShadow = true;
      group.add(tyres, bases);
    }
  }

  /* ------------------------------------------------------- grandstands */
  function facadeTexture() {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#262b31';
    g.fillRect(0, 0, 512, 128);
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 14; i++) {
        g.fillStyle = `rgba(255, 250, 230, ${0.12 + Math.random() * 0.22})`;
        g.fillRect(18 + i * 35, 14 + r * 36, 22, 24);
      }
    }
    g.fillStyle = '#c22';
    g.fillRect(0, 122, 512, 6);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function grandstand(w, h, d, x, z, ry) {
    const g = new THREE.Group();
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.8 });
    const facMat = new THREE.MeshStandardMaterial({ map: facadeTexture(), roughness: 0.7 });
    const shell = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [
      baseMat, baseMat, baseMat, baseMat, baseMat, facMat,
    ]);
    shell.position.y = h / 2;
    shell.castShadow = true;
    g.add(shell);
    const roofSlab = new THREE.Mesh(
      new THREE.BoxGeometry(w + 2.5, 0.3, d + 3),
      new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.9 }),
    );
    roofSlab.position.y = h + 0.15;
    roofSlab.castShadow = true;
    g.add(roofSlab);
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    group.add(g);
  }

  grandstand(36, 14, 10, 306, 92, Math.PI / 2);    // inside of T1
  grandstand(44, 13, 10, -66, -196, Math.PI);      // outside of the chicane

  // timing tower next to the start/finish
  {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#20242a';
    g.fillRect(0, 0, 256, 512);
    g.fillStyle = '#ff2f2f';
    g.fillRect(0, 0, 256, 26);
    g.fillStyle = '#f2f5f8';
    g.font = '900 170px Inter, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('R3', 128, 250);
    g.font = '700 30px Inter, system-ui, sans-serif';
    g.fillStyle = '#9aa4b0';
    g.fillText('TIMING', 128, 400);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.85 });
    const facMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 });
    const tower = new THREE.Mesh(new THREE.BoxGeometry(7, 18, 7), [
      sideMat, sideMat, sideMat, sideMat, sideMat, facMat,
    ]);
    tower.position.set(-40, 9, 140);
    tower.rotation.y = Math.PI; // facade to the track
    tower.castShadow = true;
    group.add(tower);
  }

  /* ------------------------------------------------- trees and bushes */
  {
    const samples = curve.getSpacedPoints(400);
    const clearZones = [
      // [x0, z0, x1, z1, margin]
      [-170, 182, 190, 228, 14], // pit corridor + building
      [290, 76, 330, 110, 14],   // stand A
      [-96, -220, -36, -172, 14], // stand B
      [-54, 126, -26, 154, 10],  // timing tower
    ];
    function isClear(x, z, margin) {
      for (let i = 0; i < samples.length; i++) {
        const dx = samples[i].x - x;
        const dz = samples[i].z - z;
        if (dx * dx + dz * dz < margin * margin) return false;
      }
      for (const [x0, z0, x1, z1, m] of clearZones) {
        const cx = Math.max(x0, Math.min(x, x1));
        const cz = Math.max(z0, Math.min(z, z1));
        if ((cx - x) ** 2 + (cz - z) ** 2 < m * m) return false;
      }
      return true;
    }
    function scatter(count, margin, area = { x0: -390, x1: 400, z0: -260, z1: 350 }) {
      const out = [];
      let attempts = 0;
      while (out.length < count && attempts < count * 40) {
        attempts++;
        const x = area.x0 + Math.random() * (area.x1 - area.x0);
        const z = area.z0 + Math.random() * (area.z1 - area.z0);
        if (!isClear(x, z, margin)) continue;
        out.push({ x, z, s: 0.7 + Math.random() * 0.8, r: Math.random() * Math.PI * 2 });
      }
      return out;
    }

    const trees = scatter(110, 19);
    if (trees.length > 0) {
      const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 0.95 });
      const coneMat = new THREE.MeshStandardMaterial({ color: 0x3c5a33, roughness: 0.9 });
      const crownMat = new THREE.MeshStandardMaterial({ color: 0x4a6b3a, roughness: 0.9 });
      const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.26, 1.8, 6), trunkMat, trees.length);
      const cones = new THREE.InstancedMesh(new THREE.ConeGeometry(2.1, 4.6, 7), coneMat, Math.ceil(trees.length * 0.6));
      const crowns = new THREE.InstancedMesh(new THREE.SphereGeometry(1.9, 8, 6), crownMat, Math.floor(trees.length * 0.4));
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      let ci = 0;
      let ri = 0;
      for (let i = 0; i < trees.length; i++) {
        const t = trees[i];
        const s = t.s;
        m.compose(
          new THREE.Vector3(t.x, 0.9 * s, t.z),
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.r),
          new THREE.Vector3(s, s, s),
        );
        trunks.setMatrixAt(i, m);
        m.compose(
          new THREE.Vector3(t.x, (1.8 + 2.2) * s, t.z),
          q,
          new THREE.Vector3(s, s, s),
        );
        if (i % 5 < 3) {
          cones.setMatrixAt(ci++, m);
        } else {
          m.compose(
            new THREE.Vector3(t.x, (1.8 + 1.9) * s, t.z),
            q,
            new THREE.Vector3(s * 1.15, s * 0.85, s * 1.15),
          );
          crowns.setMatrixAt(ri++, m);
        }
      }
      cones.count = ci;
      crowns.count = ri;
      trunks.castShadow = true;
      cones.castShadow = true;
      group.add(trunks, cones, crowns);
    }

    const bushes = scatter(150, 15);
    if (bushes.length > 0) {
      const bushMat = new THREE.MeshStandardMaterial({ color: 0x44603a, roughness: 0.95 });
      const bushesMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 7, 5), bushMat, bushes.length);
      const m = new THREE.Matrix4();
      for (let i = 0; i < bushes.length; i++) {
        const b = bushes[i];
        m.compose(
          new THREE.Vector3(b.x, 0.45 * b.s, b.z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.r),
          new THREE.Vector3(1.1 * b.s, 0.7 * b.s, 1.1 * b.s),
        );
        bushesMesh.setMatrixAt(i, m);
      }
      group.add(bushesMesh);
    }
  }

  /* ---------------------------------------------------- distant hills */
  {
    const hillMat = new THREE.MeshLambertMaterial({ color: 0x6e7d66 });
    const hills = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), hillMat, 26);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
      const r = 1500 + Math.random() * 800;
      const sx = 180 + Math.random() * 270;
      const sy = 45 + Math.random() * 95;
      m.compose(
        new THREE.Vector3(Math.cos(a) * r, -14, Math.sin(a) * r),
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI),
        new THREE.Vector3(sx, sy, sx * (0.7 + Math.random() * 0.6)),
      );
      hills.setMatrixAt(i, m);
    }
    group.add(hills);
  }

  /* ------------------------------------------------------------- sun */
  {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 8, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255, 252, 240, 1)');
    grad.addColorStop(0.18, 'rgba(255, 244, 214, 0.95)');
    grad.addColorStop(0.4, 'rgba(255, 236, 190, 0.35)');
    grad.addColorStop(1, 'rgba(255, 236, 190, 0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, fog: false, depthWrite: false, transparent: true }),
    );
    const d = new THREE.Vector3(55, 80, 35).normalize().multiplyScalar(3800);
    sprite.position.copy(d);
    sprite.scale.set(560, 560, 1);
    if (scene.userData.sky) scene.userData.sky.add(sprite);
    else group.add(sprite);
  }

  return group;
}
