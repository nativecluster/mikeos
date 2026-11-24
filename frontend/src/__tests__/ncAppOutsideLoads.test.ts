// The NativeCluster app's pages load nothing from outside (the host serves
// them at the app's own origin, and the sandbox gives pages no internet of
// their own). The pages' own outside loads are each gated on isNcApp() where
// they are made; this test keeps new ones from slipping in unnoticed.

import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const FRONTEND = resolve(__dirname, "../..");
const rel = (file: string) => relative(FRONTEND, file).split(sep).join("/");

/** The sources `next build` compiles (tsconfig.build.json leaves tests out). */
function productionSources(): string[] {
    const configPath = join(FRONTEND, "tsconfig.build.json");
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(read.error, "tsconfig.build.json must parse").toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, FRONTEND);
    const files = parsed.fileNames.filter((file) => !file.includes("node_modules"));
    expect(files.length).toBeGreaterThan(0);
    return files;
}

/**
 * Hosts a page would fetch a script, stylesheet or font from. Each file that
 * names one chooses the app's own copy when isNcApp() is on.
 */
const ASSET_CDN = /https:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)/;
const GATED_ON_NC_APP = new Set([
    // pdf.js standard fonts: standardFontDataUrl() serves the vendored copy.
    "src/app/components/shared/views/highlightQuote.ts",
    // The report-only CSP: securityHeaders(…, ncApp) names no CDN.
    "src/app/lib/securityHeaders.ts",
]);

describe("the NativeCluster app loads nothing from outside", () => {
    it("names an asset CDN only where the app's own copy replaces it", () => {
        const offenders = productionSources()
            .filter((file) => ASSET_CDN.test(readFileSync(file, "utf8")))
            .map(rel)
            .filter((file) => !GATED_ON_NC_APP.has(file));
        expect(offenders).toEqual([]);
        for (const file of GATED_ON_NC_APP) {
            expect(
                readFileSync(join(FRONTEND, file), "utf8"),
                `${file} must choose the app's own copy with isNcApp()`,
            ).toMatch(/isNcApp\(\)|ncApp/);
        }
    });

    it("never imports the DOCX editor's Google font catalog, which loads from cdn.jsdelivr.net", () => {
        // packagedFonts() (@docx-editor.dev/fonts) bundles its fonts as the
        // app's own assets; the "./google" entry fetches from the CDN.
        const offenders = productionSources()
            .filter((file) =>
                /["']@docx-editor\.dev\/fonts\/google["']/.test(readFileSync(file, "utf8")),
            )
            .map(rel);
        expect(offenders).toEqual([]);
    });
});
