# Security Policy

## Scope

symbol-mcp-server is a **read-only** MCP server. It never handles private keys, mnemonics, or
tokens, never signs or announces transactions, and only makes network requests to the node URL(s)
the user configures via environment variables.

The only thing it writes to disk is the snapshot file of `symbol_harvester_watch`, and only when
`SYMBOL_STATE_DIR` is set: one file per node in that directory, holding unlocked harvester public
keys, heights and times (no secrets). The directory is created with mode 0700 if it does not exist,
and each write goes to a temporary file with mode 0600 that is renamed into place.

A way to break any of these properties is in scope: making the server accept or reveal a secret,
contact a host other than `SYMBOL_NODE_URL` and `SYMBOL_REFERENCE_NODES`, or write outside
`SYMBOL_STATE_DIR`.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability")
on this repository. Do not open a public issue for security problems.

You can expect an acknowledgement within 7 days. Please include reproduction steps and the version
(`npm ls symbol-mcp-server`), and allow reasonable time for a fix before public disclosure.

## Supported versions

Only the latest published minor version receives security fixes.

## Development safeguards

This repository is developed with an AI coding agent under deterministic guardrails
(`.claude/hooks/`, `.claude/settings.json`), branch protection, secret scanning with push protection,
Dependabot, and releases published through npm trusted publishing (OIDC, provenance attested).
See `GUARDRAILS.md` for the full model.
