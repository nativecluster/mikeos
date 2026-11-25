/**
 * DOCX tracked-changes helpers.
 *
 * `applyTrackedEdits` rewrites a .docx so that the requested substitutions
 * appear as `<w:ins>` / `<w:del>` tracked changes rather than direct text
 * replacements. `resolveTrackedChange` accepts or rejects one change by
 * its `w:id`, producing a new .docx with only that change collapsed.
 *
 * Only text inside `<w:p><w:r><w:t>` is considered. Headers, footers,
 * comments, footnotes are left alone. Pre-existing tracked changes in the
 * paragraph are presented to the matcher in *accepted view*: w:ins runs are
 * treated as normal text, w:del wrappers are invisible. When a new edit's
 * range lands on runs inside a pre-existing w:ins, the wrapper is dropped
 * (accepting that insertion) before the new change is emitted.
 */

import JSZip from "jszip";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { readZipEntryBounded } from "./docxpackagevalidation";

// ---------------------------------------------------------------------------
// JSZip path helpers
// ---------------------------------------------------------------------------
//
// Some older Windows/Word archives store entries with backslash path
// separators (e.g. `word\document.xml`) even though the zip spec requires
// forward slashes. JSZip looks up entries by exact string, so
// `zip.file("word/document.xml")` misses those files. These helpers accept
// the canonical forward-slash form and transparently fall back to the
// backslash variant for both reads and writes.

