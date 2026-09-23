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
2. **ツールは「質問に答える」単位**。エンドポイントの写しにしない。合計 22 ツール（§5。`src/server.ts` の `TOOLS`。§13 の `check` は CLI サブコマンドでツールには数えない）。Anthropicのガイド「複数の下位操作を1つの目的別ツールに統合する」に従う。
3. **ノードURLは環境変数でのみ設定**（`SYMBOL_NODE_URL`）。**ツール引数でURLを受け取らない**（モデルが内部ネットワークへリクエストを向けられる SSRF 経路になるため）。起動時に `/node/info` を取得し、`networkGenerationHashSeed` で mainnet/testnet を判定。`SYMBOL_NETWORK` が指定されていて不一致なら**起動失敗**。使用ノードとネットワークを stderr にログ。
4. **出力は構造化＋人間向け**。全ツールに `outputSchema` を定義し、`structuredContent` と、その JSON 文字列を入れた `text` ブロックの**両方**を返す（仕様の後方互換要件）。`structuredContent` の先頭に `summary: string`（1〜3行の要約）を必ず含める。金額は divisibility 適用後の値と生の整数の両方。日時は ISO 8601（UTC）＋ `SYMBOL_TIMEZONE` 指定時はローカル時刻も。数値IDは名前解決（例: `6BED913FA20223F8` → `symbol.xym`、`16724` → `transfer`）。
5. **ネットワーク定数はハードコードしない**。`/network/properties` から取得してプロセス内キャッシュ。既知の値はテストの期待値としてのみ使う（例外: §4 の generationHashSeed 照合表）。
6. **エラーは `isError: true` の結果で返し、本文に復旧のヒントを書く**（例: 「アドレスは39文字のbase32。hexを渡した場合は symbol_address_parse で変換」）。スタックトレースやHTTP生レスポンスをそのまま返さない。
7. **外部通信は `SYMBOL_NODE_URL` と `SYMBOL_REFERENCE_NODES` のみ**。テレメトリ禁止。
8. **チェーン上の文字列は信頼しない**。転送メッセージ・メタデータの値・ネームスペース名・ノードが自分について返す値（friendlyName、host、`/node/health` の状態、`/node/server` の restVersion、取引ステータスの code）は第三者が書ける。出力では `untrusted` であることが分かるフィールド名（例: `messageText`）に入れ、`src/domain/sanitize.ts` の `sanitizeUntrusted` で 1 行にする: タブと改行（TAB・LF・VT・FF・CR・NEL・行区切り Zl・段落区切り Zp）は空白 1 つにし（前後の単語がくっつかないように）、それ以外の制御文字（Cc）・書式文字（Cf）・単独サロゲート（Cs）・タグ文字ブロック U+E0000〜U+E007F（未割り当てを含む）を除去し、空白（U+0020）の連続を 1 つにまとめ、両端の空白を削り、長さを制限する（サロゲートペアは割らない）。全角空白や NBSP はまとめず残す。異体字セレクタは残す。状態の判定（`up` か）も除去後の値で行い、表示と判定を一致させる。取引詳細の型付きフィールドは OpenAPI の形（MetadataKey・RestrictionKeyHex は 16 桁 hex、VotingKey は 64 桁）に合うものだけで、合わなければ除去済みの `other` に落とす。エラー文にノードの値を引用するときも同じ除去と上限を通す。
   - **除去数（`invisibleCharactersRemoved`）**: 第三者の文字列を出力に入れる 17 ツール（§5 共通規約）は、その呼び出しで除去した文字（Cc・Cf・Cs・タグ文字）の数を返す。空白にした改行・タブ、まとめたり削ったりした空白、長さの切り詰めは数えない（除去は切り詰めの前なので、上限で切れた部分にあった見えない文字は数える）。同じ出所の文字列は 1 回の呼び出しで 1 回だけ数える: 除去済みの値に出所のキー（モザイクごとの別名 `mosaic-alias:<id>`、ネームスペースの各階層 `namespace:<id>`）を持たせ、プロセス内でキャッシュした通貨の別名、2 つの名前に共通する親ネームスペース、1 回の呼び出しで 2 度取得した同じ名前も 1 回にする。出力に出ない文字列は数えない（手数料を表示しない取引の通貨ラベル、受取人に使われないネームスペース名）。除去後に何も残らない別名や名前は無いものとして扱い（モザイク id や呼び出し側が書いた名前に戻る。欠けた階層のある名前も同じ）、除去した文字は数える。priceSource・priceAsOf も同様に、何も残らなければ指定なしとして扱う。1 以上なら summary の最後に「Removed N invisible characters …」の 1 行を足す（`- ` では始めない。1 行目は変えない）。
   - **除去の経路は 1 本**: ツール定義に `untrustedText: true` を付けると、`defineTool` が呼び出しごとに `UntrustedText`（除去と計数）を作って `run(ctx, input, text)` に渡し、outputSchema の末尾に `invisibleCharactersRemoved` を足し、結果にフィールドと summary の行を付ける（MCP 経由も CLI check も同じ）。第三者の文字列は必ず `text.clean`（その場で除去）か `text.use`（`cleanUntrusted` で除去済みの値。通貨の別名・`resolveMosaicAliases`・`resolveNamespaceNames` は除去済みの値と除去数を返すので、型の上でも `text` を通さないと文字列にならない）を通して出力に入れる。数えなくてよいエラー文・ログ・CLI は `sanitizeUntrusted`。テンプレート文字列に除去済みの値（オブジェクト）をそのまま入れると型では検出できないので、全ツール横断のテストで「[object Object]」が無いことも確かめる。
   - **除去をレスポンスのスキーマ側に寄せる案は採らない**（2026-09 に検討）: zod の transform は文字列しか返せず除去数を運べない（オブジェクトを返すと全消費者の型が変わり、グローバルな集計は同時に走る呼び出しの数を混ぜる）／プロセス内でキャッシュする通貨の別名は取得時に 1 回しか解析されない／メッセージやメタデータの値は hex を解析した後にデコードされ、priceSource は呼び出し側の入力でスキーマを通らない。スキーマは形と長さの上限だけを受け持ち、取引詳細の zod transform による除去もやめて、上の 1 本にそろえた。
9. **ローカル状態ファイル**（0.3.0 で追加）。ディスクに書くのは `symbol_harvester_watch` だけで、書く場所は `SYMBOL_STATE_DIR`（任意。絶対パス）配下の `harvesters-<nodePublicKey 先頭 16 hex>.json` のみ。内容は解錠中ハーベスターの公開鍵・高さ・時刻だけで秘密情報を含まない。削除しても動作に影響しない（次回が baseline になる）。未設定なら何も書かず「比較不可」として現在の一覧だけ返す。fs を import するのは `src/state/snapshotfile.ts` の 1 ファイルだけ（`grep -l node:fs src/` で監査できる）。同日に複数回呼べばその回数だけ積み、新しい 60 件で有界。`readOnlyHint: true` は据え置く（モデルはパスも内容も選べず、書けるのは「今日の一覧を追記する」ことだけ）。

## 3. 技術スタック（確認済みの現行規約）

| 項目 | 採用 | 根拠 |
|---|---|---|
| 言語/ランタイム | TypeScript、**Node.js ≥ 22**、ESM（`"type": "module"`） | Node 20 は EOL。SDK v2 は ESM-first |
| MCP SDK | **`@modelcontextprotocol/server` `^2.0.0`** | 2026-07-27 公開の安定版。v1 の `@modelcontextprotocol/sdk` は保守のみ |
| スキーマ | **`zod` `^4.2.0`**、`import * as z from 'zod/v4'` | SDK v2 の依存。`inputSchema` には `z.object(...)` を渡す（v1 のように shape を渡さない） |
| サーバー起動 | `serveStdio(createServer)` を `@modelcontextprotocol/server/stdio` から | v1 の `new StdioServerTransport()` + `connect` は廃止 |
| HTTP | 標準 `fetch` + `AbortSignal.timeout()` | 依存を増やさない |
| Symbol SDK | 原則不要。アドレス導出・ネームスペースID生成のテストベクタ確認にのみ `symbol-sdk`（npm）を参照 | 読み取りと算術しかしない |
| テスト | vitest 5（開発時は Node 22.12 以上）。SDK公式のインプロセス方式（§7） | `docs/testing.md` |
| Lint/Format | biome | 軽量 |
| CI | GitHub Actions。Node 22 / 24 のマトリクスで lint + test | |
| 配布 | npm。`bin` で `npx` 起動。**ビルド済み JS（`dist/`）を配布**（利用者に tsx を要求しない） | |
| ライセンス | **MIT**（初回コミットに含める） | 公開リポジトリの必須要件 |

**SDK v2 を使う上での注意**
- v2 は公開から日が浅い。致命的な不具合に当たったら `@modelcontextprotocol/sdk` 1.x（`server.tool()` API）へ退避する選択肢はあるが、その場合も本書の設計は変えない。v1→v2 は `npx @modelcontextprotocol/codemod@latest v1-to-v2 .` で機械移行できる。
- `serveStdio` は既定で「2025年系（`initialize` ハンドシェイク）」と「2026-07-28 系」の両プロトコル世代を同じ factory から提供する。**既定のままにする**（ホスト側がまだ旧世代のことがある）。
- 2026-07-28 仕様で Roots / Sampling / Logging 機能は非推奨。**ログは MCP の logging 機能ではなく stderr に書く**。`console.log` は禁止（stdout は JSON-RPC チャネルで、1行で壊れる）。

### 3.1 サーバー instructions と Prompts（0.2.0 で追加）

**instructions**: `new McpServer(info, { instructions })`（SDK v2 `ServerOptions.instructions`。npm 配布物に `docs/` は含まれないので `dist/*.d.mts` で確認した）で initialize 結果に載せる。本文は `src/instructions.ts` の `SERVER_INSTRUCTIONS`（英語 150 語以内。`test/unit/instructions.test.ts` が語数を検証）。書くのはツール説明では伝わらないことだけ: 読み取り専用で秘密鍵を受け取らず署名・送信しない／アカウントは 39 文字 base32・64 桁 hex 公開鍵・ネームスペース名／ハーベスト報酬はレシートなので `symbol_harvesting_income`（`symbol_transaction_search` を使わない。月別・CSV の引数）／保有額の通貨換算は単価を先に用意して `symbol_holdings_value` に渡し、残高 × 単価を自分で計算しない（0.7.0 で追加）／取り違えやすい質問とツールの対応を 1 文にまとめた一覧（`Route by question:` の後に「問い, ツール」を `;` で並べる: 保有順位、Voting キーの失効、ファイナリティ投票の署名、委任ハーベストの不調、委任者の増減、ノードのサービスの健全性、同期、版の遅れ、他ノードとの高さの差、トランザクションが通ったか・失敗したか）／数値はサーバー計算済みなのでモデルは再計算しない。150 語に収めるため既存文を圧縮した（ツール説明の組み立ては §5 共通規約）。クライアントは `client.getInstructions()` で読める（ツール層テストで検証）。

**Prompts**: `server.registerPrompt(name, { title, description, argsSchema: z.object(...) }, cb)`。`src/prompts/` に 1 ファイル 1 プロンプト、`server.ts` の `PROMPTS` 配列の順に登録する（ツールと同じく末尾追加のみ、並べ替えない）。引数は `account`（base32 アドレス）だけ。コールバックで `isValidBase32Address` を通し、不正なら prompts/get をエラーにする。本文は `{account}` を置換するテンプレートで、**実在のアドレス・ホスト・鍵・ハッシュ・日付を書かない**（`test/tools/prompts.test.ts` が、置換前のテンプレートと、置換後の本文から渡した account を除いた残りの両方を正規表現で検査する）。
- `voting_key_renewal_checklist`: `symbol_voting_key_status`（endEpoch・失効予定・推奨ウィンドウ・空き枠）→ `symbol_node_status`（未同期なら中止）→ `symbol_network_compare` → 更新コマンドは人間が実行 → 教えられた Tx ハッシュを `symbol_transaction_status` で confirmed 確認 → `symbol_voting_key_status` を再確認（新キーが active / future、失効キーが unlink されて枠が空いた）→ 「現行キー / 新キー / 失効予定 / 未対応事項」の 4 行。
- `monthly_health_check`: `symbol_node_status` → `symbol_node_health`（verdict と warn 以上の項目。unhealthy なら先頭）→ `symbol_version_drift`（verdict・自ノード版・majorityVersion。behind 以上なら先頭）→ `symbol_network_compare` → `symbol_harvester_watch`（mode `compare_and_save`。`current.count` と `comparison` の previousCount / previousTakenAt / 追加・削除件数 / deltaCount。負なら注意。`comparison` が null で notes が `SYMBOL_STATE_DIR` 未設定を言うなら前回値をユーザーに聞き、初回なら baseline 保存を報告。`symbol_harvesting_status` は制限値や鍵一覧を求められたときだけ）→ `symbol_voting_key_status`（30 日以内なら警告を先頭）→ `symbol_account_get`（残高 vs `minVoterBalance`）→ `symbol_harvesting_income`（先月 1 日〜末日、daily）→ 要対応 / 注意 / 正常の 3 段階で 1 画面。

## 4. 設定

| 環境変数 | 必須 | 内容 |
|---|---|---|
| `SYMBOL_NODE_URL` | **必須** | 例 `https://<node-host>:3001`。末尾スラッシュの有無を吸収。`https://` 必須（`http://` は `localhost` / `127.0.0.1` のみ許可） |
| `SYMBOL_NETWORK` | 任意 | `mainnet` / `testnet`。指定時は起動時に照合、不一致なら起動失敗 |
| `SYMBOL_TIMEZONE` | 任意 | IANA名（例 `Asia/Tokyo`）。日時出力にローカル時刻を併記 |
| `SYMBOL_REFERENCE_NODES` | 任意 | カンマ区切りURL。`symbol_network_compare` の比較対象。**ここに無いURLへは通信しない** |
| `SYMBOL_REQUEST_TIMEOUT_MS` | 任意 | 既定 10000 |
| `SYMBOL_STATE_DIR` | 任意 | `symbol_harvester_watch` のスナップショット置き場（絶対パス必須。相対は `ConfigError`。起動時に作成も書込確認もしない）。§2-9 |

既知のネットワーク識別情報（起動時照合用。ハードコードしてよい唯一の定数）:

| ネットワーク | networkIdentifier | networkGenerationHashSeed |
|---|---|---|
| mainnet | 104 | `57F7DA205008026C776CB6AED843393F04CD458E0AA2D9F1D5F31A402072B2D6` |
| testnet (sai) | 152 | `49D6E1CE276A85B70EAFE52349AACCA389302E7A9754BCF1221E79494FC665A4` |

