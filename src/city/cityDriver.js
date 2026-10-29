/**
 * Autonomous city driver - the "FSD" brain for the city simulation.
 *
 * Each car owns a route (a dense lane path from buildRoutePath) and drives it
 * with the same instincts a cautious city driver uses:
 *   - follows the lane (heading + cross-track correction)
 *   - honours traffic lights (stops at the entry point on red, stops on
 *     yellow only when it can do so comfortably)
 *   - keeps a safe following gap (gap-proportional speed, hard stop on a
 *     fast-closing car, emergency brake inside 3 m)
 *   - yields to oncoming traffic before a left turn
 *   - flashes the correct turn signal ~30 m before an intersection
 *   - if it ever gets stuck (jam, knock-on), eases in reverse and tries again
 *
 * No teleports, no respawns: the car always recovers on its own.
 */
import * as THREE from 'three';
import { AISensors } from '../ai/aiSensors.js';
import {
  buildRoutePath,
  findPath,
  nodePos,
  nodeName,
  dirBetween,
  turnType,
  neighbors,
  nodeIndex,
  nearestRoadPoint,
  CITY,
} from './cityLayout.js';

const _fwd = new THREE.Vector3();
const _quat = new THREE.Quaternion();

const wrapPi = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

export class CityDriver {
  /**
   * @param car     Vehicle instance (owns the physics body + telemetry)
   * @param lights  createCityLights() result
   * @param cityTime getter returning the simulation clock (s)
   */
  constructor(car, world, lights, getCityTime) {
    this.car = car;
    this.world = world;
    this.lights = lights;
    this.getCityTime = getCityTime;
    this.sensors = new AISensors(car, world);
    this._lastGap = this.sensors.maxDist;
    this.stuckT = 0;
    this.reverseT = 0;
    this.replans = 0;

    // spawn pose comes from the caller via reset()
    this.route = null;
    this.s = 0;
    this.stopIdx = 0;
    this.manIdx = 0;
    this.nextNode = null;
    this.prevNode = null;
    this.turnSignal = 0; // -1 left, 0 none, +1 right (mirrors steer sign)
    // debug / HUD introspection
    this.crossTrack = 0;
    this._lastVT = 0;
    this._lastHold = false;
    this._lastSteer = 0;
    this._lastProjDist = 0;
    this.offPathT = 0;
    // fleet getter for semantic traffic reasoning (set by the game/test):
    // () => [{ x, z, dx, dz, car }, ...]
    this._fleet = null;
  }

  setFleet(getFleet) {
    this._fleet = getFleet;
  }

  /**
   * Place the car mid-segment heading toward `nextNode` and give it a first
   * route to a random destination.
   */
  reset(x, z, yaw, nextNode) {
    // yaw = atan2(fx, fz)  =>  fx = sin(yaw), fz = cos(yaw)
    const sx = Math.sin(yaw);
    const cz = Math.cos(yaw);
    // quantise to the dominant axis (roads are axis aligned)
    const f = Math.abs(sx) >= Math.abs(cz)
      ? { dx: Math.sign(sx) || 1, dz: 0 }
      : { dx: 0, dz: Math.sign(cz) || 1 };
    this.nextNode = nextNode;
    this.prevNode = null;
    this._place(x, z, f, nextNode);
  }