function getZipEntry(zip: JSZip, pathSlash: string) {
    const direct = zip.file(pathSlash);
    if (direct) return direct;
    return zip.file(pathSlash.replace(/\//g, "\\"));
}

function setZipEntry(
    zip: JSZip,
    pathSlash: string,
    content: string | Buffer,
): void {
    const backslash = pathSlash.replace(/\//g, "\\");
    // If the archive already stores the entry under backslashes, keep it
    // there so we don't emit both variants side by side.
    if (!zip.file(pathSlash) && zip.file(backslash)) {
        zip.file(backslash, content);
        return;
    }
    zip.file(pathSlash, content);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EditInput {
    find: string;
    replace: string;
    context_before: string;
    context_after: string;
    reason?: string;
}

export interface AppliedChange {
    id: string;
    delId?: string;
    insId?: string;
    deletedText: string;
    insertedText: string;
    contextBefore: string;
    contextAfter: string;
    reason?: string;
}

export interface EditError {
    index: number;
    reason: string;
}

export interface ApplyTrackedEditsResult {
    bytes: Buffer;
    changes: AppliedChange[];
    errors: EditError[];
}

// ---------------------------------------------------------------------------
// Preserve-order tree helpers
// ---------------------------------------------------------------------------

type XNode = Record<string, unknown>;

const ATTR_KEY = ":@";
const TEXT_KEY = "#text";

function elName(n: unknown): string | null {
    if (!n || typeof n !== "object") return null;
    for (const k of Object.keys(n as XNode)) {
        if (k === ATTR_KEY || k === TEXT_KEY) continue;
        return k;
    }
    return null;
}

function isTextNode(n: unknown): n is { [TEXT_KEY]: string } {
    if (!n || typeof n !== "object") return false;
    const obj = n as XNode;
    return TEXT_KEY in obj && elName(n) === null;
}

function elChildren(n: unknown): XNode[] {
    const name = elName(n);
    if (!name) return [];
    const v = (n as XNode)[name];
    return Array.isArray(v) ? (v as XNode[]) : [];
}

function setChildren(n: XNode, children: XNode[]): void {
    const name = elName(n);
    if (!name) return;
    n[name] = children;
}

function elAttrs(n: unknown): Record<string, string> {
    if (!n || typeof n !== "object") return {};
    const a = (n as XNode)[ATTR_KEY];
    return (a as Record<string, string>) ?? {};
}

function makeEl(
    name: string,
    children: XNode[] = [],
    attrs?: Record<string, string>,
): XNode {
    const el: XNode = { [name]: children };
    if (attrs) {
        const attrObj: Record<string, string> = {};
        for (const [k, v] of Object.entries(attrs)) {
            attrObj[`@_${k}`] = v;
        }
        el[ATTR_KEY] = attrObj;
    }
    return el;
}

function makeText(s: string): XNode {
    return { [TEXT_KEY]: s };
}

function getTextContent(wtEl: XNode): string {
    // A w:t node has only a single text child (or nothing).
    const kids = elChildren(wtEl);
    let out = "";
    for (const k of kids) {
        if (isTextNode(k)) out += String(k[TEXT_KEY] ?? "");
    }
    return out;
}

// Build a w:r element that wraps a piece of text. Newlines in the text are
// emitted as <w:br/> soft line breaks (interleaved with w:t/w:delText
// segments) so models can request multi-line replacements without the
// literal "\n" showing up as visible text.
function buildRun(rPr: XNode | null, text: string, tagName: "w:t" | "w:delText"): XNode {
    const children: XNode[] = [];
    if (rPr) children.push(cloneNode(rPr));
    const segments = text.split("\n");
    for (let i = 0; i < segments.length; i++) {
        if (i > 0) children.push(makeEl("w:br", []));
        const seg = segments[i];
        if (seg.length > 0) {
            children.push(
                makeEl(tagName, [makeText(seg)], { "xml:space": "preserve" }),
            );
        }
    }
    return makeEl("w:r", children);
}

function cloneNode<T>(n: T): T {
    return JSON.parse(JSON.stringify(n)) as T;
}

// ---------------------------------------------------------------------------
// Paragraph flattening
// ---------------------------------------------------------------------------

interface RunSlot {
    childIndex: number;         // index in paragraph.children
    rPr: XNode | null;          // reference (not cloned)
    /**
     * Per-w:t info. Slots preserve the relative order of the run's textual
     * children. Non-textual run children (w:tab, w:br, ...) are ignored for
     * the char stream but left in place via their surrounding w:r.
     */
    textNodes: { wtEl: XNode; text: string; paraStart: number; paraEnd: number }[];
}

interface Flattened {
    paraText: string;
    runs: RunSlot[];          // order corresponds to their paragraph position
    /** Built on first use by charMaps(); only edited paragraphs need it. */
    maps?: CharMaps;
}

/** For each char index in paraText: which run slot and which of its w:t nodes. */
interface CharMaps {
    charRun: Int32Array;      // runIdx
    charTextNode: Int32Array; // index into slot.textNodes
}

/**
 * Flatten a paragraph to its accepted-view text and run slots. Each w:t
 * records its [paraStart, paraEnd) span, which is all the per-character maps
 * are derived from, so those are built lazily by charMaps() for the few
 * paragraphs an edit actually rewrites — not for every paragraph read.
 */
function flattenParagraph(paraChildren: XNode[]): Flattened {
    const runs: RunSlot[] = [];
    let paraText = "";

    const processRun = (rEl: XNode, topChildIdx: number) => {
        const rKids = elChildren(rEl);
        let rPr: XNode | null = null;
        const textNodes: RunSlot["textNodes"] = [];
        for (const rk of rKids) {
            const name = elName(rk);
            if (name === "w:rPr") {
                rPr = rk;
            } else if (name === "w:t") {
                const txt = getTextContent(rk);
                const start = paraText.length;
                textNodes.push({
                    wtEl: rk,
                    text: txt,
                    paraStart: start,
                    paraEnd: start + txt.length,
                });
                paraText += txt;
            }
            // other run children (w:tab, w:br, w:sym, …) are left alone
        }
        runs.push({ childIndex: topChildIdx, rPr, textNodes });
    };

    for (let ci = 0; ci < paraChildren.length; ci++) {
        const child = paraChildren[ci];
        const name = elName(child);
        if (name === "w:r") {
            processRun(child, ci);
        } else if (name === "w:ins") {
            // Accepted view: include inner runs as if bare. childIndex points
            // at the w:ins wrapper so reconstruction can drop the wrapper
            // whole when a new edit touches any of these runs.
            for (const inner of elChildren(child)) {
                if (elName(inner) === "w:r") processRun(inner, ci);
            }
        }
        // w:del: skip entirely — accepted view excludes deleted text.
    }

    return { paraText, runs };
}

/** Per-character maps for a paragraph, filled span-by-span into typed arrays. */
function charMaps(flat: Flattened): CharMaps {
    if (flat.maps) return flat.maps;
    const charRun = new Int32Array(flat.paraText.length);
    const charTextNode = new Int32Array(flat.paraText.length);
    flat.runs.forEach((slot, runIdx) => {
        slot.textNodes.forEach((tn, tnIdx) => {
            charRun.fill(runIdx, tn.paraStart, tn.paraEnd);
            charTextNode.fill(tnIdx, tn.paraStart, tn.paraEnd);
        });
    });
    flat.maps = { charRun, charTextNode };
    return flat.maps;
}

// ---------------------------------------------------------------------------
// Planning edits on a paragraph
// ---------------------------------------------------------------------------

/**
 * A single logical change. Spans a contiguous [start, end) character range in
 * the paragraph text (may be empty for a pure insert) and may carry an
 * inserted string appended at `start`.
 */
interface PlannedChange {
    editIndex: number;            // source edit index
    deleteStart: number;          // paragraph text offset (inclusive)
    deleteEnd: number;            // paragraph text offset (exclusive); may equal start
    deletedText: string;          // substring of paraText in [start, end)
    insertedText: string;         // may be empty
    contextBefore: string;
    contextAfter: string;
    reason?: string;
    changeId: string;             // logical id (not the w:id)
    delWId?: string;              // w:id of w:del wrapper (if deletedText non-empty)
    insWId?: string;              // w:id of w:ins wrapper (if insertedText non-empty)
}

/**
 * Collapse a find/replace pair into a minimal `{deletedText, insertedText}`
 * tuple anchored at a single start position. A character-level diff would
 * produce sequences like EQ-DEL-EQ-INS; for the tracked-change UI we want one
 * "replace this substring with that substring" card per edit, so only the
 * common prefix and suffix are trimmed and the rest is one span.
 */
function collapseDiff(find: string, replace: string): { deleted: string; inserted: string; leadingEq: number; trailingEq: number } {
    // Find leading/trailing common substrings so the tracked range is minimal
    let leading = 0;
    const minLen = Math.min(find.length, replace.length);
    while (leading < minLen && find[leading] === replace[leading]) leading++;
    let trailing = 0;
    while (
        trailing < minLen - leading &&
        find[find.length - 1 - trailing] === replace[replace.length - 1 - trailing]
    ) {
        trailing++;
    }
    const deleted = find.slice(leading, find.length - trailing);
    const inserted = replace.slice(leading, replace.length - trailing);
    return { deleted, inserted, leadingEq: leading, trailingEq: trailing };
}

// ---------------------------------------------------------------------------
// Paragraph reconstruction
// ---------------------------------------------------------------------------

/**
 * Given a paragraph's children and a sorted, non-overlapping list of
 * `PlannedChange`s that fall within it, return a new children array with
 * tracked changes inserted.
 */
function reconstructParagraph(
    paraChildren: XNode[],
    flat: Flattened,
    plan: PlannedChange[],
    now: string,
    author: string,
): XNode[] {
    if (plan.length === 0) return paraChildren;
    const { charRun, charTextNode } = charMaps(flat);

    // Determine the run-index span that edits touch.
    let firstRunIdx = flat.runs.length;
    let lastRunIdx = -1;
    for (const p of plan) {
        for (let pos = p.deleteStart; pos < p.deleteEnd; pos++) {
            const r = charRun[pos];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        }
        // Also include the run to the left/right of a pure insertion so we
        // can inherit its rPr.
        if (p.deleteStart === p.deleteEnd && p.deleteStart < flat.paraText.length) {
            const r = charRun[p.deleteStart];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        } else if (p.deleteStart === p.deleteEnd && p.deleteStart > 0) {
            const r = charRun[p.deleteStart - 1];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        }
    }
    if (firstRunIdx > lastRunIdx) {
        // No runs touched (edits against empty paragraph?) — nothing to do.
        return paraChildren;
    }

    // Child-index range in paragraph.children we are going to replace.
    const startChildIdx = flat.runs[firstRunIdx].childIndex;
    const endChildIdx = flat.runs[lastRunIdx].childIndex;

    // Paragraph-text range that this run span covers.
    const firstRun = flat.runs[firstRunIdx];
    const lastRun = flat.runs[lastRunIdx];
    const spanStart =
        firstRun.textNodes.length > 0 ? firstRun.textNodes[0].paraStart : 0;
    const spanEnd =
        lastRun.textNodes.length > 0
            ? lastRun.textNodes[lastRun.textNodes.length - 1].paraEnd
            : spanStart;

    // Walk [spanStart, spanEnd) in paraText, producing a new children array.
    const newRunGroup: XNode[] = [];

    // Helper: get the rPr for the run containing paragraph offset `pos`
    // (clamped to the touched span). Used to inherit formatting for
    // insertions that fall exactly on a boundary.
    const rPrForPos = (pos: number): XNode | null => {
        if (pos < 0) pos = 0;
        if (pos >= flat.paraText.length) pos = flat.paraText.length - 1;
        if (pos < 0) return firstRun.rPr;
        return flat.runs[charRun[pos]].rPr;
    };

    // Emit a "normal" run fragment covering [a, b) of paraText, grouping
    // consecutive chars that belong to the same source text node.
    const emitNormal = (a: number, b: number) => {
        if (a >= b) return;
        let i = a;
        while (i < b) {
            const runIdx = charRun[i];
            const tnIdx = charTextNode[i];
            let j = i + 1;
            while (
                j < b &&
                charRun[j] === runIdx &&
                charTextNode[j] === tnIdx
            ) {
                j++;
            }
            const slot = flat.runs[runIdx];
            const rPr = slot.rPr;
            const slice = flat.paraText.slice(i, j);
            newRunGroup.push(buildRun(rPr, slice, "w:t"));
            i = j;
        }
    };

    // Emit a w:del wrapping run fragments covering [a, b) of paraText.
    const emitDel = (a: number, b: number, wId: string) => {
        if (a >= b) return;
        const inner: XNode[] = [];
        let i = a;
        while (i < b) {
            const runIdx = charRun[i];
            const tnIdx = charTextNode[i];
            let j = i + 1;
            while (
                j < b &&
                charRun[j] === runIdx &&
                charTextNode[j] === tnIdx
            ) {
                j++;
            }
            const slot = flat.runs[runIdx];
            const slice = flat.paraText.slice(i, j);
            inner.push(buildRun(slot.rPr, slice, "w:delText"));
            i = j;
        }
        newRunGroup.push(
            makeEl("w:del", inner, {
                "w:id": wId,
                "w:author": author,
                "w:date": now,
            }),
        );
    };

    // Emit a w:ins at position `pos` inheriting rPr from there.
    const emitIns = (pos: number, text: string, wId: string) => {
        if (!text) return;
        const rPr = rPrForPos(pos === spanEnd ? pos - 1 : pos);
        const run = buildRun(rPr, text, "w:t");
        newRunGroup.push(
            makeEl("w:ins", [run], {
                "w:id": wId,
                "w:author": author,
                "w:date": now,
            }),
        );
    };

    let cursor = spanStart;
    for (const p of plan) {
        // Untouched slice before this edit
        emitNormal(cursor, p.deleteStart);
        // Insertion fires at the edit boundary
        if (p.insertedText) emitIns(p.deleteStart, p.insertedText, p.insWId!);
        // Deletion wraps the span
        if (p.deleteEnd > p.deleteStart)
            emitDel(p.deleteStart, p.deleteEnd, p.delWId!);
        cursor = p.deleteEnd;
    }
    emitNormal(cursor, spanEnd);

    // Replace only the w:r children that the edits touch; preserve any other
    // interleaved elements (bookmarks, existing tracked-changes, w:sdt …) at
    // their original positions.
    const droppedChildIdx = new Set<number>();
    for (let r = firstRunIdx; r <= lastRunIdx; r++) {
        droppedChildIdx.add(flat.runs[r].childIndex);
    }
    // Any w:del wrappers that sit inside the span we're rewriting are also
    // dropped, which accepts their deletions (their text is already absent
    // from paraText in the accepted view).
    for (let i = startChildIdx; i <= endChildIdx; i++) {
        if (elName(paraChildren[i]) === "w:del") droppedChildIdx.add(i);
    }
    const firstDroppedIdx = startChildIdx;
    void endChildIdx;
    const out: XNode[] = [];
    for (let i = 0; i < paraChildren.length; i++) {
        if (i === firstDroppedIdx) {
            for (const n of newRunGroup) out.push(n);
        }
        if (droppedChildIdx.has(i)) continue;
        out.push(paraChildren[i]);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Locating context in the document
// ---------------------------------------------------------------------------

interface ParagraphRef {
    paraNode: XNode;
    paraChildren: XNode[];
    flat: Flattened;
    globalStart: number; // where this paragraph starts in the full doc text
}

// --- Whitespace / punctuation normalization for anchor matching -------------
// The text LLMs see (via mammoth's extractRawText) does not line up 1:1 with
// the raw w:t concatenation: smart quotes, non-breaking spaces, tabs, and
// runs of whitespace all differ. We normalize both haystack and needle to
// a canonical form for matching, then map matched offsets back to the
// original paragraph text.

function preNormalize(s: string): string {
    // All 1-to-1 character replacements — preserves length for straightforward
    // index mapping.
    return s
        .replace(/[\u2018\u2019\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[\u2013\u2014]/g, "-")
        .replace(/\u00A0/g, " ")
        .replace(/\u200B/g, " ");
}

interface Normalized {
    norm: string;
    // origIdx[i] = index in the *original* string for norm[i]
    origIdx: number[];
}

function normalizeWs(input: string): Normalized {
    const s = preNormalize(input);
    const norm: string[] = [];
    const origIdx: number[] = [];
    let prevSpace = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (/\s/.test(ch)) {
            if (!prevSpace) {
                norm.push(" ");
                origIdx.push(i);
                prevSpace = true;
            }
        } else {
            norm.push(ch);
            origIdx.push(i);
            prevSpace = false;
        }
    }
    return { norm: norm.join(""), origIdx };
}

/**
 * Locate the unique position in `hayNorm` where `findNorm` appears AND is
 * preceded by `ctxBeforeNorm` AND followed by `ctxAfterNorm`. The context
 * check compares in place (`startsWith` at an offset) rather than against a
 * concatenation, so boundary-whitespace collapsing doesn't matter, and never
 * copies a substring. Returns the normalized [start, end) range of the
 * `find` portion, or a structured error.
 *
 * Candidates always come from `indexOf` on a non-empty needle: `findNorm`
 * itself, or — for a pure insertion, where `findNorm` is empty — whichever
 * context side is present. Scanning stops at the second candidate because
 * the verdict is already "ambiguous".
 */
function findUniqueAnchor(
    hayNorm: string,
    findNorm: string,
    ctxBeforeNorm: string,
    ctxAfterNorm: string,
): { start: number; end: number } | { error: "none" | "ambiguous" } {
    const checkCtx = (pos: number): boolean => {
        if (ctxBeforeNorm) {
            const start = pos - ctxBeforeNorm.length;
            if (start < 0 || !hayNorm.startsWith(ctxBeforeNorm, start))
                return false;
        }
        if (ctxAfterNorm && !hayNorm.startsWith(ctxAfterNorm, pos + findNorm.length))
            return false;
        return true;
    };

    // The needle that drives the scan and how far a hit at `idx` sits from
    // the anchor position it implies.
    let needle = findNorm;
    let shift = 0;
    if (!needle) {
        if (ctxBeforeNorm) {
            needle = ctxBeforeNorm;
            shift = ctxBeforeNorm.length;
        } else if (ctxAfterNorm) {
            needle = ctxAfterNorm;
        } else {
            // Empty find, no context: every one of the hay.length + 1
            // positions matches, so only an empty paragraph is unique.
            return hayNorm.length === 0
                ? { start: 0, end: 0 }
                : { error: "ambiguous" };
        }
    }

    let found = -1;
    for (let from = 0; ; ) {
        const idx = hayNorm.indexOf(needle, from);
        if (idx < 0) break;
        const pos = idx + shift;
        if (checkCtx(pos)) {
            if (found >= 0) return { error: "ambiguous" };
            found = pos;
        }
        from = idx + 1;
    }

    if (found < 0) return { error: "none" };
    return { start: found, end: found + findNorm.length };
}

/** Map a normalized [start, end) range back to the original string range. */
function mapNormRangeToOriginal(
    paraNorm: Normalized,
    origLen: number,
    normStart: number,
    normEnd: number,
): { start: number; end: number } {
    const origStart =
        normStart < paraNorm.origIdx.length
            ? paraNorm.origIdx[normStart]
            : origLen;
    const origEnd =
        normEnd === normStart
            ? origStart
            : normEnd - 1 < paraNorm.origIdx.length
              ? paraNorm.origIdx[normEnd - 1] + 1
              : origLen;
    return { start: origStart, end: origEnd };
}

// ---------------------------------------------------------------------------
// Main: applyTrackedEdits
// ---------------------------------------------------------------------------

function createParser() {
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        trimValues: false,
        parseTagValue: false,
        parseAttributeValue: false,
        processEntities: true,
    });
}

function createBuilder() {
    return new XMLBuilder({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        suppressEmptyNode: false,
        processEntities: true,
    });
}

function findBody(doc: XNode[]): XNode[] | null {
    for (const top of doc) {
        if (elName(top) === "w:document") {
            for (const c of elChildren(top)) {
                if (elName(c) === "w:body") return elChildren(c);
            }
        }
    }
    return null;
}

/**
 * Walk a tree and collect all max w:id values in w:ins/w:del so new changes
 * can start their numbering safely above it.
 */
function maxTrackedId(doc: XNode[]): number {
    let max = 0;
    const visit = (n: unknown) => {
        const name = elName(n);
        if (!name) return;
        if (name === "w:ins" || name === "w:del") {
            const a = elAttrs(n);
            const raw = a["@_w:id"];
            if (raw != null) {
                const v = parseInt(String(raw), 10);
                if (Number.isFinite(v) && v > max) max = v;
            }
        }
        for (const c of elChildren(n as XNode)) visit(c);
    };
    for (const top of doc) visit(top);
    return max;
}

/**
 * Extract the body text of a .docx using the same flattening rules as the
 * tracked-changes matcher. Paragraphs are joined by a single newline. The
 * output is what the LLM should base its `find` / `context_before` /
 * `context_after` strings on, since it exactly mirrors the string the
 * anchor matcher operates against.
 */
export async function extractDocxBodyText(bytes: Buffer): Promise<string> {
    return (await extractDocxBodyAndReview(bytes)).body;
}

// What the review notes may hold: enough for a reviewer's pass over a
// contract, bounded so a document of thousands of changes stays readable.
const REVIEW_MAX_ITEMS = 200;
const REVIEW_MAX_TEXT_CHARS = 500;
const REVIEW_MAX_CONTEXT_CHARS = 200;
const COMMENTS_MAX_BYTES = 8 * 1024 * 1024;

/**
 * `by` is the author, with the date when the document gives one.
 * `paragraph` is where the change is, already cut to fit: for an insertion
 * the paragraph as the body reads it, for a deletion as it read before the
 * changes (`original`), so the words a deletion takes out are seen in place.
 */
type ReviewChange = {
    kind: "Inserted" | "Deleted";
    by: string;
    text: string;
    paragraph: string;
    original?: boolean;
};
type ReviewComment = { id: string; by: string; text: string };

function oneLine(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function byline(attrs: Record<string, string>): string {
    const author = String(attrs["@_w:author"] ?? "").trim() || "an unknown author";
    const date = String(attrs["@_w:date"] ?? "").match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    return date ? `${author} (${date})` : author;
}

/** The text of a tracked change's runs: w:t for an insertion, w:delText for a deletion. */
function changeText(wrapper: XNode, tag: "w:t" | "w:delText"): string {
    let out = "";
    const visit = (n: XNode) => {
        for (const c of elChildren(n)) {
            const name = elName(c);
            if (name === tag) out += getTextContent(c);
            else if (name === "w:tab") out += "\t";
            else if (name === "w:br" || name === "w:cr") out += "\n";
            else if (name && name !== "w:rPr") visit(c);
        }
    };
    visit(wrapper);
    return out;
}

/**
 * A paragraph as the body reads it (its insertions in, its deletions out)
 * and as it read before its tracked changes (the reverse), with where each
 * of its own w:ins and w:del is in the view that shows it. The accepted
 * view is flattenParagraph's, so `accepted` is the body's paragraph; a
 * change nested deeper (in a hyperlink) has no place here.
 */
function paragraphViews(paraChildren: XNode[]): {
    accepted: string;
    original: string;
    at: Map<XNode, { start: number; end: number }>;
} {
    let accepted = "";
    let original = "";
    const at = new Map<XNode, { start: number; end: number }>();
    const runText = (run: XNode, tag: "w:t" | "w:delText") => {
        let out = "";
        for (const child of elChildren(run)) {
            if (elName(child) === tag) out += getTextContent(child);
        }
        return out;
    };
    for (const child of paraChildren) {
        const name = elName(child);
        if (name === "w:r") {
            const text = runText(child, "w:t");
            accepted += text;
            original += text;
        } else if (name === "w:ins") {
            const start = accepted.length;
            for (const inner of elChildren(child)) {
                if (elName(inner) === "w:r") accepted += runText(inner, "w:t");
            }
            at.set(child, { start, end: accepted.length });
        } else if (name === "w:del") {
            const start = original.length;
            for (const inner of elChildren(child)) {
                if (elName(inner) === "w:r") original += runText(inner, "w:delText");
            }
            at.set(child, { start, end: original.length });
        }
    }
    return { accepted, original, at };
}

/**
 * The part of a paragraph around [start, end), at most
 * REVIEW_MAX_CONTEXT_CHARS, cut at spaces and marked "…" where cut: a short
 * change in a long clause ("6" for "9" in "60 days") is shown with the words
 * around it, not with the clause's first words.
 */
function contextAround(text: string, start: number, end: number): string {
    const max = REVIEW_MAX_CONTEXT_CHARS;
    if (text.length <= max) return oneLine(text, max);
    if (end - start >= max) return `${start > 0 ? "…" : ""}${oneLine(text.slice(start, end), max)}`;
    const room = max - (end - start);
    let from = Math.max(0, start - Math.floor(room / 2));
    let to = Math.min(text.length, from + max);
    from = Math.max(0, to - max);
    if (from > 0) {
        const space = text.indexOf(" ", from);
        if (space >= 0 && space < start) from = space + 1;
    }
    if (to < text.length) {
        const space = text.lastIndexOf(" ", to);
        if (space >= end) to = space;
    }
    const inner = text.slice(from, to).replace(/\s+/g, " ").trim();
    return `${from > 0 ? "…" : ""}${inner}${to < text.length ? "…" : ""}`;
}

/**
 * The text of a .docx as read_document gives it to the model: the accepted
 * view (extractDocxBodyText, which the edit matcher anchors against) and,
 * apart from it, what that view cannot show: the tracked changes not yet
 * accepted or rejected, each an insertion or a deletion with its author, and
 * the comments, each with its author and the text it is on. `review` is ""
 * for a document with neither, so its text is exactly the accepted view.
 *
 * The notes come after the body, never inside it: an edit is anchored on
 * the body's own characters, and a marker in the middle of a sentence would
 * be copied into a `find` that then matches nothing. `lead` goes before the
 * body when there are tracked changes (reviewLead): the body reads as if
 * they were accepted, and a model that summarizes from it must know that
 * before it reads a word, not after (the models campaign's bug 4).
 */
export async function extractDocxBodyAndReview(
    bytes: Buffer,
): Promise<{ body: string; review: string; lead: string }> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) return { body: "", review: "", lead: "" };
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const bodyChildren = findBody(tree);
    if (!bodyChildren) return { body: "", review: "", lead: "" };

    const lines: string[] = [];
    const changes: ReviewChange[] = [];
    // A comment's range may span paragraphs: each open range gathers the
    // accepted text of every paragraph it touches.
    const openRanges = new Map<string, string[]>();
    const anchors = new Map<string, string>();
    const paragraphReview = (paraChildren: XNode[], paraText: string) => {
        const starts: string[] = [];
        const ends: string[] = [];
        const references: string[] = [];
        let views: ReturnType<typeof paragraphViews> | undefined;
        const visit = (nodes: XNode[], depth: number) => {
            for (const c of nodes) {
                const name = elName(c);
                if (!name) continue;
                const id = String(elAttrs(c)["@_w:id"] ?? "");
                if (name === "w:ins" || name === "w:del") {
                    const text = changeText(c, name === "w:ins" ? "w:t" : "w:delText");
                    if (text.trim()) {
                        views ??= paragraphViews(paraChildren);
                        const place = views.at.get(c);
                        const shown = name === "w:ins" ? views.accepted : views.original;
                        changes.push({
                            kind: name === "w:ins" ? "Inserted" : "Deleted",
                            by: byline(elAttrs(c)),
                            text,
                            paragraph: place
                                ? contextAround(shown, place.start, place.end)
                                : oneLine(paraText, REVIEW_MAX_CONTEXT_CHARS),
                            original: !!place && name === "w:del",
                        });
                    }
                } else if (name === "w:commentRangeStart") starts.push(id);
                else if (name === "w:commentRangeEnd") ends.push(id);
                else if (name === "w:commentReference") references.push(id);
                else if (depth < 8 && name !== "w:pPr" && name !== "w:rPr") visit(elChildren(c), depth + 1);
            }
        };
        visit(paraChildren, 0);
        for (const id of starts) if (!openRanges.has(id)) openRanges.set(id, []);
        for (const texts of openRanges.values()) texts.push(paraText);
        for (const id of ends) {
            const texts = openRanges.get(id);
            if (texts) { anchors.set(id, texts.join(" ")); openRanges.delete(id); }
        }
        for (const id of references) if (!anchors.has(id) && !openRanges.has(id)) anchors.set(id, paraText);
    };
    const collect = (nodes: XNode[]) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:p") {
                const flat = flattenParagraph(elChildren(n));
                lines.push(flat.paraText);
                paragraphReview(elChildren(n), flat.paraText);
            } else if (
                name === "w:tbl" ||
                name === "w:tr" ||
                name === "w:tc" ||
                name === "w:sdt" ||
                name === "w:sdtContent"
            ) {
                collect(elChildren(n));
            }
        }
    };
    collect(bodyChildren);
    for (const [id, texts] of openRanges) anchors.set(id, texts.join(" "));
    const body = lines.join("\n");

    let comments: ReviewComment[] = [];
    let commentsUnreadable = false;
    const commentsFile = getZipEntry(zip, "word/comments.xml");
    if (commentsFile) {
        try {
            // Bounded: comments.xml is not checked at upload as document.xml is.
            const xml = await readZipEntryBounded(commentsFile, COMMENTS_MAX_BYTES);
            comments = parseComments(parser.parse(xml) as XNode[]);
        } catch {
            commentsUnreadable = true;
        }
    }
    return {
        body,
        review: formatReview(changes, comments, anchors, commentsUnreadable),
        lead: reviewLead(changes.length),
    };
}