動作確認に使うノードは https://nodewatch.symbol.tools/ で探す（mainnet / testnet の API ノードで、現在の高さにあり、多数派の版で、`https://`（通常 3001 番）で応答するもの。README「Choosing a node」）。文書・`--help`・ツール説明の例は `https://<node-host>:3001`（testnet は `https://<testnet-node>:3001`）のプレースホルダにし、実在のノードのホスト名や Tx ハッシュを書かない（配布物に入り、稼働状況も変わるため。テストと evals の公開データは除く）。

## 5. ツール仕様

### 共通規約

- **名前**: `symbol_<対象>_<操作>` の snake_case（仕様で許される文字は `[A-Za-z0-9_.-]`、1〜128文字）。`title` に人間向けの表示名を付ける。
- **引数名**: 曖昧さを排する（`id` ではなく `address` / `publicKey` / `transactionHash`）。各引数に `.describe()` を必ず付ける（モデルが読む唯一の説明）。
- **description の組み立て**: 1 文目で、そのツールがどの問いに答えるかを命令形の動詞で書き始める（取り違えやすい組の中では互いに違う動詞と対象にし、他のツール名は書かない）。2 文目で「〜なら X を使う」と組の他のツールを案内し、3 文目以降に出力の詳細を書く。取り違えやすい組: `symbol_node_status`（同期と素性）/ `symbol_node_health`（サービスの健全性）/ `symbol_version_drift`（版の遅れ）/ `symbol_network_compare`（他ノードとの高さの差）、`symbol_transaction_get`（中身）/ `symbol_transaction_status`（通ったか・失敗の理由。失敗した Tx は get の読むグループに無く not_found になる）、`symbol_harvesting_status`（ノードの解錠一覧と制限値）/ `symbol_harvester_watch`（一覧の増減）/ `symbol_delegation_diagnose`（1 アカウントの委任が有効か）/ `symbol_harvesting_income`（報酬）/ `symbol_account_get`（残高・鍵・設定）。`symbol_harvesting_income` は例外的に、1 文目に「use this tool whenever the user asks about harvesting rewards, harvest income, or earnings for a period」、2 文目に「Do not use symbol_transaction_search or a browser for this (harvest rewards are receipts, not transactions)」を残す（Claude Desktop がこのツールを見落としてブラウザで答えようとした実害を直した文。外すなら同じ強さの別表現にする）。1 文目は .mcpb の manifest の tools 宣言にもなる（§14）。組と参照先は `test/unit/tool-descriptions.test.ts` で固定する。
- **account 引数の解決規則**（0.2.0 で追加。`src/tools/_accounts.ts` の `resolveAccountInput`。account を受ける全ツール＝`symbol_account_get` / `symbol_voting_key_status` / `symbol_harvesting_status` / `symbol_harvesting_income` / `symbol_finality_participation` / `symbol_delegation_diagnose` / `symbol_account_rank` / `symbol_holdings_value` / `symbol_transaction_search` の `address` / `symbol_address_parse` の `value` が通る）:
  1. 判定順（`classifyAccountId`）: 64 桁 hex 公開鍵 → 48 桁 hex アドレス → 39 文字 base32 アドレス（**チェックサムが通ったときだけ**）→ ネームスペース名（`[a-z0-9][a-z0-9_-]*` を `.` で最大 3 階層、各部分 64 文字以下。SDK `idGenerator.js` と `NamespaceNetworkPropertiesDTO` の `maxNameSize` / `maxNamespaceDepth` で確認。書かれたとおりに判定し、小文字化・trim はしない）→ どれでもなければ `isError`＋ヒント（ヒントに「ネームスペース名も可」）。小文字 39 文字でチェックサムが通らない入力はネームスペース判定へフォールスルーする（39 文字ちょうどの正当な名前を「不正なアドレス」と誤判定しないため）。大文字の打ち間違いは両方の規則に落ちて invalid のまま。小文字の 64 桁 hex は名前としても合法だが公開鍵が先に勝つ。
  2. 名前 → namespaceId は `src/domain/namespace.ts`（`symbol_namespace_get` と同じ SHA3 経路）。`GET /namespaces/{id}` は `AppContext.getNamespaceInfo` のプロセス内キャッシュ経由。TTL は `chain.blockGenerationTargetTime`（1 ブロック分。エイリアスは変更されうるので長くしない。定数を焼かない）。
  3. 判定（OpenAPI `AliasDTO` / `AliasTypeEnum` / `NamespaceMetaDTO` で確認）: 404 → 「存在しない（未登録または失効・削除済み）」／`meta.active === false` → 「失効している」／`alias.type === 1`（mosaic）→ 「モザイクのエイリアス（アドレスではない）」／`alias.type !== 2` または `address` 無し → 「アドレスエイリアスがない」。すべて `isError`＋ヒント。`type === 2` なら `alias.address`（hex）を base32 に変換して続行。解決先アドレスに口座が無ければ `fetchAccount` が「エイリアス先にアカウントが無い」と返す。
  4. 出力: 共通の任意フィールド `accountResolution: nullable({ input, namespace, namespaceId, address })`（直接アドレス／公開鍵指定なら null。`symbol_harvesting_status` は account 未指定でも null）。summary の 1 行目の先頭に `alice → NCV5…（完全アドレス）. ` を付ける（`withResolutionPrefix`）。名前はチェーン上の文字列と同じ扱いで `sanitizeUntrusted` を通す。`symbol_address_parse` は `kind: 'namespace'` で解決先アドレスと namespaceId を返し、この形だけノード通信があることを description に明記する。
  5. 逆引き（アドレス → 名前）はこの版では行わない。将来候補: `POST /namespaces/account/names` による `accountNames` の併記。
  - テスト: 単体（判定順、名前規則の否定例: 大文字・スペース・4 階層・空部分・先頭 `-`・65 文字・39 文字フォールスルー）、ツール層 `test/tools/account_resolution.test.ts`（合成ネームスペース `fixture-alias` → 合成メインアカウント。名前指定と直接指定で本体が一致し `accountResolution` だけ違う／4 種のエラー／失効／エイリアス先に口座なし／TTL キャッシュ／`symbol_address_parse`／`SYMBOL_NODE_URL` 以外に fetch しない）、両世代のスモーク `EXTRA_SMOKE_CALLS`（`SMOKE_CALLS` はツールと 1:1 の assert があるので分ける）。
- **annotations**: 全ツールに `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }` を明示する（外部ノードへ通信するため openWorld は true）。
  仕様上の既定値（`schema/2025-11-25` と `schema/2026-07-28` の `ToolAnnotations` で確認済み。既定値は JSON Schema の `default` キーではなく説明文中に「Default: …」として書かれている点に注意）:
  `readOnlyHint` = **false**、`destructiveHint` = **true**、`idempotentHint` = **false**、`openWorldHint` = **true**。
  つまり **何も書かないと「状態を変更しうる破壊的ツール」として扱われる**ので、読み取り専用サーバーでは `readOnlyHint: true` の明示が必須。`destructiveHint` と `idempotentHint` は `readOnlyHint == false` のときだけ意味を持つ（明示は無害）。
- **登録順序を固定する**: 2026-07-28 仕様で `tools/list` は決定的な順序で返すこと（SHOULD）が追加された（クライアント側キャッシュとプロンプトキャッシュのため）。ツールは配列で定義し、常に同じ順序で `registerTool` する。同仕様の `ttlMs` / `cacheScope`（SEP-2549）は、静的で認可に依存しない `tools/list` と `prompts/list` にだけ `ServerOptions.cacheHints` で宣言する（`ttlMs` 24 時間 = クライアント側上限 `MAX_CACHE_TTL_MS`、`cacheScope: 'public'`。`src/server.ts` の `LIST_CACHE_HINTS`）。`tools/call` などの結果は SDK 既定（0 / private）のまま。2025 世代の応答にはこれらのフィールドは付かない（両方をツール層テストで検証: `test/tools/era_2026.test.ts` と `server.test.ts`）。
- **出力**: `outputSchema`（zod）を定義し、`structuredContent` と `content: [{type:'text', text: JSON.stringify(structuredContent)}]` の両方を返す。先頭フィールドは `summary`。第三者の文字列を出力に入れるツール（`symbol_network_info`・`symbol_node_status`・`symbol_account_get`・`symbol_voting_key_status`・`symbol_transaction_get`・`symbol_transaction_search`・`symbol_mosaic_get`・`symbol_namespace_get`・`symbol_fee_estimate`・`symbol_harvesting_status`・`symbol_harvesting_income`・`symbol_transaction_status`・`symbol_delegation_diagnose`・`symbol_node_health`・`symbol_version_drift`・`symbol_account_rank`・`symbol_holdings_value` の 17）は `untrustedText: true` を付け、末尾フィールドは `invisibleCharactersRemoved`（§2-8。`defineTool` が足す）。ほかの 5 ツール（`symbol_address_parse`・`symbol_finality_participation`・`symbol_time_convert`・`symbol_network_compare`・`symbol_harvester_watch`）は第三者が自由に書ける文字列を出さない。ツールを足すときは、出すなら付け、出さないなら付けない（全ツール横断のテストが両方向を検査する）。
- **outputSchema にフィールドを足すときは、マイナー版を上げてリリースノートに書く**: SDK が公開する outputSchema は `additionalProperties: false` で、クライアント SDK はキャッシュした `tools/list` の outputSchema で structuredContent を検証する（`@modelcontextprotocol/client` の `callTool`）。更新前の `tools/list` を持ち続けるクライアント（2026 世代の `tools/list` は最大 24 時間のキャッシュを許す）は、新しいフィールドを含む結果を検証エラーで拒否しうる。新しいフィールドを任意にしても古いスキーマが余分なフィールドを拒否するので防げない。リリースノートには「更新後は MCP ホストを再起動する」と書く。
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

**`symbol_transaction_status`**（0.2.0 で追加。ツール配列の末尾に登録し、既存の順序を変えない）— `transactionHashes`（64 桁 hex の配列、1〜20 件。1 件でも配列で受ける。空・21 件以上・hex 不正は `run` 内で検証して `isError`＋ヒント。重複は 1 件にまとめ、順序は入力どおり）。
答える問い: 「このハッシュのトランザクションは今どの状態か（確認済み / 未確認 / 署名待ち / 失敗）」。キー更新の link を送った直後の確認用。中身は `symbol_transaction_get`。
出力: `statuses[]` に各ハッシュの `{ hash, group: confirmed|unconfirmed|partial|failed|not_found, code, codeMeaning, height, deadline }`、`counts`、`note`。`code` が `Success` 以外のとき `codeMeaning` に意味を付ける。対応表 `src/domain/txstatus.ts` は OpenAPI `spec/core/transaction/schemas/TransactionStatusEnum.yml` の `enum` 一覧と `description` ブロックを機械的に取り込んだもの（説明の無い `Success` / `Neutral` / `Failure` / `Failure_Hash_Already_Exists` と列挙に無いコードは `codeMeaning: null`。記憶で補わない）。`height` は confirmed のときだけ、`deadline` は `epochAdjustment` で実時刻に変換。summary では partial に「署名待ち（aggregate bonded、cosignature 不足）」と添える。応答に含まれないハッシュと、バッチ全体の 404 は `not_found` として `isError` にしない。
参照: `POST /transactionStatus`（body `{ "hashes": [...] }`、`spec/request_bodies/schemas/transactionHashes.yml`）→ `TransactionStatusDTO[]`（`{ group, code?, hash, deadline, height? }`、group / hash / deadline が必須。`TransactionGroupEnum` = `unconfirmed | confirmed | partial | failed`）。ステータスは問い合わせたノードのものなので、アナウンスを受けたノードに聞くのが最も詳しい（OpenAPI の注記。`note` にも書く）。

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
- 残高の範囲（`balanceWithinLimits`）は `minHarvesterBalance <= 残高 <= maxHarvesterBalance`（harvestingMosaicId の残高。両端を含む）。上限を超えた分が切り捨てられるのではなく、**上限を超えるとハーベストできない**。catapult の `ImportanceView::canHarvest`（`client/catapult/src/catapult/cache_core/ImportanceView.cpp`）が importance が 0 でないことと両端の範囲を求め、`EligibleHarvesterValidator` はこれを満たさないハーベスターのブロックを `Failure_Core_Block_Harvester_Ineligible` で拒否する（テスト `FailureWhenBalanceIsAboveMaxBalance`）。さらに harvesting 拡張の `UnlockedAccountsUpdater::pruneUnlockedAccounts` が、次の高さで `canHarvest` を満たさない委任者をノードの解錠一覧から外す。`canHarvestHere` はこの範囲も含めて判定する。`symbol_delegation_diagnose` の `balance_in_range` と同じ規則。

**`symbol_network_compare`** — 引数なし（対象は `SYMBOL_REFERENCE_NODES`）。
自ノードと各参照ノードの高さ・ファイナライズ高さ、最大差分、`lagging: boolean`（差が10ブロック超）。参照ノード未設定なら、その旨と https://nodewatch.symbol.tools/ を案内する（エラーにしない）。

