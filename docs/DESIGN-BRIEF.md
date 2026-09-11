# Symbol MCP Server 開発ブリーフ（v2・規約調査反映版）

前提知識ゼロのエージェント向けの指示書。この文書だけで着手できるように書いてある。
不明点は推測せず、§12 の参照先（OpenAPI仕様・SDK docs・実ノード）で確認すること。

> **v1からの変更点（2026-09-10 に公式ドキュメントを確認して反映）**
> - SDKは **`@modelcontextprotocol/server` 2.0.0**（2026-07-27公開）を使う。旧 `@modelcontextprotocol/sdk`（v1系）ではない。API は `registerTool` / `serveStdio`、Zod v4。
> - ツール名を `symbol_<対象>_<操作>` の名前空間付きに統一（Anthropicのツール設計ガイド準拠）。
> - **モデルが任意URLを指定できる引数を廃止**（SSRF対策。MCPセキュリティガイド準拠）。参照ノードは環境変数の許可リストのみ。
> - 全ツールに `annotations`（readOnlyHint 等）と `outputSchema` + `structuredContent` を必須化。
> - テストは SDK 公式のインプロセス方式（`createMcpHandler` + `Client`）。
> - 公開手順を MCP Registry の実際の手順（`mcpName` / `server.json` / `mcp-publisher`）に合わせた。

---

## 1. 背景と目的

**Symbol** は公開ブロックチェーン（旧NEMの後継だが、NEM/XEMとは**別チェーン**）。ネイティブ通貨は **XYM**。各ノードが REST API（通常 3000=http / 3001=https）を公開しており、認証なしで読める。

作るもの: **Symbol の REST API を MCP（Model Context Protocol）ツールとして使えるサーバー**。対象ユーザーは2種類。

- **一般ユーザー**: 残高・トランザクション・モザイク（トークン）・ネームスペースの照会、手数料の目安、アドレス検証
- **ノード運用者**: ノードの状態、同期確認、ハーベスティング状況、**Votingキーの失効日の算出**

設計上の要点は次の 3 つ。REST エンドポイントをそのまま写すのではなく、質問単位のツールにする（§2-2）。設定したノード URL が実際のリクエストに使われることを回帰テストで保証する（§7）。LICENSE（MIT）を初回コミットに含める（§3）。

## 2. 設計原則（必須）

1. **読み取り専用**。秘密鍵・ニーモニックを受け取る引数を作らない。署名しない。`PUT /transactions`（アナウンス）はツール化しない。
2. **ツールは「質問に答える」単位**。エンドポイントの写しにしない。合計 14 ツール（§5）。Anthropicのガイド「複数の下位操作を1つの目的別ツールに統合する」に従う。
3. **ノードURLは環境変数でのみ設定**（`SYMBOL_NODE_URL`）。**ツール引数でURLを受け取らない**（モデルが内部ネットワークへリクエストを向けられる SSRF 経路になるため）。起動時に `/node/info` を取得し、`networkGenerationHashSeed` で mainnet/testnet を判定。`SYMBOL_NETWORK` が指定されていて不一致なら**起動失敗**。使用ノードとネットワークを stderr にログ。
4. **出力は構造化＋人間向け**。全ツールに `outputSchema` を定義し、`structuredContent` と、その JSON 文字列を入れた `text` ブロックの**両方**を返す（仕様の後方互換要件）。`structuredContent` の先頭に `summary: string`（1〜3行の要約）を必ず含める。金額は divisibility 適用後の値と生の整数の両方。日時は ISO 8601（UTC）＋ `SYMBOL_TIMEZONE` 指定時はローカル時刻も。数値IDは名前解決（例: `6BED913FA20223F8` → `symbol.xym`、`16724` → `transfer`）。
5. **ネットワーク定数はハードコードしない**。`/network/properties` から取得してプロセス内キャッシュ。既知の値はテストの期待値としてのみ使う（例外: §4 の generationHashSeed 照合表）。
6. **エラーは `isError: true` の結果で返し、本文に復旧のヒントを書く**（例: 「アドレスは39文字のbase32。hexを渡した場合は symbol_address_parse で変換」）。スタックトレースやHTTP生レスポンスをそのまま返さない。
7. **外部通信は `SYMBOL_NODE_URL` と `SYMBOL_REFERENCE_NODES` のみ**。テレメトリ禁止。
8. **チェーン上の文字列は信頼しない**。転送メッセージ・ノードの friendlyName・ネームスペース名は第三者が書ける。出力では `untrusted` であることが分かるフィールド名（例: `messageText`）に入れ、制御文字を除去する。

