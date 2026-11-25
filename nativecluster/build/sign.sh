#!/bin/sh
# Signs Mike's built package for NativeCluster's Store, checks it, and zips it:
#
#   nativecluster/build/sign.sh <package folder> [identity] [zip]
#
# It needs only what macOS and Xcode's command line tools carry (codesign,
# lipo, file, ditto, plutil, shasum): no Node, no repository. Run it on the
# Mac that holds the team's Developer ID, on the folder build.sh made (or
# the one handed over), then send the zip to Apple's notary service.
#
#   identity  default "Developer ID Application: Pablo Eder (RM68U4477F)",
#             the team NativeCluster's host requires. "-" signs ad hoc, to
#             try the hardened runtime on a Mac without that identity:
#             ad hoc code has no team, so library validation cannot hold
#             and each program also gets disable-library-validation, and
#             there is no timestamp; such a package is for testing only.
#   zip       default <the folder's parent>/mikeos-<version>-darwin-arm64.zip
#
# What it does, as Apple's notary service asks of every Mach-O file before
# NativeCluster's Store publishes a package (NativeCluster's register,
# NC-121), and as Hermes's build does:
#   1. every Mach-O keeps its Apple silicon code alone (lipo -thin arm64);
#   2. libraries (dylibs, Node addons) are signed first, then programs, with
#      the hardened runtime and a secure timestamp. Node alone gets one
#      entitlement, allow-jit: V8 and PGlite's WebAssembly compile code as
#      they run. Library validation stays on, so Node and PostgREST load only
#      libraries signed by Apple or by the team, which is every one here;
#   3. the launcher, the `mike` script, is signed last (its signature rides
#      in its extended attributes: zip it with ditto, never xattr -c it);
#   4. every Mach-O and the launcher are checked; a build from a tree with
#      uncommitted changes is refused;
#   5. ditto -c -k --keepParent makes the zip, and its SHA-256 is printed.
set -eu

team=RM68U4477F
pkg=${1:?usage: sign.sh <package folder> [identity] [zip]}
identity=${2:-${MIKE_SIGN_IDENTITY:-Developer ID Application: Pablo Eder ($team)}}
pkg=$(cd "$pkg" && pwd -P)
[ -f "$pkg/nc-app.json" ] && [ -f "$pkg/mike" ] && [ -f "$pkg/runtime/bin/node" ] || {
	echo "sign.sh: $pkg is not Mike's package (no nc-app.json, mike or runtime/bin/node)" >&2; exit 2; }
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$pkg/nc-app.json")
[ -n "$version" ] || { echo "sign.sh: no version in nc-app.json" >&2; exit 2; }
zip=${3:-$(dirname "$pkg")/mikeos-$version-darwin-arm64.zip}

adhoc=0
[ "$identity" = "-" ] && adhoc=1
if [ $adhoc = 0 ]; then
	grep -q "uncommitted changes" "$pkg/NOTICE" 2>/dev/null && {
		echo "sign.sh: this build was made from a tree with uncommitted changes (NOTICE); build it again from a commit" >&2; exit 1; }
	[ -f "$pkg/NOTICE" ] && [ -f "$pkg/LICENSE" ] || { echo "sign.sh: LICENSE or NOTICE is missing" >&2; exit 1; }
	stamp=--timestamp
else
	stamp=--timestamp=none
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

# Entitlements: Node's allow-jit; ad hoc, every program's library validation off.
plist() { # <file> <key>...
	f=$1; shift
	{ echo '<?xml version="1.0" encoding="UTF-8"?>'
	  echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
	  echo '<plist version="1.0"><dict>'
	  for k in "$@"; do echo "<key>$k</key><true/>"; done
	  echo '</dict></plist>'; } >"$f"
	plutil -lint -s "$f"
}
if [ $adhoc = 1 ]; then
	plist "$work/node.plist" com.apple.security.cs.allow-jit com.apple.security.cs.disable-library-validation
	plist "$work/program.plist" com.apple.security.cs.disable-library-validation
else
	plist "$work/node.plist" com.apple.security.cs.allow-jit
fi

# Every Mach-O file, by its contents (never by name or mode).
# file pads its answers into a column when given many files: -N stops that.
find "$pkg" -type f -print0 | xargs -0 file -h -N --mime-type -F '|' |
	sed -n 's/^\(.*\)|[[:space:]]*application\/x-mach-binary$/\1/p' >"$work/macho"
