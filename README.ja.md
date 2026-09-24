# symbol-mcp-server

[![npm version](https://img.shields.io/npm/v/symbol-mcp-server)](https://www.npmjs.com/package/symbol-mcp-server)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/inotakeh/symbol-mcp-server/badge)](https://scorecard.dev/viewer/?uri=github.com/inotakeh/symbol-mcp-server)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14763/badge)](https://www.bestpractices.dev/projects/14763)

> **Symbol 専用です。** このサーバーは [Symbol](https://docs.symbol.dev/)（catapult）ノードと通信します。
> 別チェーンで API も異なる NEM NIS1（XEM）には対応していません。
> **非公式プロジェクトです。** NEM / Symbol のコアチームとは無関係の独立したプロジェクトです。

[English README](README.md)

[Symbol](https://docs.symbol.dev/) の REST API を 22 個の目的別ツールとして公開する、読み取り専用の
[MCP](https://modelcontextprotocol.io/) サーバーです。REST エンドポイントを 1 対 1 で写すのではなく、
各ツールが「人が実際に尋ねる質問」に答えます。

- **一般ユーザー:** エイリアス名と桁を反映した残高、メッセージ復号付きのトランザクション履歴と詳細、
  モザイク・ネームスペース照会、手数料の目安、アドレス検証、高さ・エポック・時刻の相互変換。
- **ノード運用者:** ノードの状態と同期判定、委任ハーベスティングの状況、参照ノードとの比較、そして
  **Voting キーの失効管理**: 残りエポック数・ブロック数・日数、失効予定日時、推奨更新ウィンドウ。

全ツールが `structuredContent`（公開された `outputSchema` で検証済み）と同じ JSON の text ブロックを返し、
先頭に 1〜3 行の `summary` が付きます。金額は divisibility 適用後の値と生の整数の両方、日時は ISO 8601（UTC）で、
`SYMBOL_TIMEZONE` を設定するとローカル時刻も併記されます。

## 出力の例

代表的な 2 つの呼び出しと、返る内容の抜粋です。値はテスト用フィクスチャ（合成したノードホストとアカウント）
から取ったもので、実ノードの値ではありません。

**「ノードは健全？」** → `symbol_node_health {}`

```jsonc
{
  "summary": "node health: healthy (node.test:3001, mainnet).",
  "network": "mainnet",
  "verdict": "healthy",
  "checks": [
    { "id": "api_node", "status": "ok", "detail": "API node service is up.", "hint": null },
    { "id": "db", "status": "ok", "detail": "Database service is up.", "hint": null },
    {
      "id": "clock_skew",
      "status": "ok",
      "detail": "Node clock is 1,000 ms behind this machine's clock (warn at 15,000 ms, fail at 30,000 ms).",
      "hint": null
    },
    {
      "id": "finalization_lag",
      "status": "ok",
      "detail": "Finalized height 5,763,656 is 19 blocks (about 9.5 min) behind height 5,763,675 (warn at 720, fail at 1,440 blocks).",
      "hint": null
    }
    // … storage_consistent と roles、続いて node / storage / chain / time / notes
  ]
}
```

`ok` 以外のチェックには次の手順を書いた `hint` が付き、summary にも 1 行ずつ出ます。

**「ハーベスト報酬を月ごとに知りたい」**
→ `symbol_harvesting_income { "account": "NCV5HR…", "fromDate": "2026-09-01", "toDate": "2026-09-11", "granularity": "monthly" }`

```
NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY on mainnet, 2026-09-01 to 2026-09-11 (Asia/Tokyo; heights 5,736,305-5,767,984, 31,680 blocks): 20 harvest receipts totalling 662.574177 symbol.xym from 11 blocks (harvester share 461.240390 in 9 receipts, beneficiary share 201.333787 in 11 receipts).
Blocks: 9 harvested by this account, 2 harvested by others that paid it only the beneficiary share (typically delegators on its node). 9 of the 11 beneficiary receipts come from blocks it harvested itself, as its own node's beneficiary.
2026-09: 20 receipts, 662.574177 symbol.xym; 11 blocks: 9 harvested by this account, 2 by others (receipts 9 harvester / 11 beneficiary)
```

これが `summary` です。同じ数値が `totals` と `monthly[]` にも入り、金額はどれも 10 進文字列（`"662.574177"`）と
生の整数（`"662574177"`）の両方で、サーバーが合算しています。
レシートはブロック報酬の取り分なので、自分のノードの beneficiary でもある運用者は、自分でハーベストした 1 ブロックから
2 件を受け取ります。ブロックの数は `blocksHarvested` と `blocksBeneficiaryOnly` で数えます。

## 要件

- Node.js 22 以上。
- `https://` で到達できる Symbol REST ノード（公開ノードは多くが 3001 番ポート）。公開ノードの一覧は
  https://nodewatch.symbol.tools/ を参照。

## インストール

### Claude Desktop: ワンクリックのバンドル（.mcpb）

1. [Releases](https://github.com/inotakeh/symbol-mcp-server/releases/latest) から最新の
   `symbol-mcp-server-<version>.mcpb` をダウンロードします。
2. ダブルクリックするか、Claude Desktop の **Settings → Extensions** からインストールします。
3. 設定画面で **Symbol node URL**（例 `https://<node-host>:3001`）を入力します。自分のノードが最適です
   （[ノードの選び方](#ノードの選び方)を参照）。必須の項目で、未入力だと拡張機能は起動しません。必要なら
   タイムゾーンと、`symbol_harvester_watch` の状態ディレクトリも設定します。ほかの項目は空のままで構いません。
4. 拡張機能を有効にします。

あとで設定を変えたときは、新しい会話で試してください。

バンドルには、公開済みの npm パッケージから作ったサーバーと本番用の依存が入っていて、Claude Desktop に同梱の
Node.js で動きます。バンドルと下の `npx` の設定は、どちらか一方だけにしてください。両方入れるとツールが重複します。
バンドルは `mcpb sign` で署名していないため、Claude Desktop に「未検証」と表示されることがあります。出所は、
リリースのワークフローが付ける build provenance で確認できます:

```sh
gh attestation verify symbol-mcp-server-<version>.mcpb --repo inotakeh/symbol-mcp-server
```

### npm とソース

**npm から**（Claude Desktop 以外の MCP ホストではこちらを推奨）:

```sh
npx -y symbol-mcp-server --help
```

[MCP Registry](https://registry.modelcontextprotocol.io) にも `io.github.inotakeh/symbol` として登録されています。

**ソースから:**

```sh
git clone https://github.com/inotakeh/symbol-mcp-server.git
cd symbol-mcp-server
npm ci
npm run build
SYMBOL_NODE_URL=https://<node-host>:3001 node dist/index.js
```

`node dist/index.js --help` は環境変数の説明を stderr に出して終了し、`--version` はバージョンを表示します。
これ以外のフラグはありません。設定はすべて環境変数で行うため、モデルがサーバーを別ホストに向けることはできません。

## MCP ホストの設定

サーバーは stdio で MCP を話します。起動時に `/node/info` を取得し、generationHashSeed から mainnet / testnet を
判定して、stderr に 1 行ログを出します。

```
symbol-mcp-server <version>: mainnet via <node-host>:3001, timezone Asia/Tokyo
```

### Claude Desktop

`claude_desktop_config.json` に追加します。npm パッケージを使う場合:

```json
{
  "mcpServers": {
    "symbol": {
      "command": "npx",
      "args": ["-y", "symbol-mcp-server"],
      "env": {
        "SYMBOL_NODE_URL": "https://<node-host>:3001",
        "SYMBOL_TIMEZONE": "Asia/Tokyo"
      }
    }
  }
}
```

ソースのチェックアウトから起動する場合:

```json
{
  "mcpServers": {
    "symbol": {
      "command": "node",
      "args": ["/path/to/symbol-mcp-server/dist/index.js"],
      "env": {
        "SYMBOL_NODE_URL": "https://<node-host>:3001"
      }
    }
  }
}
```

### Claude Code

```sh
claude mcp add symbol -s user -e SYMBOL_NODE_URL=https://<node-host>:3001 -e SYMBOL_TIMEZONE=Asia/Tokyo -- npx -y symbol-mcp-server
# ソースのチェックアウトから:
claude mcp add symbol -s user -e SYMBOL_NODE_URL=https://<node-host>:3001 -- node /path/to/symbol-mcp-server/dist/index.js
```

プロジェクト単位で `.mcp.json` をコミットする場合:

```json
{
  "mcpServers": {
    "symbol": {
      "command": "npx",
      "args": ["-y", "symbol-mcp-server"],
      "env": { "SYMBOL_NODE_URL": "https://<node-host>:3001" }
    }
  }
}
```

### その他のクライアント

stdio サーバーを起動できる MCP ホストなら、同じ `npx` コマンドで動きます。設定ファイルの場所と形式は、
各クライアントの公式ドキュメントに従っています。

**Cursor:** 全プロジェクト共通なら `~/.cursor/mcp.json`、プロジェクト単位なら `.cursor/mcp.json`。

```json
{
  "mcpServers": {
    "symbol": {
      "command": "npx",
      "args": ["-y", "symbol-mcp-server"],
      "env": { "SYMBOL_NODE_URL": "https://<node-host>:3001" }
    }
  }
}
```

**VS Code:** ワークスペースの `.vscode/mcp.json`、またはコマンド **MCP: Open User Configuration** で開く
ユーザー設定のファイル。最上位のキーは `mcpServers` ではなく `servers` です。

```json
{
  "servers": {
    "symbol": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "symbol-mcp-server"],
      "env": { "SYMBOL_NODE_URL": "https://<node-host>:3001" }
    }
  }
}
```

**Cline:** Cline のパネルで **MCP Servers → Configure → Configure MCP Servers** を開き、`mcpServers` の下に
追加します（Cline CLI は同じ形式を `~/.cline/mcp.json` から読みます）。

```json
{
  "mcpServers": {
    "symbol": {
      "command": "npx",
      "args": ["-y", "symbol-mcp-server"],
      "env": { "SYMBOL_NODE_URL": "https://<node-host>:3001" },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Windows で `npx` を起動できないクライアントでは、`"command": "npx.cmd"` が必要な場合があります。

## 環境変数

| 変数 | 必須 | 内容 |
|---|---|---|
| `SYMBOL_NODE_URL` | 必須 | 照会先ノードの REST URL。例 `https://<node-host>:3001`。`https://` 必須（`http://` は `localhost` / `127.0.0.1` のみ）。ポートは指定どおりに使います。 |
| `SYMBOL_NETWORK` | 任意 | `mainnet` または `testnet`。指定時、ノードが別ネットワークなら起動に失敗します。 |
| `SYMBOL_TIMEZONE` | 任意 | `Asia/Tokyo` などの IANA 名。UTC の日時の隣にローカル時刻を併記します。 |
| `SYMBOL_REFERENCE_NODES` | 任意 | `symbol_network_compare` と `symbol_version_drift` の比較対象となる `https://` ノード URL のカンマ区切り。ここに無いホストへは一切通信しません。 |
| `SYMBOL_REQUEST_TIMEOUT_MS` | 任意 | リクエストごとのタイムアウト（100〜600000）。既定 `10000`。 |
| `SYMBOL_STATE_DIR` | 任意 | `symbol_harvester_watch` がノードごとのスナップショット（解錠中ハーベスターの公開鍵・高さ・時刻のみ。秘密情報なし）を置く絶対パスのディレクトリ。初回保存時に 0700 で作成。未設定なら比較なしで現在の一覧だけ返します。 |

## ノードの選び方

- **自分のノードが最適です。** 呼び出しのたびに、照会したアドレス・公開鍵・ハッシュ・ネームスペース名が
  `SYMBOL_NODE_URL` に送られます。参照ノードに送るのは `/node/info` と `/chain/info` だけで、照会した識別子は送りません。
- **公開ノードも使えますが、何を調べたかはそのノードの運営者に見えます。** アクセスログから、どのアカウント・
  トランザクション・ネームスペースを、いつ、どの IP アドレスから照会したかが分かります。信頼できるノードを使うか、
  知られたくない照会には自分のノードを使ってください。
- **探し方:** https://nodewatch.symbol.tools/ に mainnet / testnet のノードが高さとバージョン付きで並んでいます。
  現在の高さに追いついていて、多数派のバージョンで、`https://`（通常 3001 番ポート）で応答する API ノードを選んでください。
  `SYMBOL_NETWORK` を設定すると、別ネットワークのノードだった場合に起動が失敗します。動作確認は
  `SYMBOL_NODE_URL=https://<node-host>:3001 npx -y symbol-mcp-server check` でできます。

## ツール

22 ツールすべてが読み取り専用（`readOnlyHint: true`）で、常に固定の順序で一覧されます。引数は識別子のみで、URL は受け取りません。
`account` 引数（と `symbol_transaction_search` の `address`）は、base32 アドレス・hex 公開鍵のほかに、アドレスエイリアスを持つ
ネームスペース名（`alice`、`alice.pay`）も受け付けます。解決結果は `accountResolution` と summary の先頭に出ます。

| ツール | 引数 | 答えること |
|---|---|---|
| `symbol_network_info` | なし | ネットワーク名・identifier・generationHashSeed、現在高さと確定高さ、確定エポック、ブロック生成目標時間、votingSetGrouping、epochAdjustment、XYM の mosaicId / エイリアス / divisibility、現在の手数料乗数。 |
| `symbol_node_status` | なし | friendlyName、host、ロール（Peer / API / Voting）、復号したバージョン、API ノードと DB の health、高さ、ピア数、同期判定（最新ブロックが 5 分より古ければ `synced: false`）。 |
| `symbol_account_get` | `account`（アドレス、公開鍵、またはネームスペース名）, `format` | base32 / hex アドレス、公開鍵、全モザイク残高（エイリアスと桁反映）、importance、linked / VRF / node / voting キー、委任ハーベスティング設定の有無、マルチシグ設定。 |
| `symbol_voting_key_status` | `account` | 全 Voting キーと状態（expired / active / future）、残りエポック・ブロック・日数、失効予定日時、推奨更新ウィンドウ（失効 7 日前〜3 日前）、失効済みキーを含む枠の使用状況、`minVoterBalance` に対する資格、警告。 |
| `symbol_transaction_get` | `transactionHash` | confirmed / unconfirmed / partial を順に探して状態を返す。種別名、署名者と宛先、エイリアス付きモザイク、平文メッセージの復号（暗号化なら明記）、手数料、高さと日時、アグリゲートの内包トランザクション。 |
| `symbol_transaction_search` | `address`, `type`, `pageSize`, `pageNumber`, `order`, `format` | アカウントが関わる確定トランザクション。既定は新しい順、種別は名前（`transfer`）またはコード（`16724`）で絞り込み、1 ページ 10〜100 件。 |
| `symbol_mosaic_get` | `mosaic`（hex ID または `symbol.xym` のようなエイリアス） | 供給量、divisibility、フラグ（supplyMutable / transferable / restrictable / revokable）、所有者、開始高さ、有効期間と推定失効日。 |
| `symbol_namespace_get` | `namespace`（名前または hex ID） | 所有者、root / sub、各レベルの名前、エイリアス先（アドレスまたはモザイク）、開始 / 終了高さ、推定終了日時。 |
| `symbol_fee_estimate` | `transactionSizeBytes`（任意） | ノードの現在の乗数から算出した slow / average / median / fast の手数料目安（XYM）。署名も送信もしません。 |
| `symbol_address_parse` | `value`（アドレス、公開鍵、またはネームスペース名） | オフライン検証: チェックサム、ネットワークバイト、base32 / hex / ハイフン区切り形式、公開鍵から導出したアドレス。ネームスペース名はノードでアドレスエイリアスに解決します。 |
| `symbol_time_convert` | `height` / `epoch` / `timestamp` のいずれか 1 つ | 高さ、確定エポック、ネットワークタイムスタンプ、実時刻の相互変換。過去は実測、将来は推定（その旨を明記）。 |
| `symbol_harvesting_status` | `account`（任意） | ノードで解錠中の委任ハーベスター、ハーベスティングの残高制限と受益者割合。アカウントを指定すると、その linked キーがこのノードで解錠されているかと、残高が制限の範囲内か（`minHarvesterBalance` 以上 `maxHarvesterBalance` 以下。上限を超えるとハーベストできない）。 |
| `symbol_network_compare` | なし | 自ノードと `SYMBOL_REFERENCE_NODES` の高さ・確定高さ、最良ノードとの差、`lagging` フラグ。参照ノード未設定時はその旨と対処を案内。 |
| `symbol_harvesting_income` | `account`, `fromDate` + `toDate` または `fromHeight` + `toHeight`, `granularity`, `format` | 期間内に受け取ったハーベスト報酬: 件数と XYM 合計（サーバー側で整数のまま合算）、harvester / beneficiary / unknown の内訳、ブロックの数（`blocksHarvested`: 自分でハーベストしたブロック、`blocksBeneficiaryOnly`: 他のアカウントがハーベストし beneficiary の取り分だけを受け取ったブロック）、`SYMBOL_TIMEZONE`（未指定なら UTC）の日付ごとの集計、またはレシート一覧。日付はブロックのタイムスタンプから高さに解決。`granularity: monthly` で暦月ごと（年次の質問向け）、`output: csv` で表計算向けの CSV テキスト（JSON も併せて返す）。1 年以上を 1 回で指定してよい（約 90 日分ずつに分割して取得。`fetch` にチャンク数・再試行数・ページ数）。 |
| `symbol_transaction_status` | `transactionHashes`（配列、1〜20 件） | 各トランザクションの現在の状態: confirmed（高さ付き）/ unconfirmed / partial（署名待ち）/ failed（ノードのコードとその意味付き）/ not_found。バッチ全体を 1 リクエストで照会。 |
| `symbol_finality_participation` | `account`, `epoch`（任意、既定は最新の確定エポック）, `epochs`（1〜20、既定 1）, `format` | アカウントの Voting キーが各エポックのファイナリティ proof に実際に署名したか: participated（prevote と precommit の両方）/ missed（署名しなかったステージ付き）/ no_active_key / unavailable。ステージごとの署名数（proof が 1 つのステージを複数のメッセージグループに分けていても 1 ステージとして扱い、どのグループの署名でも署名済みと数える）と、現在のエポックをカバーする鍵が無い／現在のエポックが missed のときの警告（過去のエポックでは警告しない）。 |
| `symbol_delegation_diagnose` | `account`, `recentDays`（1〜30、既定 7）, `format` | 委任ハーベストが有効か、無効ならどこで止まっているか: アカウントの存在、ハーベスト残高制限、importance（0 なら次の再計算までのブロック数）、linked / VRF / node の各鍵、node 鍵と設定ノードの `nodePublicKey` の一致、そのノードでの解錠、accountType、直近 N 日のハーベスト実績、ノード宛の委任要求トランザクション。判定は `active` / `not_active` / `cannot_verify`（別ノードへの委任はここからは確認できない）。 |
| `symbol_node_health` | `format` | 設定ノードが今、健全に動いているか: API ノードと DB の状態（`/node/health` の 503 応答も本文を読んで判定）、DB のブロック数とチェーン高さの差、ノード時計とこの端末の時計のずれ、ファイナリティ遅延（ブロック数と分）、ロール。固定順の 6 チェックが ok / warn / fail / unknown とヒントを持ち、判定は `healthy` / `degraded`（warn、または確認できなかった項目あり）/ `unhealthy`。閾値は `/network/properties` から導出。`symbol_node_status` を補完。 |
| `symbol_version_drift` | `format` | 設定ノードのバージョンがネットワークの多数派から取り残されていないか: ノードが知るピアと参照ノードのバージョン分布、多数派の版、自ノードより新しい版の割合。判定は `ok` / `behind`（多数派より古い、または新しい版が半数以上）/ `far_behind`（75% 以上が新しい。接続を拒否され始める可能性）/ `unknown`（ピアなし）。まだ版を報告していないピア（0.0.0.0）は版として数えず、`sample.unknownVersion` に別に数えます。ピアの host や鍵は出力しません。 |
| `symbol_harvester_watch` | `mode`（`compare` / `compare_and_save` / `save_only`）, `format` | 設定ノードで解錠中の委任ハーベスターが前回より増えたか減ったか: 追加・削除されたリモート鍵、件数の差分、直近 30 日のスナップショットの最小・最大・平均。スナップショットは `SYMBOL_STATE_DIR` 配下にノードごと 1 ファイル。未設定なら現在の一覧だけを返し「比較不可」と明記。`compare` は読むだけ、`compare_and_save`（既定）は今回分も保存、`save_only` は比較せず保存。 |
| `symbol_account_rank` | `account`（任意）, `mosaic`（任意。hex id かエイリアス名、既定は XYM）, `top`（1〜100、既定 20）, `maxRank`（100〜5000、既定 1000）, `format` | あるアカウントがモザイクの保有量で何番目か、上位は誰か（エクスプローラのリッチリスト相当）: アカウントの残高・供給量に対する割合（小数 4 桁、整数演算）・順位、上位 N 件の残高と割合、上位 N 件の合計割合。保有者は `GET /accounts?orderBy=balance` から 100 件ずつ逐次読み、見つかるか `maxRank` に達するまで続けます（達したら `rankBeyond` に出ます）。`account` を省略すると上位一覧だけ。同額の順序はノード依存で、取引所・財団などのラベルは付けません。 |
| `symbol_holdings_value` | `account`, `unitPrice`（10 進文字列。例 `"12.34"`）, `currency`（大文字 3〜6 文字）, `priceSource`（任意）, `priceAsOf`（任意）, `mosaic`（任意。既定は XYM）, `decimals`（任意。0〜12）, `format` | **呼び出し側が与えた単価**で、アカウントのモザイク残高がいくらになるか: 残高、正規化した単価、丸め前の積、四捨五入（half up）した積。すべて整数演算。丸める桁は Intl（Unicode CLDR）がその通貨に与える桁（JPY 0、USD 2、KWD 3、CLF 4）です。CLDR は一部の通貨で ISO 4217 と異なり（HUF・IDR・IQD・IRR は CLDR では 0 桁。ISO 4217 では IQD が 3 桁、ほかは 2 桁）、桁はサーバーを動かす Node.js に依存するので、固定したいときは `decimals` を渡してください。Intl が知らないコード（BTC、USDT）は丸めず、0 でない値が丸めで 0 になる場合も丸めません。どの規則を使ったかは `value.decimalsSource` に出ます。サーバーは価格を取得も検証もしません。`priceSource` / `priceAsOf` はそのまま出力に echo され、答えに出所が残ります。税務計算ではなく、手数料・スプレッド・税は含みません。 |

### 質問の例

**「NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY の Voting キーはいつ失効しますか。いつ更新すべきですか」**
→ `symbol_voting_key_status { "account": "NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY" }`
各キーの `startEpoch` / `endEpoch`、失効高さ `(endEpoch - 1) × votingSetGrouping`、残りエポック・ブロック・日数、
実測平均ブロック時間に基づく失効予定日時、推奨更新ウィンドウ、空き枠（失効済みキーも枠を消費）、
`minVoterBalance` に対する残高の充足を返します。

**「alice のアカウントを見せて」**
→ `symbol_account_get { "account": "alice" }`
ネームスペース `alice` をノードでアドレスエイリアスに解決してから処理します（未登録・失効・モザイクのエイリアス・
エイリアス無しはヒント付きのエラー）。応答は `alice → NCV5…` で始まり、`accountResolution` に解決結果が入ります。
account を受けるすべてのツールで使えます。

**「NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY の XYM 残高は?」**
→ `symbol_account_get { "account": "NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY" }`
全モザイクを `alias`（`symbol.xym`）、`amount`（桁反映後）、`rawAmount` 付きで返します。

**「そのアカウントの直近 20 件の転送を見せて。いちばん新しいものの詳細も」**
→ `symbol_transaction_search { "address": "NCV5HR…", "type": "transfer", "pageSize": 20 }`
→ `symbol_transaction_get { "transactionHash": "<一覧のハッシュ>" }`
一覧はハッシュ・日時・相手・メッセージのプレビューを、詳細は手数料・復号済みメッセージ全文・内包トランザクションを返します。

**「私のノードは遅れていますか?」**
→ `symbol_node_status {}` が設定ノードの最新ブロックの古さを確認し、
→ `symbol_network_compare {}` が `SYMBOL_REFERENCE_NODES` に対して何ブロック遅れているかを返します。

**「NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY の 2026 年 8 月のハーベスト報酬はいくら？」**
→ `symbol_harvesting_income { "account": "NCV5HR…", "fromDate": "2026-08-01", "toDate": "2026-08-31" }`
日付をブロック高さに解決し、そのアカウント宛の HarvestFee レシートを全件読んで整数のまま合算します。
XYM 合計、harvester と beneficiary の内訳、日ごとの行を返すので、モデルが足し算をする余地はありません。

**「さっき Voting キーの link を送った。トランザクション `<hash>` は通った?」**
→ `symbol_transaction_status { "transactionHashes": ["<hash>"] }`
confirmed（高さ付き）/ unconfirmed / partial（aggregate bonded で cosignature 待ち）/ failed（`Failure_Core_Insufficient_Balance`
のようなノードのコードとその意味付き）/ not_found を返します。1 件でも配列で渡し、1 回に 20 件まで。

**「先週うちのノード（NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY）は投票できてた?」**
→ `symbol_finality_participation { "account": "NCV5HR…", "epochs": 14 }`
最新の確定エポックとその前 13 エポック（1 エポックは `votingSetGrouping` ブロック、mainnet で約 12 時間）の
ファイナリティ proof を読み、エポックごとに自分の Voting キーが両ステージの署名者に含まれるか、署名者は何人か、
現在のエポックが missed か、それをカバーする鍵が無ければ警告を返します。

**「自分の委任ハーベストが動いてない気がする。見て。NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY」**
→ `symbol_delegation_diagnose { "account": "NCV5HR…" }`
11 項目のチェック（存在、残高制限、importance、3 つの鍵、node 鍵と設定ノードの一致、そのノードでの解錠、
accountType、直近のハーベスト実績、委任要求トランザクション）を固定順に実行し、`active` / `not_active`
（止まっている項目とヒント付き）/ `cannot_verify`（`SYMBOL_NODE_URL` 以外のノードに委任しているため
ノード側を確認できない）を返します。

**「ノードは健全？ バージョンは古くない？」**
→ `symbol_node_health {}` が設定ノードの API ノード・DB・ストレージ・時計・ファイナリティ遅延を確認し、
healthy / degraded / unhealthy と問題のあるチェックを返します。
→ `symbol_version_drift {}` がノードのバージョンをピアと参照ノードと比べ、ok / behind / far_behind を返します。
どちらもノードの OS 移行後に最初に見る項目です。

**「移行後、委任者は戻ってきた？」**
→ `symbol_harvester_watch {}` が、いま解錠されているハーベスターを前回保存したスナップショットと比較し（追加・削除された鍵、
件数差分、30 日の最小・最大・平均）、次回のために今日の一覧を保存します。`SYMBOL_STATE_DIR` が必要で、未設定なら現在の件数と
「比較不可」を返します。

**「うちは XYM 保有量で何位？（NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY）上位 10 件は誰？」**
→ `symbol_account_rank { "account": "NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY", "top": 10 }`
残高順の保有者一覧を 100 件ずつ、アカウントが見つかるか `maxRank`（既定 1000）に達するまで読み、
残高・供給量に対する割合・順位を、上位 10 件とその合計割合とともに返します。割合はすべてサーバーが
整数演算で計算します。上位は取引所や財団であることが多く、ツールはラベルを付けません。

**「XYM が 12.34 円のとき、うちの保有額はいくら？（NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY）」**
→ `symbol_holdings_value { "account": "NCV5HR…", "unitPrice": "12.34", "currency": "JPY" }`
残高を読み、単価との積を整数演算で求めます（4,321,000 XYM なら `53,321,140 JPY`。丸め前の値も併記）。
**単価は呼び出し側が用意します。** このサーバーは価格 API に一切アクセスしません（通信先は `SYMBOL_NODE_URL` だけ）。
Claude Desktop で「今いくら？」と聞いたときの流れは、まずモデルが単価を調べ（web 検索、価格を返す別の MCP サーバー、
またはユーザーが入力）、次にこのツールを `unitPrice` / `currency` と、できれば `priceSource` / `priceAsOf` 付きで
呼びます。答えには「いつ・どこの単価か」が残ります。モデルには残高 × 単価を自分で計算しないよう指示しています。

期待される引数まで含めた他の例は [`evals/cases.json`](evals/cases.json) にあります。

## Prompts

ノード運用者が繰り返すツール呼び出しの手順を、MCP の prompt（`prompts/list`）として 2 本同梱しています。引数はどちらも
`account`（Voting / ハーベスティングアカウントの 39 文字 base32 アドレス）だけで、本文自体にはアドレス・ホスト・鍵・日付を書いていません。

| Prompt | 手順 |
|---|---|
| `voting_key_renewal_checklist` | `symbol_voting_key_status`（失効予定・推奨ウィンドウ・空き枠）→ `symbol_node_status`（未同期なら中止）→ `symbol_network_compare` → 運用者がこのサーバーの外で VotingKeyLink を送信 → そのハッシュを `symbol_transaction_status` で確認 → `symbol_voting_key_status` を再度呼んで新キーを確認 → 新キーの startEpoch が確定した後に `symbol_finality_participation` で参加を確認 → 4 行で要約。 |
| `monthly_health_check` | `symbol_node_status` → `symbol_node_health`（unhealthy なら先頭に）→ `symbol_version_drift`（behind 以上なら先頭に）→ `symbol_network_compare` → `symbol_harvester_watch`（前回スナップショットとの差分。`symbol_harvesting_status` は求められたときだけ） → `symbol_voting_key_status`（30 日以内に失効するなら警告を先頭に）→ `symbol_account_get`（残高 vs `minVoterBalance`）→ 先月 1 日〜末日の `symbol_harvesting_income`（収益と、自分でハーベストしたブロック・委任者などのブロックを分けて）→ 要対応 / 注意 / 正常の 3 段階で 1 画面に。 |

サーバーは initialize 時に短い `instructions`（読み取り専用であること、アカウントの指定形式、取り違えやすい質問（ハーベスト報酬、Voting キー、
ノードの同期・健全性・バージョン、トランザクションが通ったか）に使うツール、返された数値をそのまま使うこと）も送ります。
隣り合う質問に答えるツールは、説明文で互いを案内します。

## CLI: cron からの監視

同じバイナリに、MCP クライアント無しで動く 1 回実行のサブコマンド `check` があります。上のツールでノードを判定し、
レポートを 1 つ出力して、異常があれば非ゼロで終了します。

```
symbol-mcp-server check [--account <address|publicKey|namespace>] [--warn-days <n>]
                        [--format text|json] [--quiet]
```

環境変数はサーバーと共通です（`SYMBOL_NODE_URL` 必須、`SYMBOL_TIMEZONE` / `SYMBOL_REFERENCE_NODES` /
`SYMBOL_STATE_DIR` は任意）。Node.js 22 以上が必要です。引数なしで起動したときは従来どおり MCP サーバーです。

| # | 項目 | ok / warn / fail |
|---|---|---|
| 1 | `node_health` | `symbol_node_health`: healthy / degraded / unhealthy |
| 2 | `version_drift` | `symbol_version_drift`: ok / behind または unknown / far_behind |
| 3 | `harvester_watch` | `symbol_harvester_watch`（比較して保存）: 解錠中のハーベスターが前回より減った、またはスナップショットを保存できなかったら warn。`SYMBOL_STATE_DIR` 未設定なら skip |
| 4 | `voting_key_status` | `--account` 指定時: アクティブな Voting キーの失効まで `--warn-days`（既定 14、1〜120）日以内なら warn、3 日以内またはアクティブなキーが無ければ fail。後継キーが切れ目なく登録済みなら ok。`--account` 無しなら skip |
| 5 | `finality_participation` | `--account` 指定時、最新の確定エポック: participated / missed またはノードに proof が無い / そのエポックをカバーする鍵が無い。`--account` 無しなら skip |

判定はツールのものをそのまま使い、check はその出力を読み替えるだけです。warn / fail の行の下に出る hint もツールの文言です。
ツールが 1 つ失敗しても（HTTP エラーなど）その項目が fail になるだけで、他の項目は実行されます。

| exit code | 意味 |
|---|---|
| 0 | すべて ok または skip |
| 1 | warn あり（fail なし） |
| 2 | fail あり |
| 3 | 実行できなかった: 設定エラー、ノードに到達できない、引数エラー（stderr に 1〜2 行で原因とヒント） |

text 出力（既定。値は説明用の例）:

```
symbol check: WARN (node.example:3001, mainnet, 2026-01-15T07:00:03+09:00)
[ok] node_health: healthy (finalization lag 12 blocks)
[ok] version_drift: ok. node.example:3001 runs 1.0.3.9; majority of 24 sampled nodes runs 1.0.3.9; 0% run something newer.
[ok] harvester_watch: 18 unlocked harvesters on node.example:3001, unchanged since 2026-01-14T07:00:02+09:00 (2026-01-13T22:00:02.000Z). Snapshot saved (31 stored).
[warn] voting_key_status: active key 0A1B2C3D… expires in about 12.4 days (epoch 4321, estimated 2026-01-27T16:40:00+09:00 (2026-01-27T07:40:00.000Z))
  hint: Active voting key 0A1B2C3D… expires at epoch 4321 in about 12.4 days (...) and no successor key is registered.
[ok] finality_participation: epoch 4290: participated (signed prevote and precommit)
```

`--format json` は同じレポートを 1 つの JSON で出力します: `{ verdict, exitCode, node: { host, network }, checkedAt,
checks: [{ id, status, detail, hint }], warnDays, account }`。`verdict` は `ok` / `warn` / `fail` / `error`（exit code 3）、
`account` は解決後のアドレスです。`--quiet` は exit code が 0 のとき何も出力しないので、cron からは「読むものがあるときだけ」
メールが届きます。

```
MAILTO=you@example.com
0 7 * * * SYMBOL_NODE_URL=https://node.example:3001 SYMBOL_STATE_DIR=/var/lib/symbol-mcp-server \
  npx --yes symbol-mcp-server check --account NXXX... --warn-days 14 --quiet
```

- **check は通知を行いません。** stdout / stderr への出力と exit code だけで、メールは cron（`MAILTO`）に任せます。
  通信先は `SYMBOL_NODE_URL` と `SYMBOL_REFERENCE_NODES` だけで、サーバーと同じく読み取り専用です。`SYMBOL_STATE_DIR` を
  設定している場合、実行のたびに `symbol_harvester_watch` と同じファイルへスナップショットを 1 件追記します（新しい 60 件を保持）。
- 全体の実行時間は 120 秒が上限です。上限に達すると残りの項目は skip になり、理由を stderr に出し、総合判定は最良でも WARN で、
  `--quiet` でも出力します。
- サブコマンド名の打ち間違いは従来どおりサーバーの「未知の引数」として exit 2 になります。

## セキュリティ

- **読み取り専用。** トランザクションの作成・署名・アナウンスは行いません。秘密鍵・ニーモニック・トークンを
  受け取る引数はありません。呼び出し間で何も保存しません。例外は `symbol_harvester_watch` で、`SYMBOL_STATE_DIR` を設定した
  ときだけ、解錠中ハーベスターの公開鍵・高さ・時刻のスナップショットをノードごとに保存します（秘密情報なし。ファイルを消せば初期化）。
- **通信先は固定。** 通信するのは `SYMBOL_NODE_URL` と、`symbol_network_compare` / `symbol_version_drift` に限り
  `SYMBOL_REFERENCE_NODES` のホストだけです。ツール引数で URL を受け取らないため、モデルがリクエストを別ホストへ向けることはできません。
  テレメトリはありません。
- **チェーン上の文字列は信頼しない。** 転送メッセージ、メタデータの値、エイリアス名、ノードが自分について返す値
  （friendlyName、ホスト名、状態や版の文字列）は第三者が書ける値です。それが分かる名前（`messageText` など）で、
  1 行にして出力します。タブと改行は空白 1 つにし（前後の単語がくっつかないように）、連続する空白は 1 つにまとめます。
  そのほかの制御文字と見えない書式文字（ゼロ幅文字、双方向制御文字、ソフトハイフン、人には見えずモデルには読める
  タグ文字 U+E0000〜U+E007F）はすべて除去し、文字を割らずに長さを制限します。異体字セレクタは残すので絵文字や
  漢字の異体字はそのままですが、ゼロ幅接合子でつないだ絵文字は個々の絵文字に分かれます。こうした文字列を出す
  17 のツールは、除去した文字の数を `invisibleCharactersRemoved` で返し、1 文字以上除去したときは summary の
  最後の行でもそう伝えます。すべて指示ではなくデータとして扱ってください。
- **失敗は明示。** ネットワーク不一致（`SYMBOL_NETWORK` とノード）、ノード到達不能、想定外の応答形式は復旧ヒント付きの
  エラーになります。別ネットワークへ黙って切り替えることはありません。スタックトレースや HTTP 生レスポンスは
  モデルに返しません。
- **リクエスト衛生。** リクエストごとのタイムアウト、`User-Agent`、5 MB の応答サイズ上限（本文を受信しながら数え、
  宣言された `Content-Length` が上限を超えていれば本文を読まずに拒否）、同時 4 リクエストまで、全応答のスキーマ検証。
  リダイレクトは追いません。HTTP 3xx を返したノードはエラーになり、転送先には接続しません。リクエストのパスには
  単純な識別子だけを入れます。
- **リポジトリの設定。** CodeQL のコードスキャン、Secret scanning と push protection、Dependabot（セキュリティ更新と、
  グループ化した月次のバージョン更新）、`main` のブランチ保護（変更はすべて pull request 経由、線形履歴）、
  Private vulnerability reporting を有効にしています。

脆弱性の報告は [`SECURITY.md`](SECURITY.md) を参照してください。

## リリースの完全性

- **CI から provenance 付きで公開。** npm のリリースはすべて GitHub Actions のワークフロー
  [`release.yml`](.github/workflows/release.yml) がビルドし、npm の Trusted Publishing（OIDC）で公開します。
  npm トークンは保守者の手元にもリポジトリのシークレットにも存在しません。各バージョンには、ソースのコミットと
  ビルドしたワークフロー実行に結び付く provenance（来歴証明）が付いています。
- **自分で確認する方法。**
  - [npmjs.com](https://www.npmjs.com/package/symbol-mcp-server) のパッケージページに **Provenance** 欄があり、
    コミットとワークフロー実行へのリンクが表示されます。
  - `npm view symbol-mcp-server dist.attestations` で、最新版の attestation の URL と provenance の predicate type が表示されます。
  - インストールしたプロジェクトで `npm audit signatures` を実行すると、インストール済みパッケージのレジストリ署名と
    provenance を検証できます。
- **GitHub Release にも同じパッケージ。** 各 GitHub Release には 2 つのファイルを添付しています。
  `symbol-mcp-server-<version>.tgz` は npm が配布している tarball とバイト単位で同一のもの（SHA-512 をレジストリの
  `dist.integrity` と照合済み）、`symbol-mcp-server-<version>.tgz.sigstore.json` はその tarball に対する npm の
  SLSA provenance を Sigstore バンドルにしたもの（subject がその tarball の SHA-512 であることを照合済み）です。
  どちらも [`scripts/release-assets.sh`](scripts/release-assets.sh) が集めます。ダウンロードした 2 つのファイルは
  [GitHub CLI](https://cli.github.com/manual/gh_attestation_verify) で検証できます:

  ```sh
  gh attestation verify symbol-mcp-server-<version>.tgz \
    --bundle symbol-mcp-server-<version>.tgz.sigstore.json \
    --repo inotakeh/symbol-mcp-server --digest-alg sha512
  ```

  npm の provenance は tarball を SHA-512 で指定しているため、`--digest-alg sha512` が必要です。
- **Claude Desktop 用のバンドルも同じ tarball から。** `symbol-mcp-server-<version>.mcpb` は
  [`scripts/build-mcpb.sh`](scripts/build-mcpb.sh) が、上で照合した npm の tarball と、そのリリースの lockfile から
  `npm ci --omit=dev` で入れた本番用の依存だけで作ります。それ以外にコンパイルやダウンロードはしません。リリースの
  ワークフローが GitHub の build provenance を付けます（`gh attestation verify … --repo inotakeh/symbol-mcp-server`。
  [インストール](#インストール)を参照）。
- **リリースできる人。** リリース用タグ（`v1.2.3`）を作れるのは保守者だけです。ワークフローはタグと `package.json` の
  バージョンの一致を確認し、lint・typecheck・テストを実行したうえで、GitHub Environment `npm-publish` で保守者が
  承認するまで待機します。手順全体は [`docs/RELEASING.md`](docs/RELEASING.md)（英語）にあります。

## 対応ネットワーク

| ネットワーク | identifier | generationHashSeed で判定 |
|---|---|---|
| Symbol mainnet | 104 | `57F7DA20…72B2D6` |
| Symbol testnet (sai) | 152 | `49D6E1CE…FC665A4` |

ネットワークは起動時にノードから判定します。それ以外の generationHashSeed（プライベートネットワーク、NEM NIS1）は
拒否します。どちらのネットワークのノードも https://nodewatch.symbol.tools/ に一覧があります。
[ノードの選び方](#ノードの選び方)も参照してください。

## 制限事項

- **ノードの履歴と制限。** 結果は設定したノードから取得します。トランザクション履歴を prune しているノードは保持している分
  しか返さないため、`symbol_transaction_search` が古いトランザクションを取りこぼすことがあります。公開ノードは、
  受け付けるリクエストの数を制限していることもあります。リクエストが特に多いのは `symbol_account_rank`（最大 50 ページ）と、
  長い期間の `symbol_harvesting_income`（最大 200 ページ）なので、これらは自分のノードで使ってください。
- **将来の日時は推定。** Voting キー・ネームスペース・モザイクの失効日、将来の高さやエポックの日時は、直近 10,000
  ブロックの実測平均ブロック時間（mainnet で約 30 秒）から推定し、推定であることを明記します。
- **暗号化メッセージは復号しません。** 暗号化されている旨を返します。
- **ページサイズは 10〜100。** catapult-rest がそれ未満を 10 に丸めるためです。
- **検索は確定トランザクションのみ。** 未確定・partial のトランザクションはハッシュ指定の
  `symbol_transaction_get` で参照できます。
- **ハーベスティング状況は設定ノードの範囲**（`/node/unlockedaccount`）で、ネットワーク全体ではありません。
- **価格は扱いません。** `symbol_holdings_value` は呼び出し側が渡した単価と残高の積を求めるだけで、価格の取得・検証・
  保存はしません。結果の確からしさはその入力次第です。先に単価を調べ（web 検索、価格 MCP サーバー、ユーザー入力）、
  `priceSource` / `priceAsOf` と一緒に渡してください。値は単純な積で、手数料・スプレッド・税は含まず、取得価額や
  譲渡損益の計算でもありません。
- **保有量の順位は走査で求めます。** `symbol_account_rank` は保有者一覧を 100 件ずつ `maxRank`（最大 5,000 = 50 リクエスト）まで
  読みます。それより下のアカウントは `rank: null` と `rankBeyond` になります。同額のアカウントの順序はノード依存で、
  呼び出しごとに入れ替わることがあります。
- **ハーベスターの履歴はローカルです。** `symbol_harvester_watch` は自分が `SYMBOL_STATE_DIR` に書いたスナップショットとだけ比較します。
  別のマシン、ファイルの削除、ノード鍵の変更（移行で node.key.pem が変わった場合）は新しい baseline になります。同じ日に何度呼んでも
  その回数だけ積まれ、新しい 60 件だけが残ります。
- **ハーベスト報酬の集計は 1 回あたり最大 20,000 ステートメント**（100 件 × 200 ページ）。超える期間は
  `truncated` になるので `fromHeight`/`toHeight` で分割してください。HarvestFee レシートから合算するため、
  レシートを prune しているノードではチェーン上の実績より少なく出ます。
- **1 年分のハーベスト報酬は分割して読みます。** catapult-rest は広い高さ範囲への応答が遅いため、約 90 日分ずつの
  チャンクに自動分割して順に取得し、1 ページ目がタイムアウトしたチャンクは半分（最小で約 7 日分）にして再試行します。
  合計は 1 回で読んだ場合と同じで、どう読んだかは `fetch` フィールドに出ます。約 7 日分でも
  `SYMBOL_REQUEST_TIMEOUT_MS` 以内に返せないノードのときだけエラーになります。
- **ファイナリティ参加はノードが保持する proof から判定します。** `unavailable` は「そのエポックの proof をノードが
  持っていない」（未確定、または保持期間外）ことを意味し、投票しなかったことを意味しません。登録されている投票者の
  総数はサーバーには分からないので、`signatureCount` は nodewatch のような外部の一覧と比べてください。
- **バージョンの比較はサンプルです。** `symbol_version_drift` が見るのは設定ノードが今知っているピアと参照ノードで、
  ネットワーク全体ではありません（全体像は nodewatch）。`symbol_node_health` の時計ずれはこのサーバーを動かしている
  端末の時計との比較で、端末側がずれている可能性もあります。
- **mainnet と testnet のみ。** トランザクションの作成・署名・送信は設計上行いません。
- **URL は指定どおりに使います。** ポートやスキームを勝手に変えません。http の 3000 番しか開いていないノードは
  localhost 以外では使えません。

## トラブルシューティング

起動時のエラーは `symbol-mcp-server failed to start:` で始まる 1 行として stderr に出ます。MCP ホストは stderr を
ログに残します（Claude Desktop: macOS は `~/Library/Logs/Claude/mcp*.log`、Windows は `%APPDATA%\Claude\logs`）。
同じコマンドをターミナルで実行しても表示されます。

| 表示 | 原因と対処 |
|---|---|
| `SYMBOL_NODE_URL is required` | 変数がサーバーのプロセスに届いていません。ホスト設定の `env` に書いてください。シェルの `export` は、デスクトップアプリが起動するサーバーには届きません。 |
| `SYMBOL_NODE_URL must use https://` または `SYMBOL_NODE_URL must start with https://` | ノードの `https://` の URL（通常 3001 番ポート）を指定してください。`http://` は `localhost` / `127.0.0.1` のみ使えます。 |
| `SYMBOL_NETWORK=mainnet but node <host> is on testnet` | ノードが別のネットワークです。`SYMBOL_NODE_URL` を目的のネットワークのノードに変えるか、`SYMBOL_NETWORK` を直してください。 |
| `Node <host> reports an unknown network` | ノードの generationHashSeed が Symbol の mainnet でも testnet でもありません（プライベートネットワークや NEM NIS1 のノード）。Symbol の mainnet / testnet のノードを使ってください。 |
| 起動時の `<host> did not answer /node/info within 10000 ms` / `could not reach <host> for /node/info`、ツールの `Node <host> did not answer … within … ms` / `Could not connect to node <host>` | ノードが停止・過負荷か、ポートが違います（https は 3001）。nodewatch で別のノードを選ぶか、遅いノードなら `SYMBOL_REQUEST_TIMEOUT_MS`（最大 600000）で待ち時間を延ばしてください。 |
| 起動時の `<host> answered /node/info with a redirect (HTTP 301), which is not followed`、ツールの `Node <host> answered … with a redirect` | URL の先がリダイレクトを返しています（http から https へ、プロキシ、パスの移動など）。リダイレクトは追わず、転送先にも接続しません。`SYMBOL_NODE_URL` にはノードの REST API の URL（通常 `https://<node-host>:3001`）を直接指定してください。 |
| ツールの `Node <host> answered HTTP 429 for …`（または 503） | ノードがリクエストの数を制限しているか、過負荷です。時間をおいて再試行してください。多くのページを読む呼び出し（大きな `maxRank` の `symbol_account_rank`、長い期間の `symbol_harvesting_income`）は、自分のノードか nodewatch で選んだ別のノードで使ってください。 |
| Claude Desktop に `symbol_*` ツールが出ない | バンドル（.mcpb）の場合: 拡張機能の設定を開いてください。**Symbol node URL** が空のあいだは起動しません。JSON で設定した場合: Claude Desktop は起動時にしか設定を読みません。完全に終了して（ウィンドウを閉じるだけでは不十分）起動し直してください。それでも出なければ、上のログで `failed to start` の行を探し、JSON が正しいか確認してください。 |
| `npm warn EBADENGINE Unsupported engine`（npm が出す警告） | Node.js が 22 より古いです。`node --version` で確認し、22 以上を入れてください（例 `nvm install 22`）。デスクトップアプリはシェルとは別の `PATH` で `node` / `npx` を探すことがあるので、必要なら `command` にフルパスを書いてください。 |
| リリース後も古い版が動く | npx がキャッシュを使っています。`npx -y symbol-mcp-server@latest --version` を実行するか、`args` に `symbol-mcp-server@latest` と書いてください。 |

## 開発

```sh
npm ci
npm run lint && npm run typecheck && npm test
npm run build
SYMBOL_NODE_URL=https://<node-host>:3001 node dist/index.js
npx @modelcontextprotocol/inspector -e SYMBOL_NODE_URL=https://<node-host>:3001 node dist/index.js
SYMBOL_INTEGRATION=1 SYMBOL_NODE_URL=https://<testnet-node>:3001 npm test   # 実ノードでの統合テスト
SYMBOL_INTEGRATION=1 SYMBOL_NODE_URL=https://<node-host>:3001 SYMBOL_INTEGRATION_ACCOUNT=<address> npm test   # 指定アカウントでアカウント系ツールを検証
node scripts/capture-fixtures.mjs https://<node-host>:3001   # test/fixtures/<network>/ をノードから更新
```

MCP Inspector がサーバーに渡すのは、自分の環境変数のうち `PATH` や `HOME` などごく一部（MCP SDK の既定）と、
指定された変数だけです。`npx` の前に書いた変数はサーバーに届かないので、上のように `-e KEY=VALUE` で 1 つずつ渡すか、
Inspector の画面で入力してください。macOS と Linux では、サーバーのコマンドを `env` で包んでも渡せます。

設計メモ: [`docs/DESIGN-BRIEF.md`](docs/DESIGN-BRIEF.md)。変更履歴: [`CHANGELOG.md`](CHANGELOG.md)。
リリース手順: [`docs/RELEASING.md`](docs/RELEASING.md)（英語）。

## コントリビューション

バグ報告・機能要望・pull request を歓迎します。開発環境、ツールの追加手順、設計上の決まりは
[`CONTRIBUTING.md`](CONTRIBUTING.md)（英語）を参照してください。セキュリティ上の問題は [`SECURITY.md`](SECURITY.md) の手順で報告してください。

## ライセンス

[MIT](LICENSE)