**`symbol_harvesting_income`**（0.2.0 で追加。ツール配列の末尾に登録し、既存の順序を変えない）— `account`（アドレスまたは公開鍵）、期間は `fromDate`/`toDate`（`YYYY-MM-DD`、両端含む。`SYMBOL_TIMEZONE` の日付、未指定なら UTC）または `fromHeight`/`toHeight` の**どちらか一方**（両方・どちらも無し・片方だけ・逆順・実在しない日付は `isError`）、`granularity`（`daily` 既定 / `monthly` / `receipt`）、`format`（JSON の詳細度。`receipt` 時の上限: concise 50 件 / detailed 500 件）、`output`（`json` 既定 / `csv`。text ブロックの形式。`format` とは独立）。
- 指定期間にそのアカウント宛に発生した Harvest_Fee（8515）レシートのうち、通貨モザイク（`/network/properties` の `currencyMosaicId`）のものだけを集計する。件数・合計は**サーバー内で BigInt により決定的に計算**し、divisibility 適用後の文字列と生の整数を両方返す。summary の数値もその文字列を埋め込む（LLM に計算させない、丸めない）。
- 日付→高さ: `/blocks/{h}` のタイムスタンプに対する二分探索（下限 1、上限 `/chain/info` の高さ）。from/to の探索は並行、それぞれ逐次なので同時リクエストは 2 本。
- 取得: `GET /statements/transaction?receiptType=8515&targetAddress=<base32>&fromHeight&toHeight&pageSize=100&order=asc&pageNumber=n` を 100 件未満のページが返るまで読む（クエリ名と DTO は symbol-openapi `spec/plugins/receipt/` で確認済み）。上限 200 ページ（20,000 ステートメント）を超えたら `truncated: true`、`truncationReasons: ['pageLimit']`、summary に「期間を狭めるか fromHeight/toHeight で分割」。`/statements/transaction` と `/blocks/*` はキャッシュしない。
- 分割取得と適応縮小（0.4.0 で追加。実ノードで 1 年分 ≒ 1,050,000 ブロックの 1 ページ目が 10 秒で返らず timeout、半年ずつなら各 17〜19 ページを返すことを観測。REST の MongoDB が「広い高さ範囲 × targetAddress」で遅く、2 ページ目以降は速い。タイムアウトは延長しない）: 高さ範囲を `splitHeightRange(from, to, chunkBlocks)`（昇順・重複なし・隙間なし）で約 `CHUNK_DAYS`（90）日分ずつに分け、**昇順に逐次**（同時リクエスト 1 本）読む。`chunkBlocks = blocksForDays(90, blockGenerationTargetTimeMs)` = `round(90 × 86,400,000 / blockTime)`（mainnet 259,200）。90 と 7 はポリシー定数（`CHUNK_DAYS` / `MIN_CHUNK_DAYS`）で、ブロック数は焼かない。`pageNumber` はチャンクごとに 1 から、上限 200 ページは**全チャンク合計**（timeout した試行は数えない）。チャンクの **1 ページ目**が `RestError(kind: 'timeout')` なら `shrinkChunkBlocks(len, minChunkBlocks)` = `max(ceil(len / 2), min)` で、その高さから終端までを分割し直して先頭から再試行する（縮めた長さは同じ呼び出しの残りに引き継ぐので、無駄な timeout は 1 呼び出しで最大 4 回: 259,200 → 129,600 → 64,800 → 32,400 → 20,160）。長さが `minChunkBlocks`（約 7 日分）以下の範囲が timeout したら `isError`（ホスト・失敗した高さ範囲・ブロック数・現在のタイムアウト値・「fromHeight/toHeight で狭めるか `SYMBOL_REQUEST_TIMEOUT_MS` を上げる」）。2 ページ目以降の timeout と timeout 以外の RestError は従来どおりそのまま失敗（隠さない、再試行しない）。部分合計は返さない。出力に常時 `fetch { chunks（読み切ったチャンク数）, chunkBlocks（導出した初期値）, splitRetries, pagesFetched }`（トップレベルの `pagesFetched` / `statementsFetched` は互換のため残す）、`notes` に分割の 1 行、`splitRetries > 0` のとき summary の末尾に `(the node timed out on N wide queries; retried with smaller chunks)`。集計結果（totals / daily / monthly / receipts / csv、高さ昇順）は分割しても同一。純粋関数は `src/domain/harvesting.ts`、取得は同ツールの `fetchHarvestStatements`。`symbol_delegation_diagnose` の `recent_harvest` は最大 30 日・独自ループなので対象外。
- 分類（harvester / beneficiary / unknown）: 1 ブロックの 8515 レシートは harvester・beneficiary・ネットワークの 3 件が常に別レシートで（ハーベスターと beneficiary が同一アカウントでも 2 件別々。mainnet 実データで確認済み）、返却順は金額順ではない。同一ステートメント内の 8515 を amount 降順に並べ、`harvestBeneficiaryPercentage`(B) と `harvestNetworkPercentage`(N) から導いた (100-B-N):B:N（3 件）または (100-N):N（2 件、beneficiary 未設定のブロック）と各金額が合計の ±1 ポイント以内で一致すれば、最大 = harvester、2 番目（3 件時）= beneficiary。一致しなければそのステートメントの受取分は `unknown`（集計には含め、`unknownStatements` と summary に件数を出す）。比率をコードに焼かない。
- 出力: `summary`、`period`（種別・日付・使用タイムゾーン）、`range`（fromHeight/toHeight と両端ブロックの日時）、`totals` と `daily[]`（`SYMBOL_TIMEZONE` の日付境界でバケット）または `receipts[]`、各行に harvester / beneficiary / unknown の内訳（`xym*` と `raw*`）、`truncated`、`notes`（「ハーベストは確率的で日ごとの変動が大きい」「為替換算は含まない」）。
- 参照: `GET /statements/transaction`（TransactionStatementPage → `statement.receipts[]` の BalanceChangeReceiptDTO `{ type, mosaicId, amount, targetAddress }`、`meta.timestamp` はブロックのネットワークタイムスタンプ）、`GET /blocks/{height}`、`GET /chain/info`、`GET /accounts/{id}`。レシート種別の名前表は catbuffer `receipt_type.cats` から取り込む（`src/domain/receipttype.ts`）。
- `granularity: monthly`（0.2.0 で追加）: `SYMBOL_TIMEZONE`（未指定なら UTC）の暦月でバケットし `monthly[]`（`{ month: 'YYYY-MM', ...daily と同じ列 }`、月キー昇順）を返す。`src/domain/harvesting.ts` で日次と同じ BigInt 経路・同じ日付キー（先頭 7 文字）で集計するので「月合計 = その月の日次合計」が構造的に成り立つ（単体テストで固定値検証）。summary は**先頭の期間合計 1 行を維持したまま**、その後に月ごとに 1 行（`2026-08: 674 receipts, 23,237.845492 symbol.xym (317 harvester / 357 beneficiary)`。桁区切りは summary だけ）。行数は月数なので切り詰めない。daily / receipt の出力形は不変。
- `output: csv`（0.2.0 で追加）: **§2-4「text は structuredContent の JSON 文字列」の明示的な例外**。`structuredContent` は JSON のまま（outputSchema を満たす）で `csv: string`（json のときは null）を持ち、`content[0].text` は CSV 本文そのもの（`_shared.ts` の `renderText` フック。他ツールは JSON のまま）。行は granularity に従う（daily → 1 日 1 行、monthly → 1 か月 1 行、receipt → 1 レシート 1 行で `format` の上限 50 / 500 を適用、切り詰めは summary に書く）。列: daily / monthly は `period,receipts,xym,raw,receipts_harvester,xym_harvester,raw_harvester,receipts_beneficiary,xym_beneficiary,raw_beneficiary,receipts_unknown,xym_unknown,raw_unknown`、receipt は `height,timestamp_utc,timestamp_local,kind,xym,raw`（`timestamp_local` は `SYMBOL_TIMEZONE` 未設定なら空）。ヘッダ行あり、LF 改行（最終行の後も）、UTF-8、BOM なし、合計行なし、桁区切りなし。値は数値と ISO 日時だけだが RFC 4180 の引用処理（`src/domain/csv.ts`）を必ず通す。

**`symbol_finality_participation`**（0.2.0 で追加。ツール配列の末尾に登録し、既存の順序を変えない）— `account`（アドレスまたは公開鍵）、`epoch`（任意。未指定なら `/chain/info` の `latestFinalizedBlock.finalizationEpoch`）、`epochs`（1〜20、既定 1。`epoch` から過去に向かって連続 N エポック。取得は並行で、同時リクエストは RestClient の上限 4 に収まる）、`format`（concise は `participated` のエポックで `stages` を省略、detailed は全エポックに含める）。
答える問い: 「このアカウントの投票鍵は、指定エポックのファイナリティ投票に実際に参加したか」。キー更新後の検証（新キーで投票できているか）と、月次の Voting ノード健全性確認に使う。`symbol_voting_key_status` は「いつ失効するか」、このツールは「実際に使われているか」。
- 確認済み事項（2026-09-13、mainnet epoch 4010 の実 proof を人間が確認）: `GET /finalization/proof/epoch/{epoch}` の応答は `{ version, finalizationEpoch, finalizationPoint, height, hash, messageGroups: [{ stage, height, hashes[], signatures: [{ root: {parentPublicKey, signature}, bottom: {parentPublicKey, signature} }] }] }`。messageGroups は 2 件（stage 1 = precommit、stage 0 = prevote）、各 17 署名。**アカウントに登録された voting 公開鍵は `signatures[].root.parentPublicKey` と完全一致し、`bottom.parentPublicKey`（中間鍵）には現れない**。したがって参加判定は「root 鍵の集合に登録鍵が含まれるか」。stage の意味は OpenAPI v1.0.4 の `StageEnum`（0 = Prevote、1 = Precommit、2 = Count）で確認済み。署名数 17 に対し nodewatch 上の Voting ノードは 18 だったので、この差分（不参加ノード）の検出が目的の 1 つ。
- 確認済み事項（2026-09-21、mainnet epoch 4027 の実 proof を人間が確認。0.5.0 で修正）: **messageGroups は「ステージごとに 1 件」とは限らない。同一ステージ・同一高さで複数グループに分かれることがある**（投票先ハッシュ一覧の違い。epoch 4027 は 3 件: stage 1 ×1、stage 0 が同じ高さ 5796428 に署名 2 本と 15 本の 2 グループ、合計 17）。1 人の投票者の鍵はそのうち 1 グループにしか現れないので、**判定はグループ単位ではなくステージ単位**: messageGroups を stage でまとめ、そのステージの全グループの root 鍵の和集合に登録鍵があれば署名済み。0.4.0 までの「全グループに自鍵があるか」は、このような proof で正しく投票したアカウントを missed と誤判定し、summary も「signed prevote and precommit only, not prevote」と矛盾した。
- 処理: `/accounts/{id}` の voting 鍵一覧と `/chain/info` を並行取得 → 対象エポックごとに proof を `getOrNull` で取得（404 は `status: 'unavailable'` にして `isError` にしない。全エポックが 404 のときだけ `isError`＋ヒント。要求エポックが最新確定エポックより大きいときはヒントに「proof は確定済みエポックにしか無い」と書く。proof の `finalizationEpoch` が要求と違えば `invalid_response`）→ messageGroups ごとに root 鍵集合を作り登録鍵と照合 → そのエポックで有効であるべき鍵（startEpoch ≤ e ≤ endEpoch）の有無を別途判定。判定は `src/domain/finality.ts` の純粋関数。
- 判定: **proof に存在する全ステージ**で一致（ステージ内のどのグループでもよい）→ `participated`（proof の署名は現在の鍵一覧より優先。既に unlink した鍵の署名でも participated）。一致しないステージがあり有効鍵あり → `missed`。署名したステージの列挙は `describeSignedStages`（`src/domain/finality.ts`。ツールの summary と CLI check の detail が共用）: 全部 → `signed prevote and precommit`、一部 → `signed prevote, not precommit`、無し → `signed no stage (not prevote, not precommit)`。ステージ名は 1 回ずつしか出ないので矛盾した文にならない。summary のエポック行は `Epoch N: participated, signed prevote and precommit (prevote 17 signatures in 2 groups, precommit 17 signatures; …)`（グループが 1 つなら `in N groups` は付けない）。有効鍵なし → `no_active_key`。proof なし → `unavailable`。
- 出力: `summary`、`account: { address, publicKey, votingKeys[{ publicKey, startEpoch, endEpoch, activeForEpoch }] }`、`current`、`requested`、`epochs[{ epoch, status, finalizationPoint, height, proofHash, stages[{ stage, stageName, height, heights[], groups, signatureCount, participated, matchedPublicKey }], participatedAllStages }]`（新しいエポックが先頭。`stages[]` は**ステージごとに 1 要素**で、`groups` = そのステージのメッセージグループ数、`heights` = グループの高さ（重複なし昇順）、`height` = その最小値（グループが 1 つなら従来と同じ値）、`signatureCount` = そのステージの全グループの署名数の合計）、`totals { checked, participated, missed, noActiveKey, unavailable }`、`warning`（「今」投票できるかの警告で、判定は現在の finalizationEpoch 基準。現在の finalizationEpoch をカバーする鍵が無い → 参加不能の警告（要求エポックに関係なく判定）／先頭の要求エポックが現在の finalizationEpoch と一致し missed → 投票していない警告／それ以外は null。過去エポックの `no_active_key` / `missed` は `epochs[].status` に留める。歴史的エポックに鍵が無いのは正常）、`notes`（`signatureCount` は署名した投票者数で、登録ノード総数はこのサーバーからは分からない／`unavailable` は投票の有無を意味しない）。**他ノードの公開鍵は出力しない**。
- フィクスチャ: 実 proof の全 `parentPublicKey`・`signature`・`hashes`・`hash` を `H("fixture:…")` 由来の合成値に置換した `test/fixtures/mainnet/finalization-proof-epoch.json`（規則は `test/fixtures/README.md`）。自アカウントの root 鍵は既存の合成 voting 鍵 `H("fixture:voting-key-2")`（epoch 3700〜4059、4010 を含む）。epoch / point / height / stage / 署名数 17 / hashes 21 件は実値のまま。生ファイルの値はリポジトリに書かない。
- 参照: `GET /finalization/proof/epoch/{epoch}` → `FinalizationProofDTO`（`MessageGroup` → `BmTreeSignature` → `ParentPublicKeySignaturePair`、OpenAPI v1.0.4 で確認）、`GET /accounts/{id}`、`GET /chain/info`。

