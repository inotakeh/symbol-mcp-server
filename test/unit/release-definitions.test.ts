/**
 * The version rule of DESIGN-BRIEF §5 as the release check applies it (scripts/release-definitions.mjs):
 * which parts of the definitions are descriptive text, which changes are shape, how a version and
 * its CHANGELOG.md section are judged, and how the previous definitions are read from git.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compareDefinitions,
  DEFINITIONS_SNAPSHOT,
  definitionsCheck,
  MAX_LISTED_CHANGES,
  PREVIOUS_FLAG,
  readSnapshotAt,
  splitDefinitions,
  unreadableDefinitions,
} from '../../scripts/release-definitions.mjs';
import { RESTART_BANNER } from '../../scripts/release-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Definitions as JSON, edited freely by the tests. */
// biome-ignore lint/suspicious/noExplicitAny: test data reached into at any depth
type Json = Record<string, any>;

/** Small definitions with every schema position the walk knows, and fields named like keywords. */
function definitions(): Json {
  return {
    instructions: 'Use the tools.',
    tools: [
      {
        name: 'tool_a',
        title: 'Tool A',
        description: 'Does A.',
        annotations: { title: 'A', readOnlyHint: true },
        inputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'How many.', default: 10, minimum: 1 },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Line 1 answers.' },
            description: { type: 'string', description: 'A field named description.' },
            title: {
              anyOf: [{ type: 'string', description: 'A field named title.' }, { type: 'null' }],
            },
            list: {
              type: 'array',
              items: {
                type: 'object',
                properties: { id: { type: 'string', title: 'Id' } },
                additionalProperties: { type: 'string', description: 'Any other key.' },
              },
            },
            kind: { type: 'string', enum: ['a', 'b'] },
            properties: { type: 'object', properties: { title: { type: 'string' } } },
            fixed: { const: { description: 'a value, not a keyword' } },
            word: { type: 'string', default: 'description' },
          },
          required: ['summary', 'kind'],
        },
      },
      {
        name: 'tool_b',
        title: 'Tool B',
        description: 'Does B.',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      },
    ],
    prompts: [
      {
        name: 'prompt_p',
        title: 'Prompt P',
        description: 'A prompt.',
        arguments: [
          { name: 'account', description: 'An address.', required: true },
          { name: 'extra', required: false },
        ],
      },
    ],
  };
}

/** A copy of the definitions changed by `edit`. */
function edited(edit: (d: Json) => void): Json {
  const copy = definitions();
  edit(copy);
  return copy;
}

const outputProperties = (d: Json) => d.tools[0].outputSchema.properties;

describe('splitDefinitions', () => {
  it('takes out exactly the descriptive text, by path', () => {
    const { texts } = splitDefinitions(definitions());
    expect([...texts.keys()]).toEqual([
      '/instructions',
      '/tools/tool_a/title',
      '/tools/tool_a/description',
      '/tools/tool_a/annotations/title',
      '/tools/tool_a/inputSchema/properties/limit/description',
      '/tools/tool_a/outputSchema/properties/summary/description',
      '/tools/tool_a/outputSchema/properties/description/description',
      '/tools/tool_a/outputSchema/properties/title/anyOf/0/description',
      '/tools/tool_a/outputSchema/properties/list/items/properties/id/title',
      '/tools/tool_a/outputSchema/properties/list/items/additionalProperties/description',
      '/tools/tool_b/title',
      '/tools/tool_b/description',
      '/prompts/prompt_p/title',
      '/prompts/prompt_p/description',
      '/prompts/prompt_p/arguments/account/description',
    ]);
  });

  it('keeps the fields named description, title or properties, and the values of value keywords', () => {
    const tool = splitDefinitions(definitions()).tools.get('tool_a') as Json;
    const properties = tool.outputSchema.properties;
    expect(Object.keys(properties)).toEqual([
      'summary',
      'description',
      'title',
      'list',
      'kind',
      'properties',
      'fixed',
      'word',
    ]);
    expect(properties.description).toEqual({ type: 'string' });
    expect(properties.title).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(properties.properties).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
    });
    expect(properties.fixed).toEqual({ const: { description: 'a value, not a keyword' } });
    expect(properties.word).toEqual({ type: 'string', default: 'description' });
    expect(tool.annotations).toEqual({ readOnlyHint: true });
    expect(tool.inputSchema.properties.limit).toEqual({ type: 'number', default: 10, minimum: 1 });
  });
});

