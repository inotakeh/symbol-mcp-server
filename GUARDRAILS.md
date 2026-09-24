# セキュリティガードレール設計（symbol-mcp-server / エージェント開発・GitHub公開）

作成: 2026-09-10。Claude Code 公式ドキュメント（hooks / permissions / sandboxing / permission-modes / security / memory / best-practices / github-actions）、`anthropics/claude-code` の公式設定例、GitHub Actions セキュリティ強化ガイド、npm Trusted Publishing のドキュメントを確認して設計した。各項目の出典は末尾。

## 0. 結論（先に読む）

| 層 | 何で実現するか | 性質 |
|---|---|---|
| 1. 行動指針 | `AGENTS.md`（`CLAUDE.md` は `@AGENTS.md` の 1 行で import するだけ） | **助言**。モデルは従おうとするが強制ではない（公式明記） |
| 2. 権限ルール | `.claude/settings.json` の `permissions.deny/ask/allow` | 強制。ただし Bash ルールは**コマンド文字列一致**で、`/bin/rm` や `sh -c` で回避されうる（公式明記） |
| 3. フック | `PreToolUse`（Bash / Edit / Write）・`PostToolUse` | **強制・決定的**。コマンド全文を検査。exit 2 のブロックは allow ルールにも `bypassPermissions` にも勝つ |
| 4. サンドボックス | `sandbox` 設定（macOS Seatbelt / Linux bubblewrap） | **OS レベル強制**。ファイル書込先・読取禁止・接続先ドメインを全子プロセスに適用。プロンプトインジェクションでモデルが騙されても効く |
| 5. リポジトリ側 | ブランチ保護 / secret scanning push protection / CODEOWNERS / Dependabot / CodeQL / CI | エージェントの手が届かない層。**merge・tag・publish は人間だけ** |
| 6. 配布 | npm Trusted Publishing（OIDC）+ provenance | **npm トークンが存在しない**。ローカルにもエージェントにも渡さない |

原則: **CLAUDE.md は説明のため、フックとサンドボックスは強制のため、GitHub 側は最後の砦のため**。同じルールを 3 層に書くのは冗長ではなく設計。

## 1. 脅威モデル

| # | 脅威 | 主な対策 |
|---|---|---|
| T1 | **プロンプトインジェクション**: 取得した Web ページ、npm パッケージ README、GitHub Issue/PR 本文、チェーン上のメッセージに仕込まれた指示に従い、データ持ち出しや悪意あるコードを書く | CLAUDE.md で「取得内容は全てデータ」明記／`curl|sh`・`eval`・`sh -c` をフックで禁止／サンドボックスの接続先許可リスト／auto モードの分類器（`curl|bash`、機密送信を既定でブロック） |
| T2 | **サプライチェーン**: typosquat・悪意ある依存の追加、postinstall で任意コード実行 | `.claude/allowed-packages.txt` 外の `npm install` をフックで禁止／`.npmrc` で `ignore-scripts=true`／`npm ci --ignore-scripts`／Dependabot + dependency-review／npx 実行可能パッケージも許可リスト制 |
| T3 | **認証情報の漏洩**: npm/GitHub/Anthropic トークン、SSH 鍵、Symbol ノードの秘密鍵をトランスクリプト・コミットに出す | `env`/`printenv`/`$NPM_TOKEN` 参照をフックで禁止／`~/.ssh` `~/.aws` `~/.npmrc` `/data/target` を Read 禁止＋サンドボックス `denyRead`／`sandbox.credentials` で環境変数を unset／PostToolUse の秘密情報スキャン／GitHub push protection／npm トークン自体を廃止（Trusted Publishing） |
| T4 | **破壊的操作**: force push、main 直 push、履歴改変、`rm -rf`、リモート変更 | フックで禁止（`rm -rf` は `dist/` 等の成果物のみ許可）／ブランチ保護で force push・削除を拒否／`ask` ルールで push は必ず人間確認 |
| T5 | **ガードレールの自己解除**: `.claude/`・フック・ワークフロー・`.npmrc`・lockfile をエージェントが書き換える | Edit deny＋フック＋サンドボックス `denyWrite`（三重）／Claude Code 自体も `.claude` を protected path として扱う／CI の protected-files ジョブ／CODEOWNERS |
| T6 | **不正な公開**: 汚染されたパッケージを npm へ | `npm publish`/`token`/`login` をフックと deny で禁止／タグ作成を禁止／release ワークフローは GitHub Environment の**必須レビュアー承認**を通らないと publish しない／provenance 添付 |
| T7 | **本番ノードへの到達**: 開発エージェントが本番ノードのサーバーを操作する | `ssh`/`scp`/`rsync`/`docker`/`symbol-bootstrap` を禁止／ノードは REST エンドポイントとしてのみ扱う／**ノードサーバー上で開発しない**（下記 4.1） |

