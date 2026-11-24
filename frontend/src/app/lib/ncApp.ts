/**
 * Mike packaged as a NativeCluster app.
 *
 * NativeCluster runs the app inside its macOS sandbox on each person's own
 * computer and shows its pages in its own app window, at an origin of the
 * app's own (`https://127.0.0.1:<port>`, a port that differs per computer).
 * The host drops every Set-Cookie the app sends, pages may load nothing from
 * outside, and accounts are per computer. The package is built with
 * `NEXT_PUBLIC_MIKE_NC_APP=1`; every other deployment leaves it unset and
 * behaves exactly as before.
 *
 * Read at call time (Next inlines the literal at build time), so tests can
 * stub it with `vi.stubEnv`.
 */
export function isNcApp(): boolean {
    return process.env.NEXT_PUBLIC_MIKE_NC_APP === "1";
}

/** The one line Settings shows where sharing would be. */
export const NC_APP_SHARING_UNAVAILABLE =
    "Sharing with your group isn't available in the NativeCluster app yet.";
