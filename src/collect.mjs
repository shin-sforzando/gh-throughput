// gh-throughput: collect closed-Issue counts and backlog snapshot, then
// append to a CSV and (re)generate a self-contained HTML dashboard.
//
// Why a composite action calling plain Node: no npm deps, no bundling. Inputs
// arrive as INPUT_* env vars (injected by action.yml), matching the convention
// GitHub uses for JS actions so callers find it familiar.

import fs from "node:fs";
import path from "node:path";
import { loadTemplate, renderHtml } from "./template.mjs";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "gh-throughput-action";
const SEARCH_HARD_LIMIT = 1000; // GitHub Search API caps results at 1000.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- input parsing ---------------------------------------------------------

function readInputs(env = process.env) {
  const token = env.INPUT_GITHUB_TOKEN;
  if (!token) throw new Error("github-token input is required");
  const repo = (env.INPUT_REPO || "").trim();
  // An empty repo also fails this check ("".includes("/") is false).
  if (!repo.includes("/")) {
    throw new Error(`repo input must be "owner/name", got: "${repo}"`);
  }
  return {
    token,
    repo,
    assignees: (env.INPUT_ASSIGNEES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    csvPath: (env.INPUT_CSV_PATH || "metrics/throughput.csv").trim(),
    htmlPath: (env.INPUT_HTML_PATH || "metrics/throughput.html").trim(),
    // Empty means the bundled default template; a path is resolved against the
    // working directory so users can point at their own design.
    templatePath: (env.INPUT_TEMPLATE_PATH || "").trim(),
    timezone: (env.INPUT_TIMEZONE || "UTC").trim(),
    maWindow: Math.max(1, parseInt(env.INPUT_MA_WINDOW || "7", 10) || 7),
    // How many local days back to aggregate. Default 1 (yesterday) so closures
    // that happen after a scheduled run are never lost; 0 keeps the legacy
    // in-progress-today behaviour.
    lookbackDays: (() => {
      const n = parseInt(env.INPUT_LOOKBACK_DAYS ?? "1", 10);
      return Number.isNaN(n) ? 1 : Math.max(0, n);
    })(),
  };
}

// --- timezone handling -----------------------------------------------------

// Local calendar day (YYYY-MM-DD) for the given IANA timezone. en-CA formats
// as ISO-like YYYY-MM-DD, so no manual reordering is needed.
export function localDate(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// UTC offset (e.g. "+09:00") for the timezone at the given instant. Reading it
// per-instant means DST-affected zones get the correct offset for that day.
export function tzOffset(date, timeZone) {
  if (timeZone === "UTC") return "+00:00";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const name = parts.find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = name.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : "+00:00";
}

// Build the `closed:` qualifier. A bare date is interpreted by GitHub as UTC,
// so any non-UTC timezone needs an explicit offset-bearing range to carve out
// the correct local day without bleeding into neighbouring UTC days.
export function closedQualifier(localDay, offset) {
  if (offset === "+00:00") return `closed:${localDay}`;
  return `closed:${localDay}T00:00:00${offset}..${localDay}T23:59:59${offset}`;
}

// --- GitHub API ------------------------------------------------------------

// Test seam: when GH_THROUGHPUT_FIXTURE points to a JSON file we resolve from
// it instead of the network. Inert in production (env unset) and keeps the
// action's real code path unchanged.
function fixtureResponse(url) {
  const fixture = JSON.parse(
    fs.readFileSync(process.env.GH_THROUGHPUT_FIXTURE, "utf8"),
  );
  return url.includes("is%3Aopen") ? fixture.backlog : fixture.closed;
}

async function ghGet(url, token) {
  if (process.env.GH_THROUGHPUT_FIXTURE) return fixtureResponse(url);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
      },
    });
    // 403/429 with a rate-limit signal: back off and retry rather than fail.
    const remaining = res.headers.get("x-ratelimit-remaining");
    const rateLimited =
      res.status === 429 || (res.status === 403 && remaining === "0");
    if (rateLimited && attempt < 4) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = retryAfter
        ? retryAfter * 1000
        : Math.min(2 ** attempt * 1000, 30000);
      console.log(`Rate limited (status ${res.status}); waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }
  throw new Error("GitHub API: exhausted retries while rate limited");
}

async function searchAll(query, token) {
  const items = [];
  let total = 0;
  for (let page = 1; page <= 10; page++) {
    const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}`;
    const data = await ghGet(url, token);
    total = data.total_count ?? 0;
    const pageItems = data.items || [];
    items.push(...pageItems);
    if (pageItems.length < 100) break;
    await sleep(500); // Gentle pacing to avoid secondary rate limits.
  }
  if (total > SEARCH_HARD_LIMIT) {
    console.log(
      `WARNING: ${total} matches exceed the Search API's ${SEARCH_HARD_LIMIT}-result cap; counts may be truncated.`,
    );
  }
  return { items, total };
}