## 3. 技術スタック（確認済みの現行規約）

| 項目 | 採用 | 根拠 |
|---|---|---|
| 言語/ランタイム | TypeScript、**Node.js ≥ 20**、ESM（`"type": "module"`） | SDK v2 の `engines` と ESM-first |
| MCP SDK | **`@modelcontextprotocol/server` `^2.0.0`** | 2026-07-27 公開の安定版。v1 の `@modelcontextprotocol/sdk` は保守のみ |
| スキーマ | **`zod` `^4.2.0`**、`import * as z from 'zod/v4'` | SDK v2 の依存。`inputSchema` には `z.object(...)` を渡す（v1 のように shape を渡さない） |
| サーバー起動 | `serveStdio(createServer)` を `@modelcontextprotocol/server/stdio` から | v1 の `new StdioServerTransport()` + `connect` は廃止 |
| HTTP | 標準 `fetch` + `AbortSignal.timeout()` | 依存を増やさない |
| Symbol SDK | 原則不要。アドレス導出・ネームスペースID生成のテストベクタ確認にのみ `symbol-sdk`（npm）を参照 | 読み取りと算術しかしない |
| テスト | vitest。SDK公式のインプロセス方式（§7） | `docs/testing.md` |
| Lint/Format | biome | 軽量 |
| CI | GitHub Actions。Node 20 / 22 のマトリクスで lint + test | |
| 配布 | npm。`bin` で `npx` 起動。**ビルド済み JS（`dist/`）を配布**（利用者に tsx を要求しない） | |
| ライセンス | **MIT**（初回コミットに含める） | 公開リポジトリの必須要件 |

**SDK v2 を使う上での注意**
- v2 は公開から日が浅い。致命的な不具合に当たったら `@modelcontextprotocol/sdk` 1.x（`server.tool()` API）へ退避する選択肢はあるが、その場合も本書の設計は変えない。v1→v2 は `npx @modelcontextprotocol/codemod@latest v1-to-v2 .` で機械移行できる。
- `serveStdio` は既定で「2025年系（`initialize` ハンドシェイク）」と「2026-07-28 系」の両プロトコル世代を同じ factory から提供する。**既定のままにする**（ホスト側がまだ旧世代のことがある）。
- 2026-07-28 仕様で Roots / Sampling / Logging 機能は非推奨。**ログは MCP の logging 機能ではなく stderr に書く**。`console.log` は禁止（stdout は JSON-RPC チャネルで、1行で壊れる）。

## 4. 設定

| 環境変数 | 必須 | 内容 |
|---|---|---|
| `SYMBOL_NODE_URL` | **必須** | 例 `https://<node-host>:3001`。末尾スラッシュの有無を吸収。`https://` 必須（`http://` は `localhost` / `127.0.0.1` のみ許可） |
| `SYMBOL_NETWORK` | 任意 | `mainnet` / `testnet`。指定時は起動時に照合、不一致なら起動失敗 |
| `SYMBOL_TIMEZONE` | 任意 | IANA名（例 `Asia/Tokyo`）。日時出力にローカル時刻を併記 |
| `SYMBOL_REFERENCE_NODES` | 任意 | カンマ区切りURL。`symbol_network_compare` の比較対象。**ここに無いURLへは通信しない** |
| `SYMBOL_REQUEST_TIMEOUT_MS` | 任意 | 既定 10000 |

既知のネットワーク識別情報（起動時照合用。ハードコードしてよい唯一の定数）:

| ネットワーク | networkIdentifier | networkGenerationHashSeed |
|---|---|---|
| mainnet | 104 | `57F7DA205008026C776CB6AED843393F04CD458E0AA2D9F1D5F31A402072B2D6` |
| testnet (sai) | 152 | `49D6E1CE276A85B70EAFE52349AACCA389302E7A9754BCF1221E79494FC665A4` |

動作確認に使えるノード（2026-09-10 稼働確認済み。将来変わりうる）:
- mainnet: `https://sym-main-01.opening-line.jp:3001`
- testnet: `https://sym-test-01.opening-line.jp:3001`
- 他の公開ノードは https://nodewatch.symbol.tools/ で探す