describe('compareDefinitions', () => {
  it('finds nothing between equal definitions', () => {
    expect(compareDefinitions(definitions(), definitions())).toEqual({
      shapeChanges: [],
      textChanges: [],
      textOwners: [],
    });
  });

  const textOnly: Array<[string, (d: Json) => void, string]> = [
    ['the instructions', (d) => (d.instructions = 'Use them well.'), '/instructions'],
    [
      'a tool description',
      (d) => (d.tools[0].description = 'Does A well.'),
      '/tools/tool_a/description',
    ],
    ['a tool title', (d) => (d.tools[1].title = 'B'), '/tools/tool_b/title'],
    [
      'the title in annotations',
      (d) => (d.tools[0].annotations.title = 'AA'),
      '/tools/tool_a/annotations/title',
    ],
    [
      'an input field description',
      (d) => (d.tools[0].inputSchema.properties.limit.description = 'How many rows.'),
      '/tools/tool_a/inputSchema/properties/limit/description',
    ],
    [
      'a description in an anyOf branch',
      (d) => (outputProperties(d).title.anyOf[0].description = 'Changed.'),
      '/tools/tool_a/outputSchema/properties/title/anyOf/0/description',
    ],
    [
      'a title under items',
      (d) => (outputProperties(d).list.items.properties.id.title = 'Key'),
      '/tools/tool_a/outputSchema/properties/list/items/properties/id/title',
    ],
    [
      'a description under additionalProperties',
      (d) => (outputProperties(d).list.items.additionalProperties.description = 'Other.'),
      '/tools/tool_a/outputSchema/properties/list/items/additionalProperties/description',
    ],
    [
      'the description of a field named description',
      (d) => (outputProperties(d).description.description = 'Changed.'),
      '/tools/tool_a/outputSchema/properties/description/description',
    ],
    [
      'a prompt description',
      (d) => (d.prompts[0].description = 'Changed.'),
      '/prompts/prompt_p/description',
    ],
    [
      'a prompt argument description',
      (d) => (d.prompts[0].arguments[0].description = 'A base32 address.'),
      '/prompts/prompt_p/arguments/account/description',
    ],
  ];
  it.each(textOnly)('counts %s as text only', (_what, edit, path) => {
    expect(compareDefinitions(definitions(), edited(edit))).toEqual({
      shapeChanges: [],
      textChanges: [path],
      textOwners: [path === '/instructions' ? 'instructions' : path.split('/')[2]],
    });
  });

  const shape: Array<[string, (d: Json) => void, string]> = [
    [
      'an output field added',
      (d) => (outputProperties(d).extra = { type: 'string' }),
      '/tools/tool_a/outputSchema/properties/extra: added',
    ],
    [
      'the field named description removed',
      (d) => delete outputProperties(d).description,
      '/tools/tool_a/outputSchema/properties/description: removed',
    ],
    [
      'a type changed',
      (d) => (outputProperties(d).summary.type = 'number'),
      '/tools/tool_a/outputSchema/properties/summary/type: changed "string" -> "number"',
    ],
    [
      'an enum value added',
      (d) => outputProperties(d).kind.enum.push('c'),
      '/tools/tool_a/outputSchema/properties/kind/enum: added "c"',
    ],
    [
      'the order of an enum',
      (d) => outputProperties(d).kind.enum.reverse(),
      '/tools/tool_a/outputSchema/properties/kind/enum: order changed',
    ],
    [
      'a required field added',
      (d) => d.tools[0].outputSchema.required.push('word'),
      '/tools/tool_a/outputSchema/required: added "word"',
    ],
    [
      'a default',
      (d) => (d.tools[0].inputSchema.properties.limit.default = 20),
      '/tools/tool_a/inputSchema/properties/limit/default: changed 10 -> 20',
    ],
    [
      'a minimum',
      (d) => (d.tools[0].inputSchema.properties.limit.minimum = 0),
      '/tools/tool_a/inputSchema/properties/limit/minimum: changed 1 -> 0',
    ],
    [
      'a const, even a description inside it',
      (d) => (outputProperties(d).fixed.const.description = 'another value'),
      '/tools/tool_a/outputSchema/properties/fixed/const/description: changed "a value, not a keyword" -> "another value"',
    ],
    [
      'additionalProperties',
      (d) => (d.tools[0].inputSchema.additionalProperties = true),
      '/tools/tool_a/inputSchema/additionalProperties: changed false -> true',
    ],
    [
      '$schema',
      (d) => (d.tools[0].inputSchema.$schema = 'http://json-schema.org/draft-07/schema#'),
      '/tools/tool_a/inputSchema/$schema: changed "https://json-schema.org/draft/2020-12/schema" -> "http://json-schema.org/draft-07/schema#"',
    ],
    [
      'an annotation hint',
      (d) => (d.tools[1].annotations.readOnlyHint = false),
      '/tools/tool_b/annotations/readOnlyHint: changed true -> false',
    ],
    ['a tool added', (d) => d.tools.push({ ...d.tools[1], name: 'tool_c' }), 'tool added: tool_c'],
    ['a tool removed', (d) => d.tools.pop(), 'tool removed: tool_b'],
    ['the order of the tools', (d) => d.tools.reverse(), 'order of the tools changed'],
    ['a prompt added', (d) => d.prompts.push({ name: 'prompt_q' }), 'prompt added: prompt_q'],
    [
      'whether a prompt argument is required',
      (d) => (d.prompts[0].arguments[1].required = true),
      '/prompts/prompt_p/arguments/extra/required: changed false -> true',
    ],
    [
      'a prompt argument added',
      (d) => d.prompts[0].arguments.push({ name: 'more', required: false }),
      '/prompts/prompt_p/arguments/more: added',
    ],
    [
      'the order of the prompt arguments',
      (d) => d.prompts[0].arguments.reverse(),
      'order of the arguments of prompt prompt_p changed',
    ],
    ['a new top-level key', (d) => (d.resources = []), '/resources: added'],
  ];
  it.each(shape)('counts %s as shape', (_what, edit, change) => {
    expect(compareDefinitions(definitions(), edited(edit)).shapeChanges).toEqual([change]);
  });

  it('takes only the title out of annotations: any other annotation is shape', () => {
    const before = edited((d) => (d.tools[1].annotations.description = 'x'));
    const after = edited((d) => (d.tools[1].annotations.description = 'y'));
    expect(compareDefinitions(before, after)).toEqual({
      shapeChanges: ['/tools/tool_b/annotations/description: changed "x" -> "y"'],
      textChanges: [],
      textOwners: [],
    });
  });

  it('keeps a __proto__ key, which JSON.parse makes an own property, as shape', () => {
    // Built with JSON.parse: an object literal would set the prototype instead of adding the key.
    const withProto = (value: number) =>
      JSON.parse(
        JSON.stringify(definitions())
          .replace('"readOnlyHint":true}', `"readOnlyHint":true,"__proto__":{"x":${value}}}`)
          .replace('"instructions":', `"__proto__":{"y":${value}},"instructions":`),
      ) as Json;
    expect(compareDefinitions(withProto(1), withProto(2)).shapeChanges).toEqual([
      '/tools/tool_a/annotations/__proto__/x: changed 1 -> 2',
      '/__proto__/y: changed 1 -> 2',
    ]);
  });

  it('compares a tool it cannot match by name whole, by its place in the list', () => {
    const withNull = edited((d) => d.tools.push(null));
    expect(compareDefinitions(definitions(), withNull).shapeChanges).toEqual(['/tools[2]: added']);
    const twice = edited((d) => d.tools.push({ ...d.tools[1], description: 'Again.' }));
    expect(compareDefinitions(definitions(), twice).shapeChanges).toEqual(['/tools[2]: added']);
    const badArgument = edited((d) => d.prompts[0].arguments.push(null));
    expect(compareDefinitions(definitions(), badArgument).shapeChanges).toEqual([
      '/prompts/prompt_p/arguments/[2]: added',
    ]);
  });

  it('compares required as a set: its order is no change at all', () => {
    const reordered = edited((d) => d.tools[0].outputSchema.required.reverse());
    expect(compareDefinitions(definitions(), reordered)).toEqual({
      shapeChanges: [],
      textChanges: [],
      textOwners: [],
    });
  });

  it('names the tools of a text change once each, in the order of the tools', () => {
    const changed = edited((d) => {
      d.tools[1].description = 'B again.';
      d.tools[0].description = 'A again.';
      d.tools[0].title = 'A again';
    });
    expect(compareDefinitions(definitions(), changed).textOwners).toEqual(['tool_a', 'tool_b']);
  });
});

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [1.3.0] - 2026-10-02',
  '',
  RESTART_BANNER,
  '',
  '### Added',
  '',
  '- A field.',
  '',
  '## [1.2.4] - 2026-10-01',
  '',
  '### Added',
  '',
  '- A field, without the banner.',
  '',
  '## [1.2.2] - 2026-09-01',
  '',
  '### Fixed',
  '',
  '- Something old.',
  '',
].join('\n');

