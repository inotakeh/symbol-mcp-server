#!/usr/bin/env python3
"""
watch-hooks: stop every tool call while the repository's hooks or Claude Code settings differ from a version a
human reviewed and recorded.

The repository's hooks (.claude/hooks/*.py) are read from the working tree on every call, so a pull, a checkout
or any program outside the sandbox that changes them changes the guardrails at once. This script is the canonical
copy; a human installs a copy OUTSIDE the repository and registers it in the user settings (~/.claude/settings.json),
where the agent cannot write (the sandbox and guard-files refuse it). See GUARDRAILS.md.

Subcommands
  check   [--record PATH]                        the hook (PreToolUse and ConfigChange). Reads the hook input on stdin.
  status  --repo DIR [--record PATH]              show which accepted set the working tree matches (read only)
  record  --repo DIR [--id NAME] [--record PATH] [--yes]
                                                  accept the files as they are now (asks for "y" unless --yes)
  forget  --id NAME [--record PATH]               remove an accepted set

Watched files (relative to the repository): .claude/hooks/*.py, .claude/settings.json, .claude/settings.local.json,
.claude/allowed-*.txt. A file that appears or disappears is a change too.

check exits 0 when the project is not the recorded repository, or when the watched files match one accepted set
exactly (same files, same SHA-256). Otherwise it exits 2 (block; stderr is shown to Claude). A missing or unreadable
record blocks only in a project that carries this script (.claude/hooks/watch-hooks.py), so other projects keep
working.

Only the Python standard library is used (python3 3.9 or later).
"""
import datetime
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile

RECORD_DEFAULT = os.path.join(os.path.expanduser("~"), ".claude", "hooks", "symbol-mcp-server", "accepted.json")
MAX_SETS = 5
CANONICAL = os.path.join(".claude", "hooks", "watch-hooks.py")

MSG_BLOCK = ("watch-hooks: the repository's hooks or Claude Code settings differ from the version a human accepted "
             "({}). Every tool call is stopped until a human reviews the change and records it "
             "(watch-hooks.py record, GUARDRAILS.md). Do not look for a way around this: tell the human and stop.")
MSG_NO_RECORD = ("watch-hooks: the record of accepted hooks ({}) is missing or unreadable, so the repository's hooks "
                 "cannot be checked. Every tool call is stopped until a human records them (watch-hooks.py record, "
                 "GUARDRAILS.md). Do not look for a way around this: tell the human and stop.")


class RecordError(Exception):
    pass


def _is_dir(path):
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except OSError:
        return False


def _sha256(path):
    """SHA-256 of a regular file, or a marker for anything else (a symbolic link, a directory, unreadable)."""
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return "not-a-regular-file"
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return "unreadable"


def watched_files(repo):
    """{relative path: sha256} of the watched files. The file system may ignore letter case, so names are compared
    in lower case (".claude/hooks/X.PY" counts as a hook). A symbolic link in place of .claude or .claude/hooks is
    recorded as such, so it never matches an accepted set."""
    out = {}
    claude = os.path.join(repo, ".claude")
    hooks = os.path.join(claude, "hooks")
    for d, rel in ((claude, ".claude"), (hooks, ".claude/hooks")):
        if os.path.lexists(d) and not _is_dir(d):
            out[rel] = "not-a-directory"
    if _is_dir(claude):
        for name in sorted(os.listdir(claude)):
            low = name.lower()
            if low in ("settings.json", "settings.local.json") or (low.startswith("allowed-") and low.endswith(".txt")):
                out[".claude/" + name] = _sha256(os.path.join(claude, name))
    if _is_dir(hooks):
        for name in sorted(os.listdir(hooks)):
            if name.lower().endswith(".py"):
                out[".claude/hooks/" + name] = _sha256(os.path.join(hooks, name))
    return out