## 5. ツール仕様

### 共通規約

- **名前**: `symbol_<対象>_<操作>` の snake_case（仕様で許される文字は `[A-Za-z0-9_.-]`、1〜128文字）。`title` に人間向けの表示名を付ける。
- **引数名**: 曖昧さを排する（`id` ではなく `address` / `publicKey` / `transactionHash`）。各引数に `.describe()` を必ず付ける（モデルが読む唯一の説明）。
- **annotations**: 全ツールに `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }` を明示する（外部ノードへ通信するため openWorld は true）。
  仕様上の既定値（`schema/2025-11-25` と `schema/2026-07-28` の `ToolAnnotations` で確認済み。既定値は JSON Schema の `default` キーではなく説明文中に「Default: …」として書かれている点に注意）:
  `readOnlyHint` = **false**、`destructiveHint` = **true**、`idempotentHint` = **false**、`openWorldHint` = **true**。
  つまり **何も書かないと「状態を変更しうる破壊的ツール」として扱われる**ので、読み取り専用サーバーでは `readOnlyHint: true` の明示が必須。`destructiveHint` と `idempotentHint` は `readOnlyHint == false` のときだけ意味を持つ（明示は無害）。
- **登録順序を固定する**: 2026-07-28 仕様で `tools/list` は決定的な順序で返すこと（SHOULD）が追加された（クライアント側キャッシュとプロンプトキャッシュのため）。ツールは配列で定義し、常に同じ順序で `registerTool` する。`ttlMs` / `cacheScope` など同仕様で追加された応答フィールドは SDK が扱うので実装側の作業はない。
- **出力**: `outputSchema`（zod）を定義し、`structuredContent` と `content: [{type:'text', text: JSON.stringify(structuredContent)}]` の両方を返す。先頭フィールドは `summary`。
- **量の多い出力**には `format: z.enum(['concise','detailed']).default('concise')` と `pageSize`（既定10、最大100）を付け、切り詰めたら `truncated: true` と次の取り方を `summary` に書く。
- **エラー**: `{ content:[{type:'text', text:'<何が悪いか>。<どう直すか>'}], isError: true }`。ノード到達不能・タイムアウト・404・ネットワーク不一致・入力不正を区別する。

### 5.1 一般ユーザー向け

**`symbol_network_info`** — 引数なし（`inputSchema` を省略）。
ネットワーク名・identifier・generationHashSeed、現在高さ、ファイナライズ高さ/エポック、`blockGenerationTargetTime`、XYM の mosaicId と divisibility、`epochAdjustment`、現在の手数料乗数（`/network/fees/transaction` の min/average/median/highest）。

**`symbol_account_get`** — `account`（base32アドレス または 64桁hex公開鍵）、`format`。
アドレス（base32とhex）、公開鍵、全モザイク残高（id・エイリアス名・divisibility 適用後の量・生の整数）、importance と importanceHeight、`supplementalPublicKeys`（linked / vrf / node / voting[]。votingは start/endEpoch 付き）、委任ハーベスティング設定の有無（linked と vrf が両方あれば「設定済み」）、マルチシグ情報（`/account/{id}/multisig` が 404 でなければ）。
参照: `GET /accounts/{accountId}`（address と publicKey の両方を受け付ける）。

**`symbol_transaction_get`** — `transactionHash`。
種別名（数値コードから名前へ。§6）、署名者アドレス、宛先、モザイクと量（名前解決・divisibility 適用）、メッセージ（平文なら復号、暗号化なら「暗号化メッセージ」と明記）、手数料（XYM）、高さ、タイムスタンプ（ISO）、アグリゲートなら内包トランザクションの要約一覧。
参照: `GET /transactions/confirmed/{transactionId}`。見つからなければ `/transactions/unconfirmed/{id}`、`/transactions/partial/{id}` も試して状態（confirmed/unconfirmed/partial/not_found）を返す。

**`symbol_transaction_search`** — `address`、`type`（任意、名前または数値）、`pageSize`、`order`（desc既定）、`format`。
上記と同じ形式の要約リスト＋ページング情報。
参照: `GET /transactions/confirmed?address=...&type=...&pageSize=...&order=desc`。

