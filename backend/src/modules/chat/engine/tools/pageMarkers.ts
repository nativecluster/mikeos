/**
 * The pages of a document's extracted text, from its "[Page N]" markers.
 *
 * A PDF's text (lib/pdfText.ts) is each page in order, "[Page 1]" to
 * "[Page n]", each marker alone on its line; that marker's number is what a
 * citation's `page` means (prompts.ts, citeSources.ts), not a page number
 * printed in the document. A line of the document's own that reads like a
 * marker is content: markers count only in sequence from "[Page 1]", so a
 * stray "[Page 2]" on page 5 is not a page boundary. Text without them (a
 * Word document, a spreadsheet) has no pages here.
 */
const PAGE_MARKER = /^\[Page (\d+)\]$/gm;

/** Where each page starts: `starts[i]` is the offset of "[Page i+1]". */
export function pageStarts(text: string): number[] {
  const starts: number[] = [];
  for (const match of text.matchAll(PAGE_MARKER)) {
    if (Number(match[1]) === starts.length + 1) starts.push(match.index);
  }
  return starts;
}

/** The page that holds `offset`, or null before the first page or in an unpaged text. */
export function pageAt(starts: readonly number[], offset: number): number | null {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (starts[mid] <= offset) low = mid + 1;
    else high = mid;
  }
  return low === 0 ? null : low;
}

/**
 * The page a quote found at [start, end) is on, as a citation names it: "32",
 * or "41-42" for one that crosses a page break. Null in an unpaged text.
 */
export function citedPageAt(
  starts: readonly number[],
  start: number,
  end: number,
): number | string | null {
  const first = pageAt(starts, start);
  if (first === null) return null;
  const last = pageAt(starts, Math.max(start, end - 1)) ?? first;
  return last === first ? first : `${first}-${last}`;
}

const startsByHolder = new WeakMap<object, { text: string; starts: number[] }>();

/** pageStarts, built once per holder (a turn's DocStore entry) while its text is unchanged. */
export function pageStartsFor(holder: object, text: string): number[] {
  const cached = startsByHolder.get(holder);
  if (cached && cached.text === text) return cached.starts;
  const starts = pageStarts(text);
  startsByHolder.set(holder, { text, starts });
  return starts;
}
