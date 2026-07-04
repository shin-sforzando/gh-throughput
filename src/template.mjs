// gh-throughput: turn the throughput CSV into a single self-contained HTML
// dashboard. All data is inlined as JSON (no fetch), so the file works from
// file://, a Wiki attachment, or GitHub Pages identically.
//
// The data math (parseCsv/computeSeries/…) is pure. Presentation lives in an
// external template file (dashboard.template.html) so callers can restyle the
// dashboard wholesale via the action's `template-path` input; renderHtml only
// injects data into that template. loadTemplate() is the single I/O touch point.

import fs from "node:fs";

// Fixed categorical palette. Assignees map onto it deterministically so the
// same person keeps the same color across runs.
const PALETTE = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#d97706",
  "#9333ea",
  "#0891b2",
  "#db2777",
  "#65a30d",
  "#ea580c",
  "#4f46e5",
  "#0d9488",
  "#c026d3",
];

function stableHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function colorFor(login) {
  return PALETTE[stableHash(login) % PALETTE.length];
}

// Deterministic color per assignee that also avoids collisions within a team:
// each login starts at its hashed slot and probes to the next free one. For a
// stable roster this is fully reproducible; if the roster changes, only a
// colliding member's probed color may shift.
export function assignColors(logins) {
  const used = new Set();
  const map = new Map();
  for (const login of logins) {
    let idx = stableHash(login) % PALETTE.length;
    for (let tries = 0; used.has(idx) && tries < PALETTE.length; tries++) {
      idx = (idx + 1) % PALETTE.length;
    }
    used.add(idx);
    map.set(login, PALETTE[idx]);
  }
  return map;
}

export function parseCsv(content) {
  const rows = [];
  for (const line of content.split("\n")) {
    if (!line.trim() || line.startsWith("date,")) continue;
    const [date, assignee = "", closed = "0", backlog = "0"] = line.split(",");
    rows.push({
      date,
      assignee,
      closed: Number(closed) || 0,
      backlog: Number(backlog) || 0,
    });
  }
  return rows;
}

// Trailing simple moving average with a minimum window of 1, so the leading
// edge is defined instead of null. Null inputs (no observation) are skipped.
export function movingAverage(values, window) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      if (values[j] == null) continue;
      sum += values[j];
      n++;
    }
    out.push(n ? Number((sum / n).toFixed(3)) : null);
  }
  return out;
}

export function computeSeries(rows, maWindow) {
  const dates = [...new Set(rows.map((r) => r.date))].sort();

  // Last backlog value wins per day (redundant rows carry the same value).
  const backlogByDate = new Map();
  for (const r of rows) backlogByDate.set(r.date, r.backlog);
  const backlog = dates.map((d) => backlogByDate.get(d) ?? null);

  // Empty assignee = sentinel backlog row; excluded from per-person series.
  const closedByKey = new Map();
  for (const r of rows) {
    if (!r.assignee) continue;
    closedByKey.set(`${r.date}\t${r.assignee}`, r.closed);
  }
  const logins = [
    ...new Set(rows.map((r) => r.assignee).filter(Boolean)),
  ].sort();
  const colors = assignColors(logins);

  const assignees = logins.map((login) => {
    // raw: only real observations (null gaps) for the faint scatter points.
    const raw = dates.map((d) => {
      const key = `${d}\t${login}`;
      return closedByKey.has(key) ? closedByKey.get(key) : null;
    });
    // A missing row means zero closed that day, so 0-fill for the average.
    const filled = dates.map((d) => closedByKey.get(`${d}\t${login}`) ?? 0);
    return {
      login,
      color: colors.get(login),
      raw,
      ma: movingAverage(filled, maWindow),
    };
  });

  // Team average: daily mean of closed-per-assignee, then smoothed.
  const teamDaily = dates.map((d) => {
    if (!logins.length) return null;
    let sum = 0;
    for (const login of logins) sum += closedByKey.get(`${d}\t${login}`) ?? 0;
    return sum / logins.length;
  });
  const teamMA = movingAverage(teamDaily, maWindow);

  return { dates, assignees, teamMA, backlog };
}

// JSON embedded in a <script> must not contain a literal "</script>" or a lone
// "<"; escaping "<" as < is sufficient and keeps it valid JSON.
function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtml(str) {
  return str.replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );
}

// Read the HTML template. With no path, the bundled default sitting next to this
// module is used (resolved via import.meta.url so it works from any cwd, e.g.
// when the action runs from a different working directory). A caller-supplied
// path lets users ship their own design.
export function loadTemplate(templatePath) {
  const source =
    templatePath || new URL("./dashboard.template.html", import.meta.url);
  return fs.readFileSync(source, "utf8");
}

// Inject the computed series into the template. The template owns all markup
// and chart configuration; renderHtml only fills the {{TITLE}} and {{DATA}}
// placeholders. String replacements use function replacers so "$" sequences in
// the data are never interpreted as replacement patterns.
export function renderHtml(
  csvContent,
  {
    maWindow = 7,
    repo = "",
    template = loadTemplate(),
    generatedAt = "",
    timezone = "UTC",
  } = {},
) {
  const rows = parseCsv(csvContent);
  const series = computeSeries(rows, maWindow);
  const data = { ...series, maWindow, repo, generatedAt, timezone };
  const title = `Throughput${repo ? ` — ${repo}` : ""}`;

  return template
    .replaceAll("{{TITLE}}", () => escapeHtml(title))
    .replaceAll("{{DATA}}", () => safeJson(data));
}