def load_record(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise RecordError(str(e))
    if not (isinstance(data, dict) and data.get("version") == 1 and isinstance(data.get("repo"), str)
            and isinstance(data.get("sets"), list)):
        raise RecordError("unexpected format")
    for s in data["sets"]:
        if not (isinstance(s, dict) and isinstance(s.get("id"), str) and isinstance(s.get("files"), dict)):
            raise RecordError("unexpected format")
    return data


def matching_set(record, files):
    for s in record["sets"]:
        if s["files"] == files:
            return s
    return None


def describe_changes(old, new):
    """File names that were added, removed or changed between two {path: sha256} maps."""
    names = sorted(set(old) | set(new))
    parts = []
    for n in names:
        if n not in old:
            parts.append(n + " (new)")
        elif n not in new:
            parts.append(n + " (removed)")
        elif old[n] != new[n]:
            parts.append(n + " (changed)")
    return parts


def _project_dir(data):
    p = os.environ.get("CLAUDE_PROJECT_DIR") or (data.get("cwd") if isinstance(data, dict) else None)
    return os.path.realpath(p) if p else None


def cmd_check(record_path):
    try:
        data = json.load(sys.stdin)
        readable = isinstance(data, dict)
    except ValueError:
        data, readable = {}, False
    project = _project_dir(data)
    if not project:
        return 0
    try:
        record = load_record(record_path)
    except RecordError:
        if os.path.lexists(os.path.join(project, CANONICAL)):
            print(MSG_NO_RECORD.format(record_path), file=sys.stderr)
            return 2
        return 0
    if os.path.realpath(record["repo"]) != project:
        return 0
    if not readable:
        print("watch-hooks: the hook input is not the JSON Claude Code sends; blocking.", file=sys.stderr)
        return 2
    files = watched_files(project)
    if matching_set(record, files):
        return 0
    latest = record["sets"][-1]["files"] if record["sets"] else {}
    changes = describe_changes(latest, files) or ["no accepted set"]
    more = " and {} more".format(len(changes) - 5) if len(changes) > 5 else ""
    print(MSG_BLOCK.format(", ".join(changes[:5]) + more), file=sys.stderr)
    return 2


def _git(repo, args):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"})
    try:
        r = subprocess.run(["git", "--no-pager", "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"] + args,
                           cwd=repo, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.decode("utf-8", "replace").strip() if r.returncode == 0 else None


def write_record(path, record):
    d = os.path.dirname(path)
    if not os.path.isdir(d):
        os.makedirs(d, mode=0o700)
    fd, tmp = tempfile.mkstemp(prefix=".accepted-", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2, sort_keys=True)
            f.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _installed_copy_note(repo):
    """A note when this script is not the repository's canonical copy (the installed copy is out of date)."""
    canonical = os.path.join(repo, CANONICAL)
    here = os.path.realpath(__file__)
    if os.path.realpath(canonical) == here or not os.path.exists(canonical):
        return None
    if _sha256(canonical) != _sha256(here):
        return "note: {} differs from the repository's {}; copy it again after reviewing.".format(here, CANONICAL)
    return None


def cmd_status(repo, record_path):
    repo = os.path.realpath(repo)
    files = watched_files(repo)
    try:
        record = load_record(record_path)
    except RecordError as e:
        print("no usable record at {} ({})".format(record_path, e))
        return 1
    if os.path.realpath(record["repo"]) != repo:
        print("the record is for {}, not {}".format(record["repo"], repo))
        return 1
    hit = matching_set(record, files)
    for s in record["sets"]:
        mark = "*" if s is hit else " "
        print("{} {:<30} commit {} {} recorded {}".format(mark, s["id"], (s.get("commit") or "?")[:12],
                                                          "dirty" if s.get("dirty") else "clean", s.get("recordedAt", "?")))
    if hit:
        print("the working tree matches '{}'".format(hit["id"]))
    else:
        latest = record["sets"][-1]["files"] if record["sets"] else {}
        print("the working tree matches no accepted set; against the latest: "
              + (", ".join(describe_changes(latest, files)) or "no accepted set"))
    note = _installed_copy_note(repo)
    if note:
        print(note)
    return 0 if hit else 1


def cmd_record(repo, record_path, set_id, yes):
    repo = os.path.realpath(repo)
    if not os.path.isdir(os.path.join(repo, ".claude")):
        print("{} has no .claude directory".format(repo), file=sys.stderr)
        return 1
    try:
        record = load_record(record_path)
    except RecordError:
        if os.path.exists(record_path):
            print("the record at {} is unreadable; move it away first".format(record_path), file=sys.stderr)
            return 1
        record = {"version": 1, "repo": repo, "sets": []}
    if os.path.realpath(record["repo"]) != repo:
        print("the record is for {}, not {}".format(record["repo"], repo), file=sys.stderr)
        return 1
    files = watched_files(repo)
    bad = [n for n, h in files.items() if len(h) != 64]
    if bad:
        print("not recorded: not regular files: " + ", ".join(bad), file=sys.stderr)
        return 1
    hit = matching_set(record, files)
    if hit:
        print("already accepted as '{}'".format(hit["id"]))
        return 0
    commit = _git(repo, ["rev-parse", "HEAD"])
    porcelain = _git(repo, ["status", "--porcelain", "--"] + sorted(files))
    branch = _git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) or "unknown"
    set_id = set_id or "{}-{}".format(branch.replace("/", "-"), (commit or "nocommit")[:7])
    latest = record["sets"][-1] if record["sets"] else None
    print("repository: " + repo)
    print("commit:     {}{}".format(commit or "unknown", " (with uncommitted changes to watched files)" if porcelain else ""))
    if latest:
        print("changes since '{}': {}".format(latest["id"], ", ".join(describe_changes(latest["files"], files))))
    else:
        print("first record: " + ", ".join(sorted(files)))
    note = _installed_copy_note(repo)
    if note:
        print(note)
    if not yes:
        if not sys.stdin.isatty():
            print("not recorded: confirm on a terminal, or pass --yes", file=sys.stderr)
            return 1
        if input("Record these files as accepted as '{}'? [y/N] ".format(set_id)).strip().lower() != "y":
            print("not recorded")
            return 1
    record["sets"] = [s for s in record["sets"] if s["id"] != set_id]
    record["sets"].append({
        "id": set_id,
        "commit": commit,
        "dirty": bool(porcelain) or commit is None,
        "recordedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "files": files,
    })
    record["sets"] = record["sets"][-MAX_SETS:]
    write_record(record_path, record)
    print("recorded '{}' ({} sets kept)".format(set_id, len(record["sets"])))
    return 0


def cmd_forget(record_path, set_id):
    try:
        record = load_record(record_path)
    except RecordError as e:
        print("no usable record at {} ({})".format(record_path, e), file=sys.stderr)
        return 1
    kept = [s for s in record["sets"] if s["id"] != set_id]
    if len(kept) == len(record["sets"]):
        print("no set '{}'".format(set_id), file=sys.stderr)
        return 1
    record["sets"] = kept
    write_record(record_path, record)
    print("forgot '{}' ({} sets kept)".format(set_id, len(kept)))
    return 0


def _options(argv, names, flags=()):
    out = {}
    i = 0
    while i < len(argv):
        t = argv[i]
        if t in flags:
            out[t] = True
            i += 1
        elif t in names and i + 1 < len(argv):
            out[t] = argv[i + 1]
            i += 2
        else:
            raise SystemExit("unknown or incomplete argument: " + t)
    return out


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    sub, rest = argv[0], argv[1:]
    if sub == "check":
        # a hook must never crash open: anything unexpected in this project blocks
        try:
            opts = _options(rest, ("--record",))
            return cmd_check(opts.get("--record", RECORD_DEFAULT))
        except BaseException as e:  # noqa: BLE001 (SystemExit from a bad argument must block too)
            print("watch-hooks: internal error ({}); blocking.".format(type(e).__name__), file=sys.stderr)
            return 2
    if sub == "status":
        opts = _options(rest, ("--repo", "--record"))
        return cmd_status(opts.get("--repo") or ".", opts.get("--record", RECORD_DEFAULT))
    if sub == "record":
        opts = _options(rest, ("--repo", "--record", "--id"), ("--yes",))
        if "--repo" not in opts:
            raise SystemExit("record needs --repo DIR")
        return cmd_record(opts["--repo"], opts.get("--record", RECORD_DEFAULT), opts.get("--id"), opts.get("--yes", False))
    if sub == "forget":
        opts = _options(rest, ("--record", "--id"))
        if "--id" not in opts:
            raise SystemExit("forget needs --id NAME")
        return cmd_forget(opts.get("--record", RECORD_DEFAULT), opts["--id"])
    print("unknown subcommand: " + sub, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
