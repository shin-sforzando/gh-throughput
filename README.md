# gh-throughput

English | [日本語](README.ja.md)

A reusable **composite GitHub Action** that visualizes per-assignee daily Issue/PR throughput and the open-issue backlog for a repository, with no external database.
Data is persisted as a CSV inside the repository that uses the Action, and a self-contained HTML dashboard is generated alongside it.
Track everyone by default, or narrow the set with the `assignees` input.

The Action's responsibility ends at "aggregate today's closed items → append to CSV → render HTML → commit & push".
**Where** you display the HTML (GitHub Pages, Wiki attachment, or just opening it locally) is left to you — the dashboard is a single file that runs the same from `file://`, a Wiki, or Pages.

## Usage

Add one step to a workflow after `actions/checkout`:

```yaml
name: Throughput
on:
  schedule:
    - cron: "0 0 * * *" # 00:00 UTC = 09:00 JST daily
  workflow_dispatch:

# A permissions block makes every unlisted scope `none`, so declare the read
# scopes the Search API needs (issues / pull requests) next to contents: write,
# which is used to commit the CSV/HTML back to the repo.
permissions:
  contents: write
  issues: read
  pull-requests: read

jobs:
  throughput:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: shin-sforzando/gh-throughput@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          timezone: Asia/Tokyo # aggregate & record by the JST calendar day
```

With `timezone: Asia/Tokyo`, "today" is the JST calendar day and the CSV `date`
column records that local day. Omit it (default `UTC`) to key everything off the
UTC calendar day.

## Inputs

| Input            | Required | Default                            | Description                                                      |
| ---------------- | -------- | ---------------------------------- | ---------------------------------------------------------------- |
| `github-token`   | ✅       | –                                  | Token for the Search API. `secrets.GITHUB_TOKEN` is expected.    |
| `repo`           | –        | `${{ github.repository }}`         | Target repository `owner/name`.                                  |
| `assignees`      | –        | _(empty → auto-detect)_            | Comma-separated GitHub usernames.                                |
| `track`          | –        | `both`                             | `issue`, `pr`, or `both`.                                        |
| `csv-path`       | –        | `metrics/throughput.csv`           | Where the CSV is persisted.                                      |
| `html-path`      | –        | `metrics/throughput.html`          | Where the HTML dashboard is written.                             |
| `branch`         | –        | _(empty → checked-out branch)_     | Dedicated orphan branch to commit metrics to (e.g. `metrics`). Use it when the default branch requires pull requests. |
| `timezone`       | –        | `UTC`                              | IANA timezone deciding the "today" boundary (e.g. `Asia/Tokyo`). |
| `ma-window`      | –        | `7`                                | Moving-average window in days.                                   |
| `commit`         | –        | `true`                             | Whether to commit and push the generated files.                  |
| `commit-message` | –        | `chore: update throughput metrics` | Commit message.                                                  |

### Outputs

| Output      | Description                                   |
| ----------- | --------------------------------------------- |
| `csv-path`  | Path actually written for the CSV.            |
| `html-path` | Path actually written for the HTML dashboard. |

## CSV schema

```csv
date,assignee,closed,backlog
2026-07-01,alice,2,8
2026-07-01,bob,1,8
```

- `date` — calendar day in the configured `timezone` (`YYYY-MM-DD`).
- `assignee` — GitHub username. An **empty** value is a sentinel row that only
  carries the backlog for a day on which no assignee closed anything (keeps the
  backlog series continuous).
- `closed` — Issue/PR that user closed that day.
- `backlog` — repository-wide open-issue count at that time. It is the same for
  every row of the same day (redundant, but keeps the implementation simple).
- Re-running on the same day does **not** duplicate rows (idempotent on
  `date` + `assignee`).

## Dashboard

Opening the generated HTML shows a two-axis chart:

- **Left axis** — daily closed count: faint scatter points (actuals) plus a thick moving-average line per assignee, with a dashed team-average line.
- **Right axis** — the open-issue backlog as bars.
- Scroll to **zoom**, drag to **pan** (powered by `chartjs-plugin-zoom`).

