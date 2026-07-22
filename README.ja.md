# gh-throughput

[English](README.md) | 日本語

外部データベースに依存せず、リポジトリの担当者ごとの日次 Issue 消化数とオープンIssueの残数を可視化する、再利用可能な **composite GitHub Action** です。
データは Action を利用するリポジトリ内に CSV として永続化され、その隣に自己完結型の HTML ダッシュボードが生成されます。
既定では全員を追跡し、`assignees` 入力で対象を絞れます。

Action の責務は「前日(完了した1日)のクローズ分を集計 → CSV へ追記 → HTML を生成 → commit & push」までです。
生成した HTML を**どこに表示するか**(GitHub Pages、Wiki 添付、あるいはローカルで直接開くだけ)は利用側に委ねます。
ダッシュボードは単一ファイルで、`file://`・Wiki・Pages のいずれからでも同じように動作します。

## 使い方

`actions/checkout` の後に1ステップ追加するだけです。

```yaml
name: Throughput
on:
  schedule:
    # 1日1回実行できればよい。前日を集計する(lookback-days 参照)ため実行時刻は問わない。
    - cron: "0 0 * * *" # 00:00 UTC = 09:00 JST(毎日)
  workflow_dispatch:

# permissions ブロックを書くと未記載スコープはすべて none になるため、
# CSV/HTML の commit 用 contents: write に加え、Search API が必要とする
# issues / pull-requests の read も明示する。
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
          timezone: Asia/Tokyo # JST の暦日で集計・記録する
```

デフォルトでは **前日(完了した1日)** を集計します(`lookback-days: 1`)。日次スループットはその日が終わって初めて確定するため、集計窓を「完了した日」に閉じることで、実行時刻との前後に関係なくクローズが必ずカウントされます。したがって cron はいつ発火してもよく、1日の終わりに合わせる必要はありません。

`timezone: Asia/Tokyo` を指定すると「前日」は JST の暦日となり、CSV の `date` 列にもその現地日が記録されます。省略時(デフォルト `UTC`)はすべて UTC の暦日を基準にします。`lookback-days: 0` にすると従来どおり進行中の当日を集計します。

## 入力

| 入力             | 必須 | デフォルト                         | 説明                                                         |
| ---------------- | ---- | ---------------------------------- | ------------------------------------------------------------ |
| `github-token`   | ✅   | –                                  | Search API 用トークン。`secrets.GITHUB_TOKEN` を想定。       |
| `repo`           | –    | `${{ github.repository }}`         | 集計対象リポジトリ `owner/name`。                            |
| `assignees`      | –    | _(空 → 自動検出)_                  | カンマ区切りの GitHub ユーザー名。                           |
| `csv-path`       | –    | `metrics/throughput.csv`           | CSV の永続化先。                                             |
| `html-path`      | –    | `metrics/throughput.html`          | HTML ダッシュボードの出力先。                                |
| `template-path`  | –    | _(空 → 同梱の既定テンプレート)_    | ダッシュボードの独自 HTML テンプレート。`{{DATA}}` プレースホルダは必須。 |
| `branch`         | –    | _(空 → チェックアウト中のブランチ)_ | metrics を commit する専用の orphan ブランチ(例 `metrics`)。default ブランチが PR 必須のときに使う。 |
| `timezone`       | –    | `UTC`                              | 暦日の境界を決める IANA タイムゾーン(例: `Asia/Tokyo`)。    |
| `ma-window`      | –    | `7`                                | 移動平均の窓幅(日)。                                         |
| `lookback-days`  | –    | `1`                                | クローズIssueを何日前まで遡って集計するか。`1` は前日(完了した1日)を記録し実行時刻に依存しない。`0` は進行中の当日を集計。 |
| `commit`         | –    | `true`                             | 生成物を commit / push するか。                              |
| `commit-message` | –    | `chore: update throughput metrics` | commit メッセージ。                                          |

### 出力

| 出力        | 説明                                         |
| ----------- | -------------------------------------------- |
| `csv-path`  | 実際に書き出した CSV のパス。                |
| `html-path` | 実際に書き出した HTML ダッシュボードのパス。 |

## CSV スキーマ

```csv
date,assignee,closed,backlog
2026-07-01,alice,2,8
2026-07-01,bob,1,8
```

- `date` — 設定した `timezone` における集計対象の暦日(`YYYY-MM-DD`)。デフォルトでは前日(`lookback-days` 参照)。
- `assignee` — GitHub ユーザー名。**空**の値は番兵行で、その日に誰もクローズしなかった場合に backlog だけを担持します(backlog の時系列を途切れさせないため)。
- `closed` — その日にそのユーザーがクローズした Issue 数。
- `backlog` — **実行時点**のリポジトリ全体のオープンIssue数を、集計対象日の行に記録します(前日終了時点 ≒ 実行時点のスナップショットで近似)。同じ日の全行で同値です(冗長ですが実装をシンプルに保つため)。
- 同じ日に再実行しても行は重複しません(`date` + `assignee` について冪等)。

## ダッシュボード

生成された HTML を開くと、2軸のグラフが表示されます。