## 2. ファイル構成と役割

```
.
├── AGENTS.md                        # 行動指針（<100行）。設計ブリーフ docs/DESIGN-BRIEF.md を @import
├── CLAUDE.md                        # 「@AGENTS.md」の 1 行だけ（Claude Code が AGENTS.md を読むための import）
├── GUARDRAILS.md                    # この文書
├── SECURITY.md                      # 脆弱性報告ポリシー（private vulnerability reporting）
├── .npmrc                           # ignore-scripts=true, save-exact, engine-strict
├── .gitignore                       # settings.local.json / CLAUDE.local.md / .env / 鍵
├── .env.example                     # 設定例（値は入れない）
├── .claude/
│   ├── settings.json                # 権限・サンドボックス・フック（コミットする）
│   ├── allowed-packages.txt         # npm install を許可するパッケージ名（人間が管理）
│   ├── allowed-npx.txt              # npx 実行を許可するパッケージ名（人間が管理）
│   └── hooks/
│       ├── guard-bash.py            # PreToolUse(Bash): 危険コマンドのブロック / 確認要求
│       ├── guard-files.py           # PreToolUse(Edit|Write): 保護ファイル・プロジェクト外への書込ブロック
│       ├── scan-secrets.py          # PostToolUse(Edit|Write): 書いた直後に秘密情報を検出
│       ├── stop-gate.sh             # 任意: lint/test が通るまで終了させない Stop フック
│       └── test-hooks.sh            # フックの自己テスト（679 ケース。誤検知と危険な類似コマンドを対で）
├── .github/
│   ├── CODEOWNERS                   # 全変更にメンテナのレビューを要求
│   ├── dependabot.yml               # npm / actions を月次更新
│   └── workflows/
│       ├── ci.yml                   # lint/typecheck/test/build/audit + dependency-review + 保護ファイル検査
│       └── release.yml              # v* タグ → Environment 承認 → npm publish --provenance（OIDC）
└── docs/
    ├── DESIGN-BRIEF.md              # MCP サーバーの設計ブリーフ（既存文書）
    └── user-settings-snippet.json   # ~/.claude/settings.json に足す分（ユーザー層でしか効かない設定）
```

### 2.1 `.claude/settings.json` の要点

- `permissions.defaultMode: "acceptEdits"` — 編集は自動承認（フックが守る）、Bash はサンドボックス内なら自動、外なら確認。Pro/Max/Team なら `auto` にすると分類器が加わる（公式の既定）。`bypassPermissions` は `disableBypassPermissionsMode: "disable"` で**無効化**。
- `deny` は常に適用（トラスト不要）。`allow` は初回の **workspace trust ダイアログ**を承認して初めて効く。ダイアログには allow の内容が列挙されるので確認してから承認する。
- `Read(...)` の deny は同じパスの Edit/Write も止める（v2.1.208+）。`Edit(...)` の deny は Write にも効く。`Write(...)` や `MultiEdit(...)` のパスルールは**無視される**ので使わない（公式）。
- `WebFetch(domain:...)` の allow はサンドボックスの接続許可にも合流する。`github.com` と `registry.npmjs.org` は git/npm が必要とする最低限。公式ドキュメントは「`github.com` のような広いドメインはデータ持ち出し経路になりうる」と警告している — これは受け入れているリスク（4.3）。
- `sandbox.allowUnsandboxedCommands: false`（strict）。サンドボックスで動かせないコマンドは失敗する。必要なら **人間が** `.claude/settings.local.json` の `excludedCommands` に例外を足す。
- `sandbox.filesystem.denyRead` に `/data/target` を入れてあるのは、万一ノードサーバー上で起動しても鍵を読めないようにするため。
- `enableAllProjectMcpServers: false` — リポジトリ由来の `.mcp.json` を自動信頼しない。

