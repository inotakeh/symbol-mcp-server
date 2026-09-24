#!/usr/bin/env python3
"""
PreToolUse hook for the Bash tool (Claude Code).

Deterministic guardrail. It reads the command the way a POSIX shell would
(quotes, escapes, operators, redirections, heredocs, $(...), backquotes,
process substitution) and applies its rules to the commands that will actually
run, not to every word that appears in the text: a word inside a quoted
argument, a commit message or a grep pattern is data. Text that the shell or a
wrapper would execute is parsed again and checked the same way: $(...) and
backquotes, shell heredocs and here-strings, trap actions, env -S, flock -c,
script -c, watch, parallel, find -exec and xargs. sh -c / bash -c and piping
text into a shell or an interpreter are refused outright, and inline
interpreter code (node -e, python -c, ...) that starts processes is refused.

It either BLOCKS (exit 2, reason on stderr), forces a human prompt (JSON
permissionDecision "ask"), or stays silent (exit 0) so the normal permission
rules / classifier decide.

git and gh run OUTSIDE the OS sandbox (settings.local.json excludedCommands),
so for them this hook is the only defence. Refused: configuration that runs
commands (git -c other than a small allowlist, git config writes, HOME / PATH /
GIT_* / GH_* / EDITOR / PAGER / BASH_ENV / LD_* / DYLD_* / NODE_OPTIONS ... in
the same command: the hooks, pagers and ssh that git starts run outside the
sandbox as well), subcommands that run commands (submodule foreach, bisect
run, rebase --exec, difftool --extcmd, grep -O), git maintenance (it registers
background jobs), network access other than a configured remote by name
(clone, URLs, submodule add), checking out pull requests (gh pr checkout,
fetching pull/ refs: a pull request can replace these hooks, which are read
from the working tree), applying patches (apply / am other than --check /
--stat / --numstat / --summary), index/worktree plumbing, gh alias /
extension / config set / codespace / ssh-key / gpg-key, and running git or gh
anywhere other than this repository (another directory or a nested
repository). Writes to $CLAUDE_ENV_FILE and ~/.claude (shell snapshots) are
refused like other protected files.

Commands that cannot be parsed (unbalanced quotes, unterminated heredoc or
substitution) are refused: the hook fails closed.

Why a hook and not only permissions.deny:
  permissions.deny matches command text after Claude Code's own parsing and is
  bypassable by "/bin/rm", "sh -c '...'", "git -C . push" and similar forms.
  A PreToolUse hook that blocks wins over allow rules and over every permission
  mode, including bypassPermissions.

Exit codes (per Claude Code hooks reference):
  0  -> no decision (or JSON on stdout with a decision)
  2  -> block; stderr is shown to Claude as the reason
"""
import json
import os
import re
import sys

