# Testing the packaged app

The means to test Mike as a NativeCluster app without installing it: a fake
NativeCluster host that starts the package as the real host does, a front door
for a browser, a runner that confines the app in NativeCluster's own sandbox,
contract tests for any package, and Mike's e2e tests through the door.

Everything is plain Node (ESM, the system's `node`, no build step), except the
e2e specs, which are Playwright TypeScript like the repository's own `e2e/`.

## One command

```sh
nativecluster/test/run-all.sh <package dir>                # steps 1-4
nativecluster/test/run-all.sh <package dir> --real-models  # and step 5
nativecluster/test/run-all.sh <package dir> --only contract
```

1. **selftest**: the fake host held to NativeCluster's rules, no app (`node --test nativecluster/test/fakehost/`).
2. **contract**: the contract tests, the app unconfined.
3. **e2e**: the e2e specs through the front door, fake models.
4. **sandbox**: the contract tests and the e2e specs again, the app under NativeCluster's app sandbox.
5. **real** (`--real-models`): one short chat and one tiny tabular review on this Mac's NativeCluster, sandboxed. These are the harness's only real model calls.

Each run keeps its state in `nativecluster/test/.runs/all-<time>/`: per step,
the fake host's `ledger.json`, the app's output (`app-output.log`), its data
folder, the rendered `sandbox.sb`, and Playwright's results. The end of the
run says which steps passed, and the script exits non-zero if any failed.

Setup, once: `npm ci` at the repository root (for `@playwright/test`) and
`npx playwright install chromium`. The front door uses 127.0.0.1:43900
(`HARNESS_PORT`), never Stage 1's 42810-42815.

## The fake host (`fakehost/`)

```sh
node nativecluster/test/fakehost/cli.mjs <package dir> [--models fake|nativecluster] [--sandbox]
     [--front 43900|0|off] [--person alice] [--role bob=admin] [--data dir] [--state dir]
     [--keep-credentials] [--line-delay ms]
```

It starts the package the way NativeCluster's host does (`host/host/app.go`
`startLocked`, `apps.go` `otherAppEnv`, origin/main):

- the manifest's `program` from the package folder, in a process group of its own, working folder `/`;
- launchd's environment (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `USER`, `LOGNAME`, `SHELL`), none of the harness's own `LB_*`, `NC_*` or proxy variables, then `LB_APP_SOCKET`, `LB_HOST_SOCKET`, `LB_SECRETS_STDIN=1`, `LB_EXIT_WITH_PARENT=1`, `LB_WRAPPER_RESTART_EXIT=75`, `NC_APP_DATA`, `NC_APP_BASE=/`, `NC_APP_SOCKETS` (`/tmp/nc-XXXXXX/<12 hex>`, emptied at each start), `PYTHONDONTWRITEBYTECODE=1`, and `HOME` and `TMPDIR` inside the data folder;
- the secrets on stdin, one JSON line, then stdin closed: a fresh random `app_credential` and `ticket_key` per start;
- it is started once `GET /healthz`, with a ticket of the host's own (`host: true`), answers 200 or 503.

It stops the app as the host does: SIGTERM, then SIGKILL after the grace
(60 s). It then reports which of the app's processes were still running 3 s
after it ended, before the host ends its group (`leftAfterExit`), and which
survived even that (`escaped`).

The host socket (`hostsocket.mjs`) checks the app credential on every call
and serves what Mike uses:

- `GET /host/v1/models?task=&kind=`: `models`, `windows` and `facts`, for the manifest's tasks that `models.use` names (else 404);
- `POST /host/v1/line/{wait,admit,release,end}`, `GET /host/v1/line/state`: the wait answers NDJSON (`{"position":1,...}`, then the grant);
- `POST /host/v1/units`;
- `/host/v1/secrets/<name>`: kept in memory and in the state folder, 64 KiB a value;
- `/host/v1/people/<id>/role` and `/host/v1/grants?person=`;
- the triggers table, `kick`, `hello` and `firings/{done,renew}`;
- `/host/v1/main/hand` (409 `no_main`);
- `/v1/chat/completions` and `/v1/embeddings` on a live grant (`X-NC-Grant`);
- `/v1/models`, `/api/tags`, `/api/version`, `/api/show` and `/health`.

The socket follows NativeCluster's rules where an app could trip on them
(`host/host/line.go`):

- A wait's ticket must be one the host can check. Lane P is only for a request the front passed to this app within its 20-minute turn, as that request's person. A firing's ticket must name a firing the clock handed over. A job that has outlived its request's turn moves to lane B. An app may not wait on a key's or a main's ticket, nor in lane A.
- A field of the wrong type gets a 400 that names it (`tag.Job is a boolean, not a string`).
- A model call needs a live grant of this app's. A unit's grant carries calls on its own model only. An admitted call is held to its `max_tokens` (`over_admitted`).