function check(
  version: string,
  current: unknown,
  changelog = CHANGELOG,
  previous: unknown = definitions(),
) {
  return definitionsCheck(version, {
    previousVersion: '1.2.2',
    previousLabel: 'v1.2.2',
    previous,
    current,
    changelog,
    diffCommand: `git diff v1.2.2 -- ${DEFINITIONS_SNAPSHOT}`,
  });
}

describe('definitionsCheck', () => {
  const extraField = edited((d) => (outputProperties(d).extra = { type: 'string' }));

  it('refuses definitions that are not a JSON object, instead of throwing', () => {
    for (const bad of [null, [], 'text']) {
      expect(check('1.2.3', bad)).toEqual({
        verdict: 'definitions not compared: the definitions are not a JSON object.',
        problems: [
          'the definitions in the committed snapshot are not a JSON object, so they cannot be compared.',
        ],
      });
      expect(check('1.2.3', definitions(), CHANGELOG, bad).problems).toEqual([
        'the definitions in v1.2.2 are not a JSON object, so they cannot be compared.',
      ]);
    }
  });

  it('passes a patch with no change or with descriptive text only, and says which', () => {
    expect(check('1.2.3', definitions())).toEqual({
      verdict: 'definitions compared with v1.2.2: no change.',
      problems: [],
    });
    const text = edited((d) => {
      d.instructions = 'Changed.';
      d.tools[1].description = 'Changed.';
    });
    expect(check('1.2.3', text)).toEqual({
      verdict:
        'definitions compared with v1.2.2: descriptive text only, 2 paths in instructions, tool_b; a patch needs no restart note.',
      problems: [],
    });
  });

  it('refuses a patch whose definitions changed shape, with both ways out', () => {
    const result = check('1.2.3', extraField);
    expect(result.verdict).toBe(
      'definitions compared with v1.2.2: the shape changed (1 change), so 1.2.3 needs a minor or major version and the restart note.',
    );
    expect(result.problems).toEqual([
      [
        'the definitions changed shape since 1.2.2, so 1.2.3 cannot be a patch (DESIGN-BRIEF §5, "The version follows the shape of the definitions"). Release 1.3.0 or a later version and start its CHANGELOG.md section with',
        `  ${RESTART_BANNER}`,
        'or revert the change.',
        'Shape changes (1):',
        '  /tools/tool_a/outputSchema/properties/extra: added',
        `Full diff: git diff v1.2.2 -- ${DEFINITIONS_SNAPSHOT}`,
      ].join('\n'),
    ]);
  });

  it('passes a minor or major version whose section starts with the restart banner', () => {
    expect(check('1.3.0', extraField).problems).toEqual([]);
    const major = CHANGELOG.replace('## [1.3.0] - 2026-10-02', '## [2.0.0] - 2026-10-02');
    expect(check('2.0.0', extraField, major).problems).toEqual([]);
  });

  it('asks for the banner as the first line of the section of a minor that changed shape', () => {
    const noBanner = CHANGELOG.replace(`${RESTART_BANNER}\n\n`, '');
    const result = check('1.3.0', extraField, noBanner);
    expect(result.problems).toEqual([
      [
        'the definitions changed shape since 1.2.2, but the CHANGELOG.md section for 1.3.0 does not start with the restart note. Put this line first in it:',
        `  ${RESTART_BANNER}`,
        'Shape changes (1):',
        '  /tools/tool_a/outputSchema/properties/extra: added',
        `Full diff: git diff v1.2.2 -- ${DEFINITIONS_SNAPSHOT}`,
      ].join('\n'),
    ]);
    // A section that is not written yet is reported by releaseProblems, not here.
    expect(check('1.4.0', extraField).problems).toEqual([]);
  });

  it('does not take a note that no restart is needed, or a later mention, for the banner', () => {
    for (const notice of [
      '> No MCP host restart is needed after upgrading.',
      `### Added\n\n- A field; ${RESTART_BANNER.replace(/^> /, '')}`,
    ]) {
      const changelog = CHANGELOG.replace(RESTART_BANNER, notice);
      expect(check('1.3.0', extraField, changelog).problems, notice).toHaveLength(1);
    }
  });

  it('refuses a version that is not newer than the previous release', () => {
    expect(check('1.2.2', definitions()).problems).toEqual([
      '1.2.2 is not newer than the previous release 1.2.2 in CHANGELOG.md.',
    ]);
  });

  it(`lists at most ${MAX_LISTED_CHANGES} shape changes and counts the rest`, () => {
    const many = edited((d) => {
      for (let i = 0; i < MAX_LISTED_CHANGES + 5; i++) {
        outputProperties(d)[`extra${String(i).padStart(2, '0')}`] = { type: 'string' };
      }
    });
    const [problem] = check('1.2.3', many).problems;
    const lines = problem?.split('\n') ?? [];
    expect(lines).toContain(`Shape changes (${MAX_LISTED_CHANGES + 5}):`);
    expect(lines.filter((l) => l.endsWith(': added'))).toHaveLength(MAX_LISTED_CHANGES);
    expect(lines).toContain('  and 5 more');
  });
});