### 2.2 フック設計（なぜ deny だけでは足りないか）

公式の permissions リファレンスに明記されている通り、`Bash(rm *)` の deny は `/bin/rm`、`bash -c 'rm ...'` を止めない。`Bash(git push *)` は `git -C . push` を止めない。`guard-bash.py` は**コマンドをシェルと同じ規則で読み**（引用符・エスケープ・演算子・リダイレクト・heredoc・`$(...)`・バッククォート・プロセス置換）、**実際に実行されるコマンド**に規則を当てる。引用符の中の語、コミットメッセージ、grep のパターンはデータとして扱う（以前は全文に正規表現を当てていたので、`grep curl` や `ls .claude/ 2>/dev/null` まで止まっていた）。シェルやラッパーが実行する文字列は取り出して同じように検査する: `$(...)`・バッククォート、シェルへの heredoc と here-string、`trap` の文字列、`env -S`・`flock -c`・`script -c`・`watch`・`parallel`・`find -exec`・`xargs`、`command`・`exec`・`nice`・`timeout` などのラッパー、`coproc`・`select`・`function`。**解析できないコマンド（引用符や heredoc が閉じていない）は止める**（fail closed）。heredoc の終わりの行は bash と同じ規則で探す（引用していない区切りでは、バックスラッシュ改行を連結してから比べる）。**このマシンのファイルシステム（APFS）は大文字小文字を区別しない**ので、保護パスとコマンド名は大文字小文字を区別せずに判定する（`.CLAUDE/hooks/…` は `.claude/hooks/…`、`CURL` は `curl` として扱う）。実在するパスはシンボリックリンクを解決してから判定する。