  _place(x, z, f, nextNode, approachNode = null) {
    // choose a random destination that keeps the field spread out. The
    // first leg must be drivable from our approach direction: leaving
    // nextNode toward the node we CAME FROM is a 180-degree U-turn (the
    // path builder now arcs it, but it wastes a full hairpin) - so it is
    // skipped and the car takes the 90-degree exit instead (left turn +
    // yield). `approachNode` is the route's actual approach node (the car
    // may be knocked around, so its heading is not a reliable source).
    const nbs = neighbors(nextNode);
    const back =
      approachNode !== null && nbs.includes(approachNode)
        ? approachNode
        : nbs.find((v) => turnType(f, dirBetween(nextNode, v)) === 'U');
    const total = 25;
    let dest = nextNode;
    let ok = false;
    for (let tries = 0; tries < 14; tries++) {
      dest = Math.floor(Math.random() * total);
      const path = findPath(nextNode, dest, back);
      if (path && path.length >= 3) { ok = true; break; }
    }
    if (!ok) {
      // unreachable without backtracking (shouldn't happen): aim past the
      // 90-degree exit
      const exits = neighbors(nextNode).filter((v) => v !== back);
      const e = exits[0] ?? nextNode;
      const eN = neighbors(e).find((v) => v !== nextNode) ?? e;
      dest = eN;
    }
    // the car's real heading lets the builder draw a forward recovery arc
    // (instead of a backwards straight connector) when we re-join off-road
    const q0 = this.car.body.rotation();
    _fwd.set(0, 0, 1).applyQuaternion(_quat.set(q0.x, q0.y, q0.z, q0.w));
    _fwd.y = 0;
    const hl = Math.hypot(_fwd.x, _fwd.z);
    const head = hl > 1e-6 ? { dx: _fwd.x / hl, dz: _fwd.z / hl } : { ...f };
    const route = buildRoutePath(nextNode, dest, x, z, f, back, head);
    if (!route) {
      // unreachable (shouldn't happen on this grid) - go straight ahead
      const nbs = neighbors(nextNode);
      const ahead = nbs.find((v) => {
        const d = dirBetween(nextNode, v);
        return d.dx === f.dx && d.dz === f.dz;
      });
      this._place(x, z, f, ahead !== undefined ? ahead : nbs[0]);
      return;
    }
    this.route = route;
    this.s = 0;
    this.stopIdx = 0;
    this.manIdx = 0;
    this.prevNode = nextNode;
    // the node after the first one becomes nextNode once we pass the first
    // stop; until then nextNode stays the first stop's node
  }

  _replan() {
    // (callers below pass the approach node so _place can exclude the
    // U-turn leg back where we came from)
    if (!this.route || !this.prevNode) return;
    this.replans++;
    // figure out which way we are heading (the route exit direction)
    const r = this.route;
    const li = r.n - 1;
    const f = { dx: r.tx[li], dz: r.tz[li] };
    const p = this.car.body.translation();
    // the node the car is actually FACING: at the end of a route that is
    // the last stop's node (the route ends at its entry), not prevNode.
    // Getting this wrong at a grid-edge corner produced degenerate U-turn
    // routes that left the car driving in the wrong lane.
    let here = this.prevNode;
    let bd = Infinity;
    for (const st of r.stops) {
      const np = nodePos(st.node);
      const dd = (np.x - p.x) ** 2 + (np.z - p.z) ** 2;
      if (dd < bd) { bd = dd; here = st.node; }
    }
    // the node ahead is the neighbour of `here` in direction f (when it
    // exists - at a dead end _place() picks the 90-degree exit instead)
    const cand = neighbors(here).find((v) => {
      const d = dirBetween(here, v);
      return Math.abs(d.dx - f.dx) < 0.5 && Math.abs(d.dz - f.dz) < 0.5;
    });
    const nextNode = cand !== undefined ? cand : here;
    // approach direction = the actual grid direction we arrive from
    const fIn = cand !== undefined ? dirBetween(here, cand) : f;
    this._place(p.x, p.z, fIn, nextNode, here);
  }

