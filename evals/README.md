# evals

Representative questions a user might ask an assistant that has this server attached, together
with the tool call a well-behaved model is expected to make. They document intended tool selection
and argument shapes for the 13 tools, and they double as a deterministic regression test.

## Files

- `cases.json` — the cases. Each entry:

  | Field | Meaning |
  |---|---|
  | `id` | Unique kebab-case identifier. |
  | `audience` | `node-operator` or `general`. |
  | `question` / `question_ja` | The user's question in English and Japanese. |
  | `expectedTool` | Name of the tool the model should call. |
  | `expectedArguments` | The arguments it should pass. `{}` for tools without input. |
  | `notes` | Why this tool and these arguments; common confusions to avoid. |

- `../test/evals/cases.test.ts` — validates the file without an LLM or a network:
  - every `expectedTool` is a registered tool (`TOOLS` in `src/server.ts`);
  - `expectedArguments` parses against that tool's `inputSchema` (or is `{}` when the tool takes
    no input);
  - ids are unique, both audiences are present, there are at least 10 cases, and every registered
    tool is referenced by at least one case.

  It runs as part of `npm test`.

## Adding a case

1. Append an object to `cases` in `cases.json`. Use synthetic or public, non-sensitive identifiers
   only: the synthetic fixture account (`fixture` in `test/fixtures/address-vectors.json`, see
   `test/fixtures/README.md`) and a captured public transaction hash from `test/fixtures/mainnet/`
   are already used.
2. Run `npm test`. The test fails with the zod error if the arguments do not fit the tool's schema,
   which is usually the point: the case then shows how the schema should be read.
3. If you add a tool, add at least one case for it or the coverage assertion fails.

## What this is not

The cases are not executed against a model. A future LLM-based evaluation (send `question` to a
model with the server attached, compare its first tool call with `expectedTool` and
`expectedArguments`) can reuse this file as its dataset, but that would need API credentials and is
deliberately outside `npm test`.
