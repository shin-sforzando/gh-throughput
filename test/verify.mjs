// Offline verification harness. Mocks the GitHub Search API via the
// GH_THROUGHPUT_FIXTURE seam in collect.mjs and asserts CSV append,
// idempotency, sentinel rows, and HTML generation.
//
// Run: node test/verify.mjs   (writes to a throwaway temp dir)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../src/collect.mjs";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "gh-throughput-"));
const csvPath = path.join(work, "metrics/throughput.csv");
const htmlPath = path.join(work, "metrics/throughput.html");

function fixture(items, backlog) {
  const file = path.join(
    work,
    `fixture-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(
    file,
    JSON.stringify({
      closed: { total_count: items.length, items },
      backlog: { total_count: backlog },
    }),
  );
  return file;
}

function issue(...logins) {
  return { assignees: logins.map((login) => ({ login })) };
}

async function runDay(dateIso, items, backlog) {
  process.env.GH_THROUGHPUT_FIXTURE = fixture(items, backlog);
  const env = {
    INPUT_GITHUB_TOKEN: "x",
    INPUT_REPO: "shin-sforzando/rendez-vous",
    INPUT_ASSIGNEES: "", // auto-detect, so sentinel path is exercised
    INPUT_CSV_PATH: csvPath,
    INPUT_HTML_PATH: htmlPath,
    INPUT_TIMEZONE: "UTC",
    INPUT_MA_WINDOW: "3",
    // These cases assert same-day rows, so pin lookback to 0 (legacy behaviour).
    // The default (previous-day) shift is covered by its own test below.
    INPUT_LOOKBACK_DAYS: "0",
  };
  return main(env, new Date(dateIso));
}

function csvRows() {
  return fs
    .readFileSync(csvPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("date,"));
}

// Day 1: alice x2, bob x1
await runDay(
  "2026-06-30T12:00:00Z",
  [issue("alice"), issue("alice"), issue("bob")],
  8,
);
// Day 2: alice x1, bob x2, carol x1
await runDay(
  "2026-07-01T12:00:00Z",
  [issue("alice"), issue("bob"), issue("bob"), issue("carol")],
  6,
);
// Day 3: nothing closed -> sentinel backlog-only row
await runDay("2026-07-02T12:00:00Z", [], 5);

const afterThreeDays = csvRows();
console.log("Rows after 3 days:\n" + afterThreeDays.join("\n"));

// alice+bob (day1) + alice+bob+carol (day2) + sentinel (day3) = 6 rows
assert.equal(afterThreeDays.length, 6, "expected 6 rows across 3 days");
assert.ok(afterThreeDays.includes("2026-06-30,alice,2,8"), "alice day1 count");
assert.ok(afterThreeDays.includes("2026-07-01,bob,2,6"), "bob day2 count");
assert.ok(
  afterThreeDays.includes("2026-07-02,,0,5"),
  "sentinel row on empty day",
);

// Idempotency: re-run day 2 with identical data -> no new rows.
await runDay(
  "2026-07-01T12:00:00Z",
  [issue("alice"), issue("bob"), issue("bob"), issue("carol")],
  6,
);
assert.equal(csvRows().length, 6, "re-run must not duplicate rows");

// Default lookback (1 day): a run "on" 2026-07-10 must record the previous
// complete day, 2026-07-09 — this is the fix for closures being lost to run timing.
{
  const shiftCsv = path.join(work, "shift/throughput.csv");
  process.env.GH_THROUGHPUT_FIXTURE = fixture([issue("alice")], 4);
  await main(
    {
      INPUT_GITHUB_TOKEN: "x",
      INPUT_REPO: "shin-sforzando/rendez-vous",
      INPUT_ASSIGNEES: "",
      INPUT_CSV_PATH: shiftCsv,
      INPUT_HTML_PATH: path.join(work, "shift/throughput.html"),
      INPUT_TIMEZONE: "UTC",
      INPUT_MA_WINDOW: "3",
      // INPUT_LOOKBACK_DAYS omitted -> default 1 (yesterday).
    },
    new Date("2026-07-10T12:00:00Z"),
  );
  const shiftRows = fs
    .readFileSync(shiftCsv, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("date,"));
  assert.ok(
    shiftRows.includes("2026-07-09,alice,1,4"),
    `default lookback must record the previous day, got: ${shiftRows.join(" | ")}`,
  );
}

// HTML sanity: self-contained, has CDN scripts and inlined data.
const html = fs.readFileSync(htmlPath, "utf8");
assert.ok(html.includes("chartjs-plugin-zoom"), "zoom plugin CDN present");
assert.ok(html.includes("hammer.min.js"), "hammer.js CDN present");
assert.ok(html.includes("const DATA ="), "inlined data present");
assert.ok(html.includes('"alice"'), "alice series in data");
assert.ok(!html.includes("</script></script>"), "no broken script tags");
// Redesign: Basecoat styling, linked logins, and no leftover placeholders.
assert.ok(html.includes("basecoat-css@"), "Basecoat CDN present");
assert.ok(
  html.includes('"https://github.com/" + encodeURIComponent(a.login)'),
  "logins are linked to GitHub profiles",
);
assert.ok(html.includes('"generatedAt"'), "generation timestamp is inlined");
assert.ok(!html.includes("{{DATA}}"), "DATA placeholder was substituted");
assert.ok(!html.includes("{{TITLE}}"), "TITLE placeholder was substituted");

console.log(`\nAll assertions passed. HTML at: ${htmlPath}`);
// Emit the html path so a caller can open it in a browser for the visual check.
console.log(`HTML_PATH=${htmlPath}`);