describe('readSnapshotAt', () => {
  it('reads the committed snapshot of a commit', () => {
    const read = readSnapshotAt('HEAD', DEFINITIONS_SNAPSHOT, ROOT);
    expect(read.ok).toBe(true);
    const value = (read as { value: { tools?: unknown[] } }).value;
    expect(Array.isArray(value.tools)).toBe(true);
    expect(value.tools?.length).toBeGreaterThan(0);
  });

  it('tells a ref git does not know from a path the ref does not have', () => {
    expect(readSnapshotAt('refs/tags/no-such-release', DEFINITIONS_SNAPSHOT, ROOT)).toMatchObject({
      ok: false,
      reason: 'ref',
    });
    expect(readSnapshotAt('HEAD', 'test/no-such-snapshot.json', ROOT)).toMatchObject({
      ok: false,
      reason: 'path',
    });
    // package.json is committed but is not the snapshot: it still parses; README.md does not.
    expect(readSnapshotAt('HEAD', 'README.md', ROOT)).toMatchObject({ ok: false, reason: 'json' });
  });

  it('reads the same file the working tree has when nothing is uncommitted', () => {
    const read = readSnapshotAt('HEAD', 'package.json', ROOT);
    expect(read.ok).toBe(true);
    expect((read as { value: { name?: string } }).value.name).toBe(
      (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string }).name,
    );
  });
});