// --- aggregation -----------------------------------------------------------

// Multiple assignees each get +1 (simple whole-count model). Splitting credit
// across co-assignees is intentionally left as a future extension.
export function aggregate(items, targetAssignees) {
  const fixed = targetAssignees.length > 0;
  const counts = new Map();
  if (fixed) for (const a of targetAssignees) counts.set(a, 0);
  for (const item of items) {
    for (const who of item.assignees || []) {
      const login = who.login;
      if (fixed && !counts.has(login)) continue; // out-of-scope assignee
      counts.set(login, (counts.get(login) || 0) + 1);
    }
  }
  return counts;
}

// Rows for one day. When no real assignee row exists (e.g. auto-detect on a
// zero-closed day) we emit a single sentinel row with an empty assignee so the
// backlog time series stays continuous.
export function buildRows(date, counts, backlog) {
  const rows = [];
  for (const [assignee, closed] of counts) {
    rows.push({ date, assignee, closed, backlog });
  }
  if (rows.length === 0) rows.push({ date, assignee: "", closed: 0, backlog });
  return rows;
}

// --- CSV -------------------------------------------------------------------

// Existing (date,assignee) keys, so re-runs on the same day never duplicate
// rows. GitHub logins contain no commas, so naive splitting is safe.
export function existingKeys(csvContent) {
  const keys = new Set();
  for (const line of csvContent.split("\n")) {
    if (!line.trim() || line.startsWith("date,")) continue;
    const [date, assignee = ""] = line.split(",");
    keys.add(`${date}\t${assignee}`);
  }
  return keys;
}

function appendCsv(csvPath, rows) {
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  const exists = fs.existsSync(csvPath);
  const content = exists ? fs.readFileSync(csvPath, "utf8") : "";
  const keys = existingKeys(content);
  const fresh = rows.filter((r) => !keys.has(`${r.date}\t${r.assignee}`));
  if (!exists) fs.writeFileSync(csvPath, "date,assignee,closed,backlog\n");
  if (fresh.length) {
    const text =
      fresh
        .map((r) => `${r.date},${r.assignee},${r.closed},${r.backlog}`)
        .join("\n") + "\n";
    fs.appendFileSync(csvPath, text);
  }
  console.log(
    `CSV: ${fresh.length} new row(s) appended, ${rows.length - fresh.length} skipped (already present)`,
  );
  return fresh.length;
}

// --- main ------------------------------------------------------------------

export async function main(env = process.env, now = new Date()) {
  const cfg = readInputs(env);
  // Aggregate a fully-completed local day (default: yesterday) so closures that
  // happen after the scheduled run are never lost. Subtracting whole days keeps
  // the same wall-clock time on the target date, well inside that local day
  // (avoid scheduling within ~1h of local midnight in DST zones for this reason).
  const target = new Date(now.getTime() - cfg.lookbackDays * 86400000);
  const day = localDate(target, cfg.timezone);
  const offset = tzOffset(target, cfg.timezone);

  // Issues only. PR "closed" is muddier (merges vs closes, and PRs are seldom
  // assigned), and the backlog is issues-only, so keeping throughput to Issues
  // keeps both axes measuring the same kind of work.
  const closedQuery = `repo:${cfg.repo} is:issue ${closedQualifier(day, offset)}`;
  console.log(`Collecting closed issues: ${closedQuery}`);
  const { items } = await searchAll(closedQuery, cfg.token);

  const counts = aggregate(items, cfg.assignees);

  const backlogQuery = `repo:${cfg.repo} is:issue is:open`;
  const backlog =
    (
      await ghGet(
        `${GITHUB_API}/search/issues?q=${encodeURIComponent(backlogQuery)}&per_page=1`,
        cfg.token,
      )
    ).total_count ?? 0;
  console.log(`Backlog (open issues) snapshot for ${day}: ${backlog}`);

  const rows = buildRows(day, counts, backlog);
  appendCsv(cfg.csvPath, rows);

  const template = loadTemplate(
    cfg.templatePath ? path.resolve(cfg.templatePath) : undefined,
  );
  const html = renderHtml(fs.readFileSync(cfg.csvPath, "utf8"), {
    maWindow: cfg.maWindow,
    repo: cfg.repo,
    template,
    generatedAt: now.toISOString(),
    timezone: cfg.timezone,
  });
  fs.mkdirSync(path.dirname(cfg.htmlPath), { recursive: true });
  fs.writeFileSync(cfg.htmlPath, html);
  console.log(`HTML dashboard written to ${cfg.htmlPath}`);

  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      env.GITHUB_OUTPUT,
      `csv-path=${cfg.csvPath}\nhtml-path=${cfg.htmlPath}\n`,
    );
  }
  return { csvPath: cfg.csvPath, htmlPath: cfg.htmlPath, backlog };
}

// Run only when executed directly, so tests can import the helpers above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
