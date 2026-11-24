#!/bin/sh
# Every test of a packaged app, in order, behind the fake NativeCluster host:
#
#   nativecluster/test/run-all.sh <package dir> [--real-models] [--no-sandbox] [--only <step>]
#
#   1. selftest   the fake host held to NativeCluster's own rules (no app)
#   2. contract   the contract tests, the app plain (unconfined)
#   3. e2e        the e2e specs through the front door, fake models, plain
#   4. sandbox    the contract tests, then the e2e specs, the app under
#                 NativeCluster's app sandbox (dev/sandboxed.mjs)
#   5. real       with --real-models only: one short chat and one tiny tabular
#                 review on this Mac's NativeCluster (the only real model calls)
#
# Every step runs whatever failed before it, and the end says which passed.
# Each run's state (ledgers, app output, data, sandbox.sb, Playwright's
# results) is kept in nativecluster/test/.runs/all-<time>/.
#
# Needs: the system's node (22+), the repository's root npm install (for
# @playwright/test) and Playwright's Chromium (npx playwright install chromium).
# Uses 127.0.0.1:43900 for the front door; never 42810-42815.
set -u

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
pkg=""
real=0
sandbox=1
only=""
while [ $# -gt 0 ]; do
	case "$1" in
	--real-models) real=1 ;;
	--no-sandbox) sandbox=0 ;;
	--only) shift; only=$1 ;;
	-h|--help) sed -n '2,22p' "$0"; exit 0 ;;
	*) pkg=$1 ;;
	esac
	shift
done
[ -n "$pkg" ] || { echo "usage: run-all.sh <package dir> [--real-models] [--no-sandbox] [--only selftest|contract|e2e|sandbox|real]" >&2; exit 2; }
pkg=$(cd "$pkg" && pwd) || exit 2
[ -f "$pkg/nc-app.json" ] || { echo "$pkg holds no nc-app.json" >&2; exit 2; }
port=${HARNESS_PORT:-43900}
case "$port" in 4281[0-5]) echo "port $port is Stage 1's: pick another HARNESS_PORT" >&2; exit 2 ;; esac
if /usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
	echo "something already listens on 127.0.0.1:$port (another harness run?)" >&2
	exit 2
fi
[ -d "$repo/node_modules/@playwright/test" ] || { echo "run npm ci in $repo first (Playwright)" >&2; exit 2; }

run="$here/.runs/all-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$run"
app=$(node -e 'const m=require(process.argv[1]); console.log(m.id==="node-probe"?"probe":/mike/i.test(m.id+" "+m.name)?"mike":"other")' "$pkg/nc-app.json")
echo "run-all: $pkg ($app); state in $run"
results=""
failed=0
note() { results="$results\n  $1"; }
want() { [ -z "$only" ] || [ "$only" = "$1" ]; }

# A step's e2e run: the fake host (plain or sandboxed) on the door's port,
# Playwright against it, then the host stopped as NativeCluster stops an app
# and its ledger checked. $1 label, $2 cli, $3 models, $4 Playwright's projects.
e2e() {
	label=$1 cli=$2 models=$3 projects=$4
	state="$run/$label"
	mkdir -p "$state"
	node "$cli" "$pkg" --front "$port" --models "$models" --state "$state" >"$state/fakehost.out" 2>"$state/fakehost.err" &
	hostpid=$!
	i=0
	until grep -q '^ready' "$state/fakehost.out" 2>/dev/null; do
		if ! kill -0 "$hostpid" 2>/dev/null || [ $i -gt 600 ]; then
			echo "run-all: the fake host did not get ready ($label):" >&2
			tail -20 "$state/fakehost.err" >&2
			kill "$hostpid" 2>/dev/null
			return 1
		fi
		i=$((i + 1))
		sleep 0.5
	done
	cat "$state/fakehost.out"
	status=0
	# shellcheck disable=SC2086
	(cd "$repo" && HARNESS_PKG="$pkg" HARNESS_FRONT="http://127.0.0.1:$port" HARNESS_FRONT_RUNNING=1 HARNESS_STATE="$state" \
		HARNESS_MODELS="$models" HARNESS_REAL_MODELS=$([ "$label" = real ] && echo 1 || echo 0) \
		npx playwright test -c nativecluster/test/e2e $projects --output "$state/playwright") || status=1
	kill -TERM "$hostpid" 2>/dev/null
	wait "$hostpid"
	grep -E 'stopped|problem' "$state/fakehost.err"
	if grep -q '"left":\[[^]]' "$state/fakehost.err" || grep -q '"escaped":\[[^]]' "$state/fakehost.err"; then
		echo "run-all: the app left processes behind when stopped ($label)" >&2
		status=1
	fi
	node "$here/fakehost/ledger-check.mjs" "$state" || status=1
	return $status
}

if [ "$app" = mike ]; then
	fake_projects="--project upstream --project upstream-synthetic --project harness"
else
	fake_projects=""
fi

if want selftest; then
	echo "== 1. the fake host's own tests"
	if node --test "$here/fakehost/"; then note "ok    selftest"; else note "FAIL  selftest"; failed=1; fi
fi

if want contract; then
	echo "== 2. contract tests (plain)"
	if HARNESS_PKG="$pkg" HARNESS_RUN_DIR="$run/contract" node --test --test-concurrency=1 "$here/contract/"; then note "ok    contract (plain)"; else note "FAIL  contract (plain)"; failed=1; fi
fi

if want e2e; then
	echo "== 3. e2e, fake models, plain"
	if e2e e2e-plain "$here/fakehost/cli.mjs" fake "$fake_projects"; then note "ok    e2e (plain, fake models)"; else note "FAIL  e2e (plain, fake models)"; failed=1; fi
fi

if want sandbox && [ $sandbox = 1 ]; then
	echo "== 4. contract tests and e2e under NativeCluster's app sandbox"
	if node "$here/../dev/sandbox/check-installed.mjs"; then :; else note "WARN  the sandbox profile differs from the installed NativeCluster's"; fi
	if HARNESS_PKG="$pkg" HARNESS_SANDBOX=1 HARNESS_RUN_DIR="$run/contract-sandboxed" node --test --test-concurrency=1 "$here/contract/"; then note "ok    contract (sandboxed)"; else note "FAIL  contract (sandboxed)"; failed=1; fi
	if e2e e2e-sandboxed "$here/../dev/sandboxed.mjs" fake "$fake_projects"; then note "ok    e2e (sandboxed, fake models)"; else note "FAIL  e2e (sandboxed, fake models)"; failed=1; fi
fi

if want real && [ $real = 1 ]; then
	echo "== 5. one short chat and one tiny tabular review on this Mac's NativeCluster"
	if [ "$app" != mike ]; then
		note "skip  real models (only Mike has the real-model specs)"
	elif e2e real "$here/../dev/sandboxed.mjs" nativecluster "--project real"; then note "ok    real models (sandboxed)"; else note "FAIL  real models"; failed=1; fi
fi

printf "run-all: %s%b\n" "$pkg" "$results"
echo "state: $run"
exit $failed
