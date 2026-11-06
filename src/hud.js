/** Thin DOM HUD. Kept out of the render loop's hot path (text only changes). */

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      root: $('hud'),
      speedo: $('speedo'),
      speed: $('speed'),
      gear: $('gear'),
      rpmBar: $('rpm-bar')?.firstElementChild,
      rpm: $('rpm'),
      session: $('session'),
      best: $('best'),
      top: $('top'),
      tc: $('pill-tc'),
      esc: $('pill-esc'),
      abs: $('pill-abs'),
      cammode: $('cammode'),
      standings: $('standings'),
      standingsBody: $('standings-body'),
      cityCam: $('city-cammode'),
      cityTurn: $('city-turn'),
      cityDist: $('city-dist'),
      cityDest: $('city-dest'),
      cityCar: $('city-car'),
      citySpeed: $('city-speed'),
      cityLight: $('city-light'),
    };
    this.last = {};
    this.topSpeed = 0;
    this.best100 = null;
    this._lastSpeed = 0;
    this.standRows = null;
    this._standingsSig = null;
  }

  show() {
    this.el.root.classList.add('is-live');
  }

  setAssist(name, on) {
    const el = this.el[name];
    if (!el) return;
    el.classList.toggle('is-off', !on);
    el.classList.toggle('is-on', on);
    if (!on) el.classList.remove('is-active');
  }

  resetRun() {
    this.topSpeed = 0;
  }

  /** Label of the active camera (spectator mode). */
  setCamMode(label) {
    if (!this.el.cammode) return;
    if (this.last.cammode !== label) {
      this.el.cammode.textContent = label;
      this.last.cammode = label;
    }
  }

  /**
   * Build the spectator leaderboard once. meta[i] = { name, color } for the
   * car at field index i (the player's car is flagged by name 'YOU').
   */
  buildStandings(meta) {
    const body = this.el.standingsBody;
    if (!body) return;
    body.innerHTML = '';
    this.standRows = meta.map((m) => {
      const row = document.createElement('div');
      row.className = 'standings__row';
      const pos = document.createElement('span');
      pos.className = 'standings__pos';
      const dot = document.createElement('span');
      dot.className = 'standings__dot';
      dot.style.background = `#${m.color.toString(16).padStart(6, '0')}`;
      const name = document.createElement('span');
      name.className = 'standings__name';
      name.textContent = m.name;
      const lap = document.createElement('span');
      lap.className = 'standings__lap';
      row.append(pos, dot, name, lap);
      if (m.name === 'YOU') row.classList.add('is-player');
      body.appendChild(row);
      return row;
    });
    if (this.el.standings) this.el.standings.hidden = false;
    this._standingsSig = null;
  }

  /**
   * Update the leaderboard. rows = [{ idx, rank, lap, isFocus }] sorted by
   * rank. DOM is only touched when something actually changed (~4 Hz).
   */
  updateStandings(rows) {
    if (!this.standRows) return;
    const sig = rows
      .map((r) => r.rank + '|' + r.idx + '|' + r.lap + (r.isFocus ? '1' : '0'))
      .join(';');
    if (sig === this._standingsSig) return;
    this._standingsSig = sig;
    for (const r of rows) {
      const el = this.standRows[r.idx];
      if (!el) continue;
      el.children[0].textContent = String(r.rank + 1).padStart(2, '0');
      el.children[3].textContent = 'LAP ' + r.lap;
      el.classList.toggle('is-focus', r.isFocus);
      // re-appending in rank order re-sorts the list
      this.el.standingsBody.appendChild(el);
    }
  }

  setBest(seconds) {
    this.best100 = seconds;
  }

  /** Camera label for city mode (its own pill; #cammode is spectate-only). */
  setCityCam(label) {
    if (!this.el.cityCam) return;
    if (this.last.cityCam !== label) {
      this.el.cityCam.textContent = label;
      this.last.cityCam = label;
    }
  }

  /**
   * City (autonomous driving) panel. payload =
   * { speedKmh, turn: 'LANJUT'|'KIRI'|'KANAN', dist: m|null, dest, light }
   */
  updateCity(p) {
    const speed = Math.round(p.speedKmh);
    if (this.last.citySpeed !== speed) {
      if (this.el.citySpeed) this.el.citySpeed.textContent = String(speed);
      this.last.citySpeed = speed;
    }
    const turnKey = p.turn + '|' + (p.dist === null ? -1 : Math.round(p.dist));
    if (this.last.cityTurn !== turnKey) {
      this.last.cityTurn = turnKey;
      if (this.el.cityTurn) {
        this.el.cityTurn.textContent = p.turn;
        this.el.cityTurn.classList.toggle('is-turn', p.turn !== 'LANJUT');
      }
      if (this.el.cityDist) {
        this.el.cityDist.textContent =
          p.dist === null || p.dist >= 59 ? '' : p.dist + ' m';
      }
    }
    if (this.last.cityDest !== p.dest) {
      this.last.cityDest = p.dest;
      if (this.el.cityDest) this.el.cityDest.textContent = 'MENUJU ' + p.dest;
    }
    if (this.last.cityCar !== p.carLabel) {
      this.last.cityCar = p.carLabel;
      if (this.el.cityCar) this.el.cityCar.textContent = p.carLabel;
    }
    if (this.last.cityLight !== p.light) {
      this.last.cityLight = p.light;
      const el = this.el.cityLight;
      if (el) {
        el.classList.remove('is-green', 'is-yellow', 'is-red');
        if (p.light) el.classList.add('is-' + p.light);
      }
    }
  }

  update(car, sessionTime) {
    const tm = car.telemetry;
    const speed = Math.round(Math.abs(tm.speedKmh));
    const gear = tm.gear;
    const rpm = Math.round(tm.rpm);

    this.topSpeed = Math.max(this.topSpeed, Math.abs(tm.speedKmh));

    if (this.last.speed !== speed) {
      this.el.speed.textContent = String(speed);
      this.last.speed = speed;
    }
    if (this.last.gear !== gear) {
      this.el.gear.textContent = gear;
      this.last.gear = gear;
    }
    if (this.last.rpm !== rpm) {
      this.el.rpm.textContent = String(rpm);
      this.last.rpm = rpm;
      const frac = Math.max(0, Math.min(1, rpm / 8250));
      this.el.speedo?.style.setProperty('--rpm', frac.toFixed(3));
      if (this.el.rpmBar) this.el.rpmBar.style.width = `${(frac * 100).toFixed(1)}%`;
      this.el.gear.classList.toggle('is-redline', rpm > 7300);
    }

    const mm = Math.floor(sessionTime / 60);
    const ss = Math.floor(sessionTime % 60);
    const cc = Math.floor((sessionTime % 1) * 100);
    const t = `${mm}:${String(ss).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
    if (this.last.session !== t) {
      this.el.session.textContent = t;
      this.last.session = t;
    }

    const top = `${Math.round(this.topSpeed)} km/h`;
    if (this.last.top !== top) {
      this.el.top.textContent = top;
      this.last.top = top;
    }

    const best = this.best100 ? `${this.best100.toFixed(2)} s` : '—';
    if (this.last.best !== best) {
      this.el.best.textContent = best;
      this.last.best = best;
    }

    this.el.tc.classList.toggle('is-active', !!tm.tcActive);
    this.el.esc.classList.toggle('is-active', !!tm.escActive);
    // lock-up warning as a stand-in for ABS activity
    const lock = car.wheels.some(
      (w) => w.grounded && Math.abs(w.vLong) > 3 && Math.abs(w.slipRatio) > 0.35,
    );
    this.el.abs.classList.toggle('is-active', lock);
  }
}
