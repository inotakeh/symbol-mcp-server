/**
 * Deterministic check of evals/cases.json: every expected tool exists and every expected argument
 * set is accepted by that tool's inputSchema. No LLM, no network, no server start-up.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { TOOLS } from '../../src/server.js';

const CASES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'evals', 'cases.json');
const MIN_CASES = 10;

const CaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  audience: z.enum(['node-operator', 'general']),
  question: z.string().min(1),
  question_ja: z.string().min(1),
  expectedTool: z.string().regex(/^symbol_[a-z_]+$/),
  expectedArguments: z.record(z.string(), z.unknown()),
  notes: z.string().min(1),
});
const FileSchema = z.object({
  $comment: z.string().optional(),
  cases: z.array(CaseSchema).min(MIN_CASES),
});

const file = FileSchema.parse(JSON.parse(readFileSync(CASES_PATH, 'utf8')));
const toolsByName = new Map<string, (typeof TOOLS)[number]>(TOOLS.map((t) => [t.name, t]));

describe('evals/cases.json', () => {
  it(`has at least ${MIN_CASES} cases with unique ids and both audiences`, () => {
    const ids = file.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const audiences = new Set(file.cases.map((c) => c.audience));
    expect(audiences).toEqual(new Set(['node-operator', 'general']));
  });

  it('references every registered tool at least once', () => {
    const referenced = new Set(file.cases.map((c) => c.expectedTool));
    const missing = TOOLS.map((t) => t.name).filter((name) => !referenced.has(name));
    expect(missing, 'tools without an eval case').toEqual([]);
  });

  for (const c of file.cases) {
    it(`${c.id}: ${c.expectedTool} accepts ${JSON.stringify(c.expectedArguments)}`, () => {
      const tool = toolsByName.get(c.expectedTool);
      expect(tool, `unknown tool ${c.expectedTool}`).toBeDefined();
      if (!tool) return;
      if (tool.inputSchema === undefined) {
        expect(c.expectedArguments, `${c.expectedTool} takes no arguments`).toEqual({});
        return;
      }
      const parsed = (tool.inputSchema as z.ZodObject).safeParse(c.expectedArguments);
      expect(parsed.success, parsed.success ? '' : z.prettifyError(parsed.error)).toBe(true);
      // Arguments must be spelled exactly as the schema names them: no silently dropped keys.
      if (parsed.success) {
        const declared = new Set(Object.keys((tool.inputSchema as z.ZodObject).shape));
        for (const key of Object.keys(c.expectedArguments)) expect(declared.has(key)).toBe(true);
      }
    });
  }
});
