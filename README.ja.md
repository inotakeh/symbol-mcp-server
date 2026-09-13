# symbol-mcp-server

> **Symbol 専用です。** このサーバーは [Symbol](https://docs.symbol.dev/)（catapult）ノードと通信します。
> 別チェーンで API も異なる NEM NIS1（XEM）には対応していません。
> **非公式プロジェクトです。** NEM / Symbol のコアチームとは無関係の独立したプロジェクトです。

[English README](README.md)

[Symbol](https://docs.symbol.dev/) の REST API を 16 個の目的別ツールとして公開する、読み取り専用の
[MCP](https://modelcontextprotocol.io/) サーバーです。REST エンドポイントを 1 対 1 で写すのではなく、
各ツールが「人が実際に尋ねる質問」に答えます。

- **一般ユーザー:** エイリアス名と桁を反映した残高、メッセージ復号付きのトランザクション履歴と詳細、
  モザイク・ネームスペース照会、手数料の目安、アドレス検証、高さ・エポック・時刻の相互変換。
- **ノード運用者:** ノードの状態と同期判定、委任ハーベスティングの状況、参照ノードとの比較、そして
  **Voting キーの失効管理**: 残りエポック数・ブロック数・日数、失効予定日時、推奨更新ウィンドウ。

全ツールが `structuredContent`（公開された `outputSchema` で検証済み）と同じ JSON の text ブロックを返し、
先頭に 1〜3 行の `summary` が付きます。金額は divisibility 適用後の値と生の整数の両方、日時は ISO 8601（UTC）で、
`SYMBOL_TIMEZONE` を設定するとローカル時刻も併記されます。

## 要件

- Node.js 20 以上。
- `https://` で到達できる Symbol REST ノード（公開ノードは多くが 3001 番ポート）。公開ノードの一覧は
  https://nodewatch.symbol.tools/ を参照。

## インストール

**npm から**（公開後）:

```sh
npx -y symbol-mcp-server --help
```

**ソースから**（現時点では npm 未公開のため、こちらを使ってください）:

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
symbol-mcp-server 0.1.0: mainnet via <node-host>:3001, timezone Asia/Tokyo
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
claude mcp add symbol -e SYMBOL_NODE_URL=https://<node-host>:3001 -e SYMBOL_TIMEZONE=Asia/Tokyo -- npx -y symbol-mcp-server
# ソースのチェックアウトから:
claude mcp add symbol -e SYMBOL_NODE_URL=https://<node-host>:3001 -- node /path/to/symbol-mcp-server/dist/index.js
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

## 環境変数

| 変数 | 必須 | 内容 |
|---|---|---|
| `SYMBOL_NODE_URL` | 必須 | 照会先ノードの REST URL。例 `https://<node-host>:3001`。`https://` 必須（`http://` は `localhost` / `127.0.0.1` のみ）。ポートは指定どおりに使います。 |
| `SYMBOL_NETWORK` | 任意 | `mainnet` または `testnet`。指定時、ノードが別ネットワークなら起動に失敗します。 |
| `SYMBOL_TIMEZONE` | 任意 | `Asia/Tokyo` などの IANA 名。UTC の日時の隣にローカル時刻を併記します。 |
| `SYMBOL_REFERENCE_NODES` | 任意 | `symbol_network_compare` の比較対象となる `https://` ノード URL のカンマ区切り。ここに無いホストへは一切通信しません。 |
| `SYMBOL_REQUEST_TIMEOUT_MS` | 任意 | リクエストごとのタイムアウト（100〜600000）。既定 `10000`。 |

## ツール

16 ツールすべてが読み取り専用（`readOnlyHint: true`）で、常に固定の順序で一覧されます。引数は識別子のみで、URL は受け取りません。

| ツール | 引数 | 答えること |
|---|---|---|
| `symbol_network_info` | なし | ネットワーク名・identifier・generationHashSeed、現在高さと確定高さ、確定エポック、ブロック生成目標時間、votingSetGrouping、epochAdjustment、XYM の mosaicId / エイリアス / divisibility、現在の手数料乗数。 |
| `symbol_node_status` | なし | friendlyName、host、ロール（Peer / API / Voting）、復号したバージョン、API ノードと DB の health、高さ、ピア数、同期判定（最新ブロックが 5 分より古ければ `synced: false`）。 |
| `symbol_account_get` | `account`（アドレスまたは公開鍵）, `format` | base32 / hex アドレス、公開鍵、全モザイク残高（エイリアスと桁反映）、importance、linked / VRF / node / voting キー、委任ハーベスティング設定の有無、マルチシグ設定。 |
| `symbol_voting_key_status` | `account` | 全 Voting キーと状態（expired / active / future）、残りエポック・ブロック・日数、失効予定日時、推奨更新ウィンドウ（失効 7 日前〜3 日前）、失効済みキーを含む枠の使用状況、`minVoterBalance` に対する資格、警告。 |
| `symbol_transaction_get` | `transactionHash` | confirmed / unconfirmed / partial を順に探して状態を返す。種別名、署名者と宛先、エイリアス付きモザイク、平文メッセージの復号（暗号化なら明記）、手数料、高さと日時、アグリゲートの内包トランザクション。 |
| `symbol_transaction_search` | `address`, `type`, `pageSize`, `pageNumber`, `order`, `format` | アカウントが関わる確定トランザクション。既定は新しい順、種別は名前（`transfer`）またはコード（`16724`）で絞り込み、1 ページ 10〜100 件。 |
| `symbol_mosaic_get` | `mosaic`（hex ID または `symbol.xym` のようなエイリアス） | 供給量、divisibility、フラグ（supplyMutable / transferable / restrictable / revokable）、所有者、開始高さ、有効期間と推定失効日。 |
| `symbol_namespace_get` | `namespace`（名前または hex ID） | 所有者、root / sub、各レベルの名前、エイリアス先（アドレスまたはモザイク）、開始 / 終了高さ、推定終了日時。 |
| `symbol_fee_estimate` | `transactionSizeBytes`（任意） | ノードの現在の乗数から算出した slow / average / median / fast の手数料目安（XYM）。署名も送信もしません。 |
| `symbol_address_parse` | `value`（アドレスまたは公開鍵） | オフライン検証: チェックサム、ネットワークバイト、base32 / hex / ハイフン区切り形式、公開鍵から導出したアドレス。 |
| `symbol_time_convert` | `height` / `epoch` / `timestamp` のいずれか 1 つ | 高さ、確定エポック、ネットワークタイムスタンプ、実時刻の相互変換。過去は実測、将来は推定（その旨を明記）。 |
| `symbol_harvesting_status` | `account`（任意） | ノードで解錠中の委任ハーベスター、ハーベスティングの残高制限と受益者割合、指定アカウントの linked キーがこのノードで解錠されているか。 |
| `symbol_network_compare` | なし | 自ノードと `SYMBOL_REFERENCE_NODES` の高さ・確定高さ、最良ノードとの差、`lagging` フラグ。参照ノード未設定時はその旨と対処を案内。 |
| `symbol_harvesting_income` | `account`, `fromDate` + `toDate` または `fromHeight` + `toHeight`, `granularity`, `format` | 期間内に受け取ったハーベスト報酬: 件数と XYM 合計（サーバー側で整数のまま合算）、harvester / beneficiary / unknown の内訳、`SYMBOL_TIMEZONE`（未指定なら UTC）の日付ごとの集計、またはレシート一覧。日付はブロックのタイムスタンプから高さに解決。 |
| `symbol_transaction_status` | `transactionHashes`（配列、1〜20 件） | 各トランザクションの現在の状態: confirmed（高さ付き）/ unconfirmed / partial（署名待ち）/ failed（ノードのコードとその意味付き）/ not_found。バッチ全体を 1 リクエストで照会。 |
| `symbol_finality_participation` | `account`, `epoch`（任意、既定は最新の確定エポック）, `epochs`（1〜20、既定 1）, `format` | アカウントの Voting キーが各エポックのファイナリティ proof に実際に署名したか: participated（prevote と precommit の両方）/ missed（署名しなかったステージ付き）/ no_active_key / unavailable。ステージごとの署名数と、現在のエポックをカバーする鍵が無い／現在のエポックが missed のときの警告（過去のエポックでは警告しない）。 |

### 質問の例

**「NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY の Voting キーはいつ失効しますか。いつ更新すべきですか」**
→ `symbol_voting_key_status { "account": "NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY" }`
各キーの `startEpoch` / `endEpoch`、失効高さ `(endEpoch - 1) × votingSetGrouping`、残りエポック・ブロック・日数、
実測平均ブロック時間に基づく失効予定日時、推奨更新ウィンドウ、空き枠（失効済みキーも枠を消費）、
`minVoterBalance` に対する残高の充足を返します。

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

**「さっき Voting キーの link を送った。トランザクション FAEEB042… は通った?」**
→ `symbol_transaction_status { "transactionHashes": ["FAEEB042…"] }`
confirmed（高さ付き）/ unconfirmed / partial（aggregate bonded で cosignature 待ち）/ failed（`Failure_Core_Insufficient_Balance`
のようなノードのコードとその意味付き）/ not_found を返します。1 件でも配列で渡し、1 回に 20 件まで。

**「先週うちのノード（NCV5HRBSFEGTPNBIUPBVAGWXWXZ43C4TNOQUYUY）は投票できてた?」**
→ `symbol_finality_participation { "account": "NCV5HR…", "epochs": 14 }`
最新の確定エポックとその前 13 エポック（1 エポックは `votingSetGrouping` ブロック、mainnet で約 12 時間）の
ファイナリティ proof を読み、エポックごとに自分の Voting キーが両ステージの署名者に含まれるか、署名者は何人か、
現在のエポックが missed か、それをカバーする鍵が無ければ警告を返します。

期待される引数まで含めた他の例は [`evals/cases.json`](evals/cases.json) にあります。

## Prompts

ノード運用者が繰り返すツール呼び出しの手順を、MCP の prompt（`prompts/list`）として 2 本同梱しています。引数はどちらも
`account`（Voting / ハーベスティングアカウントの 39 文字 base32 アドレス）だけで、本文自体にはアドレス・ホスト・鍵・日付を書いていません。

| Prompt | 手順 |
|---|---|
| `voting_key_renewal_checklist` | `symbol_voting_key_status`（失効予定・推奨ウィンドウ・空き枠）→ `symbol_node_status`（未同期なら中止）→ `symbol_network_compare` → 運用者がこのサーバーの外で VotingKeyLink を送信 → そのハッシュを `symbol_transaction_status` で確認 → `symbol_voting_key_status` を再度呼んで新キーを確認 → 新キーの startEpoch が確定した後に `symbol_finality_participation` で参加を確認 → 4 行で要約。 |
| `monthly_health_check` | `symbol_node_status` → `symbol_network_compare` → `symbol_harvesting_status` → `symbol_voting_key_status`（30 日以内に失効するなら警告を先頭に）→ `symbol_account_get`（残高 vs `minVoterBalance`）→ 先月 1 日〜末日の `symbol_harvesting_income` → 要対応 / 注意 / 正常の 3 段階で 1 画面に。 |

サーバーは initialize 時に短い `instructions`（読み取り専用であること、アカウントの指定形式、ハーベスト報酬と Voting キーの質問に使うツール、
返された数値をそのまま使うこと）も送ります。

## セキュリティ

- **読み取り専用。** トランザクションの作成・署名・アナウンスは行いません。秘密鍵・ニーモニック・トークンを
  受け取る引数はなく、呼び出し間で何も保存しません。
- **通信先は固定。** 通信するのは `SYMBOL_NODE_URL` と、`symbol_network_compare` に限り `SYMBOL_REFERENCE_NODES`
  のホストだけです。ツール引数で URL を受け取らないため、モデルがリクエストを別ホストへ向けることはできません。
  テレメトリはありません。
- **チェーン上の文字列は信頼しない。** 転送メッセージ、ノードの friendlyName、ホスト名、エイリアス名は第三者が
  書ける値です。それが分かる名前（`messageText` など）で出力し、制御文字・双方向制御文字を除去し、長さを制限します。
  指示ではなくデータとして扱ってください。
- **失敗は明示。** ネットワーク不一致（`SYMBOL_NETWORK` とノード）、ノード到達不能、想定外の応答形式は復旧ヒント付きの
  エラーになります。別ネットワークへ黙って切り替えることはありません。スタックトレースや HTTP 生レスポンスは
  モデルに返しません。
- **リクエスト衛生。** リクエストごとのタイムアウト、`User-Agent`、5 MB の応答サイズ上限、同時 4 リクエストまで、
  全応答のスキーマ検証。

脆弱性の報告は [`SECURITY.md`](SECURITY.md) を参照してください。

## 対応ネットワーク

| ネットワーク | identifier | generationHashSeed で判定 | ノード例 |
|---|---|---|---|
| Symbol mainnet | 104 | `57F7DA20…72B2D6` | `https://sym-main-01.opening-line.jp:3001` |
| Symbol testnet (sai) | 152 | `49D6E1CE…FC665A4` | `https://sym-test-01.opening-line.jp:3001` |

ネットワークは起動時にノードから判定します。それ以外の generationHashSeed（プライベートネットワーク、NEM NIS1）は
拒否します。ノードの稼働状況は変わるので、https://nodewatch.symbol.tools/ で現在のものを選んでください。

## 制限事項

- **ノードの履歴。** 結果は設定したノードから取得します。トランザクション履歴を prune しているノードは保持している分
  しか返さないため、`symbol_transaction_search` が古いトランザクションを取りこぼすことがあります。
- **将来の日時は推定。** Voting キー・ネームスペース・モザイクの失効日、将来の高さやエポックの日時は、直近 10,000
  ブロックの実測平均ブロック時間（mainnet で約 30 秒）から推定し、推定であることを明記します。
- **暗号化メッセージは復号しません。** 暗号化されている旨を返します。
- **ページサイズは 10〜100。** catapult-rest がそれ未満を 10 に丸めるためです。
- **検索は確定トランザクションのみ。** 未確定・partial のトランザクションはハッシュ指定の
  `symbol_transaction_get` で参照できます。
- **ハーベスティング状況は設定ノードの範囲**（`/node/unlockedaccount`）で、ネットワーク全体ではありません。
- **ハーベスト報酬の集計は 1 回あたり最大 20,000 ステートメント**（100 件 × 200 ページ）。超える期間は
  `truncated` になるので `fromHeight`/`toHeight` で分割してください。HarvestFee レシートから合算するため、
  レシートを prune しているノードではチェーン上の実績より少なく出ます。
- **ファイナリティ参加はノードが保持する proof から判定します。** `unavailable` は「そのエポックの proof をノードが
  持っていない」（未確定、または保持期間外）ことを意味し、投票しなかったことを意味しません。登録されている投票者の
  総数はサーバーには分からないので、`signatureCount` は nodewatch のような外部の一覧と比べてください。
- **mainnet と testnet のみ。** トランザクションの作成・署名・送信は設計上行いません。
- **URL は指定どおりに使います。** ポートやスキームを勝手に変えません。http の 3000 番しか開いていないノードは
  localhost 以外では使えません。

## 開発

```sh
npm ci
npm run lint && npm run typecheck && npm test
npm run build
SYMBOL_NODE_URL=https://<node-host>:3001 node dist/index.js
npx @modelcontextprotocol/inspector node dist/index.js
SYMBOL_INTEGRATION=1 SYMBOL_NODE_URL=https://sym-test-01.opening-line.jp:3001 npm test   # 実ノードでの統合テスト
SYMBOL_INTEGRATION=1 SYMBOL_NODE_URL=https://<node-host>:3001 SYMBOL_INTEGRATION_ACCOUNT=<address> npm test   # 指定アカウントでアカウント系ツールを検証
node scripts/capture-fixtures.mjs https://<node-host>:3001   # test/fixtures/<network>/ をノードから更新
```

設計メモ: [`docs/DESIGN-BRIEF.md`](docs/DESIGN-BRIEF.md)。変更履歴: [`CHANGELOG.md`](CHANGELOG.md)。

## ライセンス

[MIT](LICENSE)