/**
 * What a .docx's text says first when it has tracked changes not yet
 * accepted or rejected (the models campaign's bug 4, 2026-11-25): its body
 * reads as if they were accepted, so a memo drafted from it stated a
 * proposed 90 days and Delaware law as the agreement's, where the signed
 * text says 60 days and Pennsylvania. "" when it has none.
 */
export function reviewLead(changeCount: number): string {
    if (changeCount === 0) return "";
    const changes = changeCount === 1 ? "1 tracked change" : `${changeCount} tracked changes`;
    return `[This version has ${changes} not yet accepted or rejected. The text below shows ${changeCount === 1 ? "it" : "them"} as if accepted: a proposed insertion is in it and a proposed deletion is left out. Tracked changes are proposals, not agreed terms: until one is accepted, the original wording is what the document says. Each change is listed after the text; a deletion's text is the original wording, an insertion's is proposed. When you say what the document provides, give the original wording and name each change as proposed.]`;
}

function parseComments(tree: XNode[]): ReviewComment[] {
    const out: ReviewComment[] = [];
    for (const top of tree) {
        if (elName(top) !== "w:comments") continue;
        for (const c of elChildren(top)) {
            if (elName(c) !== "w:comment") continue;
            const attrs = elAttrs(c);
            const paragraphs: string[] = [];
            const visit = (nodes: XNode[], depth: number) => {
                for (const n of nodes) {
                    const name = elName(n);
                    if (name === "w:p") paragraphs.push(flattenParagraph(elChildren(n)).paraText);
                    else if (name && depth < 6) visit(elChildren(n), depth + 1);
                }
            };
            visit(elChildren(c), 0);
            out.push({ id: String(attrs["@_w:id"] ?? ""), by: byline(attrs), text: paragraphs.join(" ") });
        }
    }
    return out;
}