  update(dt) {
    const car = this.car;
    if (!this.route) {
      this._replan();
      return { steer: 0, throttle: 0, brake: 0.2, handbrake: false };
    }
    const tm = car.telemetry;
    const speed = Math.max(0, tm.speed);
    const p = car.body.translation();
    const sense = this.sensors.sense();

    // ------------------------------------------------------- follow the path
    // project the car onto the path (windowed search around last s)
    const idx = this._project(p.x, p.z);
    const r = this.route;
    const sA = Math.min(r.n - 1, Math.max(0, idx));
    const txA = r.tx[sA];
    const tzA = r.tz[sA];
    // cross-track: + = right of the path
    const cross = (p.x - r.px[sA]) * tzA - (p.z - r.pz[sA]) * txA;
    this.crossTrack = cross;
    this.s = Math.min(r.length - 0.2, Math.max(0, r.s[sA]));

    // heading (same convention as the track AI: forward is local +Z)
    const q = car.body.rotation();
    _fwd.set(0, 0, 1).applyQuaternion(_quat.set(q.x, q.y, q.z, q.w));
    _fwd.y = 0;
    const fl = Math.hypot(_fwd.x, _fwd.z);
    const fx = _fwd.x / Math.max(fl, 1e-6);
    const fz = _fwd.z / Math.max(fl, 1e-6);
    // > 0 means the nose points to the RIGHT of the path direction
    const headingErr = Math.atan2(fx * tzA - fz * txA, fx * txA + fz * tzA);

    // deadband so the wheel doesn't chatter when centred
    let steer = 0;
    if (Math.abs(headingErr) > 0.01 || Math.abs(cross) > 0.35) {
      const steerHead = -headingErr * 1.6;
      // low-speed floor 1.2 (not 2.2): while creeping (follow/oncoming) the
      // car must still be able to re-centre fast enough to get out of the
      // contact band before it grinds; at cruise speed the gain is capped
      // by the speed itself, so high-speed handling is unchanged.
      const steerCross = -cross * (1.2 / Math.max(speed, 1.2));
      steer = Math.max(-0.98, Math.min(0.98, steerHead + steerCross));
      if (Math.abs(steer) < 0.03) steer = 0;
    }

    // ---------------------------------------------------------- speed target
    const vProf = r.vprof[Math.min(r.n - 1, Math.round(this.s / 0.5))];
    let vTarget = vProf;

    // red / yellow lights: stop at the entry point of the next stop
    this._advanceStopMarkers();
    // `hold` = the car is intentionally holding position (light / yield /
    // traffic ahead). While holding, the stuck detector must stay quiet or
    // cars in a red-light queue would ease backwards into the car behind.
    let hold = false;
    // a hold is only "legitimate" while waiting for a red light or for
    // oncoming traffic at a left turn. Anything else held for seconds is a
    // jam (nose-to-nose across a centreline, boxed-in car) and must get
    // the stuck recovery, or the whole intersection deadlocks forever.
    let lightHold = false;
    let yieldHold = false;
    let stuckLimit = null; // per-frame jam-threshold override (oncoming jam)

    const stop = r.stops[this.stopIdx];
    if (stop) {
      const dStop = stop.s - this.s;
      // only while approaching the line: once it is behind us the car must
      // roll through the intersection (a permanent zero here deadlocks any
      // car that crosses the line by even a few cm)
      if (dStop > 0.5 && dStop < 60) {
        const t = this.getCityTime();
        const light = this.lights.lightFor(stop.node, stop.axis, t);
        if (light === 'red' || (light === 'yellow' && speed * speed < 2 * 3.5 * Math.max(dStop - 2.5, 0))) {
          // comfort-decel profile with a 2.5 m margin so the car settles
          // just BEFORE the line, never past it
          vTarget = Math.min(vTarget, Math.sqrt(2 * 3.5 * Math.max(dStop - 2.5, 0)));
          hold = true;
          // only "legitimate" close to the line: a red 50 m away cannot be
          // why we are stopped at THIS instant (something else is blocking
          // us) - and a long jam must get the stuck recovery.
          if (dStop < 30) lightHold = true;
        }
      }
    }

    // following: gap-proportional speed in our lane
    const gap = sense.frontCenter;
    let oncomingIntruder = false;
    if (gap < 26) {
      const closing = (this._lastGap - gap) / Math.max(dt, 1e-4);
      this._lastGap = gap;
      const rel = this._classifyAhead(gap);
      if (rel === 'oncoming') {
        // A car facing us in (or beside) our lane is a WALL, not a leader.
        // One of the two is off its lane - the cross-track decides who.
        // No follow-hold for either: the stuck recovery resolves the rest.
        if (Math.abs(this.crossTrack) > 1.0) {
          oncomingIntruder = true;
          stuckLimit = 6;
        } else {
          // in-lane car keeps priority and passes at a cautious 3 m/s
          vTarget = Math.min(vTarget, 3.0);
          stuckLimit = 6;
        }
      } else {
        let vFollow = (gap - 2.3) * 0.85;
        if (closing > 2.5) vFollow = Math.min(vFollow, Math.max(0, (gap - 3) * 0.5));
        vTarget = Math.min(vTarget, Math.max(0, vFollow));
        // sitting on the bumper of a (stopped) car ahead is waiting, not
        // stuck
        if (gap < 4.5 && vFollow < 1.5) hold = true;
      }
    } else {
      this._lastGap = gap;
    }
    // emergency: something right in front of the nose (the intruder is
    // exempt - see below, it must keep creeping to re-centre)
    if (sense.frontCenter < 3.0 && !oncomingIntruder) vTarget = 0;
    // intruder: CREEP while steering back into its own lane. Steering at
    // zero speed does nothing, and reversing mid-road rams into traffic
    // behind - a slow creep lets the cross-track correction re-centre the
    // car in a couple of seconds. Full stop only when truly nose-to-nose.
    if (oncomingIntruder) {
      vTarget = Math.min(vTarget, sense.frontCenter < 1.5 ? 0 : 1.2);
    }

    // left-turn yield: oncoming cars have priority. Judged GEOMETRICALLY
    // from the fleet's real positions - a ray-based check "saw" buildings
    // down the crossing street and made cars yield to a wall forever.
    // COMMIT RULE: once the car is past the stop line (dMan < ~8, the left
    // stop line sits 8.5 m before the node centre) it finishes the turn -
    // stopping mid-intersection for oncoming traffic boxes the junction.
    const man = r.maneuvers[this.manIdx];
    if (man && man.type === 'L') {
      const dMan = man.s - this.s;
      if (dMan < 34 && dMan > 8) {
        const si = Math.max(0, Math.round((man.s - 8) / 0.5));
        const fIn = {
          dx: Math.abs(r.tx[si]) >= Math.abs(r.tz[si]) ? Math.sign(r.tx[si]) || 1 : 0,
          dz: Math.abs(r.tz[si]) >= Math.abs(r.tx[si]) ? Math.sign(r.tz[si]) || 1 : 0,
        };
        const oncoming = this._oncomingNear(man.node, fIn);
        if (oncoming.near) {
          vTarget = Math.min(vTarget, oncoming.dist < 11 ? 0 : 3.5);
          hold = true;
          yieldHold = true;
        }
      }
    }

    // lost-driver recovery: far from the route for a sustained moment means
    // the path is stale (missed turn, knock-on). Plan a fresh route from the
    // car's real position - it recovers on its own, no teleport. 5 m (not
    // 8) so the car re-joins the road while it is still next to it.
    if (this._lastProjDist > 5) this.offPathT += dt;
    else this.offPathT = 0;
    if (this.offPathT > 2.5) {
      this.offPathT = 0;
      this.replans++;
      this._replanFromScratch();
      return { steer: 0, throttle: 0, brake: 0.2, handbrake: false };
    }

    // re-centering: if we drift wide, creep (not stop - a hard stop off-line
    // deadlocks the car because the stuck detector needs vTarget > 0.3) while
    // the steering pulls it back to the line
    if (Math.abs(cross) > 2.2) vTarget = Math.min(vTarget, 4.5);
    if (Math.abs(cross) > 4.5) vTarget = Math.min(vTarget, 2.5);

    // ------------------------------------------------------------- throttle
    // if the car is jammed it eases in reverse. A hold is only quiet while
    // it is a LEGITIMATE wait (red light / left-turn yield); a follow-hold
    // against a car that will not move (nose-to-nose across a centreline)
    // must count as stuck or the intersection deadlocks forever.
    const legitHold = hold && (lightHold || yieldHold);
    const wantsMove = speed < 0.5 && (vTarget > 0.3 || !legitHold);
    // stuck time only resets when the car actually moves - decaying it while
    // stationary would let a red-light cycle (red 10 s / green 6 s) keep a
    // truly blocked car from ever accumulating enough for the recovery.
    if (wantsMove) this.stuckT += dt; else if (speed > 0.5) this.stuckT = 0;

    let throttle = 0;
    let brake = 0;
    let reverse = false;
    let handbrake = false;

    // physically blocked -> quick reverse; follow-hold jam -> a little more
    // patience (creeping queues), then reverse too; oncoming jam -> the
    // intruder reverses fast, the in-lane car waits it out
    const jamLimit = stuckLimit ?? (hold ? 6 : 4);
    if (this.stuckT > jamLimit && this.reverseT <= 0) {
      this.reverseT = 1.8;
    }
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      reverse = true;
      // Throttle the reverse ONLY when the road behind is clear: from a
      // standstill a coast-reverse produces no wheel torque (the drivetrain
      // cuts it at idle), so a car wedged against a building corner can
      // never actually move without it. But with traffic queued behind, a
      // throttled reverse would rear-end the car at our bumper - then fall
      // back to the gentle coast.
      throttle = this._carBehind() ? 0 : 0.35;
      brake = 0;
      handbrake = false;
      // a straight reverse grinds deeper into a side-jam (a wedge against
      // a queue keeps v at zero no matter how long we back up). Steer the
      // REAR toward the lane centre instead: reversing while steering
      // right swings the back end left, pulling the car off the obstacle.
      steer = Math.abs(cross) > 0.5 ? -Math.sign(cross) * 0.7 : 0;
      this.stuckT = 0;
    } else if (speed < 0.15 && vTarget < 0.3) {
      // holding a stop (light / car ahead): creep the brake so we hold
      brake = Math.max(brake, 0.25);
    } else {
      const wantAccel = vTarget > speed + 0.08;
      const wantDecel = vTarget < speed - 0.08;
      if (wantAccel) {
        const a = Math.min((vTarget - speed) / Math.max(dt, 1e-4), 3.4);
        throttle = Math.min(1, Math.max(0.12, a / 3.4 + 0.1));
      } else if (wantDecel) {
        const a = (speed - vTarget) / Math.max(dt, 1e-4);
        brake = Math.min(1, Math.max(0.1, a / 6.5));
        if (sense.frontCenter < 5 && vTarget < 0.5) brake = Math.max(brake, 0.6);
      } else {
        throttle = 0.18; // cruise hold
      }
    }