**`symbol_mosaic_get`** — `mosaic`（16桁hex ID または `symbol.xym` のようなエイリアス名）。
ID、エイリアス名、供給量、divisibility、フラグ（supplyMutable / transferable / restrictable / revokable）、所有者、開始高さ、有効期間（duration=0 は無期限）。
参照: `GET /mosaics/{mosaicId}`、名前解決は `GET /namespaces/{namespaceId}`。

**`symbol_namespace_get`** — `namespace`（名前または16桁hex ID）。
所有者、種別（root/sub）、エイリアス先（address または mosaicId）、開始/終了高さと**終了予定日時**（§6 の換算）。
参照: `GET /namespaces/{namespaceId}`。

**`symbol_fee_estimate`** — `transactionSizeBytes`（任意。未指定なら代表的な転送トランザクションのサイズ例で計算）。
`/network/fees/transaction` の各乗数 × サイズ を XYM に換算した目安（最低/平均/中央値/高速）。送信はしない。

**`symbol_address_parse`** — `value`（base32アドレス / hexアドレス / 公開鍵）。
妥当性、種別、base32 と hex の両形式、所属ネットワーク（先頭文字 N=mainnet, T=testnet）、公開鍵ならそこから導出したアドレス。

**`symbol_time_convert`** — `height` または `epoch` または `timestamp`（ネットワークタイムスタンプms）のいずれか1つ。
高さ・エポック・ネットワークタイムスタンプ・実時刻（ISO/UTC、ローカル）の相互変換。将来の高さ/エポックなら実測平均ブロック時間からの**推定**と明記。

### 5.2 ノード運用者向け

**`symbol_node_status`** — 引数なし（対象は `SYMBOL_NODE_URL`）。
friendlyName、host、ロール（ビットフラグを Peer/API/Voting に展開）、バージョン（4バイト整数を `1.0.3.9` 形式に復号。例 16777993 → `1.0.3.9`）、ネットワーク、`/node/health` の apiNode/db 状態、現在高さ/ファイナライズ高さ/エポック、ピア数（`/node/peers` の件数）、**同期判定**（最新ブロックのタイムスタンプを実時刻に変換し、現在時刻との差が5分を超えたら `synced: false` と警告）。

**`symbol_voting_key_status`** ← **最重要ツール** — `account`（アドレスまたは公開鍵）。
- 登録済み Voting キー一覧: publicKey、startEpoch、endEpoch、状態（`expired` / `active` / `future`）
- 現在のファイナライズエポック、現在高さ
- アクティブキーについて: 残りエポック数、残りブロック数、**残り日数**、**失効予定日時**（ISO/UTC＋ローカル）、**推奨実施ウィンドウ**（失効の7日前〜3日前）
- ネットワーク制約: `maxVotingKeysPerAccount`、`minVotingKeyLifetime` / `maxVotingKeyLifetime`、登録枠の空き数（失効済みキーも枠を消費することを注記）
- 残高と `minVoterBalance` の比較（Voting資格の有無と余裕）
- アクティブキーが無い / 30日以内に失効 なら `warning` を立てる
計算方法は §6。

**`symbol_harvesting_status`** — `account`（任意）。
ノードで解錠中の委任ハーベスター数と公開鍵一覧（`/node/unlockedaccount`）、`minHarvesterBalance` / `maxHarvesterBalance` / `harvestBeneficiaryPercentage`、`account` 指定時はその linked 公開鍵が解錠リストに含まれるか（＝このノードで実際にハーベストできる状態か）。

**`symbol_network_compare`** — 引数なし（対象は `SYMBOL_REFERENCE_NODES`）。
自ノードと各参照ノードの高さ・ファイナライズ高さ、最大差分、`lagging: boolean`（差が10ブロック超）。参照ノード未設定なら、その旨と https://nodewatch.symbol.tools/ を案内する（エラーにしない）。

