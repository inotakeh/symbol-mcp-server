#!/usr/bin/env python3
"""
PostToolUse hook for Edit / Write / MultiEdit (Claude Code).

After the agent writes a file, scan that file for credential-looking content.
PostToolUse cannot undo the write, but exit 2 makes the finding loud: stderr is
shown to Claude with an instruction to remove the secret immediately, before it
can be committed. GitHub secret scanning + push protection is the next layer.

To exempt a file that legitimately contains known public test vectors, put the
marker `secrets-scan:ignore-file` anywhere in the file (e.g. in a comment).

Private identifiers: if `.claude/private-identifiers.txt` exists (it is
gitignored and never committed), every non-empty, non-comment line in it is a
literal string that must not appear in any written file (case-insensitive).
Use it for hostnames, addresses and public keys that identify the operator.
The ignore-file marker does NOT exempt a file from this check.
Override the list path with SCAN_SECRETS_PRIVATE_LIST (used by test-hooks.sh).
"""
import json
import os
import re
import sys

PATTERNS = [
    (r"-----BEGIN (RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----", "private key block"),
    (r"\bsk-ant-[A-Za-z0-9_\-]{20,}", "Anthropic API key"),
    (r"\bnpm_[A-Za-z0-9]{36}\b", "npm access token"),
    (r"\bgh[pousr]_[A-Za-z0-9]{36,}\b", "GitHub token"),
    (r"\bgithub_pat_[A-Za-z0-9_]{22,}\b", "GitHub fine-grained token"),
    (r"\bAKIA[0-9A-Z]{16}\b", "AWS access key id"),
    (r"\bxox[abprs]-[A-Za-z0-9\-]{10,}", "Slack token"),
    (r"\bAIza[0-9A-Za-z_\-]{35}\b", "Google API key"),
    # Symbol / NEM: a 64-hex value labelled as a private key
    (r"(?i)(private[_\s-]?key|privateKey|signerPrivateKey|harvesterSigningPrivateKey|harvesterVrfPrivateKey|votingKey|mnemonic)\s*[:=]\s*['\"]?[0-9A-Fa-f]{64}\b", "Symbol/NEM private key"),
    (r"(?i)\b(mnemonic|seed[_\s-]?phrase)\s*[:=]\s*['\"]([a-z]+\s+){11,23}[a-z]+['\"]", "mnemonic phrase"),
    # Generic assignment of a long secret-looking literal
    (r"(?i)\b(api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd)\s*[:=]\s*['\"][^'\"\s]{16,}['\"]", "hard-coded credential literal"),
]

SKIP_DIRS = ("node_modules/", "dist/", "coverage/", ".git/")

PROJECT_DIR = os.path.realpath(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
DEFAULT_PRIVATE_LIST = os.path.join(PROJECT_DIR, ".claude", "private-identifiers.txt")


def load_private_identifiers():
    path = os.environ.get("SCAN_SECRETS_PRIVATE_LIST") or DEFAULT_PRIVATE_LIST
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if len(s) < 6:
            continue  # too short to be a meaningful identifier; avoid mass false positives
        out.append(s)
    return out


def main():
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)
    if data.get("tool_name") not in ("Edit", "Write", "MultiEdit"):
        sys.exit(0)
    path = (data.get("tool_input") or {}).get("file_path") or ""
    if not path or any(s in path.replace(os.sep, "/") for s in SKIP_DIRS):
        sys.exit(0)
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            text = f.read()
    except OSError:
        sys.exit(0)

    # 1. Private identifiers (never exempted by the ignore marker)
    lowered = text.lower()
    private_hits = []
    for ident in load_private_identifiers():
        if ident.lower() in lowered:
            line_no = lowered.count("\n", 0, lowered.index(ident.lower())) + 1
            private_hits.append(f"line {line_no}: private identifier ({ident[:6]}…)")
    if private_hits:
        print(
            f"PRIVATE IDENTIFIER DETECTED by scan-secrets in {path}: " + "; ".join(private_hits[:10]) + ". "
            "This repository is public; operator-identifying hosts, addresses and keys must not be written "
            "anywhere. Replace the value with a placeholder or a synthetic fixture value and do not mention "
            "the original in commit messages, docs or chat summaries.",
            file=sys.stderr,
        )
        sys.exit(2)

    if "secrets-scan:ignore-file" in text:
        sys.exit(0)

    # 2. Credential patterns
    findings = []
    for pattern, label in PATTERNS:
        for m in re.finditer(pattern, text):
            line_no = text.count("\n", 0, m.start()) + 1
            findings.append(f"line {line_no}: {label}")
    if findings:
        msg = (
            f"SECRET DETECTED by scan-secrets in {path}: " + "; ".join(findings[:10]) + ". "
            "Remove it now. Never write real credentials into the repository. If this is a documented public "
            "test vector, keep it in test/fixtures/ and add the marker 'secrets-scan:ignore-file' with a comment "
            "explaining its origin."
        )
        print(msg, file=sys.stderr)
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