    // ------------------------------------------------------------ turn signal
    // flash the correct indicator ~30 m before the next L/R intersection
    let sig = 0;
    if (man) {
      const dMan = man.s - this.s;
      if (dMan < 34 && dMan > -14) {
        if (man.type === 'L') sig = -1;
        else if (man.type === 'R') sig = 1;
      }
    }
    this.turnSignal = sig;
    car.turnSignal = sig;

    this._lastVT = vTarget;
    this._lastHold = hold;
    this._lastSteer = steer;
    return { steer, throttle, brake, handbrake, reverse };
  }

  // advance stopIdx / manIdx as the car passes their s markers
  _advanceStopMarkers() {
    const r = this.route;
    while (this.stopIdx < r.stops.length && this.s > r.stops[this.stopIdx].s + 2.5) {
      this.stopIdx++;
      // passing a node: the next stop's node becomes nextNode; the one we
      // just passed becomes prevNode
      const passed = r.stops[this.stopIdx - 1];
      const next = r.stops[this.stopIdx];
      this.prevNode = passed.node;
      if (next) this.nextNode = next.node;
    }
    while (this.manIdx < r.maneuvers.length && this.s > r.maneuvers[this.manIdx].s + 2.5) {
      this.manIdx++;
    }
    // arrival: path fully consumed -> plan the next route
    if (this.s >= r.length - 1.5) {
      this._replan();
    }
  }

  // windowed nearest-sample projection; keeps a rough index to stay O(window)
  _project(x, z) {
    const r = this.route;
    let guess = Math.round(this.s / 0.5);
    guess = Math.min(r.n - 1, Math.max(0, guess));
    const lo = Math.max(0, guess - 40);
    const hi = Math.min(r.n - 1, guess + 120);
    let best = guess;
    let bd = Infinity;
    for (let i = lo; i <= hi; i++) {
      const dx = r.px[i] - x;
      const dz = r.pz[i] - z;
      const dd = dx * dx + dz * dz;
      if (dd < bd) { bd = dd; best = i; }
    }
    this._lastProjDist = Math.sqrt(bd);
    return best;
  }

  /**
   * What does the frontCenter ray actually see? Uses the fleet's real
   * headings:
   *   'oncoming' - a car facing us that explains the hit (lat within the
   *                ray cone + box margin) -> wall, never a leader
   *   'leader'   - same-ish direction or crossing in front -> follow it
   *   null       - no fleet car explains it -> old (leader) behaviour
   */
  _classifyAhead(gap) {
    const cars = this._fleet ? this._fleet() : null;
    if (!cars) return null;
    const p = this.car.body.translation();
    const q = this.car.body.rotation();
    _fwd.set(0, 0, 1).applyQuaternion(_quat.set(q.x, q.y, q.z, q.w));
    _fwd.y = 0;
    const fl = Math.hypot(_fwd.x, _fwd.z);
    const fx = _fwd.x / Math.max(fl, 1e-6);
    const fz = _fwd.z / Math.max(fl, 1e-6);
    for (const c of cars) {
      if (!c || c.car === this.car) continue;
      const dx = c.x - p.x;
      const dz = c.z - p.z;
      const along = dx * fx + dz * fz;
      if (along < 0.5 || along > gap + 3.5) continue;
      // ray cone (±10 deg) plus box-width margin
      const lat = Math.abs(dx * fz - dz * fx);
      if (lat > 0.4 * along + 0.8) continue;
      const dot = c.dx * fx + c.dz * fz;
      if (dot < -0.2) return 'oncoming';
      return 'leader';
    }
    return null;
  }

  /**
   * Is there a fleet car in our lane BEHIND us (0.5-7 m)? Decides whether
   * the stuck-reverse may use throttle (clear) or must stay a coast
   * (traffic at our bumper - a coast cannot rear-end it).
   */
  _carBehind() {
    const cars = this._fleet ? this._fleet() : null;
    if (!cars) return false;
    const p = this.car.body.translation();
    const q = this.car.body.rotation();
    _fwd.set(0, 0, 1).applyQuaternion(_quat.set(q.x, q.y, q.z, q.w));
    _fwd.y = 0;
    const fl = Math.hypot(_fwd.x, _fwd.z);
    const fx = _fwd.x / Math.max(fl, 1e-6);
    const fz = _fwd.z / Math.max(fl, 1e-6);
    for (const c of cars) {
      if (!c || c.car === this.car) continue;
      const dx = c.x - p.x;
      const dz = c.z - p.z;
      const back = -(dx * fx + dz * fz); // > 0 = behind us
      if (back < 0.5 || back > 7) continue;
      const lat = Math.abs(dx * fz - dz * fx);
      if (lat < 1.8) return true;
    }
    return false;
  }

  /**
   * Is there an oncoming car in the conflict zone of a left turn at `node`,
   * for a car arriving along `fIn`? Oncoming traffic comes from beyond the
   * node on the OPPOSITE lane of our own road (1.5 m to its left, i.e.
   * lat ≈ -1.5 relative to fIn) and is a conflict if it is within ~20 m of
   * the intersection.
   */
  _oncomingNear(node, fIn) {
    const A = nodePos(node);
    const cars = this._fleet ? this._fleet() : null;
    if (!cars) return { near: false, dist: Infinity };
    const rx = fIn.dz;
    const rz = -fIn.dx;
    let best = Infinity;
    for (const c of cars) {
      if (!c || c.car === this.car) continue;
      const ax = c.x - A.x;
      const az = c.z - A.z;
      const along = ax * fIn.dx + az * fIn.dz; // > 0: beyond the node
      if (along < -2 || along > 22) continue;
      const lat = ax * rx + az * rz; // oncoming lane sits at lat ≈ -1.5
      if (lat > -0.1 || lat < -2.9) continue;
      const headingToward = -(c.dx * fIn.dx + c.dz * fIn.dz);
      if (headingToward > 0.6 && along < best) best = along;
    }
    return { near: best < 20, dist: best };
  }

  /**
   * Lost-driver recovery (NO teleport): the car strayed far from its route
   * (wrong turn, bad exit, knock-on, pushed past the city edge). It comes
   * BACK TO THE ROAD first - the nearest road point is joined, then the car
   * continues along that road toward the next intersection. One consistent
   * route, no replan loops: the old "aim at a node in front" logic bounced
   * cars that were outside the grid (no node in front -> route back ->
   * slow U-turn -> off path -> replan -> ...).
   */
  _replanFromScratch() {
    const p = this.car.body.translation();
    const q = this.car.body.rotation();
    _fwd.set(0, 0, 1).applyQuaternion(_quat.set(q.x, q.y, q.z, q.w));
    _fwd.y = 0;
    const fl = Math.hypot(_fwd.x, _fwd.z);
    const fx = _fwd.x / Math.max(fl, 1e-6);
    const fz = _fwd.z / Math.max(fl, 1e-6);

    const off = (CITY.n - 1) / 2;
    const road = nearestRoadPoint(p.x, p.z);
    let nextNode = null;
    let prevNode = null;
    if (road && road.dev < 30) {
      // the two endpoint nodes of the nearest road segment
      let a, b;
      if (road.dx !== 0) {
        const j = Math.min(CITY.n - 1, Math.max(0, Math.round(road.z / CITY.pitch + off)));
        const i = Math.min(CITY.n - 2, Math.max(0, Math.floor(road.x / CITY.pitch + off)));
        a = nodeIndex(i, j);
        b = nodeIndex(i + 1, j);
      } else {
        const i = Math.min(CITY.n - 1, Math.max(0, Math.round(road.x / CITY.pitch + off)));
        const j = Math.min(CITY.n - 2, Math.max(0, Math.floor(road.z / CITY.pitch + off)));
        a = nodeIndex(i, j);
        b = nodeIndex(i, j + 1);
      }
      // keep going along the road when our heading allows it; otherwise
      // (facing across/out of the road) just take the nearer endpoint
      const along = fx * road.dx + fz * road.dz;
      if (along > 0.5) {
        nextNode = b; prevNode = a;
      } else if (along < -0.5) {
        nextNode = a; prevNode = b;
      } else {
        const pa = nodePos(a);
        const pb = nodePos(b);
        const da = (pa.x - p.x) ** 2 + (pa.z - p.z) ** 2;
        const db = (pb.x - p.x) ** 2 + (pb.z - p.z) ** 2;
        if (da <= db) { nextNode = a; prevNode = b; }
        else { nextNode = b; prevNode = a; }
      }
      const d2 = dirBetween(prevNode, nextNode);
      this.prevNode = prevNode;
      this._place(p.x, p.z, { dx: d2.dx, dz: d2.dz }, nextNode, prevNode);
      return;
    }
    // no road within 30 m (shouldn't happen in this city): aim at the
    // nearest intersection like before
    let bd = Infinity;
    nextNode = 0;
    for (let id = 0; id < CITY.n * CITY.n; id++) {
      const np = nodePos(id);
      const dd = (np.x - p.x) ** 2 + (np.z - p.z) ** 2;
      if (dd < bd) { bd = dd; nextNode = id; }
    }
    const behind = this._nearestNodeBehind(p.x, p.z, nextNode);
    this.prevNode = behind;
    this._place(p.x, p.z, dirBetween(behind, nextNode), nextNode, behind);
  }

  // the node on the other side of the car from `nextNode` (or the nearest
  // node when the car is closer to an intersection than to any segment)
  _nearestNodeBehind(x, z, nextNode) {
    let best = nextNode;
    let bd = Infinity;
    for (const v of neighbors(nextNode)) {
      const np = nodePos(v);
      const dx = np.x - x;
      const dz = np.z - z;
      const dd = dx * dx + dz * dz;
      if (dd < bd) { bd = dd; best = v; }
    }
    const np = nodePos(nextNode);
    const dn = (np.x - x) ** 2 + (np.z - z) ** 2;
    if (dn < bd) best = nextNode;
    return best;
  }
}