**`symbol_harvesting_income`**（0.2.0 で追加。ツール配列の末尾に登録し、既存の順序を変えない）— `account`（アドレスまたは公開鍵）、期間は `fromDate`/`toDate`（`YYYY-MM-DD`、両端含む。`SYMBOL_TIMEZONE` の日付、未指定なら UTC）または `fromHeight`/`toHeight` の**どちらか一方**（両方・どちらも無し・片方だけ・逆順・実在しない日付は `isError`）、`granularity`（`daily` 既定 / `receipt`）、`format`（`receipt` 時の上限: concise 50 件 / detailed 500 件）。
- 指定期間にそのアカウント宛に発生した Harvest_Fee（8515）レシートのうち、通貨モザイク（`/network/properties` の `currencyMosaicId`）のものだけを集計する。件数・合計は**サーバー内で BigInt により決定的に計算**し、divisibility 適用後の文字列と生の整数を両方返す。summary の数値もその文字列を埋め込む（LLM に計算させない、丸めない）。
- 日付→高さ: `/blocks/{h}` のタイムスタンプに対する二分探索（下限 1、上限 `/chain/info` の高さ）。from/to の探索は並行、それぞれ逐次なので同時リクエストは 2 本。
- 取得: `GET /statements/transaction?receiptType=8515&targetAddress=<base32>&fromHeight&toHeight&pageSize=100&order=asc&pageNumber=n` を 100 件未満のページが返るまで読む（クエリ名と DTO は symbol-openapi `spec/plugins/receipt/` で確認済み）。上限 200 ページ（20,000 ステートメント）を超えたら `truncated: true`、`truncationReasons: ['pageLimit']`、summary に「期間を狭めるか fromHeight/toHeight で分割」。`/statements/transaction` と `/blocks/*` はキャッシュしない。
- 分類（harvester / beneficiary / unknown）: 1 ブロックの 8515 レシートは harvester・beneficiary・ネットワークの 3 件が常に別レシートで（ハーベスターと beneficiary が同一アカウントでも 2 件別々。mainnet 実データで確認済み）、返却順は金額順ではない。同一ステートメント内の 8515 を amount 降順に並べ、`harvestBeneficiaryPercentage`(B) と `harvestNetworkPercentage`(N) から導いた (100-B-N):B:N（3 件）または (100-N):N（2 件、beneficiary 未設定のブロック）と各金額が合計の ±1 ポイント以内で一致すれば、最大 = harvester、2 番目（3 件時）= beneficiary。一致しなければそのステートメントの受取分は `unknown`（集計には含め、`unknownStatements` と summary に件数を出す）。比率をコードに焼かない。
- 出力: `summary`、`period`（種別・日付・使用タイムゾーン）、`range`（fromHeight/toHeight と両端ブロックの日時）、`totals` と `daily[]`（`SYMBOL_TIMEZONE` の日付境界でバケット）または `receipts[]`、各行に harvester / beneficiary / unknown の内訳（`xym*` と `raw*`）、`truncated`、`notes`（「ハーベストは確率的で日ごとの変動が大きい」「為替換算は含まない」）。
- 参照: `GET /statements/transaction`（TransactionStatementPage → `statement.receipts[]` の BalanceChangeReceiptDTO `{ type, mosaicId, amount, targetAddress }`、`meta.timestamp` はブロックのネットワークタイムスタンプ）、`GET /blocks/{height}`、`GET /chain/info`、`GET /accounts/{id}`。レシート種別の名前表は catbuffer `receipt_type.cats` から取り込む（`src/domain/receipttype.ts`）。

## 6. ドメイン知識と落とし穴

**アドレス**: 24バイト。base32エンコードして末尾の `=` を除いた **39文字**。先頭文字が `N`=mainnet、`T`=testnet。API のJSONはアドレスを **hex（48文字）** で返すので base32 へ変換して表示する。`/accounts/{id}` は base32アドレスでも公開鍵でも引ける。公開鍵→アドレスの導出は SHA3-256 → RIPEMD-160 → ネットワークバイト付加 → チェックサム（SHA3-256先頭3バイト）。実装は `symbol-sdk`（npm）の `SymbolFacade.network.publicKeyToAddress` を参照するか、そのテストベクタで検証する。

**金額**: 全て整数文字列。XYM は divisibility 6（`1000000` = 1 XYM）。mainnet の XYM mosaicId は `6BED913FA20223F8`（エイリアス `symbol.xym`）。他のモザイクの divisibility は `/mosaics/{id}` で取る。

**`/network/properties` のパース**: 値は全て文字列で、数値に**アポストロフィ区切り**（`"3'000'000'000'000"`）、時間に**単位**（`"30s"`, `"15m"`）が付く。専用パーサを書き、単体テストする。

**タイムスタンプ**: `block.timestamp` は `epochAdjustment` からの**ミリ秒**。実時刻(ms) = `epochAdjustment(秒)×1000 + timestamp`。mainnet の epochAdjustment は 1615853185（= 2021-03-16 00:06:25 UTC）。**値は `/network/properties` の `network.epochAdjustment` から読む**（`"1615853185s"` 形式）。

