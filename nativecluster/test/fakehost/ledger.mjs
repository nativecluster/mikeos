// What the fake host saw of an app's use of its socket: every wait in line
// and what it got, every grant and each release of it, every model call,
// and the other routes' calls (names and counts, never a secret's value or a
// prompt's words). Tests read it to hold the app to "every line wait has
// exactly one release" and to check lanes and origins.
//
// It is kept in memory and written to <file> (JSON) after each change, so a
// test in another process (Playwright) can read it too.

import { writeFileSync, renameSync } from "node:fs";

export class Ledger {
  constructor(file = null) {
    this.file = file;
    this.reset();
    this._timer = null;
  }

  reset() {
    this.started = new Date().toISOString();
    this.waits = []; // {seq, at, kind, lane, tag, ticket, pick, turn, call, answer, refused, left_early}
    this.grants = {}; // id -> {id, via, work, wait, model, lane, origin, from, person, request, firing, created, releases: [], calls: 0}
    this.works = {}; // id -> {id, wait, lane, ends: [], admits: 0}
    this.unknownReleases = []; // {at, grant}
    this.unknownEnds = [];
    this.calls = []; // {at, path, grant, model, status, stream, tools, tool_calls, ms}
    this.refusedCalls = []; // {at, path, why, status}
    this.unauthorized = 0;
    this.routes = {}; // "GET /host/v1/models" -> count
    this.units = []; // the app's /host/v1/units reports (as sent; numbers only)
    this.events = []; // other notable things, in words
    this.seq = 0;
    this.save();
  }

  route(method, path) {
    const k = `${method} ${path}`;
    this.routes[k] = (this.routes[k] ?? 0) + 1;
  }

  note(words) {
    this.events.push({ at: new Date().toISOString(), words });
    this.save();
  }

  wait(entry) {
    entry.seq = ++this.seq;
    entry.at = new Date().toISOString();
    this.waits.push(entry);
    this.save();
    return entry;
  }

  grant(g) {
    this.grants[g.id] = { ...g, created: new Date().toISOString(), releases: [], calls: 0 };
    this.save();
    return this.grants[g.id];
  }

  work(w) {
    this.works[w.id] = { ...w, created: new Date().toISOString(), ends: [], admits: 0 };
    this.save();
    return this.works[w.id];
  }

  release(id, notes) {
    const g = this.grants[id];
    const r = { at: new Date().toISOString(), notes: notes ?? null };
    if (!g) this.unknownReleases.push({ ...r, grant: id });
    else g.releases.push(r);
    this.save();
    return g;
  }

  end(id) {
    const w = this.works[id];
    if (!w) this.unknownEnds.push({ at: new Date().toISOString(), work: id });
    else w.ends.push(new Date().toISOString());
    this.save();
    return w;
  }

  call(c) {
    this.calls.push({ at: new Date().toISOString(), ...c });
    if (c.grant && this.grants[c.grant]) this.grants[c.grant].calls++;
    this.save();
  }

  refusedCall(c) {
    this.refusedCalls.push({ at: new Date().toISOString(), ...c });
    this.save();
  }

  /**
   * What is wrong, in words: a grant released never or more than once, a
   * release or end naming nothing, begun work never ended, a call refused for
   * its grant. `live` grants (still held while the app works) count as never
   * released only when `final` is true.
   */
  problems({ final = true } = {}) {
    const out = [];
    for (const g of Object.values(this.grants)) {
      if (g.releases.length > 1) out.push(`grant ${g.id} (${g.via}, lane ${g.lane}, ${g.origin}) was released ${g.releases.length} times`);
      if (final && g.releases.length === 0) out.push(`grant ${g.id} (${g.via}, lane ${g.lane}, ${g.origin}, ${g.calls} calls) was never released`);
    }
    for (const r of this.unknownReleases) out.push(`a release named grant ${JSON.stringify(r.grant)}, which the line never gave`);
    for (const w of Object.values(this.works)) {
      if (w.ends.length > 1) out.push(`work ${w.id} was ended ${w.ends.length} times`);
      if (final && w.ends.length === 0) out.push(`work ${w.id} (lane ${w.lane}) was begun and never ended`);
    }
    for (const e of this.unknownEnds) out.push(`an end named work ${JSON.stringify(e.work)}, which the line never began`);
    for (const c of this.refusedCalls) out.push(`a model call to ${c.path} was refused: ${c.why}`);
    return out;
  }

  /** Counts by lane and origin, for asserting where work waited. */
  summary() {
    const by = {};
    for (const w of this.waits) {
      const k = `${w.kind}/${w.lane}/${w.ticket?.origin ?? "?"}${w.ticket?.from ? "<" + w.ticket.from : ""}`;
      by[k] = (by[k] ?? 0) + 1;
    }
    return {
      waits: this.waits.length,
      refused: this.waits.filter((w) => w.refused).length,
      grants: Object.keys(this.grants).length,
      releases: Object.values(this.grants).reduce((n, g) => n + g.releases.length, 0),
      calls: this.calls.length,
      by,
    };
  }

  toJSON() {
    return {
      started: this.started,
      summary: this.summary(),
      problems: this.problems({ final: false }),
      waits: this.waits,
      grants: this.grants,
      works: this.works,
      unknownReleases: this.unknownReleases,
      unknownEnds: this.unknownEnds,
      calls: this.calls,
      refusedCalls: this.refusedCalls,
      unauthorized: this.unauthorized,
      routes: this.routes,
      units: this.units,
      events: this.events,
    };
  }

  save() {
    if (!this.file || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 50);
    this._timer.unref?.();
  }

  flush() {
    if (!this.file) return;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    try {
      writeFileSync(this.file + ".tmp", JSON.stringify(this, null, 2));
      renameSync(this.file + ".tmp", this.file);
    } catch {}
  }
}