**`symbol_delegation_diagnose`**（0.2.0 で追加。ツール配列の末尾に登録し、既存の順序を変えない）— `account`（アドレスまたは公開鍵。メインアカウントを渡す）、`recentDays`（1〜30、既定 7。直近のハーベスト実績を探す日数）、`format`（concise は ok のチェックの `hint` を null、detailed は全チェックに `hint`）。
答える問い: 「このアカウントの委任ハーベストは有効か。無効ならどこで止まっているか」。委任者が自分のアカウントを、ノード運用者が委任者のアカウントを診断する（Harvest Checker / XEMBook の委任状況確認に相当）。`symbol_harvesting_status` は「ノードの解錠一覧に含まれるか」だけ、`symbol_harvesting_income` は報酬の集計だけ。
- **検証範囲の原則**: 通信できるのは `SYMBOL_NODE_URL` だけなので、ノード側の状態（解錠・委任要求）は**設定済みノードに委任している場合だけ**確認できる。アカウントの node 鍵が `/node/info` の `nodePublicKey` と違えば、ノード側チェックは `unknown` にして「委任先ノードが設定済みノードと異なるため確認できない」と書く。他ノードには問い合わせない。
- 閾値はすべて `/network/properties` から取る: `minHarvesterBalance` / `maxHarvesterBalance`（**`chain.harvestingMosaicId` の残高で比較**。OpenAPI `ChainPropertiesDTO` に「Mosaic id used to provide harvesting ability」として存在。mainnet / testnet では `currencyMosaicId` と同じ値だがハーベスト要件は harvestingMosaicId で定義されている。パーサは必須扱いなので、空値のときだけ currencyMosaicId にフォールバック）、`importanceGrouping`、`harvestBeneficiaryPercentage` / `harvestNetworkPercentage`（レシート分類）。
- チェック（`checks[]` 固定順、各 `{ id, status: ok|warn|fail|unknown, detail, hint }`）:
  1. `account_exists` — `/accounts/{id}` が 404 なら fail。以降は全部 unknown、`recentHarvest: null`、`isError` にはしない。
  2. `balance_in_range` — 未満 fail、超過 fail（maxHarvesterBalance を超えるとハーベストできない）。
  3. `importance_positive` — `importance > 0` で ok。0 かつ残高 ok → warn（次の再計算高さ `(floor(h / G) + 1) × G` と残りブロック数を hint に。`src/domain/delegation.ts`）。0 かつ残高 fail → fail。
  4. `linked_key` / 5. `vrf_key` / 6. `node_key` — `supplementalPublicKeys` の有無。無ければ fail（AccountKeyLink / VrfKeyLink / NodeKeyLink を案内）。
  7. `node_key_matches_configured_node` — `/node/info` の `nodePublicKey`（OpenAPI `NodeInfoDTO` では optional）と一致 ok、不一致 warn、node 鍵なし／`nodePublicKey` 無しは unknown。
  8. `unlocked_on_node` — 7 が ok のときだけ判定。`/node/unlockedaccount`（`unlockedAccount`、単数）に linked 鍵があれば ok、無ければ fail（未受理・再起動後の再送・解錠枠満杯。運用者に確認）。7 が warn/unknown、または `/node/unlockedaccount` が失敗（5xx でも他のチェックは返す）なら unknown。
  9. `account_type` — `accountType` が 1（OpenAPI `AccountTypeEnum`: balance-holding account linked to a remote harvester = Main）なら ok。2 / 3（Remote 系）は warn「メインアカウントを指定」、0 も warn。
  10. `recent_harvest` — 直近 `recentDays` 日の HarvestFee（8515）レシート。期間→高さは実測平均ブロック時間（`getAverageBlockTime`）からの推定（`notes` に明記。二分探索を使わないのはリクエスト数のため）。`/statements/transaction?...&order=desc` を 100 件ページで最大 20 ページ。`classifyHarvestReceipts` で分類し **harvester と unknown だけ数える**（beneficiary は他人がハーベストした証拠なので除外）。1 件以上 ok、0 件で fail が無ければ warn（「有効だが直近 N 日は当たっていない。importance が小さいと間隔が空く」）、0 件で fail があれば unknown。`recentHarvest { days, receipts, lastHeight, lastTime }`。
  11. `delegation_request_found` — 委任要求トランザクションの有無。出典を確認したうえで実装（推測で書かない）: catapult `plugins/txes/transfer/src/plugins/TransferPlugin.cpp` は `CreateTransferMessageObserver(0xE201735761802AFE, recipient, …)` を登録し、`recipient = PublicKeyToAddress(encryptionPublicKey)`（node.key.pem = REST の `nodePublicKey`）。`observers/TransferMessageObserver.cpp` は先頭 8 バイトを LE uint64 として比較し `MessageSize > 8` を要求する。SDK `sdk/javascript/src/symbol/MessageEncoder.js` の `DELEGATION_MARKER = 'FE2A8061577301E2'` と同じ。定数は `src/domain/message.ts` の `PERSISTENT_DELEGATION_MARKER`（出典コメント付き）。処理: `GET /transactions/confirmed?signerPublicKey=<pk>&recipientAddress=<publicKeyToAddress(nodePublicKey)>&type=16724&pageSize=100&order=desc&pageNumber=1`（`embedded` は既定 false なので内包 Tx は対象外）から `message` がマーカーで始まる最新 1 件。見つかれば ok（高さ・日時）、無ければ warn（情報のみ。verdict には影響しない）。7 が warn/unknown、公開鍵ゼロ、`nodePublicKey` 無しは unknown。
- verdict: いずれかの fail → `not_active`。fail なしで unknown を含む → `cannot_verify`。それ以外 → `active`（`recent_harvest` / `delegation_request_found` が warn でも active）。
- 出力: `summary`（1 行目 `delegated harvesting: active | not active | cannot verify (<address>).`、以降に fail / warn の要点と、cannot_verify なら確認できなかった項目）、`network`、`address`、`verdict`、`checks[]`、`account { balanceXym, rawBalance, importance, importanceHeight, accountType { code, name }, keys { linked, vrf, node } }`（鍵は hex または null）、`node { configuredNodePublicKey, unlockedCount }`（取れなければ null）、`recentHarvest | null`、`notes[]`（unlockedaccount は自己申告でチェーンで裏付けられない／他ノードへの委任は確認できない／importance は importanceGrouping ごとに更新／期間の高さは推定）。
- 参照: `GET /accounts/{id}`、`GET /chain/info`、`GET /node/info`（`nodePublicKey`）、`GET /node/unlockedaccount`、`GET /statements/transaction`、`GET /transactions/confirmed`（`signerPublicKey` / `recipientAddress` / `type` / `order` / `pageSize` / `pageNumber` は OpenAPI で確認）、`GET /blocks/{h}`（平均ブロック時間）。

**`symbol_node_health`**（0.3.0 で追加。ツール配列の末尾に登録し、既存の順序を変えない）— `format` のみ。account 引数なし。
答える問い: 「設定済みノードは今、健全に動いているか（DB / API ノード / ストレージ / 時刻 / ファイナリティ遅延）」。`symbol_node_status`（バージョン・同期・ピア数）を置き換えず補完する。OS 移行の前後で最初に見るツール。
- 取得（並行。RestClient のセマフォ 4 で直列化）: `GET /node/health`、`GET /node/storage`、`GET /node/time`、`GET /chain/info`、`GET /node/info`、`ctx.getNetworkData()`。DTO は OpenAPI v1.0.4（`spec/core/node/schemas/`）で確認済み: `NodeHealthInfoDTO { status: { apiNode, db } }`（`NodeStatusEnum` = `up` / `down`。**どちらかが down のとき HTTP 503 で同じ body を返す**ので `RestClient.get(path, schema, { acceptStatuses: [503] })` で本文を読む）／`StorageInfoDTO { numBlocks, numTransactions, numAccounts }`（integer、required）／`NodeTimeDTO { communicationTimestamps: { sendTimestamp?, receiveTimestamp? } }`（`Timestamp` は nemesis 起点 ms の**文字列**、両方 optional。send 優先）。スキーマは `src/client/schemas.ts` の `NodeStorageSchema` / `NodeTimeSchema`。
- 各エンドポイントは `settle` で個別に失敗を受け、取れた分だけで答える（`ctx.getNetworkData()` だけ致命。閾値の元）。`/node/health` 自体が失敗（timeout / unreachable / 503 以外の http / invalid）なら `api_node` と `db` を fail にする。
- チェック（固定順、各 `{ id, status: ok|warn|fail|unknown, detail, hint }`。`src/tools/_checks.ts` の共通 `CheckSchema` / `check()` / `stripOkHints()`）:
  1. `api_node` — `status.apiNode === 'up'` で ok、それ以外 fail
  2. `db` — `status.db === 'up'` で ok、それ以外 fail
  3. `storage_consistent` — `|numBlocks − height|` が `max(1, ceil(60000 / blockGenerationTargetTime))` ブロック以内（「1 分相当」。mainnet 30 s → 2）なら ok、超えれば warn。`/node/storage` か `/chain/info` が取れなければ unknown
  4. `clock_skew` — `/node/time` の send タイムスタンプを `epochAdjustment` で UTC にして `ctx.now()` と比較。|skew| < blockTime/2 → ok、< blockTime → warn、それ以上 → fail（hint: 時計ずれはハーベスト失敗・Tx deadline 不正の原因、NTP を確認、端末側がずれている可能性）。取れない・タイムスタンプ欠落は unknown
  5. `finalization_lag` — `height − latestFinalizedBlock.height`（ブロック数と、blockTime 換算の分）。`< votingSetGrouping / 2` → ok、`< votingSetGrouping` → warn、それ以上 → fail
  6. `roles` — `decodeRoles` で名前解決し、Voting 役割の有無を detail に（判定は ok 固定）。`/node/info` が取れなければ unknown
- verdict（`src/domain/nodehealth.ts` の `deriveHealthVerdict`）: fail あり → `unhealthy`、**warn または unknown あり → `degraded`**（取れなかった項目を健全とみなさない）、全部 ok → `healthy`。
- 出力（先頭 summary）: `summary`（1 行目 `node health: healthy | degraded | unhealthy (<host>, <network>).`、以降 ok 以外を 1 行ずつ）/ `network` / `verdict` / `checks[]` / `node: nullable({ version, roles[], publicKey })` / `storage: nullable({ numBlocks, numTransactions, numAccounts })` / `chain: nullable({ height, finalizedHeight, finalizationEpoch })` / `time { nodeTime: nullable(Instant), localTime: Instant, skewMs: nullable }` / `notes[]`（clock_skew はこのサーバーを動かしている端末の時計との比較でリクエスト遅延を含む、端末側がずれている可能性／storage の数値はノード DB 由来でチェーンで裏付けられない／閾値の導出元）。
- 閾値の純粋関数は `src/domain/nodehealth.ts`（`storageToleranceBlocks` / `assessStorage` / `computeClockSkewMs` / `skewThresholds` / `assessClockSkew` / `assessFinalizationLag` / `deriveHealthVerdict`）。定数を焼かない。
- 参照: `GET /node/health`、`GET /node/storage`、`GET /node/time`、`GET /chain/info`、`GET /node/info`。

**`symbol_version_drift`**（0.3.0 で追加。ツール配列の末尾に登録し、既存の順序を変えない）— `format` のみ。
答える問い: 「設定済みノードのバージョンは、ネットワークの多数派から取り残されていないか」。多数派から遅れると他ノードから接続を拒否されるので、OS 移行後の最重要確認項目。
- 取得: `GET /node/info`（自ノード。`decodeVersion`。失敗は致命）、`GET /node/server`（`ServerInfoDTO { serverInfo: { restVersion, sdkVersion, deployment } }`。v1.0.4 は `sdkVersion` を required にしながら property 定義が無く、古い catapult-rest には `deployment` が無いので `restVersion` 以外は optional + loose。失敗は `restVersion: null`）、`GET /node/peers`（`NodeInfoDTO[]`。`NodePeersRawSchema` で配列として受け、要素ごとに `NodePeerSchema.safeParse`。壊れた要素・別 `networkGenerationHashSeed`・自ノードの `publicKey` は `ignored` に数えて除外。失敗はピア 0 件＋note）、`SYMBOL_REFERENCE_NODES` があれば `ctx.referenceClients()` 各 `/node/info`（`symbol_network_compare` の `probe` と同じ try/catch。到達不能と別ネットワークは除外して note）。
- 集計（`src/domain/version.ts`）: `compareVersions` は成分ごとの数値比較（欠けは 0。`1.0.3.10 > 1.0.3.9`、`2.10.0 > 2.4.4`。文字列比較しない）。`versionDistribution` は count 降順 → version 降順（**同数のときは新しい版を多数派とする**: 移行期には新しい方に収束するので warn 側に倒す）。`newerShare` = 自ノードより新しい版の割合。
- verdict（`deriveVersionDriftVerdict`）: size 0 → `unknown`（hint: ピア接続自体の問題。`symbol_node_health` / `symbol_node_status` を見る、または `SYMBOL_REFERENCE_NODES`）／`newerShare ≥ 0.75`（`FAR_BEHIND_SHARE`）→ `far_behind`（「接続を拒否され始める可能性」）／`own < majority` **または** `newerShare ≥ 0.5`（`BEHIND_SHARE`。自ノードが最頻値でも新しい版の合計が過半なら取り残されつつある）→ `behind`／それ以外 `ok`（多数派より新しい場合も ok）。閾値はポリシー定数で、ネットワーク定数ではない。
- 出力（先頭 summary）: `summary` / `network` / `verdict` / `node { version, versionRaw, restVersion: nullable }` / `sample { size, source: 'peers' | 'peers+reference', peers, referenceNodes, ignored }` / `distribution [{ version, count, share }]` / `majorityVersion: nullable` / `newerShare: nullable` / `farBehindShare` / `notes[]`（サンプルは自ノードが知っているピアの一部で全体像は nodewatch／ピアの host・friendlyName・publicKey は untrusted で**出力しない**（version と数だけ）／除外規則）。
- 参照: `GET /node/info`、`GET /node/server`、`GET /node/peers`、参照ノードの `GET /node/info`。

**`symbol_harvester_watch`**（0.3.0 で追加。ツール配列の末尾に登録し、既存の順序を変えない）— `mode`（`compare` = 読むだけ / `compare_and_save` = 既定、比較して今回分を追記 / `save_only` = 比較せず追記）、`format`（detailed は `current.keys` と `history.entries` を出す）。
答える問い: 「設定済みノードで解錠されている委任ハーベスターは、前回と比べて増えたか減ったか」。OS 移行後に「委任者が戻ったか」を確認する用途と、月次の churn 監視。`symbol_harvesting_status` は現在の一覧だけ。
- ローカル状態ファイル（§2-9）: `SYMBOL_STATE_DIR` 配下の `harvesters-<nodePublicKey 先頭 16 hex>.json`。`{ version: 1, nodePublicKey, snapshots: [{ takenAt: ISO(UTC), height, keys: string[] }] }`。`keys` は `/node/unlockedaccount` のリモート公開鍵を大文字 hex・重複除去・昇順。`snapshots` は新しい順、保存時に 60 件（`MAX_SNAPSHOTS`）に切り詰め。純粋ロジック（`SnapshotSchema` / `HarvesterStateSchema` / `normalizeKeys` / `diffKeys` / `historyStats` / `trimSnapshots` / `stateFileName` / `assertInsideDir` / `resolveStateFile`）は `src/domain/harvesterwatch.ts`、fs I/O（`readSnapshotFile` / `writeSnapshotFileAtomic` / `StateFileError`）は `src/state/snapshotfile.ts`。
- 書き込み規則: `path.resolve` で正規化し `assertInsideDir` でディレクトリ外（`..`、別絶対パス、`/a/b` vs `/a/bb`）を拒否。ディレクトリが無ければ `mkdir -p` mode 0o700（既存の mode は変えない）。同ディレクトリの一時ファイル（`<file>.tmp-<pid>-<random>`、`wx`、mode 0o600）に書いて `rename`（POSIX ではアトミック。既存の symlink はエントリごと置換されるので symlink 越しに書かない）。読み込みは `lstat` で通常ファイル以外（symlink・dir）を corrupt 扱い。読み込みは throw しない。
- 処理: `GET /node/info`（`nodePublicKey` 無し → isError＋ヒント。何も読まず書かない）、`GET /node/unlockedaccount`、`GET /chain/info` を並行取得 → `SYMBOL_STATE_DIR` 未設定なら current だけ（`comparison` / `history` / `stateFile` は null、`saved: false`、notes に設定方法）→ ファイルを読む（無し = baseline。壊れている・通常ファイルでない・別ノード鍵は notes に理由を書いて baseline 扱い、保存モードなら上書き）→ compare / compare_and_save では直前スナップショットとの差分（`added` / `removed` 昇順、`unchangedCount`、`deltaCount`）と、**保存前の**スナップショットに対する 30 日窓の統計（compare と compare_and_save が同じ数字を返す。save_only は null）→ 保存モードなら先頭に今回分を足して切り詰め、書く。書込失敗は compare_and_save では `saved: false`＋note（比較結果が答え）、save_only では isError（`describeError` の `StateFileError` 分岐）。
- 出力（先頭 summary）: `summary` / `network` / `mode` / `node { host, publicKey }` / `current { count, takenAt: Instant, height, keys: nullable }` / `comparison: nullable({ previousTakenAt, previousHeight, previousCount, added[], removed[], unchangedCount, deltaCount })` / `history: nullable({ snapshots, oldestTakenAt, min, max, average, entries: nullable })` / `saved` / `stateFile: nullable(絶対パス)` / `notes[]`（`/node/unlockedaccount` は自己申告でチェーンの裏付けなし／鍵はリモート鍵で委任者本体は特定できない／再起動直後は一時的に 0 になりうる／状況別）。summary 例: `18 unlocked harvesters on <host> (was 15 on <instant>): +4 -1. Snapshot saved (7 stored).`／`… No previous snapshot; baseline saved (1 stored).`／`… SYMBOL_STATE_DIR is not set, so no comparison.`／`… Previous snapshot unusable; baseline saved (1 stored).`／`… baseline NOT saved (EACCES).`
- ノード鍵（node.key.pem）が移行で変わるとファイル名も変わり新しい baseline になる。委任者は新鍵に再リンクするので「戻ったか」はその baseline の伸びで見る（README Limitations に明記）。
- 参照: `GET /node/info`（`nodePublicKey`）、`GET /node/unlockedaccount`（`UnlockedAccountDTO`）、`GET /chain/info`。