Every wait, grant, release and model call goes to the **ledger** (`ledger.json`
in the state folder, and `GET /.harness/ledger`). `node fakehost/ledger-check.mjs
<state>` holds it to "every line wait has exactly one release". It reports
grants never released or released twice, releases of grants the line never
gave, work never ended, and calls refused for their grant.

**Models.** `--models fake` (`models.mjs`) gives fixed, deterministic answers
in OpenAI's chat shapes, streamed or whole. It speaks Mike's protocols:

- a tabular row (one JSON line per column) and a cell (one JSON object), in the format its instruction asks for (`[[Yes]]`, a date, a tag);
- a chat title;
- the upstream e2e fixture's two scripts: `Reply with exactly: X`, and `Read test.pdf and quote its first line.` through `read_document`;
- with tools offered, one harmless read-only tool call (`list_workflows`, else `list_documents`), then words naming its result.

A test can steer it with `[[fake:say …]]`, `[[fake:tool name {args}]]` and
`[[fake:no-tools]]` in a message, or by queuing answers, including a 409
`X-NC-Stopped` or a 503 `Retry-After`, with `POST /.harness/models/script`.

`--models nativecluster` forwards each model call to this Mac's NativeCluster
at `http://localhost:8487/v1` and streams the answer through. The key comes
from the env file that `nativecluster env` names, which is parsed, never run
and never printed. The forward drops `cache_key`, and drops `think` for a
model that does not think: the host socket ignores `think` there, while the
local address refuses it (400 `invalid_value`, measured).

## The front door (`fakehost/front.mjs`)

The door runs on `http://127.0.0.1:43900`, where NativeCluster's app origin
(`https://127.0.0.1:849x`) stands. It signs an `X-NC-Ticket` with the fake
host's ticket key (`iat` now) for the chosen person, and passes every request,
upgrades included, to `LB_APP_SOCKET`. Like the real origin (`origin.go`
`rewriteFor`, `front.go` `appProxy`), it:

- drops an incoming `X-NC-Ticket`, every `Cookie`, an `Authorization` that starts with `Bearer `, and every `Set-Cookie` the app answers;
- answers 404 to `/nativecluster`, `/host/` and `/.nc/`, and 405 to TRACE and TRACK;
- answers 401 itself for nobody signed in.

Other `X-NC-*` headers a browser sends pass through, as they do through the
real host, so the launcher must strip its own (a contract test forges them).
`--keep-credentials` passes cookies and Bearer through, to tell a harness
difference from an app fault.

| Choose | Header | Cookie | Values |
|---|---|---|---|
| the person | `X-Harness-Person` | `nc_harness_person` | a label (`alice`, `bob`, …) that maps to one stable `p_…` id; `nobody` |
| the ticket | `X-Harness-Ticket` | `nc_harness_ticket` | `valid`, `none`, `bad` (another key), `stale` (5 min old) |
| nobody's ticket passed on | `X-Harness-Pass-Nobody: 1` | `nc_harness_pass_nobody` | for the app's own answer to nobody |
| the app's origin | `X-Harness-App-Origin` | `nc_harness_app_origin` | `https://127.0.0.1:849x`: the request reaches the app with that Host, as the real origin passes it (`origin.go` `rewriteFor`), and the door's own Origin and Referer rewritten to it; a Location on it comes back as the door's. Without it the app sees the door's Host (127.0.0.1:43900), and Mike's connectors, which build a sign-in's way back from the Host, refuse to start one |

The ticket carries email and name (`<label>@harness.local`, `Alice`) only when
the manifest asks for `people.read`, as the real host's does.

Control routes are the door's own and never reach the app:

- `GET /.harness/{ready,state,whoami,ledger,ledger/problems?final=1}`;
- `POST /.harness/{person,people,ticket,ledger/reset,models/script,line/hold,line/open,tick,restart}`.

## The sandbox runner (`../dev/`)

```sh
node nativecluster/dev/sandboxed.mjs <package dir> [the fake host's options]
node nativecluster/dev/sandbox/check-installed.mjs     # the profile against the installed host
```

The runner is the same fake host, with the app started through
`/usr/bin/sandbox-exec` under NativeCluster's own app profile.

