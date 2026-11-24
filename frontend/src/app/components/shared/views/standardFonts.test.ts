import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    STANDARD_FONT_DATA_URL,
    VENDORED_STANDARD_FONT_DATA_URL,
    standardFontDataUrl,
} from "./highlightQuote";

const FRONTEND = resolve(__dirname, "../../../../..");
const installed = `${FRONTEND}/node_modules/pdfjs-dist/standard_fonts/`;
const vendored = `${FRONTEND}/public${VENDORED_STANDARD_FONT_DATA_URL}`;

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("pdf.js standard fonts", () => {
    it("come from the CDN outside the NativeCluster app, as before", () => {
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "");
        expect(standardFontDataUrl()).toBe(STANDARD_FONT_DATA_URL);
    });

    it("come from the app's own origin in the NativeCluster app", () => {
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "1");
        const url = new URL(standardFontDataUrl());
        expect(url.origin).toBe(window.location.origin);
        expect(url.pathname).toBe(VENDORED_STANDARD_FONT_DATA_URL);
        // pdf.js refuses a factory URL without its trailing slash.
        expect(standardFontDataUrl().endsWith("/")).toBe(true);
    });

    it("are served as an exact copy of the installed pdfjs-dist's", () => {
        const files = readdirSync(installed).sort();
        expect(files.length).toBeGreaterThan(0);
        expect(readdirSync(vendored).sort()).toEqual(files);
        for (const file of files) {
            expect(
                readFileSync(`${vendored}${file}`).equals(
                    readFileSync(`${installed}${file}`),
                ),
                `public/pdfjs/standard_fonts/${file} differs from pdfjs-dist's: copy node_modules/pdfjs-dist/standard_fonts/ again`,
            ).toBe(true);
        }
    });
});