**`symbol_account_rank`**（0.6.0 で追加。ツール配列の末尾に登録し、既存の順序を変えない）— `account`（任意。アドレス・公開鍵・ネームスペース名。省略時は順位を出さず上位一覧だけ）、`mosaic`（任意。16 桁 hex id かエイリアス名。既定は `/network/properties` の `currencyMosaicId`。解決は `src/tools/_mosaics.ts` の `resolveMosaicInput`＝`symbol_mosaic_get` から切り出した同じ経路）、`top`（1〜100、既定 20）、`maxRank`（100〜5000、既定 1000）、`format`（JSON は同一。detailed は summary に上位 1 件 1 行を追加）。
答える問い: 「このアカウントは XYM（または任意のモザイク）の保有量で何番目か」「上位 N 件は誰でどれだけ持っているか」。エクスプローラのリッチリストに相当。
- OpenAPI（v1.0.4、2026-09-22 に確認）: `GET /accounts` の `orderBy` は `AccountOrderByEnum` = **`id` / `balance` のみ**（`balance` のときは `mosaicId` フィルタ必須）。`importance` 順は無いので `by` 引数は作らず、固定 notes に「importance 順は REST が対応していない」と書く。`pageSize` は 10〜100（既定 10）、`pageNumber` は 1 以上。応答 `AccountPage { data: AccountInfoDTO[], pagination }`（`src/client/schemas.ts` の `AccountPageSchema`）。供給量は `GET /mosaics/{id}` の `MosaicDTO.supply`（`Amount`、生の整数文字列）。
- 処理: `ctx.getNetworkData()` → モザイク解決（既定は currency の id / alias / divisibility と `GET /mosaics/{id}` の供給量を毎回取得。キャッシュしない）→ `account` があれば `fetchAccount`（`GET /accounts/{id}`。残高はここから、順位は走査から。404 は既存のヒント付き `isError`）→ `GET /accounts?mosaicId=&orderBy=balance&order=desc&pageSize=100&pageNumber=n` を 1 ページ目から**逐次**（同時リクエスト 1 本）。停止条件: address（hex）が一致 → `rank = (n-1)×100 + index + 1`、`rankBeyond: null`／`ceil(maxRank/100)` ページまで無ければ `rank: null`、`rankBeyond: maxRank`／100 件未満のページで一覧が尽きた、または残高が 0 なら `rank: null`、`rankBeyond: null`（残高 0 は 1 ページ目で止める）。account が無ければ 1 ページ目だけ。各ページの `RestError` はそのまま失敗（隠さない、部分結果を返さない）。
- 計算（`src/domain/rank.ts`、純粋関数）: `mosaicBalanceOf`（`mosaics[]` から id 一致、無ければ 0n）、`rankOf`、`pagesToScan`、`percentOfSupply(part, total)` = `(part × 100 × 10^4 + total/2) / total` を BigInt で計算して小数 4 桁の文字列（四捨五入、浮動小数を使わない。total が 0 なら null）。上位 N 件の合計割合は残高の BigInt 和から同じ関数で求める（丸めた割合の和ではない）。`HOLDER_PAGE_SIZE = 100` は REST 上限に合わせたポリシー定数。
- 出力（先頭 summary）: `summary` / `network` / `accountResolution`（共通規約どおりトップレベル）/ `mosaic { id, alias, divisibility, supply, supplyRaw }` / `account: nullable({ address, rank, rankBeyond, balance, balanceRaw, sharePercent })` / `topHolders[{ rank, address, balance, balanceRaw, sharePercent }]` / `topHoldersSharePercent` / `fetch { pagesFetched, accountsScanned }` / `notes[]`。summary は `<address> holds 4,321,000.000000 symbol.xym (0.0551% of supply), rank 157 by symbol.xym balance.` ＋ `Top 20 symbol.xym holders own 1.1392% of supply (… in circulation).`（桁区切りは summary だけ。割合は JSON と同じ 4 桁の文字列を埋め込む）。rank null のときは `… but is not within the top 1,000 holders; raise maxRank (up to 5,000) to look further.`。
- 固定 notes: 上位はしばしば取引所・カストディアン・財団でツールはラベルを付けない／順位はこのモザイクの残高順で importance 順ではない（REST に importance 順は無い）／同額のアカウントの順序はノード依存／アドレスは公開情報だが他人のアドレスを外部に貼る前に用途を考える。状況別: 残高は `/accounts/{id}`、順位は一覧からで数ブロックずれうる／maxRank で打ち切った／一覧の総件数。
- 他人のアドレスは `topHolders` にそのまま出す（公開情報、マスクしない）。`AccountInfoDTO` に friendlyName のような自由文字列は無い。エイリアス名は `resolveMosaicAliases` で sanitize 済み。
- テスト: 単体 `test/unit/rank.test.ts`。ツール層 `test/tools/account_rank.test.ts`（ハーネスの `syntheticHolders`: 300 行、残高降順、`H("fixture:holder-NNN")` 由来の合成アドレス、157 行目がメインアカウント → rank 157 / 上位 20 件と合計割合の固定文字列 / account なし / maxRank 100 で rankBeyond 100 / 一覧に無い口座は末尾まで読む / 残高 0 / 別モザイク hex とエイリアス名 / ネームスペース名 / `/accounts` 500 で isError / `SYMBOL_NODE_URL` 以外に fetch しない / outputSchema）、`account_resolution.test.ts` の共通契約、両世代スモーク（account なし、top 5）。
- 参照: `GET /accounts`（`searchAccounts`。`mosaicId` / `orderBy` / `order` / `pageSize` / `pageNumber`）、`GET /mosaics/{mosaicId}`、`GET /accounts/{accountId}`、`GET /network/properties`。

**`symbol_holdings_value`**（0.7.0 で追加。ツール配列の末尾に登録し、既存の順序を変えない）— `account`（必須。アドレス・公開鍵・ネームスペース名）、`unitPrice`（必須。**文字列**。10 進表記の正の数、小数点以下最大 12 桁。指数表記・カンマ・通貨記号・符号・`12.`・`.5`・空・0 は `run` 内で検証して `isError`＋ヒント。zod の `.min(1)` や regex に任せると SDK の汎用メッセージになりヒントが付かないので schema は `z.string()` のまま）、`currency`（必須。`^[A-Z]{3,6}$`。同じく `run` 内で検証）、`priceSource`（任意。最大 80 文字。untrusted として `sanitizeUntrusted` を通して echo）、`priceAsOf`（任意。最大 40 文字。sanitize 後に `Date.parse` が通ることだけ検証し、入力どおりに echo。ISO 8601 の厳密な正規表現は入れない）、`mosaic`（任意。hex id かエイリアス名。既定は通貨モザイク。`resolveMosaicInput` を再利用し、通貨モザイクなら追加リクエストなし）、`decimals`（任意。0〜12 の整数。`amount` を丸める桁。schema は `z.number()` のままで `run` 内で検証して `isError`＋ヒント）、`format`（JSON は同一。detailed は、丸めたときだけ summary に丸め前の値の 1 行を追加）。
答える問い: 「このアカウントの保有 XYM は、単価 X 円のとき合計いくらか」。**単価は呼び出し側が与える。**
- **価格を扱わないという原則と、この設計がそれを守る理由。** §2-7 の「外部通信は `SYMBOL_NODE_URL` と `SYMBOL_REFERENCE_NODES` のみ」は、価格 API を叩けば破れる。価格は変動し、出所ごとに値が違い、取引所 API には利用規約や鍵があり、どれを信じるかはユーザーの判断で、サーバーが「正しい価格」を持つことはできない。そこでこのツールは価格を**入力**として受け、掛け算だけを行う。単価の出所（`priceSource`）と時刻（`priceAsOf`）は検証せずそのまま echo し、summary に「price supplied by the caller: …」と書くので、答えを読む人には「いつ・どこの単価か」が常に見える。単価の取得は呼び出し側（web 検索、価格を返す別の MCP サーバー、ユーザー入力）の仕事で、description と instructions にそう明記し、モデルには「残高 × 単価を自分で計算しない」と指示する（浮動小数の丸めと桁の取り違えを避けるため。積はサーバーが BigInt で決定的に計算する）。`test/tools/holdings_value.test.ts` の「参照ノードを設定しても `SYMBOL_NODE_URL` 以外に fetch しない」で、価格 API を叩かないことを固定する。
- 処理（すべて整数演算。純粋関数は `src/domain/price.ts`）: `parseDecimalString` で `unitPrice` を整数 `scaled` と小数桁数 `decimals` に分解し、整数部の先頭ゼロと小数部の末尾ゼロを落として正規化（`"012.340"` → `1234n` / 2 / `"12.34"`。`exact` の桁数が入力の書き方に依存しないようにする）→ `ctx.getNetworkData()` → モザイク解決 → `fetchAccount` → `mosaicBalanceOf`（`domain/rank.ts` を再利用）→ `multiplyAndRound`: `raw = balanceRaw × scaled`、`exact` は小数 `divisibility + decimals` 桁の文字列（`formatScaled`。`formatAmount` は divisibility 18 上限があるので使わない）、`amount` は `roundScaled` = `(x + unit/2) / unit` の四捨五入（half up）。丸める桁は `roundingRule` が次の順で決める: (1) `decimals` 引数があればその値（`caller`）、(2) Intl が知っている通貨なら `new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits`（`currency`。「知っている」は `new Intl.DisplayNames(['en'], { type: 'currency', fallback: 'none' }).of(code)` が名前を返すこと。`Intl.supportedValuesOf('currency')` は ICU の「一般的で廃止されていない」通貨だけで CLF・UYW・XAU を含まないので使わない）、(3) それ以外（BTC・USDT など）は丸めない（`none`）。ISO 4217 の表は内蔵しない。`Intl.DisplayNames` と `NumberFormat` は呼び出し時に作り（Intl の無い Node でも失敗はこの引き当てだけで `none` になり、サーバー全体は落ちない）、Intl が知っている通貨の桁だけをプロセス内でキャッシュする（知らないコードは残さないので、呼び出し側が渡すコードの種類にかかわらず CLDR の通貨一覧を超えて増えない。Intl の無い環境での失敗も残らない）。CLDR が名前を持つ特殊コード（XXX・XTS・XAG など）も CLDR の桁（多くは既定の 2）で丸める。値は実行中の Node.js の ICU / CLDR に依存し、CLDR は一部で ISO 4217 と異なる（ICU 78.3 / CLDR 48: HUF 0・IDR 0・IQD 0・IRR 0）。**安全策**: 0 でない積が丸めで 0 になるときは丸めない（`rounds_to_zero`。XAU は CLDR 既定の 2 桁で、少額が 0.00 になるのを防ぐ。`decimals` を指定したときも同じ）。丸めないときの `amount` は `exact` から末尾のゼロを除いたもの（`trimFraction`。値は変わらない）。派生値（1,000 XYM あたりの価値など）は出さない。
- 出力（先頭 summary）: `summary` / `network` / `address` / `accountResolution` / `mosaic { id, alias, divisibility }` / `balance { amount, raw }`（XYM 以外も扱うので `xym` ではなく `amount`）/ `price { unitPrice（正規化形）, currency, source: nullable, asOf: nullable }` / `value { amount（丸め後。丸めないときは末尾ゼロを除いた正確な積）, exact（丸め前）, currency, roundingDecimals: nullable（丸めた桁。丸めないとき null）, decimalsSource: caller | currency | none | rounds_to_zero }` / `notes[]`。summary の 1 行目は `<address> holds 4,321,000.000000 symbol.xym; at 12.34 JPY per XYM that is 53,321,140 JPY (price supplied by the caller: Zaif XYM/JPY last, as of 2026-09-22T21:00:00+09:00).`（桁区切りは summary だけ。単位は通貨モザイクなら `per XYM`、他は `per <alias か id>`。source / asOf が無ければ括弧内は `price supplied by the caller` だけ）、2 行目は使った規則（`Rounded half up to whole units, as Intl (Unicode CLDR) formats JPY.` / `Rounded half up to 4 decimals, as requested.` / `Not rounded: Intl (Unicode CLDR) does not know BTC, so this is the exact product.` / `Not rounded: rounding to 2 decimals as Intl (Unicode CLDR) formats XAU would show it as 0, so this is the exact product.`）。
- 固定 notes: 単価は呼び出し側が与えたもので、このサーバーは価格を取得も検証もしない／評価額は残高 × 単価の単純な積で、手数料・スプレッド・税は含まない／税務上の取得価額や譲渡損益の計算ではない。
- テスト: 単体 `test/unit/price.test.ts`（parse の正常系・正規化・12 桁ちょうど・不正 16 種、通貨コード、`intlCurrencyDigits` の固定値 JPY 0・KRW 0・USD 2・EUR 2・KWD 3・BHD 3・CLF 4・XAU 2 と BTC・ETH・XYM・USDT は null（CI の Node 22 と 24 で ICU の差を検出するため固定。失敗時に Node / ICU / CLDR の版を出す）、`roundingRule`、`parseRoundingDecimals`、`trimFraction`、`formatScaled`、`roundScaled` の half up、`multiplyAndRound` の固定値: 9,111,457.601413 XYM × 12.34 JPY = 112,435,386.80143642 → `112435387`、USD 2 桁、KWD・BHD 3 桁と CLF 4 桁の半上げ、BTC は丸めない、1,000 XYM × 0.0000003 BTC = `0.0003`、XAU の安全策、BigInt の最大級の値（Python の Decimal で照合）、`.5` 切り上げ、divisibility 0 の桁埋め、残高 0）。ツール層 `test/tools/holdings_value.test.ts`（XYM / USD・KRW・KWD の桁と summary の 2 行目 / detailed の 3 行目 / BTC は丸めない / XAU の安全策が summary と `decimalsSource` に出る / `decimals` の上書きと同じ安全策 / `decimals` 不正 3 種がリクエスト前に isError＋ヒント / 正規化と公開鍵が出力に出ない / 別モザイク hex（divisibility 0）とエイリアス名（残高 0）/ ネームスペース名 / unitPrice 不正 9 種と currency 不正 5 種がリクエスト前に isError＋ヒント / priceAsOf 不正・数値型の unitPrice / priceSource と priceAsOf の制御文字・bidi 除去 / 81 文字の priceSource / 未知アカウント / 参照ノード設定時も `SYMBOL_NODE_URL` 以外に fetch しない / outputSchema）、`account_resolution.test.ts` の共通契約、両世代スモーク（`unitPrice: "1"`, `currency: "JPY"`）。
- 参照: `GET /accounts/{accountId}`、必要なら `GET /mosaics/{mosaicId}` / `GET /namespaces/{namespaceId}` / `POST /namespaces/mosaic/names`。価格 API は無い。

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
- **リダイレクトは追わない**。`redirect: 'manual'` で送り、リダイレクト（Fetch Standard のリダイレクト状態 301・302・303・307・308 と、仕様どおりの fetch が返す opaqueredirect）は本文を破棄して `RestError('redirect')`。ほかの 3xx（300・304 など）は従来どおり HTTP エラー（本文は破棄）。Location はノードが決める文字列なので、追わず、文言にも入れない。助言の文言は `REDIRECT_ADVICE`（`src/config.ts`）の 1 箇所で、ツールの isError、CLI check の起動失敗（exit 3）、サーバーの起動失敗（`failed to start:` の行）が同じ文を出す。参照ノードのリダイレクトは `symbol_network_compare` が `redirect: …`、`symbol_version_drift` が「リダイレクトを返した」注記で示す。
- **サイズ上限はストリームで適用する**。Content-Length が上限を超えれば本文を読まずに拒否し、読み取り中も累計バイトを数えて超えた時点で reader を cancel する（圧縮応答は展開後のバイトで数える）。読まない本文（404・HTTP エラー・リダイレクト・Content-Length 超過）は `body.cancel()` で破棄し、接続を持ち続けない。
- **パスとクエリは英数字と `_` だけ**（クエリの値は `-` も。`SAFE_REQUEST_PATH`）。ツールは引数を検証してからパスを組み立て、クエリは `URLSearchParams` で作る。RestClient の検査はその下の網で、外れたパスは送らずに内部エラーにする。