function formatReview(
    changes: ReviewChange[],
    comments: ReviewComment[],
    anchors: Map<string, string>,
    commentsUnreadable: boolean,
): string {
    const parts: string[] = [];
    const more = (n: number) => (n > REVIEW_MAX_ITEMS ? [`… and ${n - REVIEW_MAX_ITEMS} more.`] : []);
    if (changes.length) {
        parts.push([
            `[Tracked changes: ${changes.length} not yet accepted or rejected. The text above reads as if each were accepted: its insertions are in it and its deletions are not. Base an edit on the text above.]`,
            ...changes.slice(0, REVIEW_MAX_ITEMS).map((change, i) => {
                const text = oneLine(change.text, REVIEW_MAX_TEXT_CHARS);
                const paragraph = change.paragraph;
                const where = !paragraph || paragraph === text
                    ? ""
                    : change.original
                        ? `, where the original reads "${paragraph}"`
                        : `, in "${paragraph}"`;
                return `${i + 1}. ${change.kind} by ${change.by}: "${text}"${where}`;
            }),
            ...more(changes.length),
        ].join("\n"));
    }
    if (comments.length) {
        parts.push([
            `[Comments: ${comments.length}.]`,
            ...comments.slice(0, REVIEW_MAX_ITEMS).map((comment, i) => {
                const anchor = oneLine(anchors.get(comment.id) ?? "", REVIEW_MAX_CONTEXT_CHARS);
                const on = anchor ? `, on "${anchor}"` : "";
                return `${i + 1}. ${comment.by}${on}: ${oneLine(comment.text, REVIEW_MAX_TEXT_CHARS)}`;
            }),
            ...more(comments.length),
        ].join("\n"));
    } else if (commentsUnreadable) {
        parts.push("[This document has comments that could not be read.]");
    }
    return parts.join("\n\n");
}