- **ブロック（exit 2）**:
  - コマンドとして: `curl`/`wget`/`fetch`、`/dev/tcp`、`eval`、`sh -c`（csh・tcsh・fish などを含む）、パイプでシェルやインタープリタにテキストを流し込むこと、見えないスクリプトを読ませること（`bash /dev/stdin`、`source <(...)`、`python3 /dev/fd/0` など）、コマンド名が実行時に決まるもの（`$c`、`$(...)`、グロブ、ブレース展開、`alias x=`、`hash -p`）、`sudo`、`ssh/scp/rsync/docker/symbol-bootstrap`、環境変数ダンプ（`env`・`printenv`・`set`・`export`・`declare -p`）、`npm publish/token/login`、registry 変更（`--registry`、スコープ付きの `--@scope:registry=`）、インストールスクリプトを有効にすること（`--ignore-scripts=false`・`=0`、`--no-ignore-scripts`）、パッケージマネージャの設定を環境変数で変えること（`npm_config_*`・`NPM_CONFIG_*`・`yarn_*`・`bun_config_*`・`pnpm_config_*` の代入。git や gh の無い行でも止める。例外は `npm_config_cache`）、成果物ディレクトリ（パスの区切りで判定する。`distsrc` は対象外）と `$TMPDIR/<name>` 以外への `rm -r`（同じ行で TMPDIR を変える・読む・source する場合は例外なし）、許可リスト外のパッケージの `npm install`（`inst`・`it` など npm の別名を含む）・`yarn global add`・`npx`（`--package` を含む）・`bun x`・`npm exec`・`npm init <pkg>`・`npm create`・`pnpm/yarn/bun create`、`npx -c`。npm・pnpm・yarn・bun は、既知のオプション（`--prefix`・`-C`・`--cwd`・`-w`・`-g` など）を飛ばしてサブコマンドを取り出し、未知のオプションがサブコマンドより前にあれば止める
  - 保護ファイルへの書き込み: リダイレクト先、`tee`・`cp`・`mv`・`ln`・`sed -i`（スクリプト引数は除く）・`sort -o`・`uniq`・awk の `print > "file"` などの書き込み先、git と gh が書くファイルが保護パスなら止める（読むだけは通す）。書き込み先のブレース展開（`{a,b}`）は展開して、グロブは既存のファイルに当てて判定する。行き先の分からない `cd`（`cd "$X"`、`cd -`、`popd`、`CDPATH`・`cdable_vars`）の後の相対パスへの書き込みも止める。Claude Code が Bash の呼び出しの前に読み込むファイル（`$CLAUDE_ENV_FILE`、`~/.claude/shell-snapshots/`・`~/.claude/session-env/`）も保護パスとして扱う（サンドボックスもこれらへの書き込みを拒否することを 2026-09-24 に確認）。インラインコード（`node -e`・`python -c`・`perl -e` など）は、保護パスへの書き込み（`open()` は mode 引数が書き込みのときだけ）とプロセスの起動を止める。awk の `system()` とコマンドへのパイプも止める。`find` は、`-fprint`・`-fls` の出力先を書き込み先として扱い、`-delete` や書き込むコマンドの `-exec` があれば、開始点が保護パスそのものか、それを含むディレクトリのとき止める（成果物ディレクトリは除く）
  - **git と gh（サンドボックスの外で動く。`settings.local.json` の `excludedCommands`）はフックが唯一の防御**なので、**サブコマンドを許可リストで決める**（`guard-bash.py` の `GIT_ALLOWED`・`GH_ALLOWED`。リストに無いものは既定で止める。未知の経路を禁止リストに 1 つずつ足す方式では塞ぎきれないため）。
    - git: status、diff、log、show、add、commit、restore、switch、checkout、branch、fetch、pull、push、stash、rev-parse、ls-files、grep、blame、tag、config、apply、am、merge-base、describe、remote、shortlog、cat-file、ls-tree、reflog、show-ref、for-each-ref、hash-object、merge、rebase、cherry-pick、reset、clean、mv、rm、worktree（list のみ）、version、help（`--web`・`--info` 以外）、var、それに以前から通していた ls-remote・rev-list・submodule（status・summary のみ）・update-index（`--refresh` のみ）。git の alias と外部の `git-*` コマンドもリストに無いので止まる
    - gh: pr の create・view・list・diff・checks・edit・comment・close・reopen・ready・status、issue の view・list・create・comment、run の list・view・watch・rerun・cancel、workflow の list・view、release の view・list、repo の view、search、config の get・list、api（書き込みなし）、status、browse。`-R`・`--repo`・`--hostname` は飛ばしてコマンド名を取り出し、それ以外のフラグがコマンド名より前にあれば止める（値を取るフラグでコマンド名を隠せるため）。gh の alias と拡張もリストに無いので止まる
    - 許可したサブコマンドの中でも次を止める。git の長いオプションは省略形（`--no-verif`、`--tag`、`--del` など。git は一意な前方一致を受け付ける）でも一致させる: 設定経由のコマンド実行（`git -c` は `commit.gpgsign`・`core.quotepath`・`color.*`・`advice.*` 以外、`git config` の書き込み、`--git-dir`・`--work-tree`・`--exec-path=`・`--config-env`）、同じ行で git・gh やそれらが起動する子プロセス（pre-push などのフック、ページャ、エディタ、ssh、gpg。これもサンドボックスの外で動く）の読み込むものを変える環境変数の**代入**（`NAME=…`、`export`・`declare`・`typeset`・`local`・`readonly`、`env NAME=…`、`read`・`mapfile`・`printf -v`・`for NAME in`・`getopts`、`${NAME:=…}`、`declare -n` の参照先。名前が実行時に決まる代入も止める。コミットメッセージや grep のパターンの中の語は止めない。対象: `HOME`・`PATH`・`CDPATH`・`GIT_*`・`GH_*`・`EDITOR`・`PAGER`・`XDG_CONFIG_*`・`BASH_ENV`・`ENV`・`SHELL`・`LD_PRELOAD`・`LD_LIBRARY_PATH`・`LD_AUDIT`・`DYLD_*`・`PYTHONPATH`・`PYTHONHOME`・`PYTHONSTARTUP`・`NODE_OPTIONS`・`NODE_PATH`・`PERL5LIB`・`PERL5OPT`・`RUBYOPT`・`RUBYLIB`・`SSH_ASKPASS`・`GNUPGHOME`、`git help` が起動する man の `MANPAGER`・`MANOPT`・`MANPATH`・`MANROFFOPT`・`MANSECT`・`GROFF_*`・`LESS`・`LESSKEY` 系）、サブコマンドの中での実行（`submodule foreach`、`bisect run`、`rebase -x`、`difftool -x`、`grep -O`、`--upload-pack` など）、`git maintenance`（`register`・`start` がグローバル設定と launchd / cron にジョブを登録し、サンドボックスの外に常駐の仕組みを作れる）、pull request の取り込み（`gh pr checkout`・`co`、`pull/…` の ref への checkout・switch。fetch・pull の refspec は枝（`refs/heads/…` と枝名）とタグだけを許し、`refs/pull/…`・`refs/*`・コミット id などは止める。フックは呼び出しのたびに作業ツリーから読まれるので、フォークの PR を checkout するとフック自体が差し替わりうる。PR の checkout は人間が行う）、remote の設定を書き換える `remote set-branches`・`set-head`、設定済みリモートを名前で指す以外の通信（`clone`、URL、パス、`submodule add`）、パッチの適用（`apply`・`am` は `--check`・`--stat`・`--numstat`・`--summary` だけ）、index や worktree を直接書く plumbing、`checkout <tree-ish> <path>` と `checkout -- <path>`・`restore`・`rm`・`mv` による保護ファイルの上書き、`--pathspec-from-file`、このリポジトリ以外（`-C`、`cd`・`pushd`・`builtin cd`・`command cd` で別のディレクトリ・入れ子のリポジトリ、行き先の分からない `cd`、`CDPATH`・`cdable_vars`）での実行、タグの作成と push、force push・削除・`--mirror`・`--all`、main への push、`--no-verify`、remote の変更、`gh pr merge`、`gh release`（`view`・`list` 以外）、`gh secret/variable/auth/alias/extension/config set/codespace/ssh-key/gpg-key`、書込系 `gh api`
  - 文字列に出るだけで止めるもの（全文一致）: 資格情報の環境変数の参照、ホームの資格情報ファイル、秘密鍵ファイルの読み取り、`.npmrc` への書き込み、`base64 -d | sh`、`chmod 777`
