// The one rule for a NativeCluster person id, when Mike runs as a
// NativeCluster app (MIKE_NC_APP=1).
//
// The host names a person to an app by an id it made for that app alone:
// `p_` and hex (`"p_" + randomHex(16)`, host/host/origin.go; the spec's
// vectors use `p_7f3a`). Everything that reads one reads it here: the
// launcher's X-NC-Person as the ingress passes it on (lib/nc/ingress.ts),
// the sign-in that makes the person's account (lib/authApp.ts), and the
// connectors, whose secret names carry the person between `:` separators
// (lib/mcp/ncApp.ts, hostSecretColumns.ts). One pattern, so an id one of
// them takes can never read as "no person" to another (the 2026-11-24
// security review, L3).
//
// Anything else is no person. "No person" is never a wildcard: what needs a
// person refuses without one.

export const NC_PERSON_ID_RE = /^p_[A-Za-z0-9]{1,64}$/;

/** The person id `value` names, trimmed, or null when it is not one. */
export function ncPersonIdOf(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return NC_PERSON_ID_RE.test(trimmed) ? trimmed : null;
}