PROJECT_DIR = os.path.realpath(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
ALLOWED_PACKAGES_FILE = os.path.join(PROJECT_DIR, ".claude", "allowed-packages.txt")
ALLOWED_NPX_FILE = os.path.join(PROJECT_DIR, ".claude", "allowed-npx.txt")

# Directories inside the repo where "rm -rf" is acceptable (build artefacts only).
RM_ALLOWED_PREFIXES = ("dist", "./dist", "coverage", "./coverage", "node_modules", "./node_modules", ".tmp", "./.tmp")

# ---------------------------------------------------------------------------
# Rules on the raw text. A match anywhere blocks, even inside quotes: these
# name secrets or payloads that must not appear in a command at all.
# ---------------------------------------------------------------------------
TEXT_RULES = [
    (r"\bbase64\s+(-d|--decode)\b[^|;&]*\|\s*(ba|z)?sh\b", "Decoding and executing payloads is forbidden."),
    (r"\bchmod\s+(-R\s+)?(777|o\+w|a\+w)\b", "World-writable permissions are forbidden."),
    (r"\$\{?(NPM_TOKEN|GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|NODE_AUTH_TOKEN)\b", "Referencing credential environment variables is forbidden."),
    (r"(~|\$HOME|/Users/[^/\s]+|/home/[^/\s]+)/\.(ssh|aws|npmrc|netrc|gnupg|config/gh)\b", "Access to credential files under the home directory is forbidden."),
    (r"\b(cat|less|more|head|tail|grep|rg|sed|awk|cp|mv|xxd|hexdump|strings)\b[^|;&]*(\.env(\.\w+)?(\s|$|['\"])|id_rsa|id_ed25519|\.pem\b|\.key\b|harvesters\.dat)", "Reading or copying secret/key files is forbidden."),
    (r"\b(export|set)\s+(NPM_TOKEN|GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_API_KEY|NODE_AUTH_TOKEN)=", "Setting credential environment variables is forbidden."),
    (r"(>|>>|tee)\s*(~|\$HOME)?/?\.?npmrc\b", "Writing to .npmrc is forbidden."),
]

# ---------------------------------------------------------------------------
# Messages for the command rules
# ---------------------------------------------------------------------------
MSG_PARSE = "The command could not be parsed ({}). Fix the quoting or the heredoc/substitution; commands the guardrail cannot read are refused."
MSG_DYNAMIC = "The command name is computed at run time (variable, substitution, glob or brace expansion), which hides the real command from the guardrails. Write the command name literally."
MSG_NETWORK = "curl/wget are disabled for the agent. Use the WebFetch tool for documentation; the MCP server itself uses fetch() in code."
MSG_DEV_TCP = "Opening network connections through /dev/tcp or /dev/udp is forbidden."
MSG_EVAL = "eval is forbidden."
MSG_SHELL_C = "sh -c / bash -c wrappers are forbidden (they hide the real command from the guardrails). Run the command directly."
MSG_PIPE_SHELL = "Feeding text into a shell or an interpreter through a pipe hides the commands from the guardrails. Run the commands directly or from a file."
MSG_PRIV = "Privilege escalation is forbidden."
MSG_REMOTE = "Remote shell/copy is forbidden. The production Symbol node must never be touched by the agent."
MSG_NODE_OPS = "Node-operation tools are forbidden in this repository."
MSG_DOCKER = "docker is forbidden here (this project has no container workflow)."
MSG_ENV_DUMP = "Dumping the environment is forbidden (it can leak tokens into the transcript)."
MSG_NPM = "npm publishing/auth/registry configuration is forbidden for the agent. Releases go through CI (tag by a human)."
MSG_PNPM = "Publishing/auth via pnpm/yarn is forbidden."
MSG_REGISTRY = "Overriding the npm registry is forbidden."
MSG_SCRIPTS = "Re-enabling install scripts is forbidden."
MSG_NPM_EXEC_C = "npm exec -c / --call runs a shell string, which hides the real command from the guardrails. Run the command directly."
MSG_INLINE_SPAWN = "Inline interpreter code that starts processes is forbidden (the guardrails cannot see the command it runs). Run the command directly."
MSG_INLINE_WRITE = "Inline interpreter code that writes to protected files (.claude/, .github/workflows/, CLAUDE.md, AGENTS.md, .npmrc, package-lock.json, LICENSE, SECURITY.md, CODEOWNERS, server.json, mcpb/manifest.json, .gitignore, .git/) is forbidden. Propose the change in chat for a human to apply."
MSG_AWK = "awk programs that run commands (system() or piping to/from a command) are forbidden. Run the command directly."
MSG_PROTECTED = "shell writes to protected files (.claude/, .github/workflows/, CLAUDE.md, AGENTS.md, .npmrc, package-lock.json, LICENSE, SECURITY.md, CODEOWNERS, server.json, mcpb/manifest.json, .gitignore, .git/) are forbidden. Propose the change in chat for a human to apply."
MSG_FORCE = "Force-pushes and remote branch deletion are forbidden."
MSG_MAIN = "Pushing directly to main/master is forbidden. Push a feature branch and open a PR."
MSG_TAG_PUSH = "Pushing tags is forbidden (tags trigger releases; a human pushes them)."
MSG_NO_VERIFY = "Bypassing commit hooks (--no-verify) is forbidden."
MSG_GIT_CONFIG = "Changing git configuration is forbidden. git config may only be read (--get, --get-all, --get-regexp, --list, -l, --show-origin, or 'git config get/list')."
MSG_GIT_C = "git -c {} is forbidden. git runs outside the sandbox and configuration can run commands; only commit.gpgsign, core.quotepath, color.* and advice.* may be set with -c."
MSG_GIT_ENV = "Setting or mentioning {} in a command that runs git or gh is forbidden: git and gh run outside the sandbox and these variables change which configuration, programs or editors they run."
MSG_GIT_LOCATION = "git --git-dir / --work-tree / --exec-path=... / --config-env are forbidden (git runs outside the sandbox; they point it at other configuration or programs)."
MSG_GIT_DIR = "git and gh run outside the sandbox, so they may only run in this repository: no -C or cd into another directory, a computed directory, or a nested repository."
MSG_REMOTE_CHANGE = "Changing git remotes is forbidden."
MSG_TAG = "Creating tags is forbidden (tags trigger releases; a human creates them)."
MSG_HISTORY = "History rewriting is forbidden."
MSG_GIT_EXEC = "This git option runs an arbitrary command (submodule foreach, bisect run, rebase --exec, difftool --extcmd, grep -O, --upload-pack/--receive-pack/--exec), which is forbidden: git runs outside the sandbox."
MSG_SUBMODULE = "git submodule is limited to 'status' and 'summary' (git runs outside the sandbox; the others run commands or reach other hosts)."
MSG_GIT_NET = "git may only talk to a configured remote by name (e.g. 'origin'): clone, URLs, paths and scp-like addresses are forbidden (git runs outside the sandbox)."
MSG_APPLY = "git apply / git am may only inspect a patch (--check, --stat, --numstat, --summary). Applying patches is done by a human."
MSG_PLUMBING = "Low-level git plumbing that writes the index, objects, refs or worktree directly is reserved for humans."
MSG_GIT_OTHER = "This git command talks to other hosts, serves the repository, handles credentials or schedules background jobs (maintenance), which is forbidden (git runs outside the sandbox)."
MSG_PR_CHECKOUT = "Checking out or fetching pull-request refs is forbidden: a pull request (including one from a fork) can change .claude/hooks, and the hooks are read from the working tree on every call. A human checks out pull requests."
MSG_GH = "This gh operation (merge/release/settings/secrets/auth/alias/extension/config/codespace/keys) is reserved for humans."
MSG_GH_API_PROTECTED = "Changing repository protection/secrets via gh api is forbidden."
MSG_GH_API_FIELDS = "gh api with write fields is reserved for humans."
MSG_RM_OUTSIDE = "rm target '{}' is outside the safe set (absolute/home/parent/variable paths are forbidden; \"$TMPDIR/<name>\" and paths under /tmp/claude-<uid>/ are allowed)."
MSG_RM_RECURSIVE = "Recursive rm is only allowed on build artefacts (dist/, coverage/, node_modules/, .tmp/) and temporary directories. Got '{}'."

# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------
NETWORK_CMDS = {"curl", "wget", "fetch"}
PRIV_CMDS = {"sudo", "doas", "su"}
REMOTE_CMDS = {"ssh", "scp", "sftp", "rsync"}
NODE_OPS_CMDS = {"symbol-bootstrap", "shoestring"}
DOCKER_CMDS = {"docker", "docker-compose"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
AWKS = {"awk", "gawk", "mawk", "nawk"}
WRAPPERS = {"env", "command", "builtin", "exec", "nice", "nohup", "time", "timeout", "stdbuf", "caffeinate",
            "arch", "busybox", "setsid", "xargs", "flock", "watch", "parallel", "script"}
RESERVED = {"if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "time", "coproc", "esac"}
DROP_REST = {"for", "select", "case", "function"}

INLINE_FLAGS = {  # interpreter -> (options whose value is code, options that take a non-code value)
    "node": ({"-e", "--eval", "-p", "--print"}, {"-r", "--require", "--import", "--loader", "--input-type", "--env-file", "-C", "--conditions"}),
    "bun": ({"-e", "--eval", "-p", "--print"}, {"-r", "--preload", "--cwd"}),
    "python": ({"-c"}, {"-W", "-X", "-Q"}),
    "perl": ({"-e", "-E"}, {"-I", "-M", "-m"}),
    "ruby": ({"-e"}, {"-I", "-r", "-C"}),
    "php": ({"-r"}, {"-c", "-d"}),
}
SPAWN_API = re.compile(
    r"child_process|\bexecSync\b|\bexecFileSync\b|\bspawnSync\b|\bspawn\s*\(|\bexecFile\s*\(|(?<![.\w])exec\s*\(|\bfork\s*\("
    r"|\bsubprocess\b|\bos\.(system|popen|exec\w*|spawn\w*|posix_spawn\w*)\b|\bpty\.spawn\b|\bpopen\s*\(|\bsystem\s*\("
    r"|\b__import__\b|\bimportlib\b|\bprocess\.(binding|dlopen)\b|_linkedBinding"
    r"|\bBun\.spawn|\bDeno\.(run|Command)\b|\bIO\.popen\b|\bOpen3\b|\bqx\b|\bproc_open\b|\bshell_exec\b|\bpassthru\b|\bpcntl_exec\b"
)
# perl / ruby / php also call these without parentheses, and run commands with backquotes or piped opens
SCRIPT_SPAWN = re.compile(r"\b(system|exec|fork|spawn|popen|qx|syscall|pipe)\b|%x|`|\|\s*['\"]|['\"]\s*-?\|")
WRITE_API = re.compile(
    r"writeFile|appendFile|createWriteStream|copyFile|\bcp(Sync)?\s*\(|\brename|\bunlink|\brmSync\b|\brm\s*\(|\brmdir|symlink|\bchmod"
    r"|\btruncate|\bopen\s*\([^)]*['\"][^'\"]*[wax+>]|write_text|write_bytes|\bshutil\b|\bos\.(remove|replace|rename)\b|File\.(write|open)|IO\.write"
)
PROTECTED_MENTION = re.compile(
    r"(?<![\w.-])(\.claude\b|\.github/workflows|CLAUDE\.md|AGENTS\.md|\.npmrc|package-lock\.json|LICENSE|SECURITY\.md|CODEOWNERS"
    r"|server\.json|mcpb/manifest\.json|\.gitignore|\.git/)|\bCLAUDE_ENV_FILE\b"
)
AWK_EXEC = re.compile(r"\bsystem\s*\(|\|\s*&|\|\s*\"|\|\s*getline|\bprintf?\b[^;{}\"|]*\|\s*[A-Za-z_(]")

PROTECTED_COMPONENT = re.compile(r"(^|/)(\.claude|\.git|\.husky)(/|$)|(^|/)\.github/(workflows(/|$)|CODEOWNERS$|dependabot\.yml$)")
PROTECTED_NAMES = {"CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".npmrc", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
                   "SECURITY.md", "CODEOWNERS", "server.json", ".gitignore", ".mcp.json", "lefthook.yml", ".pre-commit-config.yaml"}

GIT_C_ALLOWED = {"commit.gpgsign", "core.quotepath"}
GIT_C_ALLOWED_PREFIXES = ("color.", "advice.")
GIT_CONFIG_READ = {"--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin"}
GIT_CONFIG_WRITE = {"--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section", "-e", "--edit"}
GIT_PLUMBING = {"update-index", "mktree", "commit-tree", "fast-import", "read-tree", "checkout-index", "replace", "update-ref", "symbolic-ref"}
GIT_OTHER = {"send-email", "instaweb", "daemon", "svn", "p4", "cvsimport", "cvsserver", "cvsexportcommit", "archimport",
             "shell", "upload-pack", "receive-pack", "upload-archive",
             "maintenance"}  # register/start write the global config and a launchd/cron job that runs git later
GH_BLOCKED = {"secret", "variable", "auth", "alias", "extension", "extensions", "ext", "codespace", "cs", "ssh-key", "gpg-key"}
GH_WRITE_METHODS = {"DELETE", "PATCH", "PUT", "POST"}
REMOTE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
TAG_LIKE = re.compile(r"^v?\d+(\.\d+)+")
# Variables that change which configuration, programs or code git/gh and the processes they start
# (hooks, pagers, editors, ssh, gpg, interpreters) load. Those processes run outside the sandbox too.
EXEC_ENV = re.compile(
    r"(?<![\w${])(HOME|PATH|XDG_CONFIG_HOME|XDG_CONFIG_DIRS|EDITOR|VISUAL|PAGER|BROWSER|LESSOPEN|LESSCLOSE|GH_[A-Z0-9_]+|GIT_[A-Z0-9_]+"
    r"|BASH_ENV|ENV|SHELL|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_[A-Z0-9_]+|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP"
    r"|NODE_OPTIONS|NODE_PATH|PERL5LIB|PERL5OPT|RUBYOPT|RUBYLIB|SSH_ASKPASS|GNUPGHOME)(?!\w)"
)
SAFE_ENV = re.compile(r"(?<![\w${])(GIT_TERMINAL_PROMPT=0|GIT_OPTIONAL_LOCKS=0|(GIT_|GH_)?PAGER=cat)(?![\w])")
ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=")
ASSIGN_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?$")
TMP_VAR = re.compile(r"^(\$TMPDIR|\$\{TMPDIR\}|\$\{TMPDIR:\?[^}]*\})/(.+)$")
CLAUDE_TMP = re.compile(r"^/(private/)?tmp/claude-\d+/[^/]+/.+")
SHORT_CLUSTER = re.compile(r"^-[A-Za-z]+$")


# ---------------------------------------------------------------------------
# Shell lexer
# ---------------------------------------------------------------------------
class ParseError(Exception):
    pass


class Word(object):
    __slots__ = ("text", "quoted", "dynamic", "glob", "brace", "comma", "assign")

    def __init__(self):
        self.text = ""        # quotes removed; expansions kept as written ($X, $(...))
        self.assign = False   # starts with an unquoted NAME= (a variable assignment)
        self.quoted = False   # some part was quoted or escaped
        self.dynamic = False  # contains $var, ${...}, $(...), `...` or $'...'
        self.glob = False     # unquoted * ? [
        self.brace = False    # unquoted {
        self.comma = False    # unquoted ,


class HereDoc(object):
    __slots__ = ("strip", "delim", "quoted", "body")

    def __init__(self, strip):
        self.strip = strip
        self.delim = None
        self.quoted = False
        self.body = ""


OPERATORS = sorted(["&&", "||", ";;&", ";;", ";&", "|&", "&>>", "&>", ">>", ">|", ">&", "<<<", "<<-", "<<", "<&", "<>",
                    ";", "&", "|", "(", ")", "<", ">", "\n"], key=len, reverse=True)
REDIRECT_OPS = {">", ">>", ">|", ">&", "&>", "&>>", "<>", "<", "<&", "<<<"}
PIPE_OPS = {"|", "|&"}


def _skip_single(s, i):
    j = s.find("'", i)
    if j < 0:
        raise ParseError("unterminated single quote")
    return j + 1


def _scan_backtick(s, i):
    n = len(s)
    while i < n:
        if s[i] == "\\":
            i += 2
            continue
        if s[i] == "`":
            return i
        i += 1
    raise ParseError("unterminated backquote")


def _skip_double(s, i):
    n = len(s)
    while i < n:
        c = s[i]
        if c == "\\":
            i += 2
            continue
        if c == '"':
            return i + 1
        if c == "`":
            i = _scan_backtick(s, i + 1) + 1
            continue
        if c == "$" and i + 1 < n and s[i + 1] in "({":
            i = (_scan_group(s, i + 2, "(", ")") if s[i + 1] == "(" else _scan_group(s, i + 2, "{", "}")) + 1
            continue
        i += 1
    raise ParseError("unterminated double quote")


def _scan_group(s, i, open_c, close_c):
    depth = 1
    n = len(s)
    while i < n:
        c = s[i]
        if c == "\\":
            i += 2
            continue
        if c == "'":
            i = _skip_single(s, i + 1)
            continue
        if c == '"':
            i = _skip_double(s, i + 1)
            continue
        if c == "`":
            i = _scan_backtick(s, i + 1) + 1
            continue
        if c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ParseError("unterminated " + ("$(...) or <(...)" if open_c == "(" else "${...}"))


def _ansi_c(body):
    try:
        return body.encode("latin-1", "backslashreplace").decode("unicode_escape")
    except Exception:
        return body


def _lex_backtick(s, i, w, subs):
    j = _scan_backtick(s, i + 1)
    subs.append(re.sub(r"\\([\\`$])", r"\1", s[i + 1:j]))
    w.dynamic = True
    w.text += s[i:j + 1]
    return j + 1


def _collect_expansions(text, subs):
    _lex_dquote(text, 0, Word(), subs, None)


def _lex_dollar(s, i, w, subs, in_dq):
    n = len(s)
    nx = s[i + 1] if i + 1 < n else ""
    if nx == "(":
        j = _scan_group(s, i + 2, "(", ")")
        if s.startswith("((", i + 1) and j - 1 > i + 2 and s[j - 1] == ")":
            _collect_expansions(s[i + 3:j - 1], subs)  # arithmetic: only nested substitutions run
        else:
            subs.append(s[i + 2:j])
        w.dynamic = True
        w.text += s[i:j + 1]
        return j + 1
    if nx == "{":
        j = _scan_group(s, i + 2, "{", "}")
        _collect_expansions(s[i + 2:j], subs)
        w.dynamic = True
        w.text += s[i:j + 1]
        return j + 1
    if nx == "'" and not in_dq:
        j = i + 2
        while j < n and s[j] != "'":
            j += 2 if s[j] == "\\" else 1
        if j >= n:
            raise ParseError("unterminated $'...' string")
        w.text += _ansi_c(s[i + 2:j])
        w.quoted = True
        w.dynamic = True
        return j + 1
    if nx == '"' and not in_dq:
        w.quoted = True
        return _lex_dquote(s, i + 2, w, subs, '"')
    m = re.match(r"[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-]", s[i + 1:i + 200])
    if m:
        w.dynamic = True
        w.text += "$" + m.group(0)
        return i + 1 + len(m.group(0))
    w.text += "$"
    return i + 1


def _lex_dquote(s, i, w, subs, term):
    n = len(s)
    while i < n:
        c = s[i]
        if term is not None and c == term:
            return i + 1
        if c == "\\" and i + 1 < n:
            nx = s[i + 1]
            if nx in '$`"\\\n':
                if nx != "\n":
                    w.text += nx
                i += 2
                continue
            w.text += c
            i += 1
            continue
        if c == "`":
            i = _lex_backtick(s, i, w, subs)
            continue
        if c == "$":
            i = _lex_dollar(s, i, w, subs, True)
            continue
        w.text += c
        i += 1
    if term is not None:
        raise ParseError("unterminated double quote")
    return i


def _read_heredocs(s, i, pending, subs):
    n = len(s)
    for hd in pending:
        lines = []
        while True:
            j = s.find("\n", i)
            line = s[i:] if j < 0 else s[i:j]
            cmp = line.lstrip("\t") if hd.strip else line
            if cmp == hd.delim:
                i = n if j < 0 else j + 1
                break
            if j < 0:
                raise ParseError("unterminated heredoc (no line '{}')".format(hd.delim))
            lines.append(line)
            i = j + 1
        hd.body = "\n".join(lines)
        if not hd.quoted:
            _collect_expansions(hd.body, subs)
    return i


def _lex(s, subs):
    toks = []
    pending = []
    state = {"w": None, "delim": None}
    n = len(s)
    i = 0

    def word():
        if state["w"] is None:
            state["w"] = Word()
        return state["w"]

    def flush():
        w = state["w"]
        if w is None:
            return
        if state["delim"] is not None:
            state["delim"].delim = w.text
            state["delim"].quoted = w.quoted
            pending.append(state["delim"])
            state["delim"] = None
        else:
            toks.append(("word", w))
        state["w"] = None

    while i < n:
        c = s[i]
        if c in " \t\r":
            flush()
            i += 1
            continue
        if c == "\\":
            if i + 1 < n and s[i + 1] == "\n":
                i += 2
                continue
            w = word()
            w.quoted = True
            if i + 1 < n:
                w.text += s[i + 1]
            i += 2
            continue
        if c == "#" and state["w"] is None:
            j = s.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "'":
            w = word()
            j = _skip_single(s, i + 1)
            w.quoted = True
            w.text += s[i + 1:j - 1]
            i = j
            continue
        if c == '"':
            w = word()
            w.quoted = True
            i = _lex_dquote(s, i + 1, w, subs, '"')
            continue
        if c == "`":
            i = _lex_backtick(s, i, word(), subs)
            continue
        if c == "$":
            i = _lex_dollar(s, i, word(), subs, False)
            continue
        if c in "<>" and i + 1 < n and s[i + 1] == "(":
            j = _scan_group(s, i + 2, "(", ")")
            subs.append(s[i + 2:j])
            w = word()
            w.dynamic = True
            w.text += s[i:j + 1]
            i = j + 1
            continue
        if c in ";&|()<>\n":
            w = state["w"]
            if c in "<>" and w is not None and w.text.isdigit() and not w.quoted and not w.dynamic:
                state["w"] = None  # file-descriptor number of a redirection
            flush()
            op = next(o for o in OPERATORS if s.startswith(o, i))
            i += len(op)
            if op in ("<<", "<<-"):
                hd = HereDoc(op == "<<-")
                toks.append(("heredoc", hd))
                state["delim"] = hd
            else:
                if state["delim"] is not None:
                    raise ParseError("heredoc without a delimiter")
                toks.append(("op", op))
            if op == "\n" and pending:
                i = _read_heredocs(s, i, pending, subs)
                del pending[:]
            continue
        w = word()
        if c in "*?[":
            w.glob = True
        elif c == "{":
            w.brace = True
        elif c == ",":
            w.comma = True
        elif c == "=" and not w.quoted and not w.dynamic and not w.assign and ASSIGN_NAME.match(w.text):
            w.assign = True
        w.text += c
        i += 1
    flush()
    if state["delim"] is not None or pending:
        raise ParseError("unterminated heredoc")
    return toks


class Cmd(object):
    def __init__(self, piped_in):
        self.words = []
        self.redirs = []     # (op, Word)
        self.heredocs = []   # HereDoc
        self.piped_in = piped_in

    def empty(self):
        return not (self.words or self.redirs or self.heredocs)


def _build(toks):
    cmds = []
    cur = Cmd(False)
    i = 0
    n = len(toks)
    while i < n:
        kind, val = toks[i]
        if kind == "word":
            if not val.quoted and val.text in ("{", "}"):
                if not cur.empty():
                    cmds.append(cur)
                    cur = Cmd(False)
            else:
                cur.words.append(val)
        elif kind == "heredoc":
            cur.heredocs.append(val)
        elif val in REDIRECT_OPS:
            if i + 1 >= n or toks[i + 1][0] != "word":
                raise ParseError("redirection without a target")
            cur.redirs.append((val, toks[i + 1][1]))
            i += 1
        elif val in PIPE_OPS:
            cmds.append(cur)
            cur = Cmd(True)
        elif val == "(" and cur.empty():
            pass  # subshell start: keep the pipe state of the command that follows
        else:
            if not cur.empty():
                cmds.append(cur)
            cur = Cmd(False)
        i += 1
    cmds.append(cur)
    return [c for c in cmds if not c.empty()]


# ---------------------------------------------------------------------------
# Collecting what runs
# ---------------------------------------------------------------------------
class Ctx(object):
    def __init__(self, cwd, flat):
        self.cwd = cwd
        self.flat = flat
        self.cmds = []     # every simple command, for cd tracking
        self.invs = []     # (words, cmd): every command that runs, wrappers included
        self.writes = []   # Word: redirection targets
        self.codes = []    # (lang, code): inline interpreter code
        self.problems = []  # block reasons found while collecting
        self.asks = []     # reasons to ask a human
        without = re.sub(r"\$\{?TMPDIR", "", flat)
        # TMPDIR may be changed in this command line (assigned, exported, read, unset...); decide() also
        # counts a sourced file
        self.tmpdir_tainted = "TMPDIR" in without

    def bases(self):
        """Directories git/gh may run in: the session cwd and every literal cd target. None = unknown."""
        out = [self.cwd]
        cur = self.cwd
        for c in self.cmds:
            if not c.words:
                continue
            name = _base(c.words[0].text)
            if name not in ("cd", "pushd", "popd"):
                continue
            args = [w for w in c.words[1:] if not w.text.startswith("-")]
            if name == "popd" or not args or args[0].dynamic or args[0].glob or args[0].text == "-":
                return None
            cur = os.path.normpath(os.path.join(cur, os.path.expanduser(args[0].text)))
            out.append(cur)
        return out


MAX_DEPTH = 8


def _base(text):
    return os.path.basename(text)


def _texts(words):
    return [w.text for w in words]


def _is_cluster(t):
    return bool(SHORT_CLUSTER.match(t))


def _positionals(args):
    return [t for t in args if not t.startswith("-")]


def _collect(s, ctx, depth):
    if depth > MAX_DEPTH:
        raise ParseError("commands nested too deeply")
    subs = []
    toks = _lex(s, subs)
    for cmd in _build(toks):
        _process(cmd, ctx, depth)
    for sub in subs:
        _collect(sub, ctx, depth + 1)


def _process(cmd, ctx, depth):
    words = list(cmd.words)
    while words:
        w = words[0]
        if w.assign:
            words.pop(0)
            continue
        if not w.quoted and w.text in RESERVED:
            words.pop(0)
            if w.text == "time" and words and words[0].text == "-p":
                words.pop(0)
            continue
        break
    if words and not words[0].quoted and words[0].text in DROP_REST:
        words = []
    cmd.words = words
    ctx.cmds.append(cmd)
    for op, target in cmd.redirs:
        if target.text.startswith(("/dev/tcp/", "/dev/udp/")):
            ctx.problems.append(MSG_DEV_TCP)
        if op == "<<<" or op in ("<", "<&"):
            continue
        if op == ">&" and (target.text.isdigit() or target.text == "-"):
            continue
        ctx.writes.append(target)
    if words:
        _expand(words, cmd, ctx, depth)


def _skip_opts(a, i, with_value=()):
    n = len(a)
    while i < n and a[i].startswith("-") and a[i] != "-":
        if a[i] == "--":
            return i + 1
        i += 2 if a[i] in with_value else 1
    return i


def _option_value(a, names):
    """Values of options in names (separate or --opt=value)."""
    out = []
    for k, t in enumerate(a):
        if t in names and k + 1 < len(a):
            out.append(a[k + 1])
        for nm in names:
            if nm.startswith("--") and t.startswith(nm + "="):
                out.append(t.split("=", 1)[1])
    return out


def _wrapped(name, a):
    """For a wrapper, return (index of the wrapped command in a or None, shell strings it runs)."""
    n = len(a)
    i = 1
    if name == "env":
        while i < n:
            t = a[i]
            if t in ("-S", "--split-string"):
                return None, [" ".join(a[i + 1:])]
            if t.startswith("-S") or t.startswith("--split-string="):
                val = t[2:] if t.startswith("-S") else t.split("=", 1)[1]
                return None, [" ".join([val] + a[i + 1:])]
            if t in ("-u", "--unset", "-C", "--chdir", "-P"):
                i += 2
                continue
            if t == "--":
                i += 1
                break
            if (t.startswith("-") and t != "-") or ASSIGN_RE.match(t):
                i += 1
                continue
            break
    elif name in ("command", "builtin"):
        while i < n and a[i] == "-p":
            i += 1
        if i < n and a[i] in ("-v", "-V"):
            return None, []
    elif name == "exec":
        i = _skip_opts(a, i, ("-a",))
    elif name == "nice":
        i = _skip_opts(a, i, ("-n", "--adjustment"))
    elif name == "time":
        i = _skip_opts(a, i, ("-o", "--output", "-f", "--format"))
    elif name == "caffeinate":
        i = _skip_opts(a, i, ("-t", "-w"))
    elif name == "arch":
        i = _skip_opts(a, i, ("-e",))
    elif name == "stdbuf":
        i = _skip_opts(a, i, ("-i", "-o", "-e"))
    elif name == "setsid":
        i = _skip_opts(a, i)
    elif name == "timeout":
        i = _skip_opts(a, i, ("-s", "-k", "--signal", "--kill-after")) + 1
    elif name == "xargs":
        i = _skip_opts(a, i, ("-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--arg-file", "--delimiter", "--max-args",
                              "--max-procs", "--max-chars", "--max-lines", "--replace", "--eof"))
    elif name in ("flock", "script"):
        for k in range(1, n):
            if a[k] in ("-c", "--command") and k + 1 < n:
                return None, [a[k + 1]]
            if a[k].startswith("--command="):
                return None, [a[k].split("=", 1)[1]]
        if name == "flock":
            i = _skip_opts(a, i, ("-w", "--timeout", "-E", "--conflict-exit-code"))
            if i < n and a[i].isdigit():
                return None, []
        else:
            i = _skip_opts(a, i, ("-t", "-F", "-T", "-I", "-O", "-B", "-E", "-m", "--timing", "--log-in", "--log-out", "--log-io"))
        i += 1  # lock file / typescript file
    elif name == "watch":
        i = _skip_opts(a, i, ("-n", "--interval", "-q", "--equexit"))
        return None, ([" ".join(a[i:])] if i < n else [])
    elif name == "parallel":
        i = _skip_opts(a, i, ("-j", "-P", "--jobs", "-S", "--sshlogin", "-N", "-n", "-L", "-I", "--arg-sep", "-a", "--arg-file"))
        j = i
        while j < n and a[j] not in (":::", "::::", ":::+", "::::+"):
            j += 1
        return None, ([" ".join(a[i:j])] if j > i else [])
    # busybox, nohup: the command follows directly
    return (i if i < n else None), []


def _interp_lang(name):
    if name in ("node", "nodejs"):
        return "node"
    if name == "bun":
        return "bun"
    if re.match(r"^python[0-9.]*$", name):
        return "python"
    if name in ("perl", "ruby", "php"):
        return name
    return None


def _inline(lang, a):
    """Return (code strings, reads code from stdin)."""
    code_opts, value_opts = INLINE_FLAGS[lang]
    letters = {o[1] for o in code_opts if len(o) == 2}
    codes = []
    n = len(a)
    i = 1
    while i < n:
        t = a[i]
        if t == "-":
            return codes, not codes
        if t == "--":
            return codes, not codes and i + 1 >= n
        if t in code_opts:
            if i + 1 < n:
                codes.append(a[i + 1])
            i += 2
            continue
        if t in value_opts:
            i += 2
            continue
        if t.startswith("--"):
            key, _, val = t.partition("=")
            if key in code_opts and val:
                codes.append(val)
            i += 1
            continue
        if lang == "python" and t == "-m":
            return codes, False
        if lang in ("node", "bun") and _is_cluster(t) and t[-1] in "ep":
            if i + 1 < n:
                codes.append(a[i + 1])  # node -pe "code"
            i += 2
            continue
        if t.startswith("-") and len(t) > 2 and lang in ("python", "perl", "ruby", "php"):
            if _is_cluster(t) and t[-1] in letters:
                if i + 1 < n:
                    codes.append(a[i + 1])
                i += 2
                continue
            for k in range(1, len(t)):
                if t[k] in letters:
                    codes.append(t[k + 1:])
                    break
            i += 1
            continue
        if t.startswith("-"):
            i += 1
            continue
        return codes, False  # a script file
    return codes, not codes


def _awk_programs(a):
    progs = []
    has_file = False
    n = len(a)
    i = 1
    while i < n:
        t = a[i]
        if t == "--":
            i += 1
            break
        if t in ("-f", "--file"):
            has_file = True
            i += 2
            continue
        if t.startswith("--file="):
            has_file = True
            i += 1
            continue
        if t in ("-e", "--source"):
            progs.append(a[i + 1] if i + 1 < n else "")
            i += 2
            continue
        if t.startswith("--source="):
            progs.append(t.split("=", 1)[1])
            i += 1
            continue
        if t in ("-v", "-F", "--assign", "--field-separator"):
            i += 2
            continue
        if t.startswith("-") and t != "-":
            i += 1
            continue
        break
    if not progs and not has_file and i < n:
        progs.append(a[i])
    return progs


def _find_execs(words):
    out = []
    n = len(words)
    i = 1
    while i < n:
        if words[i].text in ("-exec", "-execdir", "-ok", "-okdir"):
            j = i + 1
            while j < n and words[j].text not in (";", "+"):
                j += 1
            if j > i + 1:
                out.append(words[i + 1:j])
            i = j
        i += 1
    return out


def _expand(words, cmd, ctx, depth):
    while words:
        ctx.invs.append((words, cmd))
        a = _texts(words)
        name = _base(a[0])
        if name in WRAPPERS:
            idx, strings = _wrapped(name, a)
            for st in strings:
                _collect(st, ctx, depth + 1)
            if idx is None:
                return
            words = words[idx:]
            continue
        if name == "find":
            for inner in _find_execs(words):
                _expand(inner, Cmd(False), ctx, depth)
        elif name == "trap":
            pos = [t for t in a[1:] if t not in ("-p", "-l", "--")]
            if pos and pos[0] not in ("-", ""):
                _collect(pos[0], ctx, depth + 1)
        elif name in SHELLS:
            for hd in cmd.heredocs:
                _collect(hd.body, ctx, depth + 1)
            for op, target in cmd.redirs:
                if op == "<<<":
                    _collect(target.text, ctx, depth + 1)
        else:
            lang = _interp_lang(name)
            if lang:
                codes, stdin = _inline(lang, a)
                if stdin:
                    codes += [hd.body for hd in cmd.heredocs]
                    codes += [t.text for op, t in cmd.redirs if op == "<<<"]
                for code in codes:
                    ctx.codes.append((lang, code))
        return


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------
def read_list(path):
    items = set()
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    items.add(line)
    except FileNotFoundError:
        pass
    return items


def _pkg_name(p):
    if p.startswith("@"):
        head, _, _ = p[1:].partition("@")
        return "@" + head
    return p.split("@")[0]


def check_installs(argv, allowed):
    """Block 'npm install <pkg>' etc. unless every package is in the allowlist."""
    tool = _base(argv[0])
    rest = argv[1:]
    pkgs = None
    if tool == "npm" and rest and rest[0] in ("install", "i", "add", "isntall", "in", "ins"):
        pkgs = [a for a in rest[1:] if not a.startswith("-")]
    elif tool == "pnpm" and rest and rest[0] in ("add", "install", "i"):
        pkgs = [a for a in rest[1:] if not a.startswith("-")]
    elif tool == "yarn" and rest and rest[0] == "add":
        pkgs = [a for a in rest[1:] if not a.startswith("-")]
    elif tool == "bun" and rest and rest[0] in ("add", "install", "i"):
        pkgs = [a for a in rest[1:] if not a.startswith("-")]
    problems = []
    for p in pkgs or []:
        if re.match(r"^(https?:|git\+|git:|github:|file:|\.|/)", p) or p.endswith((".tgz", ".tar.gz")):
            problems.append(f"'{p}' (URL/path/tarball installs are forbidden)")
        elif _pkg_name(p) not in allowed:
            problems.append(f"'{_pkg_name(p)}' (not in .claude/allowed-packages.txt)")
    return problems


def check_npx(argv, allowed):
    tool = _base(argv[0])
    rest = argv[1:]
    if tool == "npm" and rest and rest[0] in ("exec", "x"):
        pkgs = _option_value(rest, ("--package", "-p"))
        if not pkgs:
            args = [a for a in rest[1:] if not a.startswith("-")]
            pkgs = args[:1]
    elif tool in ("npx", "bunx") or (tool in ("pnpm", "yarn") and rest and rest[0] == "dlx"):
        if tool in ("pnpm", "yarn"):
            rest = rest[1:]
        args = [a for a in rest if not a.startswith("-")]
        pkgs = args[:1]
    else:
        return []
    return [f"'{_pkg_name(p)}' (not in .claude/allowed-npx.txt)" for p in pkgs if _pkg_name(p) not in allowed]


def _is_protected_path(p):
    p = p.replace(os.sep, "/")
    if PROTECTED_COMPONENT.search(p):
        return True
    name = p.rstrip("/").rsplit("/", 1)[-1]
    if name in PROTECTED_NAMES or name == "LICENSE" or name.startswith("LICENSE."):
        return True
    return p.endswith("mcpb/manifest.json")


def _protected_target(text, ctx):
    if not text or text == "-" or text.startswith("/dev/"):
        return False
    # Claude Code sources this file (and the shell snapshots under ~/.claude) before each Bash call
    if re.search(r"\$\{?CLAUDE_ENV_FILE\b", text) or _is_protected_path(text):
        return True
    p = os.path.expanduser(text)
    for base in ctx.bases() or [ctx.cwd]:
        ab = os.path.normpath(os.path.join(base, p))
        if _is_protected_path(ab) or _is_protected_path(os.path.realpath(ab)):
            return True
    return False


def _computed(text, ctx):
    """True when a path git/gh would write is computed at run time (other than "$TMPDIR/<name>")."""
    if not re.search(r"[$`]", text):
        return False
    m = TMP_VAR.match(text)
    return not (m and not ctx.tmpdir_tainted and not re.search(r"[$`]", m.group(2)) and ".." not in m.group(2).split("/"))


def _write_targets(name, a):
    args = a[1:]
    pos = _positionals(args)
    if name == "tee":
        return pos
    if name == "cp":
        t = _option_value(args, ("-t", "--target-directory"))
        return t or pos[-1:]
    if name in ("mv", "ln", "install", "rm", "rmdir", "unlink", "truncate", "touch", "mkdir", "chmod", "chown", "chgrp", "shred"):
        return pos
    if name == "sed" and any(t == "--in-place" or t.startswith(("--in-place=", "-i")) or (_is_cluster(t) and "i" in t) for t in args):
        return pos
    if name == "perl" and any(t.startswith("-i") or (_is_cluster(t) and "i" in t) for t in args):
        return pos
    if name == "dd":
        return [t[3:] for t in args if t.startswith("of=")]
    return []


def _tmp_target(w):
    t = w.text
    m = TMP_VAR.match(t)
    if m:
        rest = m.group(2)
    elif t.startswith("/") and not w.dynamic and CLAUDE_TMP.match(t):
        rest = t
    else:
        return False
    if re.search(r"[$`]", rest):
        return False
    parts = [p for p in rest.split("/") if p not in ("", ".")]
    if not parts or ".." in parts:
        return False
    return not re.match(r"^[*?\[\]]+$", parts[-1] if t.startswith("/") else parts[0])


def _rm(words, ctx):
    args = words[1:]
    flags = [w.text for w in args if w.text.startswith("-") and not w.dynamic]
    targets = [w for w in args if not (w.text.startswith("-") and not w.dynamic)]
    recursive = any("r" in f.lower() for f in flags)
    for w in targets:
        t = w.text
        if _tmp_target(w) and not (TMP_VAR.match(t) and ctx.tmpdir_tainted):
            continue
        if t.startswith(("/", "~", "$")) or w.dynamic or ".." in t or t in ("*", ".", "./"):
            return MSG_RM_OUTSIDE.format(t)
        if recursive and not t.rstrip("/").startswith(RM_ALLOWED_PREFIXES):
            return MSG_RM_RECURSIVE.format(t)
    return None


def _repo_dir(ctx, dir_words):
    bases = ctx.bases()
    if bases is None:
        return MSG_GIT_DIR
    for base in bases:
        d = base
        for w in dir_words:
            if w.dynamic or w.glob:
                return MSG_GIT_DIR
            d = os.path.normpath(os.path.join(d, os.path.expanduser(w.text)))
        real = os.path.realpath(d)
        if not (real == PROJECT_DIR or real.startswith(PROJECT_DIR + os.sep)):
            return MSG_GIT_DIR
        p = real
        while p != PROJECT_DIR:
            if os.path.lexists(os.path.join(p, ".git")):
                return MSG_GIT_DIR
            p = os.path.dirname(p)
    return None


def _git_tag(rest):
    write_long = {"--delete", "--annotate", "--sign", "--local-user", "--force", "--message", "--file", "--edit",
                  "--cleanup", "--create-reflog", "--trailer"}
    list_implied = {"--contains", "--no-contains", "--merged", "--no-merged", "--points-at"}
    with_value = list_implied | {"--sort", "--format", "--color", "--column"}
    listing = verify = False
    pos = []
    i = 0
    while i < len(rest):
        t = rest[i]
        if t == "--":
            pos += rest[i + 1:]
            break
        if t.startswith("--"):
            key = t.split("=", 1)[0]
            if key in write_long:
                return MSG_TAG
            if key == "--list" or key in list_implied:
                listing = True
            if key == "--verify":
                verify = True
            if key in with_value and "=" not in t:
                i += 1
            i += 1
            continue
        if _is_cluster(t):
            for ch in t[1:]:
                if ch in "dasufmFe":
                    return MSG_TAG
                if ch == "l":
                    listing = True
                if ch == "v":
                    verify = True
                if ch == "n":
                    listing = True
                    break
            i += 1
            continue
        if re.match(r"^-n\d+$", t):
            listing = True
            i += 1
            continue
        pos.append(t)
        i += 1
    if pos and not listing and not verify:
        return MSG_TAG
    return None


def _git_push(rest):
    blocked = {"--force": MSG_FORCE, "--force-with-lease": MSG_FORCE, "--force-if-includes": MSG_FORCE,
               "--delete": MSG_FORCE, "--mirror": MSG_FORCE, "--prune": MSG_FORCE, "--tags": MSG_TAG_PUSH,
               "--follow-tags": MSG_TAG_PUSH, "--all": MSG_MAIN, "--branches": MSG_MAIN, "--no-verify": MSG_NO_VERIFY,
               "--receive-pack": MSG_GIT_EXEC, "--exec": MSG_GIT_EXEC, "--recurse-submodules": MSG_GIT_NET}
    pos = []
    i = 0
    n = len(rest)
    while i < n:
        t = rest[i]
        if t == "--":
            pos += rest[i + 1:]
            break
        if t.startswith("--"):
            key = t.split("=", 1)[0]
            if key in blocked and not (key == "--recurse-submodules" and t.endswith("=no")):
                return blocked[key]
            if key == "--repo":
                val = t.split("=", 1)[1] if "=" in t else (rest[i + 1] if i + 1 < n else "")
                if not REMOTE_NAME.match(val):
                    return MSG_GIT_NET
                if "=" not in t:
                    i += 1
            elif key == "--push-option" and "=" not in t:
                i += 1
            i += 1
            continue
        if t.startswith("-") and t != "-":
            if "f" in t[1:] or "d" in t[1:]:
                return MSG_FORCE
            if t.endswith("o"):
                i += 1
            i += 1
            continue
        pos.append(t)
        i += 1
    if not pos:
        return None
    if not REMOTE_NAME.match(pos[0]):
        return MSG_GIT_NET
    for ref in pos[1:]:
        if ref.startswith(("+", ":")):
            return MSG_FORCE
        dst = ref.split(":", 1)[1] if ":" in ref else ref
        if "refs/tags" in ref or TAG_LIKE.match(dst):
            return MSG_TAG_PUSH
        if dst.startswith("refs/heads/"):
            dst = dst[len("refs/heads/"):]
        if dst in ("main", "master"):
            return MSG_MAIN
    return None


def _git_fetch(sub, rest):
    with_value = {"--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--jobs", "--server-option",
                  "--negotiation-tip", "--refmap", "--filter", "--strategy", "--strategy-option"}
    pos = []
    multiple = False
    i = 0
    n = len(rest)
    while i < n:
        t = rest[i]
        if t == "--":
            pos += rest[i + 1:]
            break
        if t.startswith("--"):
            key = t.split("=", 1)[0]
            if key in ("--upload-pack", "--receive-pack", "--exec"):
                return MSG_GIT_EXEC
            if key in ("--recurse-submodules", "--recurse-submodules-default") and not t.endswith("=no"):
                return MSG_GIT_NET
            if key == "--multiple":
                multiple = True
            if key in with_value and "=" not in t:
                i += 1
            i += 1
            continue
        if t.startswith("-") and t != "-":
            if sub == "ls-remote" and "u" in t[1:]:
                return MSG_GIT_EXEC
            if t in ("-j", "-o", "-s", "-X"):
                i += 1
            i += 1
            continue
        pos.append(t)
        i += 1
    for repo in (pos if multiple else pos[:1]):
        if not REMOTE_NAME.match(repo):
            return MSG_GIT_NET
    if sub in ("fetch", "pull") and any("pull/" in ref for ref in pos[1:]):
        return MSG_PR_CHECKOUT
    return None


def _git_config(rest):
    keys = [t.split("=", 1)[0] for t in rest]
    if any(k in GIT_CONFIG_WRITE for k in keys):
        return MSG_GIT_CONFIG
    pos = _positionals(rest)
    if pos and pos[0] in ("get", "list"):
        return None
    if any(k in GIT_CONFIG_READ or k.startswith("--get") for k in keys):
        return None
    return MSG_GIT_CONFIG


def _git(words, ctx):
    a = _texts(words)
    n = len(a)
    i = 1
    dirs = []
    while i < n:
        t = a[i]
        if t == "-C":
            if i + 1 < n:
                dirs.append(words[i + 1])
            i += 2
            continue
        if t.startswith("-c") and not t.startswith("--"):
            val = t[2:] if t != "-c" else (a[i + 1] if i + 1 < n else "")
            key = val.split("=", 1)[0].lower()
            if not (key in GIT_C_ALLOWED or key.startswith(GIT_C_ALLOWED_PREFIXES)):
                return MSG_GIT_C.format(key or "(missing)")
            i += 2 if t == "-c" else 1
            continue
        if t.startswith(("--config-env", "--exec-path=", "--git-dir", "--work-tree")):
            return MSG_GIT_LOCATION
        if t in ("--namespace", "--attr-source", "--list-cmds"):
            i += 2
            continue
        if t.startswith("-"):
            i += 1
            continue
        break
    r = _repo_dir(ctx, dirs)
    if r:
        return r
    if i >= n:
        return None
    sub = a[i]
    rest = a[i + 1:]
    pos = _positionals(rest)
    first = pos[0] if pos else None

    if sub == "tag":
        return _git_tag(rest)
    if sub == "push":
        r = _git_push(rest)
        if r:
            return r
        ctx.asks.append("git push to a feature branch")
        return None
    if sub in ("fetch", "pull", "ls-remote"):
        r = _git_fetch(sub, rest)
        if r:
            return r
    if sub == "clone":
        return MSG_GIT_NET
    if sub == "commit":
        if "--no-verify" in rest:
            return MSG_NO_VERIFY
        for t in rest:
            if t.startswith("-") and not t.startswith("--"):
                for ch in t[1:]:
                    if ch == "n":
                        return MSG_NO_VERIFY
                    if ch in "mFcCtuS":
                        break
    if sub == "config":
        return _git_config(rest)
    if sub == "remote" and first in ("add", "set-url", "remove", "rm", "rename"):
        return MSG_REMOTE_CHANGE
    if sub in ("filter-branch", "filter-repo"):
        return MSG_HISTORY
    if sub == "reflog" and first in ("expire", "delete"):
        return MSG_HISTORY
    if sub == "gc" and any(t.startswith("--prune") for t in rest):
        return MSG_HISTORY
    if sub == "submodule" and first not in (None, "status", "summary"):
        return MSG_SUBMODULE
    if sub == "bisect" and first == "run":
        return MSG_GIT_EXEC
    if sub == "rebase" and any(t.startswith(("-x", "--exec")) or (_is_cluster(t) and "x" in t) for t in rest):
        return MSG_GIT_EXEC
    if sub == "difftool" and any(t.startswith(("-x", "--extcmd")) or (_is_cluster(t) and "x" in t) for t in rest):
        return MSG_GIT_EXEC
    if sub == "grep" and any(t.startswith(("-O", "--open-files-in-pager")) or (_is_cluster(t) and "O" in t) for t in rest):
        return MSG_GIT_EXEC
    if sub == "archive" and any(t.startswith("--remote") for t in rest):
        return MSG_GIT_NET
    if sub in ("apply", "am"):
        if not any(t in ("--check", "--stat", "--numstat", "--summary") for t in rest) or "--apply" in rest:
            return MSG_APPLY
    if sub in GIT_PLUMBING:
        if not (sub == "update-index" and rest and all(t in ("--refresh", "--really-refresh", "-q") for t in rest)):
            return MSG_PLUMBING
    if sub in GIT_OTHER or sub.startswith(("credential", "remote-", "http-")):
        return MSG_GIT_OTHER

    # files git writes (it runs outside the sandbox, so the hook checks them)
    targets = _option_value(rest, ("--output", "--output-directory"))
    if sub in ("format-patch", "archive"):
        targets += _option_value(rest, ("-o",))
    if sub == "checkout" and "--" in rest:
        targets += rest[rest.index("--") + 1:]
    if sub in ("restore", "rm", "mv", "init"):
        targets += pos
    if sub in ("worktree", "bundle") and first in ("add", "create") and len(pos) > 1:
        targets.append(pos[1])
    for t in targets:
        if _protected_target(t, ctx) or _computed(t, ctx):
            return MSG_PROTECTED

    if sub in ("rebase", "merge", "cherry-pick"):
        ctx.asks.append("history-affecting git operation")
    discard = (
        (sub == "reset" and "--hard" in rest)
        or (sub == "clean" and any("--force" == t or (_is_cluster(t) and "f" in t) for t in rest))
        or (sub == "checkout" and "--" in rest and "." in rest[rest.index("--") + 1:])
        or (sub == "restore" and "." in pos)
        or (sub == "stash" and first in ("drop", "clear"))
        or (sub == "branch" and "-D" in rest)
    )
    if discard:
        ctx.asks.append("operation that discards work")
    return None


def _gh(words, ctx):
    a = _texts(words)
    rest = a[1:]
    pos = _positionals(rest)
    sub = pos[0] if pos else None
    verbs = set(pos[1:])
    r = _repo_dir(ctx, [])
    if r:
        return r
    if sub in GH_BLOCKED:
        return MSG_GH
    if sub == "config" and verbs & {"set", "clear-cache"}:
        return MSG_GH
    if sub == "pr" and verbs & {"checkout", "co"}:
        return MSG_PR_CHECKOUT
    if sub == "pr":
        if "merge" in verbs or ("review" in verbs and ("--approve" in rest or "-a" in rest)):
            return MSG_GH
        if verbs & {"create", "edit", "close", "reopen", "comment"}:
            ctx.asks.append("GitHub PR operation")
    if sub == "issue" and verbs & {"create", "edit", "close", "comment"}:
        ctx.asks.append("GitHub issue operation")
    if sub == "release" and (not verbs or not (verbs & {"view", "list"}) or verbs & {"create", "edit", "delete", "upload", "delete-asset", "download"}):
        return MSG_GH
    if sub == "repo" and verbs & {"delete", "edit", "deploy-key", "rename", "archive", "unarchive"}:
        return MSG_GH
    if sub == "api":
        for k, t in enumerate(rest):
            method = None
            if t in ("-X", "--method") and k + 1 < len(rest):
                method = rest[k + 1]
            elif t.startswith("--method="):
                method = t.split("=", 1)[1]
            elif t.startswith("-X") and len(t) > 2:
                method = t[2:]
            if method and method.upper() in GH_WRITE_METHODS:
                return MSG_GH
            if t in ("-f", "-F", "--field", "--raw-field", "--input") or t.startswith(("--field=", "--raw-field=", "--input=")) or re.match(r"^-[fF].", t):
                return MSG_GH_API_FIELDS
        if any(re.search(r"/(rulesets|branches/[^/\s]+/protection|hooks|keys|actions/secrets)", p) for p in pos):
            return MSG_GH_API_PROTECTED
    targets = _option_value(rest, ("-D", "--dir", "-O", "--output"))
    if sub in ("repo", "gist") and "clone" in verbs and len(pos) > 3:
        targets.append(pos[3])
    for t in targets:
        if _protected_target(t, ctx) or _computed(t, ctx):
            return MSG_PROTECTED
    return None


def _inv(words, cmd, ctx, allowed_pkgs, allowed_npx):
    """Rules for one command that runs. Returns a block reason or None."""
    a = _texts(words)
    w0 = words[0]
    if a[0] not in ("[", "[[") and (w0.dynamic or w0.glob or (w0.brace and (w0.comma or ".." in w0.text))):
        return MSG_DYNAMIC
    name = _base(a[0])
    args = a[1:]
    if name in NETWORK_CMDS:
        return MSG_NETWORK
    if name == "eval":
        return MSG_EVAL
    if (name == "alias" and any("=" in t for t in args)) or (name == "hash" and "-p" in args) or (name == "enable" and "-f" in args):
        return MSG_DYNAMIC
    if name in PRIV_CMDS:
        return MSG_PRIV
    if name in REMOTE_CMDS:
        return MSG_REMOTE
    if name in NODE_OPS_CMDS:
        return MSG_NODE_OPS
    if name in DOCKER_CMDS:
        return MSG_DOCKER
    if name in SHELLS:
        if any(t == "-c" or (_is_cluster(t) and "c" in t) for t in args):
            return MSG_SHELL_C
        stdin = not _positionals(args) or any(_is_cluster(t) and "s" in t for t in args)
        if stdin and cmd.piped_in:
            return MSG_PIPE_SHELL
    lang = _interp_lang(name)
    if lang:
        codes, stdin = _inline(lang, a)
        if stdin and cmd.piped_in:
            return MSG_PIPE_SHELL
    if name == "printenv":
        return MSG_ENV_DUMP
    if name == "env":
        idx, strings = _wrapped("env", a)
        if idx is None and not strings:
            return MSG_ENV_DUMP
    if name == "set" and not args:
        return MSG_ENV_DUMP
    if name == "export" and all(t == "-p" for t in args):
        return MSG_ENV_DUMP
    if name in ("declare", "typeset") and not [t for t in args if not t.startswith(("-", "+"))]:
        return MSG_ENV_DUMP
    for k, t in enumerate(args):
        if t.startswith("--registry"):
            return MSG_REGISTRY
        if t == "--ignore-scripts=false" or (t in ("--ignore-scripts", "ignore-scripts") and k + 1 < len(args) and args[k + 1] == "false"):
            return MSG_SCRIPTS
    if name == "npm":
        pos = _positionals(args)
        sub = pos[0] if pos else None
        if sub in ("publish", "unpublish", "deprecate", "owner", "access", "token", "login", "adduser", "logout", "whoami"):
            return MSG_NPM
        if sub == "set" or (sub in ("config", "c") and len(pos) > 1 and pos[1] in ("set", "edit", "delete")):
            return MSG_NPM
        if sub in ("exec", "x") and any(t in ("-c", "--call") or t.startswith("--call=") for t in args):
            return MSG_NPM_EXEC_C
        if sub in ("update", "upgrade", "dedupe") or (sub == "audit" and len(pos) > 1 and pos[1] == "fix"):
            ctx.asks.append("dependency tree change")
    if name in ("pnpm", "yarn"):
        pos = _positionals(args)
        if pos and (pos[0] in ("publish", "login") or (pos[0] == "config" and len(pos) > 1 and pos[1] == "set")):
            return MSG_PNPM
    if name == "git":
        r = _git(words, ctx)
        if r:
            return r
    if name == "gh":
        r = _gh(words, ctx)
        if r:
            return r
    if name in AWKS and any(AWK_EXEC.search(p) for p in _awk_programs(a)):
        return MSG_AWK
    if name == "rm":
        r = _rm(words, ctx)
        if r:
            return r
    for t in _write_targets(name, a):
        if _protected_target(t, ctx):
            return MSG_PROTECTED
    problems = check_installs(a, allowed_pkgs)
    if problems:
        return ("dependency not approved: " + ", ".join(problems)
                + ". Ask a human to add it to .claude/allowed-packages.txt (with a justification) before installing.")
    problems = check_npx(a, allowed_npx)
    if problems:
        return ("npx/dlx of unapproved package: " + ", ".join(problems)
                + ". npx downloads and runs arbitrary code; only packages listed in .claude/allowed-npx.txt may be run.")
    return None


def decide(cmd, cwd):
    """Return ("block", reason), ("ask", what) or None."""
    flat = " ".join(cmd.split())
    for pattern, reason in TEXT_RULES:
        if re.search(pattern, flat, flags=re.IGNORECASE):
            return "block", reason
    ctx = Ctx(cwd, flat)
    try:
        _collect(cmd, ctx, 0)
    except ParseError as e:
        return "block", MSG_PARSE.format(e)
    except RecursionError:
        return "block", MSG_PARSE.format("nested too deeply")
    if ctx.problems:
        return "block", ctx.problems[0]
    if any(words[0].text in ("source", ".") for words, _ in ctx.invs):
        ctx.tmpdir_tainted = True  # a sourced file can change TMPDIR
    allowed_pkgs = read_list(ALLOWED_PACKAGES_FILE)
    allowed_npx = read_list(ALLOWED_NPX_FILE)
    for words, c in ctx.invs:
        r = _inv(words, c, ctx, allowed_pkgs, allowed_npx)
        if r:
            return "block", r
    for lang, code in ctx.codes:
        if SPAWN_API.search(code) or (lang in ("perl", "ruby", "php") and SCRIPT_SPAWN.search(code)):
            return "block", MSG_INLINE_SPAWN
        if PROTECTED_MENTION.search(code) and WRITE_API.search(code):
            return "block", MSG_INLINE_WRITE
    git_gh = any(_base(words[0].text) in ("git", "gh") for words, _ in ctx.invs)
    for w in ctx.writes:
        # With git/gh the whole command may run outside the sandbox, so a computed target is refused too.
        if _protected_target(w.text, ctx) or (git_gh and w.dynamic and _computed(w.text, ctx)):
            return "block", MSG_PROTECTED
    if git_gh:
        m = EXEC_ENV.search(SAFE_ENV.sub("", flat))
        if m:
            return "block", MSG_GIT_ENV.format(m.group(1))
    if ctx.asks:
        return "ask", ctx.asks[0]
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)
    if data.get("tool_name") != "Bash":
        sys.exit(0)
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if not cmd.strip():
        sys.exit(0)
    cwd = os.path.realpath(data.get("cwd") or PROJECT_DIR)

    result = decide(cmd, cwd)
    if result and result[0] == "block":
        flat = " ".join(cmd.split())
        print(f"BLOCKED by guard-bash: {result[1]}\nCommand: {flat}", file=sys.stderr)
        sys.exit(2)
    if result and result[0] == "ask":
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "ask",
                "permissionDecisionReason": f"guard-bash: {result[1]} requires human confirmation.",
            }
        }))
    sys.exit(0)


if __name__ == "__main__":
    main()