**エポック⇄高さ**（`G = chain.votingSetGrouping`、mainnet は 1440）:
```
エポック e が占める高さ = (e-2)×G + 1  〜  (e-1)×G
高さ h のエポック       = floor((h-1)/G) + 2
```
mainnet の実データ2点で検証済み: ファイナライズ高さ 5,755,504 → エポック 3998、5,763,316 → 4004。**この式が `/chain/info` の `latestFinalizedBlock` と一致することを統合テストで確認する。** Votingキーの `endEpoch = E` の失効高さは `(E-1)×G`。

**将来の高さの日時推定**: `blockGenerationTargetTime`（30s）ではなく**実測平均**を使う。直近 N ブロック（既定 10,000）の先頭と末尾の timestamp 差 ÷ N で算出（mainnet 実測 30.03秒、2026-09）。出力に「推定」と実測値を明記。

**ノードのロール**: `roles` はビットフラグ。1=Peer、2=API、4=Voting。7 = 全部。

**バージョン**: `version` は4バイトを整数化したもの。上位から major.minor.patch.build。`16777993 = 0x01000309 → 1.0.3.9`。

**トランザクション種別**: `type` は数値（例: 16724 = Transfer）。**名前対応表は `symbol-sdk` の `TransactionType` 列挙、または公式ドキュメントから機械的に取り込む。記憶で書かない。** 主要種別: Transfer, AggregateComplete, AggregateBonded, AccountKeyLink, VotingKeyLink, VrfKeyLink, NodeKeyLink, MosaicDefinition, MosaicSupplyChange, NamespaceRegistration, AddressAlias, MosaicAlias, HashLock, SecretLock, SecretProof, 各種Metadata/Restriction, MosaicSupplyRevocation。

**メッセージ**: 転送トランザクションの `message` は hex。先頭1バイトがタイプ（`00`=平文、`01`=暗号化）、残りが本文（平文は UTF-8）。暗号化は復号できないので「暗号化メッセージ（復号不可）」と返す。**本文は第三者が書ける文字列**（§2-8）。

**ネームスペース名→ID**: 各レベルの名前を SHA3-256 で畳み込む（`generateNamespaceId`）。`symbol-sdk` の実装かテストベクタで検証。`symbol.xym` → namespace ID `E74B99BA41F4AFEE`、そのエイリアス先が mosaic ID `6BED913FA20223F8`。

**Votingキー**: `supplementalPublicKeys.voting.publicKeys[]` に `{publicKey, startEpoch, endEpoch}`。**失効したキーも登録に残り続け、`maxVotingKeysPerAccount`（mainnet 3）の枠を消費する。**

**ページング**: 検索系は `{ data: [], pagination: { pageNumber, pageSize } }`。

**ポート**: 3000（http）と 3001（https）。片方しか開けていないノードがある。URL はユーザー指定のものをそのまま使い、勝手にポートを変えない。

**キャッシュ**: `/network/properties` はプロセス内でネットワークごとに1回だけ取得。`/chain/info` `/node/*` `/accounts/*` はキャッシュしない。

**HTTP衛生**: 全リクエストに `AbortSignal.timeout(SYMBOL_REQUEST_TIMEOUT_MS)`、`User-Agent: <package-name>/<version>`、レスポンスサイズ上限（例 5MB）、同時実行数上限（例 4）。ノードが返す JSON はスキーマで検証してから使う（形が違えば `isError` で「ノードの応答が想定と異なる」と返す）。

## 7. テスト要件

**単体（CIで必ず実行）**
- `/network/properties` パーサ（アポストロフィ数値、`30s` 等の単位）
- アドレス: hex⇄base32、公開鍵→アドレス（symbol-sdk のテストベクタと照合）、ネットワーク判定
- エポック⇄高さの相互変換（上記2データ点を固定値テストに）
- バージョン復号（16777993 → `1.0.3.9`）
- 金額整形（divisibility 6 / 0 / 3）
- トランザクション種別の名前解決
- メッセージ復号（平文 / 暗号化 / 空 / 制御文字除去）

