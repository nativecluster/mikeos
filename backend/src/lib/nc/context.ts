// What started the work in hand, when Mike runs as a NativeCluster app.
//
// NativeCluster's host lets a model call wait in its line only on the origin
// of whatever started it: a person's request (the id the host put in that
// request's ticket), or a job one started. The launcher checks each ticket
// and passes its person and id to the backend in X-NC-Person and X-NC-Request
// (lib/nc/ingress.ts), which run the request inside this scope; the DB-job
// runner runs each job inside one of its own (lib/dbq/runner.ts). The model
// layer (lib/nc/hostLine.ts) reads it to name the call's origin, lane and task.
//
// Outside the app nothing enters a scope, and every reader answers undefined.

import { AsyncLocalStorage } from "node:async_hooks";

/** The tasks Mike's manifest lists (nc-app.json `tasks`). */
export const NC_TASKS = ["assistant", "tabular", "playbook", "titles", "memory"] as const;
export type NcTask = (typeof NC_TASKS)[number];

/**
 * Long work: it waits as a job, in the background lane, whether a person's
 * request or the DB-job runner started it.
 */
export const NC_JOB_TASKS: ReadonlySet<NcTask> = new Set(["tabular", "playbook", "memory"]);

/** How long the host lets a person's request stand in its line (20 minutes, less a margin). */
export const REQUEST_TURN_MS = 19 * 60 * 1000;

export type NcRequest = {
  /** The ticket's person ("p_…"), or "" when nobody is signed in. */
  person: string;
  /** The ticket's id. */
  request: string;
  /** When the request reached this process (ms since the epoch). */
  at: number;
  /** The task its route says it is (ncTaskForPath). */
  task: NcTask;
};

export type NcJob = {
  /** The task its kind says it is. */
  task: NcTask;
  person: string;
  /** The request that queued it, while the host may still know it. */
  request?: string;
  /** When that request reached the process that queued the job. */
  at?: number;
};

/** One model call's own facts, set by the provider layer around the call. */
export type NcCall = {
  /** "stream" for a chat turn, "complete" for a one-shot completion. */
  kind?: "stream" | "complete";
  /** The task the call site names, when it names one. */
  task?: NcTask;
  /** An opaque id of the conversation the call continues. */
  conversation?: string;
};

export type NcScope = {
  request?: NcRequest;
  job?: NcJob;
  call?: NcCall;
};

const storage = new AsyncLocalStorage<NcScope>();

export function currentNcScope(): NcScope | undefined {
  return storage.getStore();
}

/** The person the work in hand is for ("" or undefined when none). */
export function currentNcPerson(): string | undefined {
  const scope = storage.getStore();
  return scope?.job?.person ?? scope?.request?.person;
}

export function runInNcRequest<T>(request: NcRequest, fn: () => T): T {
  return storage.run({ request }, fn);
}

export function runInNcJob<T>(job: NcJob, fn: () => T): T {
  return storage.run({ job }, fn);
}

/** Run fn with the call's facts added to the scope in hand (none: a scope of its own). */
export function runInNcCall<T>(call: NcCall, fn: () => T): T {
  const scope = storage.getStore();
  return storage.run({ ...scope, call: { ...scope?.call, ...call } }, fn);
}

/**
 * The task a request's route says it is. Coarse on purpose: a call site that
 * knows better (a chat's title) says so for its call.
 */
export function ncTaskForPath(path: string): NcTask {
  if (/\/tabular-review\/[^/]+\/chat(?:\/|$)/.test(path)) return "assistant";
  if (/\/tabular-review(?:\/|$)/.test(path)) return "tabular";
  if (/\/playbooks(?:\/|$)/.test(path)) return "playbook";
  if (/\/memory(?:\/|$)/.test(path)) return "memory";
  return "assistant";
}

/** The DB job kinds of long model work, by task: each is one of the app's units. */
const NC_JOB_KIND_TASKS: Readonly<Record<string, NcTask>> = {
  "extraction.extract": "tabular",
  "playbook.review": "playbook",
  "playbook.import": "playbook",
  "memory.consolidate": "memory",
};

export const NC_JOB_KINDS: readonly string[] = Object.keys(NC_JOB_KIND_TASKS);

/** A DB job kind's task, or undefined for a kind that makes no model call. */
export function ncTaskForJobKind(kind: string): NcTask | undefined {
  return Object.hasOwn(NC_JOB_KIND_TASKS, kind) ? NC_JOB_KIND_TASKS[kind] : undefined;
}