**Provenance.** `dev/sandbox/profile.mjs` holds `host/host/sandbox.go`
(`appProfile`, `appProfileNet`, `appProfileTerminal`) and `egress.OwnPorts`,
copied verbatim from NativeCluster's origin/main 0eb7aa2a (2026-11-24; the
file last changed in 8db0957c, 2026-11-17). Each piece is byte for byte in the
installed host binary (NativeCluster 0.4.23), and `check-installed.mjs`
re-checks that whenever it is run. It is applied as the host applies it:

- the profile goes to `-p`, and every path to `-D` (`PKG`, `DATA`, `HOST_SOCKET`, `APP_SOCKET`, `SOCKS`), links resolved;
- a running app gets the network part;
- `HOME` and `TMPDIR` are in the data folder;
- `<program> manifest` runs without network or sockets, in a data folder made for that one run.

`<state>/sandbox.sb` is the rendered profile with this run's paths written in.

## Contract tests (`contract/`)

```sh
HARNESS_PKG=<package dir> node --test --test-concurrency=1 nativecluster/test/contract/
HARNESS_SANDBOX=1 …  # every test's app under the sandbox
```

- Every route and every upgrade gets 403 without a valid ticket. Every case of NativeCluster's ticket vectors is moved onto the fake host's key and clock and sent over the socket, plus stale, future and truncated tickets, other tickets' signatures and Bearer prefixes.
- `/healthz` answers the host's ticket with 200 or 503. `/.nc/whoami` names the person by id (never email or name), and an empty person for nobody.
- Forged `X-NC-Person` and `X-NC-Internal` headers change nothing. For Mike: alice keeps her own projects while forging bob, and bob forging alice sees none of hers.
- `<program> manifest` prints nc-app.json byte for byte, plainly and in the install sandbox. `ncdev check` passes.
- Nothing listens on TCP (lsof on the app's process tree and group). Its sockets' paths fit.
- A restart keeps the data: what was at the top of `NC_APP_DATA` remains, and the app's hook checks its own record. For Mike: alice's project is still there, bob doesn't see it, and nobody gets 403 "Sign in to NativeCluster to use Mike.".
- SIGTERM ends the app within the grace, exit 0, with nothing left 3 s later and nothing escaped.
- Every line wait has exactly one release.
- Under the sandbox, the app writes nothing outside `NC_APP_DATA`. The kernel's refusals of native programs (gotrue, postgrest, sh) come from the unified log. Node's write attempts come from a preload: **macOS logs no sandbox refusal for a Node process** (measured: sh, touch, Python and Postgres are logged, node never). The preload (`fakehost/fswatch.mjs`, set through `NODE_OPTIONS` for this one test) records every write, create, rename or remove outside the allowed folders. A positive control first proves that the runner confines (writes in data and `TMPDIR` only; no loopback TCP, no NativeCluster ports, no listening).

Per-app hooks (`contract/apps/<id>.mjs`, `mike.mjs` for any manifest that
says Mike) say when the app is up, what data a restart must keep, which
refusals are its design, and what to exercise.

## Mike's e2e (`e2e/`)

```sh
HARNESS_PKG=<package dir> npx playwright test -c nativecluster/test/e2e   # starts its own fake host
```

NativeCluster is Mike's only login (Pablo, 2026-11-24): the door's person is
the Mike user, so the fixture signs nobody up. Each worker's browser sends
`X-Harness-Person` (worker 0 is `alice`), and onboarding is done once per
worker.

| Project | What |
|---|---|
| `upstream` | Mike's own specs, copied by `stage.ts` into `.upstream/` beside the harness's stand-ins for `fixtures.ts`, `users.ts` and `onboarding.ts` (`shim/`), **unchanged** but for one step: where `helpers.ts` (`createProject`), tabular-reviews (`createReview`) and workflows-settings walk Details → Access, they go past Access only where the page shows it (`lib/wizard.ts`), since the app skips it (accounts are per computer). Staging fails if any of the three no longer matches exactly once. Included: project-management, tabular-reviews, workflows-settings, settings-search, accessibility, critical-path. auth-flows is not staged. |
| `upstream-synthetic` | upstream's browser-mocked specs, unchanged |
| `harness` | `people` (separate projects and documents for two people; nobody's 403 in words; data kept across a restart), `chat-fake` (an answer streams; `read_document` shows and answers; lane P; one release per grant), `tabular-fake` (the cells fill; lane B jobs), `extraction` (a PDF and a DOCX uploaded, checked and indexed by the app's parser threads and found by `find_documents`; no parser child process; no RangeError or dead worker thread in the backend's log), `door`, `connectors` (every button on Settings → Connectors opens a dialog that works, against the real services; below) |
| `real` | `HARNESS_REAL_MODELS=1` only: one short chat and one tiny tabular review |
| `probe` | for the Node probe package: its page, Next in-process, client fetches through the door, and the door's refusals |

**Connectors.** `connectors.spec.ts` reaches the real services, as the
app's own internet does in NativeCluster, through the door as from
`https://127.0.0.1:8494`. Slack (no dynamic client registration, and no
Slack app in the package) and Google are not offered. Each preset Mike
offers (Notion, Airtable, Linear, Lawve, Legal Data Hunter) registers Mike
as a client and opens the Connect dialog: its sign-in link goes to the
service with the way back on the app's origin, and the box takes the
address the browser lands on. CourtListener's key form saves and it is
installed. A custom server with a token (DeepWiki, which takes one and needs
none) connects with its tools; a custom one that signs in (Sentry) opens the
same dialog, refuses an address that is not its sign-in's in words, and
Cancel goes back to the form. No sign-in is ever completed and no person's
data is sent; each run registers a client at those six services.
`HARNESS_NO_INTERNET=1` skips it.

**Set aside.** Upstream tests of what the app does not have are not run
(`stage.ts` `SET_ASIDE`, each with its reason, printed at the start of a
run; their files are kept and staged): Mike's login page and its redirect,
Password, MFA, Delete account and email change (NativeCluster is the only
login), Bring Your Own Keys and its Saved Providers (models come from
NativeCluster alone), and the OAuth popup (the app's window opens none; it
links by the device grant or a pasted address). Ten tests, in
accessibility, critical-path, settings-search, workflows-settings,
settings-search-latency and legal-data-hunter.

The harness's own specs create projects and reviews with `lib/projects.ts`
and `lib/tabular.ts`, past Access the same way.

## Status (2026-11-24)

- **Against the probe** (`~/code/mikeos/nativecluster/probe`, copied; the probe's own folder is never written), `run-all.sh` passes steps 1-3: the selftest, every contract test unconfined, and the probe and door e2e specs. Under the sandbox (step 4), everything passes but one finding, a real one. The probe cannot signal its PostgREST child (EPERM: the sandbox lets a process signal only itself), and PostgREST does not exit when its parent goes. So it is still running 3 s after the probe ends, and only the host's group kill ends it. That fails "SIGTERM leaves no process behind" and the sandboxed e2e step's stop check. Mike's launcher must make each child leave by itself. `--models nativecluster` is proven by one tiny call (`HARNESS_REAL_CALL=1 node --test nativecluster/test/fakehost/`).
- **Against Mike's package** (`nativecluster/build/build.sh`, nativecluster-app 6cea3446, 2026-11-24), `run-all.sh` passes steps 1-4: the selftest (15), every contract test (23) unconfined and sandboxed, and the e2e (44 passed) unconfined and sandboxed, each grant released exactly once and nothing left running after SIGTERM. Ten upstream tests are set aside (above). One more is skipped by upstream's own guard: critical-path's "project document: read uploaded PDF and reload the saved answer" needs a hosted model's key (`e2e/llm.ts`); the harness's chat-fake runs that flow on the fake models.
- **Real models** (step 5, sandboxed, this Mac's NativeCluster 0.4.23, qwen2.5:7b): the short chat answered ("harness ok"), calling one tool (`create_text_card`) on the way; the tiny review's one cell filled ("Test PDF Document"), as a lane B job; every grant released once. The chat also started the assistant's memory work (three lane B calls).

## Where the fake host differs from the installed one

- **The line is not a queue.** Every wait is granted at once (`position` 1). `/.harness/line/hold` holds them, and `--line-delay` slows them. There are no seats, lent Macs or `about_ms`.
- **No clock or idle rest.** The host's beat (`POST /nc/v1/tick`) comes only on `/.harness/tick`. Nothing stops the app for being idle or wakes it.
- **No internet gate.** An app declaring `net.*` gets no `HTTPS_PROXY`/`NC_EGRESS` gate, and runs under the profile without the gate's port (from 0.3.7 the real host lets it reach any server itself as well).
- **The process group** comes from Node's `detached` (setsid: a session and a group), where the host uses Setpgid (a group). Signals reach it alike.
- **The environment** lacks launchd's extras that the installed host passed the probe (`COMMAND_MODE`, `XPC_*`, `SSH_AUTH_SOCK`, `OSLogRateLimit`, `__CFBundleIdentifier`).
- **Plain HTTP.** The door speaks HTTP on 127.0.0.1, where the origin is HTTPS under NativeCluster's CA. Tickets say `tls: true`, as the real origin's do. Nobody signed in gets the door's 401 and no bounce through `:8484`.