**ツール層（CIで必ず実行。SDK公式のインプロセス方式）**
`createMcpHandler(createServer)` を作り、`@modelcontextprotocol/client` の `Client` を `StreamableHTTPClientTransport(url, { fetch: (u, i) => handler.fetch(new Request(u, i)) })` で接続して `client.callTool()` を呼ぶ。ノードへの `fetch` は `vi.stubGlobal('fetch', ...)` で差し替え、固定レスポンスを返す。
- 各ツールが `structuredContent` と `text` の両方を返し、`structuredContent` が `outputSchema` を満たす
- 入力不正が `isError: true` で返り、本文に修正のヒントが含まれる
- **`SYMBOL_NODE_URL` に設定したホストへ実際にリクエストが飛ぶこと**（stub した fetch が受け取った URL のホストを検証）。設定した URL が実際に使われることを保証する回帰テスト
- `SYMBOL_NETWORK=mainnet` で `/node/info` が testnet の generationHashSeed を返したら**起動失敗**すること
- `SYMBOL_REFERENCE_NODES` に無いホストへは一切 fetch が呼ばれないこと
- 64桁hex（秘密鍵に見える値）を `symbol_account_get` に渡しても公開鍵として扱うだけで、ログ・出力・外部送信に含めないこと

**統合（`SYMBOL_INTEGRATION=1` のときだけ。CI既定では走らせない）**
- testnet ノードに対して全ツールがエラーなく応答する
- `/chain/info` の `latestFinalizedBlock.height` から式で計算したエポックが `finalizationEpoch` と一致する
- `SYMBOL_INTEGRATION_ACCOUNT` で指定した Voting アカウントに対し、`symbol_voting_key_status` が Voting キーを1本以上返す（内容は時間で変わるので件数と形だけ検証。未設定ならこのテストは skip）

**手動確認**: `npx @modelcontextprotocol/inspector node dist/index.js` で全ツールを一度は叩く。

## 8. リポジトリ構成と公開準備

```
.
├── src/
│   ├── index.ts            # #!/usr/bin/env node、config読込→createServer→serveStdio
│   ├── server.ts           # createServer(): McpServer（ツール登録）
│   ├── config.ts           # env 読込・URL検証・ネットワーク照合
│   ├── client/rest.ts      # fetch ラッパ（timeout, UA, サイズ上限, スキーマ検証）
│   ├── domain/             # address.ts, amount.ts, epoch.ts, version.ts, txtype.ts, message.ts, properties.ts
│   └── tools/              # 1ファイル1ツール（symbol_*.ts）、各ファイルで input/output zod を定義
├── test/                   # unit/, tools/, integration/
├── evals/                  # 実際の質問文と期待するツール呼び出しの例（Phase 3）
├── server.json             # MCP Registry 用
├── package.json  LICENSE  README.md  CHANGELOG.md  SECURITY.md
└── .github/workflows/ci.yml, release.yml
```

**package.json の要点**
- `"type": "module"`, `"engines": {"node": ">=20"}`, `"bin": {"<cmd>": "dist/index.js"}`, `"files": ["dist","README.md","LICENSE"]`
- `"mcpName": "io.github.<GitHubユーザー名>/symbol"`（Registry の検証に必須。GitHub認証で公開するなら必ず `io.github.<user>/` で始める）
- `repository` / `homepage` / `keywords`（symbol, xym, blockchain, mcp, model-context-protocol）
- dependencies: `@modelcontextprotocol/server ^2.0.0`, `zod ^4.2.0`。devDependencies: typescript, vitest, biome, `@modelcontextprotocol/client`（テスト用）

**README.md（英語）**: 何ができるか、インストール（`npx` 一行）、Claude Desktop / Claude Code の設定例（JSON。`env` に `SYMBOL_NODE_URL`）、環境変数、ツール一覧と実行例、**セキュリティ声明（読み取り専用・秘密鍵を扱わない・指定ノード以外に通信しない）**、対応ネットワーク、制限事項。任意で `README.ja.md`。

**MCP Registry への公開手順（公式クイックスタート準拠）**
1. `npm publish --access public`（先に npm へ）
2. `mcp-publisher` を導入（`brew install mcp-publisher` または GitHub Releases のバイナリ）
3. `mcp-publisher init` で `server.json` を生成し、`name` を `package.json` の `mcpName` と**完全一致**させる。`packages[0]` は `registryType: "npm"`, `identifier: "<npm package name>"`, `transport: {type: "stdio"}`, `environmentVariables` に `SYMBOL_NODE_URL`（`isRequired: true, isSecret: false`）等を記述
4. `mcp-publisher login github` → `mcp-publisher publish`
5. `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=<mcpName>"` で確認
※ Registry は 2026-09 時点で preview（破壊的変更やデータリセットの可能性あり）。