/** What a job's payload keeps of the request that queued it (`_nc`). */
export type NcJobOrigin = { person?: string; request?: string; at?: number };

export const NC_JOB_ORIGIN_KEY = "_nc";

/** The `_nc` a job queued now keeps, or undefined outside a request or job. */
export function ncJobOriginNow(scope: NcScope | undefined = storage.getStore()): NcJobOrigin | undefined {
  if (scope?.job) return scope.job.person ? { person: scope.job.person } : undefined;
  const request = scope?.request;
  if (!request) return undefined;
  return {
    ...(request.person ? { person: request.person } : {}),
    ...(request.request ? { request: request.request, at: request.at } : {}),
  };
}

/** The job scope a claimed job runs in, from its kind and its payload's `_nc`. */
export function ncJobFor(kind: string, payload: Record<string, unknown> | null | undefined): NcJob {
  const raw = payload?.[NC_JOB_ORIGIN_KEY];
  const kept = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const person = typeof kept.person === "string" ? kept.person : "";
  const request = typeof kept.request === "string" && kept.request ? kept.request : undefined;
  const at = typeof kept.at === "number" && Number.isFinite(kept.at) ? kept.at : undefined;
  return {
    task: ncTaskForJobKind(kind) ?? "assistant",
    person,
    ...(request ? { request } : {}),
    ...(at !== undefined ? { at } : {}),
  };
}

export function isNcTask(value: unknown): value is NcTask {
  return typeof value === "string" && (NC_TASKS as readonly string[]).includes(value);
}

/** The ticket a wait in line carries (sched.WireTicket). */
export type NcTicket = {
  origin: "request" | "job";
  from?: "request" | "resume";
  person?: string;
  request?: string;
};

export type NcOrigin = {
  ticket: NcTicket;
  lane: "P" | "B";
  task: NcTask;
  job: boolean;
  person: string;
  conversation?: string;
};

/** When this process started: a request from before it is no request the host still holds for it. */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

function jobTicket(person: string, request: string | undefined, at: number | undefined, now: number): NcTicket {
  const knownRequest =
    !!request && at !== undefined && at >= PROCESS_STARTED_AT && now - at < REQUEST_TURN_MS;
  return knownRequest
    ? { origin: "job", from: "request", ...(person ? { person } : {}), request }
    : { origin: "job", from: "resume", ...(person ? { person } : {}) };
}

/**
 * The origin, lane and task of a model call made now, or undefined when
 * nothing started it (a call made outside any request or job).
 *
 * - A job of the DB-job runner waits as a job, in lane B: "from request"
 *   while the request that queued it is still within its turn in this
 *   process, "from resume" after.
 * - Long work a request started (tabular, playbooks, memory) waits as a job
 *   from that request, in lane B.
 * - Anything else a request started waits as the person's request, in lane
 *   P; past the request's turn, as a job from it (the host moves it to B).
 */
export function ncOriginFor(scope: NcScope | undefined = storage.getStore(), now = Date.now()): NcOrigin | undefined {
  if (!scope) return undefined;
  const conversation = scope.call?.conversation || undefined;
  if (scope.job) {
    const task = scope.call?.task ?? scope.job.task;
    return {
      ticket: jobTicket(scope.job.person, scope.job.request, scope.job.at, now),
      lane: "B",
      task,
      job: true,
      person: scope.job.person,
      ...(conversation ? { conversation } : {}),
    };
  }
  const request = scope.request;
  if (!request) return undefined;
  const task = scope.call?.task ?? request.task;
  if (NC_JOB_TASKS.has(task)) {
    return {
      ticket: jobTicket(request.person, request.request, request.at, now),
      lane: "B",
      task,
      job: true,
      person: request.person,
      ...(conversation ? { conversation } : {}),
    };
  }
  const inTurn = now - request.at < REQUEST_TURN_MS;
  return {
    ticket: inTurn
      ? { origin: "request", person: request.person, request: request.request }
      : { origin: "job", from: "request", person: request.person, request: request.request },
    lane: "P",
    task,
    job: !inTurn,
    person: request.person,
    ...(conversation ? { conversation } : {}),
  };
}

/** Test seam: the process start this module measures requests against. */
export const ncProcessStartedAt = PROCESS_STARTED_AT;