/**
 * Walk document.xml in document order and collect the w:id for every
 * w:ins / w:del wrapper. No production caller remains; the tests use it to
 * check which tracked changes applyTrackedEdits and resolveTrackedChange
 * leave behind.
 */
export async function extractTrackedChangeIds(
    bytes: Buffer,
): Promise<{ kind: "ins" | "del"; w_id: string }[]> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) return [];
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const out: { kind: "ins" | "del"; w_id: string }[] = [];
    const visit = (n: unknown) => {
        const name = elName(n);
        if (!name) return;
        if (name === "w:ins" || name === "w:del") {
            const a = elAttrs(n);
            const raw = a["@_w:id"];
            if (raw != null) {
                out.push({
                    kind: name === "w:ins" ? "ins" : "del",
                    w_id: String(raw),
                });
            }
        }
        for (const c of elChildren(n as XNode)) visit(c);
    };
    for (const top of tree) visit(top);
    return out;
}

export async function applyTrackedEdits(
    bytes: Buffer,
    edits: EditInput[],
    opts?: { author?: string },
): Promise<ApplyTrackedEditsResult> {
    const author = opts?.author ?? "Mike";
    const now = new Date().toISOString();

    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const docXmlRaw = await docXmlFile.async("string");

    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];

    const bodyChildren = findBody(tree);
    if (!bodyChildren) throw new Error("w:body missing from document.xml");

    // Build paragraph table (only w:p at the top level of the body — does not
    // recurse into tables; for tables, w:p also appears inside w:tbl > w:tr >
    // w:tc so we need to traverse deeper).
    const paragraphs: ParagraphRef[] = [];
    const collectParagraphs = (nodes: XNode[]) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:p") {
                const kids = elChildren(n);
                const flat = flattenParagraph(kids);
                paragraphs.push({
                    paraNode: n,
                    paraChildren: kids,
                    flat,
                    globalStart: 0, // set below
                });
            } else if (name === "w:tbl" || name === "w:tr" || name === "w:tc" || name === "w:sdt" || name === "w:sdtContent") {
                collectParagraphs(elChildren(n));
            }
        }
    };
    collectParagraphs(bodyChildren);

    // Assign global offsets (paragraphs joined by "\n" so context can
    // straddle a paragraph boundary, though edits themselves must stay
    // inside a single paragraph).
    {
        let off = 0;
        for (const p of paragraphs) {
            p.globalStart = off;
            off += p.flat.paraText.length + 1; // +1 for synthetic separator
        }
    }

    // Precompute normalized forms per paragraph for reuse across edits.
    const paraNorms: Normalized[] = paragraphs.map((p) =>
        normalizeWs(p.flat.paraText),
    );

    let nextWId = maxTrackedId(tree) + 1;
    const plansPerParagraph = new Map<number, PlannedChange[]>();
    const appliedChanges: AppliedChange[] = [];
    const errors: EditError[] = [];

    for (let editIdx = 0; editIdx < edits.length; editIdx++) {
        const edit = edits[editIdx];
        const find = edit.find ?? "";
        const replace = edit.replace ?? "";
        const ctxBefore = edit.context_before ?? "";
        const ctxAfter = edit.context_after ?? "";

        if (!find && !replace) {
            errors.push({ index: editIdx, reason: "Empty edit." });
            continue;
        }
        if (!find && !ctxBefore && !ctxAfter) {
            errors.push({
                index: editIdx,
                reason: "Pure insertion requires context_before or context_after.",
            });
            continue;
        }

        const findNorm = normalizeWs(find).norm;
        const ctxBeforeNorm = normalizeWs(ctxBefore).norm;
        const ctxAfterNorm = normalizeWs(ctxAfter).norm;

        // Strategy:
        //   1) find + full context  (strictest — preferred)
        //   2) find + half context  (drop whichever context side is shorter)
        //   3) find alone           (only if globally unique across doc)
        // At each stage we scan every paragraph. "Unique across the doc"
        // means exactly one paragraph yields exactly one match.
        type Hit = { paraIdx: number; normStart: number; normEnd: number };

        /**
         * Search every paragraph with the given context sides. If any
         * paragraph returns a match AND no paragraph is internally ambiguous,
         * return the collected hits; otherwise signal ambiguous.
         */
        const tryStrategy = (
            cb: string,
            ca: string,
        ): { kind: "ok"; hits: Hit[] } | { kind: "ambiguous" } => {
            const hits: Hit[] = [];
            let ambiguous = false;
            for (let pi = 0; pi < paragraphs.length; pi++) {
                const r = findUniqueAnchor(
                    paraNorms[pi].norm,
                    findNorm,
                    cb,
                    ca,
                );
                if ("error" in r) {
                    if (r.error === "ambiguous") ambiguous = true;
                    continue;
                }
                hits.push({ paraIdx: pi, normStart: r.start, normEnd: r.end });
            }
            if (ambiguous || hits.length > 1) return { kind: "ambiguous" };
            return { kind: "ok", hits };
        };

        let selected: Hit | null = null;
        const attempts = [
            { cb: ctxBeforeNorm, ca: ctxAfterNorm },
            { cb: ctxBeforeNorm, ca: "" },
            { cb: "", ca: ctxAfterNorm },
            { cb: "", ca: "" }, // find-only
        ];
        let sawAmbiguous = false;
        for (const { cb, ca } of attempts) {
            const r = tryStrategy(cb, ca);
            if (r.kind === "ambiguous") {
                sawAmbiguous = true;
                continue;
            }
            if (r.hits.length === 1) {
                selected = r.hits[0];
                break;
            }
        }

        if (!selected) {
            errors.push({
                index: editIdx,
                reason: sawAmbiguous
                    ? `Ambiguous match for find="${truncate(find, 80)}". Add longer context_before / context_after so the anchor is unique.`
                    : `Could not locate find="${truncate(find, 80)}" in the document. Re-read the document and copy context verbatim (including punctuation & whitespace).`,
            });
            continue;
        }

        const hit = selected;
        const paraIdx = hit.paraIdx;
        const paraNorm = paraNorms[paraIdx];
        const origLen = paragraphs[paraIdx].flat.paraText.length;
        const { start: findStart, end: findEnd } = mapNormRangeToOriginal(
            paraNorm,
            origLen,
            hit.normStart,
            hit.normEnd,
        );

        // Use the actual original text in that range as `deletedText` —
        // this preserves the document's whitespace/quote style rather than
        // the normalized needle the LLM provided.
        const originalFind = paragraphs[paraIdx].flat.paraText.slice(
            findStart,
            findEnd,
        );

        const { deleted, inserted, leadingEq } = collapseDiff(
            originalFind,
            replace,
        );
        const minStart = findStart + leadingEq;
        const minEnd = minStart + deleted.length;
        void findEnd;

        const changeId = `mike-${editIdx}-${Date.now()}`;
        const plan: PlannedChange = {
            editIndex: editIdx,
            deleteStart: minStart,
            deleteEnd: minEnd,
            deletedText: deleted,
            insertedText: inserted,
            contextBefore: edit.context_before ?? "",
            contextAfter: edit.context_after ?? "",
            reason: edit.reason,
            changeId,
            delWId: deleted ? String(nextWId++) : undefined,
            insWId: inserted ? String(nextWId++) : undefined,
        };

        // Check for overlap with earlier plans in the same paragraph.
        const existing = plansPerParagraph.get(paraIdx) ?? [];
        const overlap = existing.some(
            (p) => !(plan.deleteEnd <= p.deleteStart || plan.deleteStart >= p.deleteEnd),
        );
        if (overlap) {
            errors.push({
                index: editIdx,
                reason: "Overlaps a previous edit in the same paragraph.",
            });
            continue;
        }

        existing.push(plan);
        existing.sort((a, b) => a.deleteStart - b.deleteStart);
        plansPerParagraph.set(paraIdx, existing);

        appliedChanges.push({
            id: changeId,
            delId: plan.delWId,
            insId: plan.insWId,
            deletedText: plan.deletedText,
            insertedText: plan.insertedText,
            contextBefore: plan.contextBefore,
            contextAfter: plan.contextAfter,
            reason: plan.reason,
        });
    }

    // Apply plans per paragraph.
    for (const [paraIdx, plan] of plansPerParagraph) {
        const p = paragraphs[paraIdx];
        const newKids = reconstructParagraph(
            p.paraChildren,
            p.flat,
            plan,
            now,
            author,
        );
        setChildren(p.paraNode, newKids);
    }

    const builder = createBuilder();
    const rebuiltXml = builder.build(tree);
    const withDecl = ensureXmlDeclaration(rebuiltXml);
    setZipEntry(zip, "word/document.xml", withDecl);

    const outBuf = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    return { bytes: outBuf, changes: appliedChanges, errors };
}