- **確認要求（permissionDecision: ask）**: 通常の `git push`、`rebase/merge/cherry-pick`、作業を捨てる git 操作（省略形やまとめた短いフラグを含む: `clean --forc`、`branch -df`）、`gh pr create/edit/close/reopen/comment/ready`、`gh issue create/comment`、`npm update` — auto モードでも必ず人間に出る
  - **作業ツリーを別の版に切り替える git の操作**（`checkout <ref>`・`checkout <ref> -- <paths>`、`switch`、`reset`（`--soft` 以外）、`restore`（`--source`・`--staged`）、`merge`、`rebase`、`stash pop/apply/branch`）は、保護ファイル（フック・設定・ワークフローなど）の内容が変わるときに確認にする。フックは呼び出しのたびに作業ツリーから読まれるので、古い版に戻すとフック自体が古くなるため。判定はフックの中で読み取り専用の `git diff --name-only`（`stash show`、`rev-parse`）を実行して行う。この git は外部プログラムを起動しないように、`-c core.fsmonitor= -c core.hooksPath=/dev/null`、`--no-ext-diff --no-textconv`、`GIT_CONFIG_NOSYSTEM=1` を付け、呼び出し側の `GIT_*` をすべて消して 2 秒の制限時間で実行する。判定できないとき（ref が解決できない、git が失敗した、時間切れ）も確認にする。`git pull` は、取り込む中身が fetch の後にしか分からないので常に確認にする（`fetch` だけなら確認しない）
- **通過（exit 0）**: それ以外。permissions ルールと分類器に委ねる

`guard-files.py` は `.claude/**`、`CLAUDE.md`、`AGENTS.md`、ワークフロー、CODEOWNERS、`LICENSE`、`server.json`、`.npmrc`、lockfile、`.env*`（`.env.example` は許可）、鍵ファイル、**プロジェクト外のパス**への Edit/Write を止める。

