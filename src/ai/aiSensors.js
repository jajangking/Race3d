import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Ray fan used by the AI. With a field of cars this runs 10x per physics
 * step, so it is written to allocate nothing in the hot path: one reusable
 * RAPIER ray, one reusable result object, no per-ray arrays.
 *
 * Readings are refreshed every `interval` AI ticks. The game ticks AI physics
 * at 60 Hz, so that is a 50 ms sensor latency at most - invisible in a racing
 * game - and it cuts the raycast/GC load by 3x.
 */
export class AISensors {
  constructor(car, world) {
    this.car = car;
    this.world = world;
    this.maxDist = 30;
    this.interval = 3;
    this._cooldown = 0;
    this.rays = [];
    this._buildRays();

    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    this._result = {
      front: this.maxDist,
      frontCenter: this.maxDist,
      left: this.maxDist,
      right: this.maxDist,
      rear: this.maxDist,
      frontLeft: this.maxDist,
      frontRight: this.maxDist,
      blockedFront: false,
      tightLeft: false,
      tightRight: false,
    };
    this.lastReading = this._result;
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
    // shoulders: a car sitting 45-75 degrees off the nose used to fall in a
    // blind spot between the front fan (+-35) and the 90 degree side rays,
    // which is exactly where side-by-side contact happens.
    for (const deg of [45, 60, 75]) {
      const rad = (deg * Math.PI) / 180;
      this.rays.push({ name: `sr${deg}`, ang: rad, len: 6.5, type: 'shoulder' });
      this.rays.push({ name: `sl${deg}`, ang: -rad, len: 6.5, type: 'shoulder' });
    }
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
    if (this._cooldown > 0) {
      this._cooldown--;
      return this._result;
    }
    this._cooldown = this.interval - 1;

    const body = this.car.body;
    const t = body.translation();
    const r = body.rotation();

    _fwd.set(0, 0, 1);
    _fwd.applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
    _fwd.y = 0;
    _fwd.normalize();
    _up.set(0, 1, 0);

    // Bumper height, not roof height: casting from t.y + 0.5 (about 0.96 m)
    // sent every ray straight over the top of another car (roof ~0.76 m), so
    // the driver never saw the player and rear-ended them.
    _origin.set(t.x, t.y + 0.06, t.z);

    let minFront = this.maxDist;
    let minCenter = this.maxDist;
    let minFrontLeft = this.maxDist;
    let minFrontRight = this.maxDist;
    let minLeft = this.maxDist;
    let minRight = this.maxDist;
    let minRear = this.maxDist;

    const ray = this._ray;
    ray.origin.x = _origin.x;
    ray.origin.y = _origin.y;
    ray.origin.z = _origin.z;

    for (let i = 0; i < this.rays.length; i++) {
      const rayDef = this.rays[i];
      _dir.copy(_fwd).applyAxisAngle(_up, rayDef.ang);
      ray.dir.x = _dir.x;
      ray.dir.y = _dir.y;
      ray.dir.z = _dir.z;

      const hit = this.world.castRay(
        ray,
        rayDef.len,
        true,
        undefined,
        undefined,
        this.car.collider,
      );
      const hitDist = hit && typeof hit.timeOfImpact === 'number' ? hit.timeOfImpact : null;
      // A miss means "clear to the end of this ray". If every ray reported
      // its own length as a hit distance, the short close-range rays would
      // pin the front distance at 2.6 m and the car would brake forever.
      const dist = hitDist ?? (rayDef.type === 'front' ? this.maxDist : rayDef.len);

      if (rayDef.type === 'front') {
        if (dist < minFront) minFront = dist;
        const a = rayDef.ang;
        // narrow cone that means "something is in my lane", as opposed to
        // "someone is on the track somewhere in front of me"
        if (a >= -Math.PI / 18 && a <= Math.PI / 18 && dist < minCenter) minCenter = dist;
        if (a < 0 && a > -Math.PI / 4 && dist < minFrontLeft) minFrontLeft = dist;
        if (a > 0 && a < Math.PI / 4 && dist < minFrontRight) minFrontRight = dist;
      }
      if (rayDef.type === 'close' && hitDist !== null) {
        if (hitDist < minFront) minFront = hitDist;
      }
      if (rayDef.type === 'side' || rayDef.type === 'shoulder') {
        // +ang rotates the forward vector towards +X, which is the car's
        // right. These were labelled the other way round, which made the
        // avoidance steer into obstacles.
        if (rayDef.ang > 0 && dist < minRight) minRight = dist;
        if (rayDef.ang < 0 && dist < minLeft) minLeft = dist;
      }
      if (rayDef.type === 'rear') {
        if (dist < minRear) minRear = dist;
      }
    }

    const res = this._result;
    res.front = minFront;
    res.frontCenter = minCenter;
    res.left = minLeft;
    res.right = minRight;
    res.rear = minRear;
    res.frontLeft = minFrontLeft;
    res.frontRight = minFrontRight;
    res.blockedFront = minFront < 2.6;
    res.tightLeft = minLeft < 2.8;
    res.tightRight = minRight < 2.8;
    return res;
  }

  _empty() {
    const res = this._result;
    res.front = this.maxDist;
    res.frontCenter = this.maxDist;
    res.left = this.maxDist;
    res.right = this.maxDist;
    res.rear = this.maxDist;
    res.frontLeft = this.maxDist;
    res.frontRight = this.maxDist;
    res.blockedFront = false;
    res.tightLeft = false;
    res.tightRight = false;
    return res;
  }
}
