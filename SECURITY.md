# Security Policy

## Scope

symbol-mcp-server is a **read-only** MCP server. It never handles private keys, mnemonics, or
tokens, never signs or announces transactions, and only makes network requests to the node URL(s)
the user configures via environment variables.

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