describe('unreadableDefinitions', () => {
  const git = `git show v1.2.2:${DEFINITIONS_SNAPSHOT}`;
  it('names both causes of an unknown tag: no tags in the checkout, or no such tag', () => {
    const failure = { reason: 'ref', detail: "fatal: invalid object name 'v1.2.2'." } as const;
    const noSuchTag =
      '1.2.2 is the greatest version with a dated section in CHANGELOG.md below this one, so v1.2.2 must exist; if it was never tagged, or its tag was deleted, restore the tag or remove that dated section on main.';
    expect(unreadableDefinitions('1.2.2', 'v1.2.2', failure, { inWorkflow: false })).toBe(
      `cannot read the definitions of the previous release 1.2.2: ${git} failed (fatal: invalid object name 'v1.2.2'.). Fetch the tags (git pull, or git fetch --tags) and run the check again. If v1.2.2 is still unknown: ${noSuchTag}`,
    );
    expect(unreadableDefinitions('1.2.2', 'v1.2.2', failure, { inWorkflow: true })).toBe(
      `cannot read the definitions of the previous release 1.2.2: ${git} failed (fatal: invalid object name 'v1.2.2'.). Either the publish job's checkout lacks fetch-depth: 0 in .github/workflows/release.yml (a re-run uses the workflow of the tag, so fix it on main and tag again), or the tag is missing: ${noSuchTag}`,
    );
  });

  it('points a release without the snapshot to --previous-definitions, outside the workflow', () => {
    expect(
      unreadableDefinitions(
        '1.2.2',
        'v1.2.2',
        { reason: 'path', detail: 'x' },
        { inWorkflow: false },
      ),
    ).toBe(
      `cannot read the definitions of the previous release 1.2.2: v1.2.2 has no ${DEFINITIONS_SNAPSHOT} (the snapshot exists from 0.9.2 on). Outside the release workflow, compare with a file instead: ${PREVIOUS_FLAG} <file>.`,
    );
    expect(
      unreadableDefinitions(
        '1.2.2',
        'v1.2.2',
        { reason: 'json', detail: 'Unexpected token' },
        { inWorkflow: true },
      ),
    ).toBe(
      `cannot read the definitions of the previous release 1.2.2: ${git} is not valid JSON (Unexpected token).`,
    );
  });
});