## 9. 実装の段階

**Phase 1（最初のPR。これだけで自分用に使える状態）**
スキャフォールド、config とネットワーク照合、`symbol_network_info`、`symbol_node_status`、`symbol_account_get`、`symbol_voting_key_status`、単体テストとツール層テスト、CI、LICENSE。

**Phase 2（一般ユーザー向け拡充）**
`symbol_transaction_get`、`symbol_transaction_search`、`symbol_mosaic_get`、`symbol_namespace_get`、`symbol_fee_estimate`、`symbol_address_parse`、`symbol_time_convert`、`symbol_harvesting_status`、`symbol_network_compare`。統合テスト。

**Phase 3（公開）**
README、CHANGELOG、SECURITY.md、`evals/`（代表的な質問10件と期待するツール呼び出し）、npm publish、MCP Registry 登録。

## 10. やってはいけないこと

- 秘密鍵・ニーモニック・パスワードを受け取る引数を作らない。トランザクションを署名・送信しない
- **ツール引数で URL を受け取らない**。ノード URL をコードにハードコードしない（テストのモック値を除く）
- REST エンドポイント 1個 = ツール 1個 の機械生成をしない
- ネットワーク定数をコードに焼かない（generationHashSeed 照合表のみ例外）
- `SYMBOL_NODE_URL` と `SYMBOL_REFERENCE_NODES` 以外へ通信しない
- エラー時に「テストネットにフォールバック」のような暗黙の切替をしない。失敗は失敗として返す
- `console.log` を使わない（stdout は JSON-RPC 専用）。ログは `console.error`
- MCP の logging / sampling / roots 機能に依存しない（2026-07-28 仕様で非推奨）

## 11. 完了条件（Definition of Done）

1. `SYMBOL_NODE_URL=https://<node-host>:3001 npx .` で起動し、stderr に「<network> via <node-host>」相当のログが出る
2. Claude Code から `symbol_voting_key_status` を Voting キー登録済みの任意のアカウントで呼ぶと、登録キー一覧・アクティブキーの endEpoch・失効予定日時・推奨実施ウィンドウが返る
3. `SYMBOL_NODE_URL` を testnet ノードに変えると testnet と判定され、`SYMBOL_NETWORK=mainnet` を付けると起動失敗する
4. 全ツールが `structuredContent` を返し、`npx @modelcontextprotocol/inspector` で Tools タブから呼べる
5. 単体・ツール層テストが全て緑、lint が緑、`README.md` と `LICENSE` がある

## 12. 参照（2026-09-10 時点で内容確認済み）

**Symbol**
- REST OpenAPI 仕様（**一次情報**）: https://symbol.github.io/symbol-openapi/v1.0.4/openapi3.yml
- 公式ドキュメント: https://docs.symbol.dev / ソース https://github.com/symbol/symbol-docs
- コアリポジトリ（SDK・catbuffer・catapult）: https://github.com/symbol/symbol — JS SDK は `sdk/javascript`
- nodewatch: https://nodewatch.symbol.tools/

**MCP**
- TypeScript SDK v2（リポジトリ内 `docs/` が一次情報。特に `docs/servers/tools.md`, `docs/servers/errors.md`, `docs/serving/stdio.md`, `docs/testing.md`, `docs/get-started/first-server.md`）: https://github.com/modelcontextprotocol/typescript-sdk
- 仕様 Tools（名前制約・outputSchema・isError・セキュリティ要件）: https://modelcontextprotocol.io/specification/2025-11-25/server/tools （2026-07-28 版でも名前制約は同一。追加点は `tools/list` の決定的順序と `ttlMs`/`cacheScope`）
- 仕様スキーマ（`ToolAnnotations` の既定値の一次情報）: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.json
- 仕様 セキュリティベストプラクティス（SSRF・ローカルstdioサーバー）: https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices
- 2026-07-28 仕様の変更点（非推奨機能）: https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- Registry 公開クイックスタート: https://modelcontextprotocol.io/registry/quickstart
- Registry 概要（命名・認証）: https://modelcontextprotocol.io/registry/about

**ツール設計**
- Anthropic「Writing effective tools for agents」: https://www.anthropic.com/engineering/writing-tools-for-agents
