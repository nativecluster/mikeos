// The two pages the launcher shows itself: while Mike starts, and if it
// could not. Plain HTML, styles inline, nothing loaded from outside.

const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// A page that looks again in a moment reloads itself from a script: a meta
// refresh is an accessibility failure (axe's meta-refresh, critical).
function page(title, body, reloadSeconds) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#fafaf9;--muted:#a8a29e}}
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}
main{max-width:28rem;padding:2rem;text-align:center}
h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}
p{margin:0;color:var(--muted)}
</style></head><body><main>${body}</main>${reloadSeconds ? `<script>setTimeout(function(){location.reload()},${reloadSeconds * 1000})</script>` : ""}</body></html>`;
}

export function startingPage(step) {
  return page("Starting Mike", `<h1>Starting Mike…</h1><p role="status">${escape(step || "Getting ready")}</p>`, 2);
}

export function failedPage(why) {
  return page("Mike could not start", `<h1>Mike could not start</h1><p>${escape(why)}</p><p>Quit Mike and open it again. If it happens again, the logs folder in Mike's data folder says why.</p>`, 0);
}
