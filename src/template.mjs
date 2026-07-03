// gh-throughput: turn the throughput CSV into a single self-contained HTML
// dashboard. All data is inlined as JSON (no fetch), so the file works from
// file://, a Wiki attachment, or GitHub Pages identically.

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

export function renderHtml(csvContent, { maWindow = 7, repo = "" } = {}) {
  const rows = parseCsv(csvContent);
  const series = computeSeries(rows, maWindow);
  const data = { ...series, maWindow, repo };

  const cdn = {
    chart: "https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js",
    hammer: "https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js",
    zoom: "https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js",
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Throughput${repo ? ` — ${repo}` : ""}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  header { padding: 12px 16px; border-bottom: 1px solid rgba(128,128,128,.3); }
  h1 { font-size: 1rem; margin: 0; font-weight: 600; }
  .hint { font-size: .8rem; opacity: .7; margin-top: 4px; }
  .wrap { padding: 16px; height: 78vh; box-sizing: border-box; }
  button { font: inherit; padding: 4px 10px; margin-left: 8px; cursor: pointer; }
</style>
</head>
<body>
<header>
  <h1>Issue/PR Throughput${repo ? ` — ${repo}` : ""}</h1>
  <div class="hint">
    Faint points = daily actuals · thick line = ${maWindow}-day moving average ·
    dashed = team average · bars = open-issue backlog (right axis).
    Scroll to zoom, drag to pan.
    <button id="reset">Reset zoom</button>
  </div>
</header>
<div class="wrap"><canvas id="chart"></canvas></div>
<script src="${cdn.chart}"></script>
<script src="${cdn.hammer}"></script>
<script src="${cdn.zoom}"></script>
<script>
const DATA = ${safeJson(data)};
const datasets = [];
for (const a of DATA.assignees) {
  // Faint actuals as points only (line type + showLine:false keeps the x axis
  // categorical; a scatter type would force a linear x axis and drop the data).
  datasets.push({
    type: "line", label: a.login + " (actual)", data: a.raw,
    backgroundColor: a.color + "55", borderColor: a.color + "55",
    pointRadius: 3, pointHoverRadius: 4, showLine: false,
    spanGaps: false, yAxisID: "y",
  });
  datasets.push({
    type: "line", label: a.login + " (avg)", data: a.ma,
    borderColor: a.color, backgroundColor: a.color,
    borderWidth: 2.5, pointRadius: 0, tension: 0.25, yAxisID: "y",
  });
}
datasets.push({
  type: "line", label: "Team average", data: DATA.teamMA,
  borderColor: "#6b7280", borderDash: [6, 4], borderWidth: 2,
  pointRadius: 0, tension: 0.25, yAxisID: "y",
});
datasets.push({
  type: "bar", label: "Backlog (open issues)", data: DATA.backlog,
  backgroundColor: "rgba(148,163,184,.35)", borderColor: "rgba(148,163,184,.6)",
  borderWidth: 1, yAxisID: "y1", order: 99,
});

const chart = new Chart(document.getElementById("chart"), {
  data: { labels: DATA.dates, datasets },
  options: {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: "nearest", intersect: false },
    stacked: false,
    scales: {
      x: { type: "category", title: { display: true, text: "Date" } },
      y: {
        type: "linear", position: "left", beginAtZero: true,
        title: { display: true, text: "Daily closed Issue/PR" },
      },
      y1: {
        type: "linear", position: "right", beginAtZero: true,
        grid: { drawOnChartArea: false },
        title: { display: true, text: "Backlog (open issues)" },
      },
    },
    plugins: {
      legend: { position: "bottom" },
      zoom: {
        zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" },
        pan: { enabled: true, mode: "x" },
      },
    },
  },
});
document.getElementById("reset").addEventListener("click", () => chart.resetZoom());
</script>
</body>
</html>
`;
}