`scan-secrets.py` は書込直後にファイルを走査し、秘密鍵ブロック・Anthropic/npm/GitHub/AWS トークン・「privateKey = <64hex>」形式・ハードコードされた credential リテラルを検出したら exit 2 で Claude に即時削除を指示する。PostToolUse は取り消せないので、GitHub の push protection が次の層。公開テストベクタは `secrets-scan:ignore-file` マーカーで除外。

フックは `.claude/settings.json` に置いてあるので**リポジトリを trust した後にだけ動く**。`disableAllHooks` や `--setting-sources` で外せるのは人間だけ（エージェントは `.claude/` を書けない）。

### 2.3 AGENTS.md（CLAUDE.md）の設計方針

行動指針の本体は `AGENTS.md`（エージェント共通の置き場所）にあり、`CLAUDE.md` は `@AGENTS.md` の 1 行だけで Claude Code にそれを import させる。どちらも保護対象（フック・deny・サンドボックス `denyWrite`・CI・CODEOWNERS）。

公式ガイダンス（CLAUDE.md 向けだが import 先にもそのまま当てはまる）: 200 行未満、具体的で検証可能な指示、「コードを読めば分かること」は書かない、強調は本当に重要な行だけ。この AGENTS.md は約 60 行で、コマンド・規約・リポジトリ作法・セキュリティルール・完了条件のみ。設計の詳細は `@docs/DESIGN-BRIEF.md` の import に逃がしている。**「ブロックされたら回避策を探さず、説明して止まれ」**を明記してあるのが要点で、これがないとエージェントは別経路を試す。

## 3. GitHub リポジトリ側の設定（人間が行う。エージェントには権限を与えない）

作成直後に、リポジトリの Settings で:

1. **Rules → Rulesets → New branch ruleset**（対象 `main`）: Require a pull request before merging（approvals 0 でよい。目的は PR 経由の強制）、Require status checks to pass（`test (20)`, `test (22)`, `dependency-review`, `protected-files`）、Block force pushes、Restrict deletions、Require linear history。可能なら Require signed commits。
2. **Rules → New tag ruleset**（対象 `v*`）: Restrict creations を自分だけに。エージェントはローカルでも tag をブロックされるが、二重化。
3. **Code security**: Secret scanning **と Push protection** を有効化（公開リポジトリは無料）。Dependabot alerts / security updates を有効化。**CodeQL default setup** を有効化。Private vulnerability reporting を有効化（SECURITY.md が参照）。
4. **Actions → General**: Workflow permissions を **Read repository contents**、「Allow GitHub Actions to create and approve pull requests」を**オフ**。Fork pull request workflows は「Require approval for all outside collaborators」。
5. **Environments → `npm-publish`**: Required reviewers に自分を追加。これで `release.yml` はタグを押しても**あなたが UI で承認するまで publish しない**。
6. **CODEOWNERS** の `YOUR_GITHUB_USERNAME` を置換。`ci.yml` の `MAINTAINER` も同様。
7. **アクションの SHA 固定**: `actions/checkout@v6` 等を、最初のリリース前にフルコミット SHA に固定する（GitHub の公式推奨）。Dependabot が以後更新する。
8. **npm 側**: パッケージ公開後、npmjs.com のパッケージ設定 → Trusted Publisher に `owner/repo` と `release.yml` を登録。以後 npm トークンは発行しない（既存トークンは失効させる）。2FA は必須。

### 3.1 エージェントに渡す GitHub 認証

`gh auth login` はマシン上で人間が行う。エージェントはその `gh` を使うため、トークンは `~/.config/gh` から読める（サンドボックスで `~/.config/gh` を `denyRead` にすると `gh` 自体が動かない）。**受け入れるリスク**なので、被害範囲を絞る:

- 可能なら **fine-grained PAT**（対象リポジトリのみ、Contents: R/W、Pull requests: R/W、Issues: R/W。Administration・Secrets・Workflows は付けない）で `gh auth login --with-token`。
- 上記のブランチ保護・タグ保護・Environment 承認があれば、トークンが漏れても main の改変・release・publish はできない。
- 定期的に失効・再発行する。