## 7. テスト要件

**単体（CIで必ず実行）**
- `/network/properties` パーサ（アポストロフィ数値、`30s` 等の単位）
- アドレス: hex⇄base32、公開鍵→アドレス（symbol-sdk のテストベクタと照合）、ネットワーク判定
- エポック⇄高さの相互変換（上記2データ点を固定値テストに）
- バージョン復号（16777993 → `1.0.3.9`）
- 金額整形（divisibility 6 / 0 / 3）
- トランザクション種別の名前解決
- メッセージ復号（平文 / 暗号化 / 空 / 制御文字除去）
- 信頼しない文字列の除去（`test/unit/sanitize.test.ts`）: タブと各種の改行は空白 1 つ（CRLF も 1 つ）、空白の連続は 1 つ、両端の空白は削る、全角空白と NBSP は残す、Cc・Cf・Zl・Zp・単独サロゲート・タグ文字ブロック（未割り当てを含む）の各クラス、タグ文字で隠した英文が消える、日本語の文章は不変、絵文字の ZWJ 列では ZWJ が消える（仕様）、異体字セレクタは残る、切り詰めでサロゲートペアを割らない。除去数（`cleanUntrusted` / `UntrustedText` / `joinCleaned`）: 除去した文字だけを数え（タグ文字・単独サロゲートは 1 つずつ）、空白にした改行や切り詰めは数えない、同じ値を何度使っても 1 回の呼び出しで 1 回、つないだ名前は部分ごとに 1 回。メッセージ（`test/unit/message.test.ts`）と取引詳細（`test/unit/txdetails.test.ts`）は、出力に入る文字列の分だけを数える。テストでは特殊文字をコードポイントから組み立て、ファイルに生で書かない（`test/unit/no-raw-control-chars.test.ts` が同じ文字集合を検査する）
- ハーベスト報酬の分割規則（`src/domain/harvesting.ts`）: `splitHeightRange`（割り切れる / 余りあり / 1 ブロックのチャンク / from == to / ちょうどチャンク長と +1 / mainnet 1 年 = 5 本で重複も隙間も無い / 逆順・小数・0 は RangeError）、`blocksForDays`（30 s → 259,200 と 20,160、15 s → 518,400、0・負・NaN は throw）、`shrinkChunkBlocks`（259,200 → 129,600、32,400 → 20,160 で最小に留まる、最小以下 → null）
- ファイナリティ参加判定（両ステージ一致 / prevote のみ / 不一致 / 鍵未登録 / 期間外の鍵のみ / proof なし、**prevote が 2 グループに分かれ自鍵が片方だけ → participated**（`groups` 2、`signatureCount` は合計、グループ順に依存しない、どのグループにも無ければそのステージだけ missed、高さが違うグループは `heights` 昇順）、`describeSignedStages` の全組み合わせで "only" が出ずステージ名が 1 回ずつ）とエポック範囲の展開（`epochs=3` で e, e-1, e-2。1 未満は切り詰め）
- ノード健全性の閾値（`src/domain/nodehealth.ts`）: 1 分相当ブロック数（30 s → 2、15 s → 4、60 s → 1）、時計ずれの計算と判定（14999 ok / 15000 warn / 30000 fail、負値も）、ファイナリティ遅延（19 ブロック → ok / 720 warn / 1440 fail、負は 0）、verdict（unknown → degraded）
- バージョン比較（`src/domain/version.ts`）: `compareVersions`（`1.0.3.10 > 1.0.3.9`、欠け成分は 0）、分布の順序と同数タイブレーク、`newerShare`、verdict（own が最頻値 40% でも newerShare 0.6 → behind、0.7499 → behind、0.75 → far_behind、空 → unknown）
- ハーベスター監視の規則（`src/domain/harvesterwatch.ts`）: `normalizeKeys`、`diffKeys`（added / removed / unchanged、昇順、同一・空・全追加）、`historyStats`（窓内・境界・未来日付・空 → null）、`trimSnapshots`（61 → 60、新しい側を残す）、`stateFileName` / `assertInsideDir`（`..`、別絶対パス、dir 自身、`/a/bb` の罠）/ `resolveStateFile`（`..` の正規化）、スキーマの否定例
- 状態ファイル I/O（`src/state/snapshotfile.ts`、一時ディレクトリ）: 無し / 不正 JSON / 形不一致 / ディレクトリ / symlink（win32 skip）→ corrupt、dir 0o700・file 0o600 の作成、既存 dir の mode 不変、一時ファイルが残らない、上書き、symlink 置換で外側ファイル不変、読み取り専用 dir で `StateFileError`（win32・root skip）、ディレクトリ外は fs に触れる前に拒否
- `RestClient.get` の `acceptStatuses`（503 受理で本文が返る / 未指定は http / 他ステータスは http / 受理しても非 JSON は invalid_response / 404 は列挙時のみ）
- `RestClient` の HTTP 衛生（`test/unit/rest.test.ts`）: fetch に `redirect: 'manual'` を渡す / 3xx（301・302・303・307・308）と opaqueredirect は `redirect` エラーで、本文を読まずに破棄し、Location を文言に入れない / ローカルの実ソケットで 302 を返しても転送先に接続しない / ほかの 3xx（300・304）は HTTP エラーのまま / 404・HTTP エラー・Content-Length 超過の本文は読まずに破棄 / 上限を超え続けるストリームは途中で打ち切る（引き出した量を検査。cancel が失敗しても `too_large`）/ 安全でないパス（`..`・`?#`・空白・`%`・`\`・`//`）は送らずに拒否
- 委任診断の規則（`src/domain/delegation.ts`）: verdict（fail 優先 / unknown → cannot_verify / warn のみ → active）、importance 再計算までの残りブロック（ちょうど倍数のときは G）、鍵有無、委任要求マーカー判定（マーカーのみ / 先頭 0xFE だが不一致 / 平文）
- 保有額の算術（`src/domain/price.ts`）: `parseDecimalString`（`"12.34"` / `"1200"` / `"0.0000123"` / 先頭ゼロ・末尾ゼロの正規化 / 12 桁ちょうど / 不正: `1e3`・`1,200`・`¥12`・`-1`・空・`12.`・`.5`・空白・0・13 桁）、`parseCurrencyCode`、`intlCurrencyDigits`（主要通貨の桁を固定: JPY 0・KRW 0・USD 2・EUR 2・KWD 3・BHD 3・CLF 4・XAU 2。BTC・USDT などは null）、`roundingRule`（caller → currency → none）、`parseRoundingDecimals`（0〜12 の整数）、`roundScaled` の half up、`multiplyAndRound` の固定値（9,111,457.601413 XYM × 12.34 JPY → `112435387`、USD 2 桁、KWD・BHD・CLF、BTC は丸めない、1,000 XYM × 0.0000003 BTC → `0.0003`、0 に丸まる非 0 値は丸めない、BigInt の最大級の値、`.5` 切り上げ、divisibility 0）
- ツール説明の経路（`test/unit/tool-descriptions.test.ts`、§5 共通規約）: 取り違えやすい組のツールごとに、1 文目に他のツール名が無く、2 文目が組の他のツールを名指しすること（文は .mcpb の manifest と同じ `firstSentence` で切る）、組の中で 1 文目の動詞が重ならないこと、全ツールの説明で文と文の間の空白が欠けていないこと（欠けると 2 文目の境界がずれる）、`symbol_harvesting_income` の「use this tool whenever …」と「Do not use symbol_transaction_search or a browser … receipts, not transactions」。instructions（`test/unit/instructions.test.ts`）: 150 語以内、必須語句（`use symbol_harvesting_income, never symbol_transaction_search`、同期・高さの差・Tx の状態の経路を含む）
- CLI check の純粋部分（`test/unit/cli-check.test.ts`、§13）: 5 項目それぞれの「ツールの verdict → status」対応表、`decideExit`（ok / skip のみ → 0、warn → 1、fail 優先 → 2、時間上限 → 最低 1、全項目到達不能 → 3）、`--warn-days` の境界（14 = warn / 14.1・15 = ok / 3 = fail / 0・失効のみ = fail / 後継キー登録済み = ok / active 複数は残り最大で判定）、hint がツールの文言から取られること、引数解析（既定値、`--flag value` と `--flag=value`、不正値・重複・値欠落・`--quiet=1` → usage、`check --help`）、`runCli` の exit 3（リクエスト 0 回）、`--quiet` は exit 0 のときだけ無出力、text / JSON の整形、`src/cli/*.ts` に `@modelcontextprotocol` の import が無いこと。`test/unit/cli.test.ts`: `check` が `serve` を呼ばない／引数なしは呼ぶ／`--help` に check と exit code／`--help` の URL は `https://<node-host>:3001` と nodewatch だけ（実在のノード名を書かない）。`test/unit/voting.test.ts`: `hasSuccessorKey`
- 文書と版の整合（`test/unit/docs-sync.test.ts`）: 両 README が全ツール名と全環境変数を含む、`server.json` の環境変数が `ENV_VARS` と一致、`server.json`（`version` と `packages[0].version`）と `package-lock.json`（ルートの `version` と `packages[""].version`）の版が `package.json` と一致、両 README の節の数が同じ、`.mcpb` の節がある。リリース PR は人間が `server.json` と lockfile を更新するまでこの検査で落ちる（`docs/RELEASING.md`）
- リリースの事前検査（`test/unit/release-check.test.ts`）: `scripts/release-check.mjs <version>` は、`package.json`・`package-lock.json`（ルートと `packages[""]`）・`server.json`（`version` とすべての `packages[].version`）の版、`server.json` の `name` と `package.json` の `mcpName` の一致、npm エントリの `identifier` と `package.json` の `name` の一致、`CHANGELOG.md` の日付付きで空でない節を検査し、不一致をすべて列挙する（`release.yml` の publish ジョブが最初に実行する）。検査の本体は副作用のない `scripts/release-files.mjs` の `releaseProblems`（`release-notes.mjs` が使う節の抽出もここ）で、2 つの CLI はガードを置かずに main を必ず実行する。ガードがあると、シンボリックリンク経由で起動したときに検査を飛ばして exit 0 になるため。テストは純粋関数の各項目と、リポジトリ自身のファイルでの CLI（package.json の版で exit 0、別の版で版の各項目と CHANGELOG の行を出して exit 1、引数の誤りで exit 2、シンボリックリンク経由でも同じ）。リリース PR では docs-sync と同じく、人間が `server.json` と lockfile を更新するまで落ちる
- npm の待機（`test/unit/wait-for-npm.test.ts`）: `scripts/wait-for-npm.sh` を、npm と sleep を差し替えて実行する。1 回目で見える／何回か後に見える／`NPM_WAIT` の上限（15 秒ごと、既定 300 秒）で失敗／期待値と違えば待たずに失敗／引数の誤りで exit 2／`NPM_WAIT` が秒の整数でなければその名前を出して exit 2、を確かめる