[ -s "$work/macho" ] || { echo "sign.sh: found no Mach-O file in $pkg" >&2; exit 1; }
: >"$work/libraries"; : >"$work/programs"
while IFS= read -r f; do
	case $(file -h -b "$f") in
	*executable*) echo "$f" >>"$work/programs" ;;
	*) echo "$f" >>"$work/libraries" ;;
	esac
done <"$work/macho"
n=$(wc -l <"$work/macho" | tr -d ' ')
echo "sign.sh: $n Mach-O files: $(wc -l <"$work/programs" | tr -d ' ') programs, $(wc -l <"$work/libraries" | tr -d ' ') libraries"
grep -qx "$pkg/runtime/bin/node" "$work/programs" || { echo "sign.sh: runtime/bin/node is not among the programs" >&2; exit 1; }

# 1. Apple silicon alone.
while IFS= read -r f; do
	archs=$(lipo -archs "$f")
	case " $archs " in
	" arm64 ") ;;
	*" arm64 "*) lipo -thin arm64 "$f" -output "$work/thin" && cat "$work/thin" >"$f" && rm "$work/thin" ;;
	*) echo "sign.sh: $f has no Apple silicon code ($archs)" >&2; exit 1 ;;
	esac
done <"$work/macho"

# 2. Libraries, then programs.
while IFS= read -r f; do
	codesign --force --options runtime $stamp --sign "$identity" "$f"
done <"$work/libraries"
while IFS= read -r f; do
	if [ "$f" = "$pkg/runtime/bin/node" ]; then
		codesign --force --options runtime $stamp --entitlements "$work/node.plist" --sign "$identity" "$f"
	elif [ $adhoc = 1 ]; then
		codesign --force --options runtime $stamp --entitlements "$work/program.plist" --sign "$identity" "$f"
	else
		codesign --force --options runtime $stamp --sign "$identity" "$f"
	fi
done <"$work/programs"

# 3. The launcher, last.
codesign --force $stamp --sign "$identity" "$pkg/mike"

# 4. Check.
bad=0
fail() { echo "sign.sh: $1" >&2; bad=1; }
while IFS= read -r f; do
	rel=${f#"$pkg"/}
	codesign --verify --strict "$f" 2>/dev/null || fail "$rel: signature does not verify"
	[ "$(lipo -archs "$f")" = arm64 ] || fail "$rel: code for another processor"
	info=$(codesign -dv "$f" 2>&1)
	case $info in *"(runtime)"* | *",runtime"* | *"runtime,"*) ;; *) fail "$rel: no hardened runtime" ;; esac
	ents=$(codesign -d --entitlements - --xml "$f" 2>/dev/null | plutil -convert json -o - - 2>/dev/null || echo '{}')
	case $ents in *get-task-allow*) fail "$rel: has get-task-allow" ;; esac
	if [ $adhoc = 0 ]; then
		case $info in *"TeamIdentifier=$team"*) ;; *) fail "$rel: not signed by team $team" ;; esac
		case $info in *"Timestamp="*) ;; *) fail "$rel: no secure timestamp" ;; esac
		if [ "$f" = "$pkg/runtime/bin/node" ]; then
			[ "$ents" = '{"com.apple.security.cs.allow-jit":true}' ] || fail "$rel: entitlements are not allow-jit alone: $ents"
		else
			case $ents in '{}' | '') ;; *) fail "$rel: has entitlements: $ents" ;; esac
		fi
	fi
done <"$work/macho"
codesign --verify --strict "$pkg/mike" 2>/dev/null || fail "mike: signature does not verify"
if [ $adhoc = 0 ]; then
	codesign --verify --strict -R="anchor apple generic and certificate leaf[subject.OU] = $team" "$pkg/mike" ||
		fail "mike: not signed by team $team"
	codesign -dv "$pkg/mike" 2>&1 | grep -q '^Timestamp=' || fail "mike: no secure timestamp"
fi
"$pkg/runtime/bin/node" -e 'new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))' ||
	fail "runtime/bin/node does not run, or cannot compile WebAssembly, under its signature"
[ $bad = 0 ] || { echo "sign.sh: the package is not ready; nothing zipped" >&2; exit 1; }
echo "sign.sh: every Mach-O signed and checked$( [ $adhoc = 1 ] && echo ' (ad hoc: for testing only, never for the Store)')"

# 5. Zip.
rm -f "$zip"
ditto -c -k --keepParent "$pkg" "$zip"
echo "sign.sh: $zip"
shasum -a 256 "$zip"