### 3.2 Claude Code GitHub Actions（`@claude` で Issue から PR を作らせる）を使う場合

最初は使わず、ローカルの Claude Code だけで運用することを勧める。使うなら公式の security.md 準拠で: トリガーは write 権限者のみ（`allowed_non_write_users` は使わない）、`allowed_bots` は明示リスト、`use_commit_signing: true`、`show_full_output` は無効のまま、`pull_request_target` で PR head をワークスペース直下に checkout しない、`permissions` は最小。Issue/PR 本文は誰でも書ける＝プロンプトインジェクションの入口なので、`.claude/` と `CLAUDE.md` がベースブランチから復元される仕様（公式）に依存しつつ、PR は必ず人間がレビューする。

## 4. 運用手順

### 4.1 開発環境

- **本番ノードのサーバー上で開発しない**。鍵と本番設定がある機械に開発エージェントを置くのは最大のリスク。手元の Mac か、専用の VM/コンテナで。
- Linux/WSL2 でサンドボックスを使う場合は `bubblewrap`（と任意で seccomp）を導入。`/sandbox` の Dependencies タブが不足を教える。`failIfUnavailable: true` にしてあるので、サンドボックスが動かない環境では Bash が失敗する（黙って無防備になるより良い）。
- `docs/user-settings-snippet.json` の内容を `~/.claude/settings.json` に足す。`strictAllowlist` と `ConfigChange` フックはユーザー層でしか効かない。

### 4.2 初回起動

1. リポジトリで `claude` を起動 → workspace trust ダイアログで allow ルールとフックを確認して承認。
2. `/hooks` で 3 つのフックが表示されること、`/permissions` で deny/ask が読み込まれていること、`/sandbox` の Config タブで denyRead/denyWrite と allowedDomains を確認。
3. `bash .claude/hooks/test-hooks.sh` を実行し `failed=0` を確認（679 ケース）。
4. `claude doctor` で設定の警告（無効なルール等）が無いことを確認。

### 4.3 日常

- 依存を足したい: エージェントはブロックされ、パッケージ名・理由・週間 DL・メンテナを提示して止まる。あなたが npm で確認し、`.claude/allowed-packages.txt` に追記してコミット。
- PR: エージェントが `gh pr create`（確認プロンプトが出る）。CI が緑で、あなたが diff を読んで merge。`/code-review` スキルや別セッションのレビュー（公式 best-practices の Writer/Reviewer パターン）を挟むと精度が上がる。
- リリース: `package.json` の version を上げる PR を merge → あなたが `git tag vX.Y.Z && git push origin vX.Y.Z` → Environment 承認 → publish。
- ブロックが誤検知だったとき: フックの正規表現を**あなたが**直し、`test-hooks.sh` にケースを追加してから使う。エージェントに直させない。

## 5. 既知の限界（正直に）