**ツール層（CIで必ず実行。SDK公式のインプロセス方式）**
`createMcpHandler(createServer)` を作り、`@modelcontextprotocol/client` の `Client` を `StreamableHTTPClientTransport(url, { fetch: (u, i) => handler.fetch(new Request(u, i)) })` で接続して `client.callTool()` を呼ぶ。ノードへの `fetch` は `vi.stubGlobal('fetch', ...)` で差し替え、固定レスポンスを返す。
- 各ツールが `structuredContent` と `text` の両方を返し、`structuredContent` が `outputSchema` を満たす
- 入力不正が `isError: true` で返り、本文に修正のヒントが含まれる
- **`SYMBOL_NODE_URL` に設定したホストへ実際にリクエストが飛ぶこと**（stub した fetch が受け取った URL のホストを検証）。設定した URL が実際に使われることを保証する回帰テスト
- `SYMBOL_NETWORK=mainnet` で `/node/info` が testnet の generationHashSeed を返したら**起動失敗**すること
- `SYMBOL_REFERENCE_NODES` に無いホストへは一切 fetch が呼ばれないこと
- 64桁hex（秘密鍵に見える値）を `symbol_account_get` に渡しても公開鍵として扱うだけで、ログ・出力・外部送信に含めないこと
- 全クライアントに起動時に配られるもの（`tools/list` の全体＝タイトル・説明・入力と出力のスキーマ、`prompts/list`、instructions）に 64 桁 hex が無いこと（例は形式だけを書き、実在の Tx ハッシュや鍵を載せない。`test/tools/server.test.ts`）
- `symbol_harvesting_income` の分割取得: 約 90 日以下は元の from/to のまま 1 クエリで `fetch.chunks` 1 / 3 チャンクの境界の両側と範囲の両端に置いたレシートが 1 回ずつ数えられる（totals の BigInt 文字列を固定値検証、リクエスト列が昇順・連続、JSON と CSV の行が高さ昇順）/ `pageNumber` がチャンクごとに 1 から / 幅 > 約 45 日の 1 ページ目にだけ timeout を返すスタブで、1 年の合計 = 半年 × 2 回の合計、`splitRetries` ≥ 1、summary 末尾の行 / 常に timeout → 5 回目（20,160 ブロック）で isError、本文に高さ範囲・タイムアウト値・`SYMBOL_REQUEST_TIMEOUT_MS` / 2 ページ目の timeout と http 500 は再試行しない / 各チャンク 120 フルページで 200 ページ上限がチャンクをまたぐ（121 + 79）/ `SYMBOL_NODE_URL` 以外に fetch しない / outputSchema
- `symbol_delegation_diagnose`（既存フィクスチャを in-test で変異させる）: 全部 ok → active / linked 鍵なし → not_active / node 鍵が別ノード → cannot_verify で `unlocked_on_node` と `delegation_request_found` が unknown、`/transactions/confirmed` を呼ばない / 残高不足・超過 → not_active / 404 → not_active で `account_exists` のみ fail / `/node/unlockedaccount` が 5xx でも他のチェックは返る / 委任要求 Tx を返すルートで `delegation_request_found: ok` / `SYMBOL_NODE_URL` 以外に fetch しない / outputSchema
- `symbol_node_health`: 既定フィクスチャで healthy（skew −1 s、lag 19 ブロック）/ storage −3・now +20 s・finalized −800 で degraded / `/node/health` が 503 本文 `db: down` → unhealthy（本文で判定）/ `/node/health` が例外・500 → `api_node` と `db` が fail で他のチェックは計算される / `/node/time` 503 とタイムスタンプ欠落 → `clock_skew` unknown・`nodeTime` null・degraded / `/node/storage` `/chain/info` `/node/info` 失敗 → 該当チェック unknown と null フィールド / now +31 s → clock_skew fail / concise・detailed / 参照ノード設定時も `SYMBOL_NODE_URL` 以外に通信しない / outputSchema
- `symbol_version_drift`: 既定フィクスチャ（6 ピア: 1.0.3.9 ×4 / 1.0.3.8 / 1.0.4.0）で ok と分布 / 自ノード 1.0.3.8 と 7 ピア（1.0.4.0 ×3、1.0.3.8 ×2、1.0.3.7 ×2）→ behind（newerShare 0.43 でも多数派より古い）/ 全ピア 1.0.4.0 → far_behind / 同数タイブレーク → 新しい版が多数派 / ピア 0 件と `/node/peers` 503 → unknown（hint に SYMBOL_REFERENCE_NODES）/ 参照ノード A が新版・B が失敗 → `peers+reference`、host 集合 = node + A + B、参照側のパスは `/node/info` のみ / 参照ノードが testnet seed → 除外 / 自ノード鍵・別 seed・壊れた要素 → `ignored` 3 / `/node/server` 503 → `restVersion` null / 出力テキストにピアの host・friendlyName・publicKey が無い / outputSchema
- `symbol_harvester_watch`（一時ディレクトリを `SYMBOL_STATE_DIR` に）: 未設定 → comparison null・ファイル無し / baseline → 2 回目で差分（鍵を 1 つ除き 2 つ足して `+2 -1`、history 1 件）/ save_only → 追記のみ / compare を 2 回で履歴が増えない（バイト一致）/ compare はディレクトリを作らない / 壊れたファイル（compare は不変、compare_and_save は上書き）/ 別ノード鍵 / 60 件切り詰めと 30 日窓（detailed の entries）/ `SYMBOL_STATE_DIR=<dir>/a/../b` → `<dir>/b` にだけ書く / `nodePublicKey` 無し・不正 → isError で何も書かない / 読み取り専用 dir → compare_and_save は note、save_only は isError（win32・root skip）/ `SYMBOL_NODE_URL` 以外に fetch しない / outputSchema / 両世代スモークは mode compare（既定ハーネスに `SYMBOL_STATE_DIR` が無いのでディスクに触れない）
- `symbol_holdings_value`: XYM at 12.34 JPY の固定値と summary（2 行目に丸めの規則）/ USD・KRW・KWD の桁 / detailed は丸めたときだけ 3 行目に丸め前の値 / BTC は丸めない（`decimalsSource: none`）/ XAU は 43.21 なら 2 桁で丸め、0.004321 なら丸めず `rounds_to_zero` と summary で分かる / `decimals` の上書き（USD 4 桁・BTC 2 桁）と同じ安全策 / `decimals` 不正 3 種がリクエスト前に isError＋ヒント / 別モザイク hex とエイリアス名 / ネームスペース名 / unitPrice 不正 9 種・currency 不正 5 種・priceAsOf 不正・数値型の unitPrice がリクエスト前に isError＋ヒント / priceSource・priceAsOf の制御文字除去 / **参照ノードを設定しても `SYMBOL_NODE_URL` 以外に fetch しない（価格 API を叩かないことをここで固定）** / outputSchema
- 全ツール横断の検査（`test/tools/untrusted_output.test.ts`、検査関数は `test/tools/unsafe-text.ts`）: ノードが書ける自由文字列（friendlyName・host・`/node/health` の状態・restVersion・取引ステータスの code・モザイクの別名・ネームスペース名・転送メッセージ）と呼び出し側の priceSource・priceAsOf に、エスケープシーケンス・ゼロ幅と双方向制御・タブ・CRLF・行区切り・NEL・タグ文字の隠し指示を仕込み、全ツールの `SMOKE_CALLS`（1 ツール 1 呼び出し。ツールを足すと自動で対象になる）の structuredContent と text（JSON は解析して、CSV は行ごとに）を再帰的にたどって、除去対象の文字が 1 つも残らないこと。LF は `summary` と `csv` の行の区切りとしてだけ認め、仕込んだ改行の直後に置いたマーカーで始まる行があれば改行の漏れとみなす。仕込みが実際に届いたこと（`untrustedText` を付けた 17 ツールの出力にマーカーがあり `invisibleCharactersRemoved` が 1 以上で summary の最後の行がそれを伝え、ほかの 5 ツールにはマーカーもフィールドも無い）、どの出力にも「[object Object]」が無いこと、検査関数が漏れを見つけることも確かめる
- `invisibleCharactersRemoved`（`test/tools/invisible_characters.test.ts`）: `untrustedText` を付けたツールの一覧が 17 ツールと一致、公開する outputSchema の最後の必須プロパティで、ほかのツールには無い、通常のフィクスチャでは 0 で summary の行も無い、出所ごとの正確な数（node_status の friendlyName・host・状態、version_drift の restVersion で summary の 1 行目は不変、transaction_status の code、キャッシュした通貨の別名は呼び出しごとに 1 回、namespace_get で共通の親は 1 回、transaction_search で各メッセージと全行に共通の別名 1 回、holdings_value の priceSource・priceAsOf）
- ノード応答由来の文字列（`test/tools/untrusted_text.test.ts`）: 制御・書式・タグ文字を含む `/node/health` の状態が `symbol_node_status`・`symbol_node_health`・CLI check の text と JSON に残らない / 状態は除去後の値で判定し、何も残らなければ `(empty)` / `/node/server` の restVersion と取引ステータスの code は除去して上限で切る（code の意味は除去後の値で引き、何も残らなければ code なし）/ `symbol_network_compare` は RestError 以外を定型文（予期しない内部エラー）で返し、詳細は stderr / アカウントの voting 鍵は 128 桁の hex まで受け付け（OpenAPI は 64 桁）、超えれば応答形式の不一致。保有者ページに変わった鍵が 1 件あっても `symbol_account_rank` は失敗しない / メッセージのプレビュー（`symbol_transaction_get` の summary、`symbol_transaction_search` の concise 行）がサロゲートペアを割らない
- HTTP 衛生（`test/tools/http_hygiene.test.ts`）: 設定ノードのリダイレクトは isError で `SYMBOL_NODE_URL` の助言、転送先には接続せず文言にも出さない / 参照ノードのリダイレクトは `symbol_network_compare` の `redirect: …` と `symbol_version_drift` の注記（「到達できない」とは書かない）/ CLI check は起動時のリダイレクトで exit 3 と同じ助言、起動後に全リクエストがリダイレクトされても exit 3 / サーバーの起動失敗の行にも同じ助言（`serverStartupFailureText`）/ 識別子を受ける全引数（17 通り）に不正な文字列 8 種を渡しても入力エラーで、送るパスとクエリはすべて `SAFE_REQUEST_PATH` に合う。スモーク（両世代）と参照ノード付きの呼び出しでは全リクエストが `redirect: 'manual'`（ハーネスの `redirects`）
- initialize 結果に `instructions` が含まれること（`client.getInstructions()` が `SERVER_INSTRUCTIONS` と一致）
- `prompts/list` が固定順で返り、`prompts/get` が `account` を埋め込んだ本文を返し、`account` 無し・不正アドレスがエラーになること。テンプレートに実在のアドレス・ホスト・鍵・ハッシュ・日付が無いこと
- **2026-07-28 世代**（`test/tools/era_2026.test.ts`）: Client を `versionNegotiation: { mode: { pin: '2026-07-28' } }` で同じ `createMcpHandler.fetch` に接続し、`getProtocolEra() === 'modern'`、`tools/list` が全ツールを既定順で annotations / outputSchema 付きで返し `ttlMs` / `cacheScope` が宣言どおり載ること（生 JSON でも確認）、`prompts/list` / `prompts/get`、`tools/call` が `content[0].text` と `structuredContent` の両方を返すこと（csv 出力では text が CSV）、`getInstructions()` と discover 結果の `instructions`、`_meta` のサーバー identity、全ツールのスモーク呼び出し（`SMOKE_CALLS`、outputSchema 検証付き）。2025 世代のテストはそのまま残し、そちらでは cache フィールドが付かないことを確認する。**注意**: SDK Client の `mode: 'auto'` はインプロセスの `createMcpHandler` に対して modern に解決する（2026-09-13 に確認）ので、ハーネスの既定は明示的に `mode: 'legacy'` にしてある。auto のままだと 2025 世代の回帰テストは存在しない
- **CLI check**（`test/tools/cli_check.test.ts`、§13。MCP クライアントを通さず、ハーネスの `createTestContext`（stub fetch + AppContext。`startTestServer` の前半を切り出したもの）で `runCheck` を直接呼ぶ）: 全 ok → exit 0（最新確定エポック 4004 の proof は epoch 4010 フィクスチャを in-test で付け替える。新しいフィクスチャは作らない）/ `/node/time` 503 → WARN・exit 1・text 1 行目 / `/node/health` 503 `db: down` → FAIL・exit 2 / 起動後に `/node/info` だけ 500 → その項目だけ fail で他は実行 / 起動後に fetch が throw → 全項目 unreachable で ERROR・exit 3 / `--account` 無しで 4・5 が skip、`SYMBOL_STATE_DIR` 無しで 3 が skip（該当リクエストも飛ばない）/ `SYMBOL_STATE_DIR` ありで 3 回実行（baseline → `+0 -1` で warn → `+1 -0` で ok）/ 読み取り専用 dir → warn（win32・root skip）/ `--warn-days 30` で warn・hint はツールの warning / ネームスペース名 → `account` は解決後アドレス / 存在しないアカウント → exit 2・`account` はマスク / 64 桁 hex を出力しない / proof 無し → warn / JSON の形（キー順・`CheckReportSchema`）/ `SYMBOL_NODE_URL` と参照ノード以外に fetch しない（参照ノードへは `/node/info` のみ）/ 時間上限（応答しないルート + `timeLimitMs: 300`）

**統合（`SYMBOL_INTEGRATION=1` のときだけ。CI既定では走らせない）**
- testnet ノードに対して全ツールがエラーなく応答する
- `/chain/info` の `latestFinalizedBlock.height` から式で計算したエポックが `finalizationEpoch` と一致する
- `SYMBOL_INTEGRATION_ACCOUNT` で指定した Voting アカウントに対し、`symbol_voting_key_status` が Voting キーを1本以上返す（内容は時間で変わるので件数と形だけ検証。未設定ならこのテストは skip）
- 同アカウントに対し、`symbol_finality_participation` が最新確定エポックで `participated` か `missed` のいずれかを返す（`unavailable` でない。未設定なら skip）

**手動確認**: `npx @modelcontextprotocol/inspector -e SYMBOL_NODE_URL=https://<node-host>:3001 node dist/index.js` で全ツールを一度は叩く（Inspector はシェルの環境変数をサーバーに渡さない。渡るのは MCP SDK の既定の数個と `-e` や画面で指定したものだけ）。

## 8. リポジトリ構成と公開準備