Chart.js and its plugins load from a CDN; the data itself is inlined, so no network fetch of the CSV is needed.

## Behavior notes & limitations

### Backlog is not backfillable.

The backlog is a snapshot captured at each run; a meaningful time series only accrues from the day you adopt the Action.
Values before adoption cannot be reconstructed accurately.

### Search API 1000-result cap.

A single day's `closed:` query is paged at 100/page up to 10 pages.
If a day exceeds 1000 matches, counts may be truncated and a warning is logged.

### Multiple assignees each get +1.

Co-assigned items count for every assignee (simple whole-count model).
Splitting credit is a future extension.

### Required permissions

`contents: write` is required in the calling workflow when `commit: true`; without it the push fails with an error pointing at this setting.
Because a `permissions:` block sets every unlisted scope to `none`, also grant `issues: read` and `pull-requests: read` — the Search API needs them, and on a private repository the aggregation otherwise fails with a 403.

### Protected default branches

If the default branch requires pull requests (a branch ruleset or protection rule), the Action cannot push to it directly and the run fails.
Set the `branch` input to a dedicated name (e.g. `branch: metrics`) and the Action commits to that **orphan** branch instead — it holds only the metrics, is created on first run, and never touches the protected branch. View the dashboard from that branch (or serve it via GitHub Pages).

```yaml
- uses: shin-sforzando/gh-throughput@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    branch: metrics
```

### Cross-repo aggregation is out of scope for now.

The `repo` input exists, but the default `GITHUB_TOKEN` can only write/read its own repository; aggregating a _different_ repository would require a fine-grained PAT with read access to it.
This is not currently supported/verified.

## Development

This repository is the Action itself; the sections below are for contributors, not consumers.

### Project layout

```text
action.yml          # composite action definition (inputs/outputs, steps)
src/collect.mjs     # Search API collection, aggregation, idempotent CSV append, HTML write
src/template.mjs    # pure functions: CSV parsing, series math, self-contained HTML rendering
test/verify.mjs     # offline verification harness (mocks the API)
```

### Toolchain

[mise](https://mise.jdx.dev/) pins Node and the dev tools (Biome, lefthook, markdownlint-cli2) in `mise.toml`.

```sh
mise install     # install Node + dev tools
mise run setup   # install git hooks (lefthook)
```

### Tasks

| Task               | What it does                 |
| ------------------ | ---------------------------- |
| `mise run check`   | Biome lint & format check    |
| `mise run fix`     | Biome auto-fix & format      |
| `mise run lint-md` | markdownlint                 |
| `mise run test`    | offline verification harness |
| `mise run setup`   | install git hooks (lefthook) |

### Git hooks

`lefthook` runs on pre-commit against staged files: Biome (`--write`) for `js/mjs/json`, markdownlint (`--fix`) for Markdown.
Fixes are re-staged automatically.

### No runtime dependencies

The Action runs plain Node with `fetch`/`fs`/`path` only — no npm install, no bundling.
Chart.js and its zoom plugin load from a CDN in the browser; they are never installed here.

### Testing offline

`src/collect.mjs` has a test seam: set `GH_THROUGHPUT_FIXTURE` to a JSON file shaped like `{ "closed": {...}, "backlog": {...} }` and it resolves from that file instead of the GitHub API.
`test/verify.mjs` uses this to assert CSV append, idempotency, sentinel rows, and HTML output — run it with `mise run test`.
Core logic is exported as pure functions (`localDate`, `tzOffset`, `closedQualifier`, `aggregate`, `buildRows`, `renderHtml`, …) plus `main(env, now)`, so units are testable without the network.

### Releasing

Consumers pin `@v1`; maintainers move the `v1` tag to each release commit.
Commits follow the cz-emoji convention, and the changelog is generated with git-cliff (`cliff.toml`).

## License

MIT License.
