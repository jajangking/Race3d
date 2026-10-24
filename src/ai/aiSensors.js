import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class AISensors {
  constructor(car, world) {
    this.car = car;
    this.world = world;
    this.maxDist = 9;
    this.rays = [];
    this._buildRays();
    this.lastReading = null;
  }

  _buildRays() {
    this.rays = [];
    // front fan
    for (let a = -35; a <= 35; a += 5) {
      this.rays.push({ name: `f${a}`, ang: (a * Math.PI) / 180, len: this.maxDist, type: 'front' });
    }
    // side
    this.rays.push({ name: 'sl', ang: Math.PI / 2, len: 4.2, type: 'side' });
    this.rays.push({ name: 'sr', ang: -Math.PI / 2, len: 4.2, type: 'side' });
    // rear diagonal
    this.rays.push({ name: 'bl', ang: Math.PI * 0.75, len: 3.6, type: 'rear' });
    this.rays.push({ name: 'br', ang: -Math.PI * 0.75, len: 3.6, type: 'rear' });
    // close range bumper
    this.rays.push({ name: 'c0', ang: 0, len: 2.6, type: 'close' });
    this.rays.push({ name: 'c1', ang: (12 * Math.PI) / 180, len: 2.6, type: 'close' });
    this.rays.push({ name: 'c2', ang: (-12 * Math.PI) / 180, len: 2.6, type: 'close' });
  }

  sense() {
    if (!this.world) return this._empty();
    const body = this.car.body;
    const t = body.translation();
    const r = body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);

    _fwd.set(0, 0, 1).applyQuaternion(q);
    _fwd.y = 0;
    _fwd.normalize();
    _right.set(1, 0, 0).applyQuaternion(q);
    _right.y = 0;
    _right.normalize();
    _up.set(0, 1, 0);

    _origin.set(t.x, t.y + 0.5, t.z);

    const readings = [];
    let minFront = this.maxDist;
    let minLeft = this.maxDist;
    let minRight = this.maxDist;
    let minRear = this.maxDist;

    for (let i = 0; i < this.rays.length; i++) {
      const rayDef = this.rays[i];
      // rotate direction
      const dir = _fwd.clone();
      dir.applyAxisAngle(_up, rayDef.ang);
      dir.normalize();
      const ray = new RAPIER.Ray({ x: _origin.x, y: _origin.y, z: _origin.z }, { x: dir.x, y: dir.y, z: dir.z });
      const hit = this.world.castRay(ray, rayDef.len, true);
      let dist = rayDef.len;
      if (hit && typeof hit.timeOfImpact === 'number') {
        dist = hit.timeOfImpact;
      }
      readings.push({ name: rayDef.name, type: rayDef.type, ang: rayDef.ang, dist, norm: dist / rayDef.len });

      if (rayDef.type === 'front' || rayDef.type === 'close') {
        if (dist < minFront) minFront = dist;
      }
      if (rayDef.type === 'side') {
        if (rayDef.ang > 0 && dist < minLeft) minLeft = dist;
        if (rayDef.ang < 0 && dist < minRight) minRight = dist;
      }
      if (rayDef.type === 'rear') {
        if (dist < minRear) minRear = dist;
      }
    }

    const res = {
      readings,
      front: minFront,
      left: minLeft,
      right: minRight,
      rear: minRear,
      frontLeft: Math.min(...readings.filter(r => r.ang > 0 && r.ang < Math.PI / 4).map(r => r.dist), this.maxDist),
      frontRight: Math.min(...readings.filter(r => r.ang < 0 && r.ang > -Math.PI / 4).map(r => r.dist), this.maxDist),
      blockedFront: minFront < 2.6,
      tightLeft: minLeft < 1.8,
      tightRight: minRight < 1.8,
    };
    this.lastReading = res;
    return res;
  }

  _empty() {
    return {
      readings: [],
      front: this.maxDist,
      left: this.maxDist,
      right: this.maxDist,
      rear: this.maxDist,
      frontLeft: this.maxDist,
      frontRight: this.maxDist,
      blockedFront: false,
      tightLeft: false,
      tightRight: false,
    };
  }
}