```
.
├── src/
│   ├── index.ts            # #!/usr/bin/env node、runCli に実プロセスを配線するだけ（serve = createAppContext→createServer→serveStdio）
│   ├── cli.ts              # 引数解析（手書き）、runCli(argv, deps)、--help の本文。check サブコマンドの入口（§13）
│   ├── cli/                # check.ts（runCheck・対応表・decideExit）、format.ts（text / JSON）。MCP SDK を import しない（§13）
│   ├── context.ts          # AppContext と createAppContext（サーバーと check で共通の起動手順）
│   ├── server.ts           # createServer(): McpServer（ツール登録）
│   ├── instructions.ts     # SERVER_INSTRUCTIONS（initialize 結果に載せる本文、§3.1）
│   ├── prompts/            # 1ファイル1プロンプト（§3.1）
│   ├── config.ts           # env 読込・URL検証・ネットワーク照合
│   ├── client/rest.ts      # fetch ラッパ（timeout, UA, サイズ上限, スキーマ検証）
│   ├── domain/             # address.ts, amount.ts, epoch.ts, version.ts, txtype.ts, message.ts, properties.ts
│   ├── state/              # snapshotfile.ts: src で唯一 node:fs を使う（symbol_harvester_watch の状態ファイル、§2-9）
│   └── tools/              # 1ファイル1ツール（symbol_*.ts）、各ファイルで input/output zod を定義
├── test/                   # unit/, tools/, integration/
├── evals/                  # 実際の質問文と期待するツール呼び出しの例（Phase 3）
├── server.json             # MCP Registry 用
├── package.json  LICENSE  README.md  CHANGELOG.md  SECURITY.md
└── .github/workflows/ci.yml, release.yml
```

**package.json の要点**
- `"type": "module"`, `"engines": {"node": ">=22"}`, `"bin": {"<cmd>": "dist/index.js"}`, `"files": ["dist","README.md","LICENSE"]`
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
※ 初回公開のための手順。リリースごとの実際の手順（release PR・タグ・承認・npm・GitHub Release・Registry と、その確認）は `docs/RELEASING.md`。リリースごとの Registry への公開は `release.yml` の `registry` ジョブが行う。GitHub OIDC でログインし、版と SHA-256 で固定した mcp-publisher を使う。手作業で公開するのは、このジョブが失敗したときだけ。

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

## 13. CLI モード（`check`。0.5.0 で追加。既存の節番号は振り直さず末尾に追加）

**目的**: MCP クライアント無しで、cron から 1 コマンドでノードの健全性を判定し、異常があれば非ゼロで終了する。**通知はしない**（cron の `MAILTO` に任せる。外部通信を増やさない）。引数なしで起動したときの挙動（MCP サーバー、stdio）、`--help` / `--version`、未知の引数 → exit 2 は変えない。

```
symbol-mcp-server check [--account <address|publicKey|namespace>] [--warn-days <n>] [--format text|json] [--quiet]
```

- 環境変数は MCP と共通（`createAppContext` = loadConfig → RestClient → resolveNetwork → AppContext を `src/context.ts` に置き、サーバーと check の両方が使う）。`--warn-days` は 1〜120 の整数で既定 14、`--format` は既定 text、`--quiet` は exit 0 のとき何も出力しない。
- 引数解析は手書き（`src/cli.ts` の `parseCliArgs`）。`--flag value` と `--flag=value` の両方。未知フラグ・位置引数・値欠落・重複・範囲外・`--quiet=…`・`--account` の構文不正（`classifyAccountId`。通信なし）は exit 3。`check --help` は全体の help。

**判定は既存ツールの読み替えのみ**。`runCheck(ctx, options)`（`src/cli/check.ts`）が 5 項目を**固定順・逐次**で `tool.run(ctx, input)` を直接呼ぶ（MCP のトランスポートも結果整形も通さない）。ツール側の閾値やロジックは CLI 用に変えない。対応表 `mapNodeHealth` / `mapVersionDrift` / `mapHarvesterWatch` / `mapVotingKeys(output, warnDays)` / `mapFinality` と `decideExit` は純粋関数で、引数は「読むフィールドだけ」の構造型（ツール出力がそのまま渡せる）。

| # | id | 呼び方 | status |
|---|---|---|---|
| 1 | `node_health` | `symbol_node_health` | healthy → ok / degraded → warn / unhealthy → fail |
| 2 | `version_drift` | `symbol_version_drift` | ok → ok / behind → warn / far_behind → fail / unknown → warn |
| 3 | `harvester_watch` | `symbol_harvester_watch`、mode `compare_and_save` | `comparison.deltaCount < 0` → warn、`saved === false`（書込失敗）→ warn、それ以外 ok（baseline も ok）。`ctx.config.stateDir` 未設定ならツールを呼ばず skip（detail はツールの `UNSET_NOTE`） |
| 4 | `voting_key_status` | `symbol_voting_key_status`（`--account` 指定時） | active キーが無い → fail。active のうち `remainingDays` 最大の鍵について: 後継キーが切れ目なく登録済み（`hasSuccessorKey`。ツールの警告抑止と同じ規則を `domain/voting.ts` から切り出したもの）→ ok、`≤ RENEWAL_WINDOW_END_DAYS`（3。推奨ウィンドウの終端。ツールと同じ定数）→ fail、`≤ warn-days` → warn、それ以外 ok。`--account` 無しなら skip |
| 5 | `finality_participation` | `symbol_finality_participation`、`epochs: 1`（`--account` 指定時） | participated → ok / missed → warn / no_active_key → fail / unavailable → warn。`--account` 無しなら skip |

- 各項目は `{ id, status: ok|warn|fail|skip, detail, hint: string|null }`。**hint はツールの出力から取る**（新しい助言文を書かない）: 1 = 最も重い非 ok check（fail > warn > unknown、同順位はツールの固定順）の `checks[].hint`、2 = summary の「- 」行、3 = 保存失敗の note（`NOT_SAVED_NOTE_PREFIX`）または再起動注記（`RESTART_NOTE`）、4 = その鍵の 8 桁プレフィックスを含む `warnings[]`（active 無しのときは `warnings[0]`）、5 = `warning`、unavailable は `UNAVAILABLE_NOTE`。ツールが 30 日より前は警告を出さないので、`--warn-days` > 30 の warn は hint が null になりうる。
- detail: 1 = verdict と非 ok check の id・status、最も重い check の detail（healthy のときは `chain` の高さ差を finalization lag として添える）、2 = summary の 1 行目、3 = ツールの summary、4 = 鍵プレフィックス・残り日数・endEpoch・失効予定（後継ありなら `successor registered`）、5 = エポックと status、署名したステージの列挙（`describeSignedStages`。例 `epoch 4027: participated (signed prevote and precommit)` / `missed (signed precommit, not prevote)`。そのためツールは `format: 'detailed'` で呼び、participated でも `stages` を受け取る）。
- 例外: `RestError` → fail（detail に kind / status / path、hint は `describeError`）。`ToolInputError` → fail（1 文目が detail、残りが hint。存在しないアカウントはここ → exit 2）。ただし `epochs: 1` で proof が無いとツールは `unavailable` を返さず例外を投げるので、`ProofUnavailableError extends ToolInputError`（メッセージも MCP 側の isError 結果も不変）を足し、check はこれだけ warn にする。それ以外の例外 → fail（詳細は `describeError` が stderr へ）。1 項目が失敗しても残りは実行する。
- JSON の `account`: 4 番目の出力の base32 アドレス。4 番目が失敗・skip なら `maskIdentifier` でマスクした入力、`--account` 無しなら null。64 桁 hex（秘密鍵の貼り間違いかもしれない値）は出力に現れない。

**exit code**（`decideExit`）: 0 = すべて ok または skip、1 = warn あり（fail なし）、2 = fail あり、3 = 実行できなかった。3 になるのは、引数エラー、`createAppContext` の失敗（`ConfigError` / `NetworkVerificationError` / `/node/info` の `RestError`。stdout は空）、実行した項目（skip 以外）が**全部** `unreachable` / `timeout` / `redirect` の `RestError` だったとき（verdict `error`。リダイレクトは「ノードに使える URL で届いていない」扱い）。3 のときは stderr に 1〜2 行の原因とヒント。`process.exit` は使わず `process.exitCode`（stdout の書き残しを切らない）。サーバーの起動失敗（exit 1）は従来どおり。

**出力**: stdout のみ、色・装飾なし。
- text（既定）: 1 行目 `symbol check: OK|WARN|FAIL|ERROR (<host>, <network>, <time>)`（`<time>` は `ctx.instant(now)` の local、無ければ utc）、以降 1 項目 1 行 `[ok] node_health: …`、warn / fail の行の次に `  hint: …` を 1 行（hint が null なら出さない）。detail / hint は `runCheck` が 1 行にし（タブと改行は空白に畳む）、制御文字と書式文字を除去する（`printableItem`。json も同じ値を出す。ツール側の除去をすり抜けた文字列への最後の防御）。
- json: `runCheck` の結果をそのまま 1 つの JSON で。`{ verdict: ok|warn|fail|error, exitCode, node: { host, network }, checkedAt: Instant, checks: [...], warnDays, account: string|null }`。structuredContent と同じ規約（数値は数値、Instant は既存の形）。形は `CheckReportSchema`（zod）でテストする。
- `--quiet` は exit 0 のときだけ無出力。診断行（時間上限、起動後の到達不能）は `options.onDiagnostic` 経由で stderr へ。
- **stdout に書くのは check モードだけ**で、書く場所は `index.ts` が `deps.stdout` に渡す `process.stdout.write` の 1 箇所。サーバーモードは従来どおり stdout に何も書かない（§10 の `console.log` 禁止はそのまま。biome の `noConsole` も据え置き）。

**実行時間上限**: `options.timeLimitMs`（既定 120,000。CLI フラグは足さない）。各項目を残り時間と競争させ、上限に達したら実行中の項目と残りを skip にする（detail に理由）。総合判定は**最低でも WARN（exit 1）**で、`--quiet` でも出力し、stderr に理由を書く。打ち切った項目のリクエストは中断しないので、プロセスは最長 `SYMBOL_REQUEST_TIMEOUT_MS` 程度残りうる（打ち切られた `harvester_watch` が後からスナップショットを書くことはあり得るが、内容は通常の追記と同じ）。

**外部通信・状態**: `SYMBOL_NODE_URL` と、`symbol_version_drift` 経由の `SYMBOL_REFERENCE_NODES`（`/node/info` のみ）だけ。通知・テレメトリなし。ディスクに書くのは従来どおり `symbol_harvester_watch` の状態ファイルだけ（§2-9。check は 1 回の実行で 1 件追記する）。

**置き場所**: `src/cli/` に閉じる（`check.ts`、`format.ts`）。将来 CLI を別パッケージに切り出せるように、**`src/cli/` から `@modelcontextprotocol` を import しない**（テストで検査。`tools/_shared.ts` 経由の `import type` は実行時に消えるので今回は許容）。`src/cli.ts` は `runCli(argv, deps)`（`deps = { env, stdout, stderr, serve, version, now }`）で、`index.ts` は実プロセスを配線して `process.exitCode` を設定するだけ。instructions / prompts / evals は変更しない（CLI は MCP の外）。

## 14. 配布形式（npm / MCP Registry / .mcpb。.mcpb は 0.8.0 で追加）

利用者に届く形は 3 つで、中身はすべて npm に公開した同じ tarball から来る。

| 形式 | 作るもの・場所 | 使う人 |
|---|---|---|
| npm | `release.yml` の `publish` ジョブ（Trusted Publishing、provenance 付き） | `npx -y symbol-mcp-server` を設定するすべての MCP ホスト |
| MCP Registry | `server.json`（`release.yml` の `registry` ジョブが GitHub OIDC で `mcp-publisher publish`。失敗したときは人間が手作業。§8、`docs/RELEASING.md`） | Registry からサーバーを探すクライアント |
| .mcpb | `github-release` ジョブが `scripts/build-mcpb.sh` で作り、GitHub Release に添付 | Claude Desktop（ダブルクリックまたは Settings → Extensions） |

**.mcpb の作り方**: 公式 CLI `@anthropic-ai/mcpb` は依存（`tmp`）に修正版の無い脆弱性があるため使わない。`.mcpb` は「直下に `manifest.json` を置いた普通の zip」で（CLI の `pack` も fflate の `zipSync` で同じ形を作り、署名は任意の追記ブロック）、`zip -X -r` で作る。中身は `manifest.json`・`icon.png`・`server/`（tarball の `dist`・`package.json`・`README.md`・`LICENSE` と、そのリリースの lockfile から `npm ci --omit=dev --ignore-scripts` で入れた本番用の `node_modules`）。ビルドは lockfile と `package.json` の版が一致しなければ失敗する。`unzip -Z1` で、`manifest.json` が直下にあること、`server/dist/index.js` と `@modelcontextprotocol/server` があること、開発用依存が無いことを確認する。

**manifest**: `mcpb/manifest.json` がテンプレート（保護対象）。`manifest_version` は "0.3"（2026-09 時点の最新スキーマ。0.4 は `uv` 型を足すだけ）。`version` は "0.0.0" の置き場所で、ビルド時にリリースの版を書く。tools と prompts はテンプレートに書かず、ビルド時に同梱した `dist/server.js` の `TOOLS` / `PROMPTS` から宣言する（`scripts/mcpb-manifest.mjs`。description は 1 文目、prompt の `text` は `{account}` を `${arguments.account}` に置き換えたテンプレート）。ツールを足しても manifest の手作業は増えない。`server` は `node`、`args` は `${__dirname}/server/dist/index.js`、`env` は `user_config` の 6 項目を `SYMBOL_*` に対応付ける（`node_url` だけ required）。

**user_config の未設定値**: 参照実装（mcpb の `src/shared/config.ts`）は、値も `default` も無い任意項目を置換しないので、`${user_config.x}` という文字列のまま環境変数に入る。そこで任意項目にはすべて `default` を置く（文字列と directory は `""`、`request_timeout_ms` は 10000）。`src/config.ts` は任意の環境変数の空文字・空白のみを未設定として扱う（`test/unit/config.test.ts`）。この「任意項目には必ず default」はテストで固定する（`test/unit/mcpb-manifest.test.ts`）。

**Node.js**: Claude Desktop は Node.js を同梱して node 型の拡張を動かす（公式）。同梱の版は公式ドキュメントに書かれていない。`compatibility.runtimes.node` は `engines` と同じ ">=22" にし、`claude_desktop` の下限は公式に確認できる値が無いので書かない。.mcpb を最初に配る前に、人間が実機の Claude Desktop に入れて、起動・ツール呼び出し・ログの Node の版を確認する。

**出所の確認**: `.mcpb` には GitHub の build provenance を付け（`actions/attest`）、`gh attestation verify <file>.mcpb --repo inotakeh/symbol-mcp-server` で確認できる。`mcpb sign` の署名は付けないので、Claude Desktop に「未検証」と表示されうる。README に明記する。

**アイコン**: `mcpb/icon.png`（512×512）は Symbol / NEM のロゴを使わない独自の図形で、`scripts/make-icon.mjs`（依存なし、`node:zlib` のみ）で再生成できる。