// ---------------------------------------------------------------------------
// Resolve a single tracked change (Accept or Reject)
// ---------------------------------------------------------------------------

/**
 * Walk the XML tree and transform matching w:ins/w:del wrappers for the
 * given change id. Returns { found, updatedTree }.
 */
function resolveInTree(
    doc: XNode[],
    changeIds: string[],
    mode: "accept" | "reject",
): { found: boolean } {
    const ids = new Set(changeIds.map((s) => String(s)));
    let touched = false;

    const rewrite = (parentKids: XNode[]): XNode[] => {
        const out: XNode[] = [];
        for (const n of parentKids) {
            const name = elName(n);
            if (!name) {
                out.push(n);
                continue;
            }

            // Recurse first so nested tables/sdts get processed
            const kids = elChildren(n);
            if (kids.length) {
                const newKids = rewrite(kids);
                if (newKids !== kids) setChildren(n, newKids);
            }

            if (name === "w:ins" || name === "w:del") {
                const a = elAttrs(n);
                const wId = String(a["@_w:id"] ?? "");
                if (ids.has(wId)) {
                    touched = true;
                    if (
                        (name === "w:ins" && mode === "accept") ||
                        (name === "w:del" && mode === "reject")
                    ) {
                        // Keep children, drop wrapper. For w:del rejected, we
                        // also need to convert inner w:delText → w:t so the
                        // text reverts to normal body content.
                        const inner =
                            name === "w:del"
                                ? (elChildren(n) as XNode[]).map(unwrapDelText)
                                : (elChildren(n) as XNode[]);
                        for (const c of inner) out.push(c);
                        continue;
                    } else {
                        // accept-del / reject-ins → drop the wrapper and its
                        // inner runs entirely.
                        continue;
                    }
                }
            }

            out.push(n);
        }
        return out;
    };

    for (const top of doc) {
        if (elName(top) !== "w:document") continue;
        const docKids = elChildren(top);
        setChildren(top, rewrite(docKids));
    }

    return { found: touched };
}

function unwrapDelText(n: XNode): XNode {
    const name = elName(n);
    if (!name) return n;
    if (name === "w:r") {
        const kids = elChildren(n).map(unwrapDelText);
        setChildren(n, kids);
        return n;
    }
    if (name === "w:delText") {
        const attrs = elAttrs(n);
        return {
            "w:t": elChildren(n),
            ...(Object.keys(attrs).length ? { [ATTR_KEY]: attrs } : {}),
        };
    }
    return n;
}

export async function resolveTrackedChange(
    bytes: Buffer,
    changeIds: string[],
    mode: "accept" | "reject",
): Promise<{ bytes: Buffer; found: boolean }> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const docXmlRaw = await docXmlFile.async("string");

    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];

    const { found } = resolveInTree(tree, changeIds, mode);

    const builder = createBuilder();
    const rebuilt = ensureXmlDeclaration(builder.build(tree));
    setZipEntry(zip, "word/document.xml", rebuilt);
    const out = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    return { bytes: out, found };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function ensureXmlDeclaration(xml: string): string {
    if (xml.startsWith("<?xml")) return xml;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`;
}

function truncate(s: string, n: number): string {
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
}