- **解析の限界**: フックはコマンド行を読むが、コマンドが読み込むファイルの中身（`bash script.sh`、`node x.mjs`、`npm run` の scripts）は見ない。インラインコードの検査（`node -e` などのプロセス起動・保護ファイルへの書き込み）も語の一致による近似で、難読化はすり抜けうる。これらはサンドボックスの中で動くので、サンドボックスが最終防衛線で、サンドボックス無しでの運用は想定していない。例外は git と gh（`excludedCommands` でサンドボックスの外）で、コマンド行に単独で書いたときだけ外で動く。スクリプトやインラインコードから起動した git はサンドボックスの中で動く。
- **呼び出しの間の状態**: フックは 1 回の Bash 呼び出しのコマンド行だけを見る。環境変数は呼び出しの間で残らないことを 2026-09-24 に Claude Code 2.1.281 で確認した（1 回目 `export ZZ_T=1`、2 回目 `echo "${ZZ_T:-unset}"` が `unset`）。そのため環境変数の規則は「git や gh と同じ行」に限っている。Claude Code の更新で残るようになったら、`EXEC_ENV` の変数の `export`・`declare -x`・`typeset -x`・`set -a` を行に関係なく止める必要がある。作業ディレクトリは残るので、git と gh はフック入力の `cwd` で判定している。
- **git と gh の許可リスト**: リストに無いサブコマンドは、安全なもの（`git notes`、`gh workflow run` など）でも止まる。必要になったら人間が実行するか、理由を添えて `GIT_ALLOWED`・`GH_ALLOWED` に足し、`test-hooks.sh` に通るテストと、そのサブコマンドで止め続ける使い方のテストを対で足す。許可したサブコマンドの中の細かい規則（書き込み先、オプションの省略形など）は、サブコマンドやオプションを増やすときに見直す。
- **作業ツリーの切り替えの確認は、フックが作業ツリーから読まれる問題への対症療法**: 保護ファイルに差がある切り替えを確認にするだけで、人間が承認すれば古いフックに戻る。承認の前に、確認の理由に出るファイル名を見ること。根本の対策（手元で完結する git をサンドボックスに入れる、フックのハッシュを見張る別のフックをユーザー設定に置く）は次の段階で検討する。判定に使う git は 2 秒で打ち切るので、とても大きなリポジトリでは判定できずに確認になることがある。`test-hooks.sh` は、この判定の結果がリポジトリの状態に左右されないように、テストの中で小さな git リポジトリを作ってそこで確かめる。
- **サンドボックスのネットワーク**: 既定ではプロキシは TLS を終端せず、ホスト名だけで判定する。公式が domain fronting の可能性を認めている。`github.com`/`registry.npmjs.org` を許可している以上、理論上の持ち出し経路は残る。
- **`gh` トークン**: 3.1 の通り読める。被害範囲の限定で対処。
- **PostToolUse は取り消せない**: 秘密情報スキャンは「書いてしまった後」に警告する。コミット前に人間が diff を見ること、push protection が次の層。
- **CLAUDE.md は助言**: モデルが従わないことはある。だから強制はフック・サンドボックス・GitHub 側に置いている。
- **auto モードの分類器**はプランに依存する。使えなくても本設計は成立する（分類器は追加の層）。
- **フックは trust 後のみ**: `claude -p` や SDK 実行では trust ダイアログが出ず、リポジトリ由来のフックの扱いが異なる（公式「What runs before you trust a folder」参照）。CI で Claude を動かす場合は別途 `--settings` で明示する。
- **Windows ネイティブ**はサンドボックス非対応（WSL2 を使う）。

## 6. 出典（2026-09-10 確認）

- Claude Code hooks リファレンス: https://code.claude.com/docs/en/hooks （イベント一覧、exit 2、`permissionDecision`、`if` フィルタ）
- hooks ガイド: https://code.claude.com/docs/en/hooks-guide （protected files の例、ConfigChange、hook は bypassPermissions でも効く、PostToolUse は取り消せない）
- permissions: https://code.claude.com/docs/en/permissions （deny 優先、Bash ルールの限界、`Read` deny が Edit を止める、`Write()` パスルールは無視、WebFetch domain、trust とallow の関係）
- sandboxing: https://code.claude.com/docs/en/sandboxing （protected paths、`denyRead`/`credentials`、`allowUnsandboxedCommands`、`strictAllowlist` はユーザー/管理層のみ、TLS 非終端の限界）
- permission modes: https://code.claude.com/docs/en/permission-modes （各モード、分類器が既定でブロックする操作、protected/critical paths、bypassPermissions の無効化）
- security: https://code.claude.com/docs/en/security （プロンプトインジェクション対策、`curl`/`wget` は非自動承認、ConfigChange での監査）
- memory / CLAUDE.md: https://code.claude.com/docs/en/memory （200 行未満、助言であり強制ではない、`.claude/rules/`、import）
- best practices: https://code.claude.com/docs/en/best-practices （CLAUDE.md に書くべき/書かないもの、Writer/Reviewer、`--allowedTools`、Stop hook）
- 公式設定例: https://github.com/anthropics/claude-code/tree/main/examples/settings （`settings-strict.json`、`settings-bash-sandbox.json`、`bash_command_validator_example.py`）
- Claude Code GitHub Actions: https://code.claude.com/docs/en/github-actions と https://github.com/anthropics/claude-code-action/blob/main/docs/security.md
- GitHub Actions セキュリティ強化: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- npm Trusted Publishing: https://docs.npmjs.com/trusted-publishers
