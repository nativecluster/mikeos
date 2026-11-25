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

/**
 * Where the app's own source is published (AGPL-3.0 §6 and §13): the exact
 * source of every package NativeCluster's Store ships, kept public there.
 */
export const NC_APP_SOURCE_URL = "https://github.com/nativecluster/mikeos";
export const NC_APP_LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";

/** The one line Settings shows where sharing would be. */
export const NC_APP_SHARING_UNAVAILABLE =
    "Sharing with your group isn't available in the NativeCluster app yet.";

/**
 * The connectors' net planes (nativecluster/nc-app.json). NativeCluster can
 * turn each off for everyone, with the plane's off switch; the profile names
 * those (`connectorsOff`), and the pages hide their connectors.
 */
export const NC_CONNECTOR_PLANES = ["courtlistener", "websearch", "mcp"] as const;
export type NcConnectorPlane = (typeof NC_CONNECTOR_PLANES)[number];

/** The known planes in what the server sent; anything else is dropped. */
export function ncConnectorPlanes(value: unknown): NcConnectorPlane[] {
    if (!Array.isArray(value)) return [];
    return NC_CONNECTOR_PLANES.filter((plane) => value.includes(plane));
}