- **左軸** — 日次消化数。担当者ごとの実績を薄い点で、移動平均を太線で描き、チーム平均を破線で重ねます。
- **右軸** — オープンIssueの残数を棒グラフで表示します。
- スクロールで**ズーム**、ドラッグで**パン**できます(`chartjs-plugin-zoom` を使用)。

Chart.js とプラグインは CDN から読み込みますが、データ自体はインラインで埋め込まれているため、CSV をネットワーク経由で取得する必要はありません。

## 挙動と制約

### backlog は遡及できない

backlog は各実行時点のスナップショットです。意味のある時系列は Action を導入した日から積み上がります。
導入前の値を正確に再現することはできません。

### Search API の 1000件上限

1日分の `closed:` クエリは 100件/ページで最大10ページまでページングします。
1日で1000件を超える場合、カウントが切り詰められる可能性があり、警告ログを出します。

### 複数アサインは全員に +1

共同アサインされた項目は各担当者にカウントされます(単純な全員加算方式)。
按分は将来の拡張点です。

### 必要な permissions

`commit: true` のとき `contents: write` が呼び出し側ワークフローに必要です。これが無いと push はこの設定を指し示すエラーで失敗します。
また `permissions:` ブロックを書くと未記載スコープはすべて `none` になるため、`issues: read` と `pull-requests: read` も付与してください。Search API がこれらを必要とし、private リポジトリでは無いと集計が 403 で失敗します。

### 保護された default ブランチ

default ブランチが PR 必須(branch ruleset / protection)の場合、Action は直接 push できず run が失敗します。
`branch` 入力に専用名(例 `branch: metrics`)を指定すると、その **orphan** ブランチへ commit します。metrics だけを持ち、初回実行時に作成され、保護対象ブランチには一切触れません。ダッシュボードはそのブランチから閲覧します(GitHub Pages 配信も可)。

```yaml
- uses: shin-sforzando/gh-throughput@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    branch: metrics
```

### self-hosted runner

追加設定なしで self-hosted runner でも動作します。
グローバル git 設定への書き込みを行わないため、`HOME` が存在しない・未設定・書き込み不可な runner でも失敗せず、runner 自身の git 設定を書き換えることもありません。

### 他リポジトリ集計は現状スコープ外

`repo` 入力は存在しますが、デフォルトの `GITHUB_TOKEN` は自身のリポジトリしか読み書きできません。
**別の**リポジトリを集計するには、そのリポジトリへの読み取り権限を持つ fine-grained PAT が必要です。
現状これはサポート・検証していません。

## 開発

このリポジトリは Action 本体です。
以下は利用者ではなく開発者向けの情報です。

### ディレクトリ構成

```text
action.yml          # composite action 定義(入出力・steps)
src/collect.mjs     # Search API 収集・集計・冪等な CSV 追記・HTML 書き出し
src/template.mjs    # 純関数: CSV パース・系列計算・自己完結 HTML 生成
test/verify.mjs     # オフライン検証ハーネス(API をモック)
```

### ツールチェーン

[mise](https://mise.jdx.dev/) が Node と開発ツール(Biome / lefthook / markdownlint-cli2)を `mise.toml` でピン留めします。

```sh
mise install     # Node と開発ツールを導入
mise run setup   # git hooks(lefthook)を導入
```

### タスク

| タスク             | 内容                          |
| ------------------ | ----------------------------- |
| `mise run check`   | Biome の lint & format チェック |
| `mise run fix`     | Biome の自動修正・整形        |
| `mise run lint-md` | markdownlint                  |
| `mise run test`    | オフライン検証ハーネス        |
| `mise run setup`   | git hooks(lefthook)の導入   |

### Git フック

`lefthook` が pre-commit でステージ済みファイルに対して実行します。
`js/mjs/json` には Biome(`--write`)、Markdown には markdownlint(`--fix`)をかけ、修正結果は自動で再ステージされます。

### ランタイム依存ゼロ

Action は `fetch`/`fs`/`path` だけの素の Node で動作します(npm install もバンドルも不要)。
Chart.js とズームプラグインはブラウザ側で CDN から読み込まれ、ここには一切インストールされません。

### オフラインでのテスト

`src/collect.mjs` にはテスト用の縫い目があります。
`GH_THROUGHPUT_FIXTURE` に `{ "closed": {...}, "backlog": {...} }` 形式の JSON ファイルを指定すると、GitHub API の代わりにそのファイルから解決します。
`test/verify.mjs` はこれを使い、CSV 追記・冪等性・番兵行・HTML 出力を検証します(`mise run test` で実行)。
中核ロジックは純関数(`localDate` / `tzOffset` / `closedQualifier` / `aggregate` / `buildRows` / `renderHtml` など)と `main(env, now)` としてエクスポートしており、ネットワークなしで単体検証できます。

### リリース

利用者は `@v1` を参照し、メンテナは各リリースコミットへ `v1` タグを移動します。
コミットは cz-emoji 規約に従い、変更履歴は git-cliff(`cliff.toml`)で生成します。

## ライセンス

MIT License.
