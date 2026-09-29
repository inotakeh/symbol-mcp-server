/**
 * The version rule of DESIGN-BRIEF §5 ("The version follows the shape of the definitions") as the
 * release check applies it. The tool and prompt definitions of a release are compared with those
 * of the previous release, both as the committed snapshot of test/tools/published_definitions.test.ts
 * has them. A change to their shape needs a minor or major version and the restart banner; a change
 * to descriptive text only may ship in a patch.
 *
 * Descriptive text is a closed list, and everything else the definitions publish is shape:
 * - the server instructions;
 * - the description and title of every tool, and the title in its annotations;
 * - the description and title of every prompt and of every prompt argument;
 * - the JSON Schema keywords description and title in the input and output schemas, found by
 *   walking only the positions that hold schemas. The names under properties (and the other name
 *   maps) stay, even a field called description or title. Value keywords (default, const, enum,
 *   examples, required, ...) are compared whole, and so is any keyword not listed here, so an
 *   unknown place can only make a text change count as shape (a minor too many), never hide a
 *   shape change.
 * Tools, prompts and prompt arguments are matched by name; adding, removing or reordering them is
 * shape. `required` is compared as a set: its order means nothing to a validator.
 *
 * Every function here is pure except readSnapshotAt, which runs `git show` when it is called;
 * importing the module does nothing. Development and CI only; the MCP server never loads this file.
 */
import { spawnSync } from 'node:child_process';
import {
  extractSection,
  hasRestartBanner,
  nextMinorVersion,
  RESTART_BANNER,
  versionBump,
} from './release-files.mjs';

/** The committed definitions, written by test/tools/published_definitions.test.ts. */
export const DEFINITIONS_SNAPSHOT = 'test/tools/__snapshots__/published-definitions.json';

/** Shape changes listed in a message; the rest are counted. */
export const MAX_LISTED_CHANGES = 20;

/** The release check's option to compare with a file instead of the tag (never in the workflow). */
export const PREVIOUS_FLAG = '--previous-definitions';

const TEXT_KEYWORDS = new Set(['description', 'title']);
/** Keywords whose value maps names to schemas: the names are kept. */
const NAME_MAPS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
/** Keywords whose value is one schema. `items` may also be a list (draft-07 tuples). */
const ONE_SCHEMA = new Set([
  'items',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'additionalItems',
  'propertyNames',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
]);
/** Keywords whose value is a list of schemas. */
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A JSON Schema without its description and title keywords, which go into `texts` by path. Any
 * schema may be a boolean; a value that is not an object is kept as it is. Shapes are built with
 * Object.fromEntries so that every key stays an own property, `__proto__` included.
 */
function splitSchema(schema, path, texts) {
  if (!isObject(schema)) return schema;
  const entries = [];
  for (const [key, value] of Object.entries(schema)) {
    const at = `${path}/${key}`;
    if (TEXT_KEYWORDS.has(key) && typeof value === 'string') {
      texts.set(at, value);
    } else if (NAME_MAPS.has(key) && isObject(value)) {
      entries.push([
        key,
        Object.fromEntries(
          Object.entries(value).map(([name, sub]) => [
            name,
            splitSchema(sub, `${at}/${name}`, texts),
          ]),
        ),
      ]);
    } else if ((SCHEMA_LISTS.has(key) || key === 'items') && Array.isArray(value)) {
      entries.push([key, value.map((sub, i) => splitSchema(sub, `${at}/${i}`, texts))]);
    } else if (ONE_SCHEMA.has(key)) {
      entries.push([key, splitSchema(value, at, texts)]);
    } else if (key === 'dependencies' && isObject(value)) {
      // draft-07: a schema, or a list of property names compared whole.
      entries.push([
        key,
        Object.fromEntries(
          Object.entries(value).map(([name, dep]) => [
            name,
            isObject(dep) ? splitSchema(dep, `${at}/${name}`, texts) : dep,
          ]),
        ),
      ]);
    } else if (key === 'required' && Array.isArray(value)) {
      entries.push([key, [...value].sort()]);
    } else {
      entries.push([key, value]);
    }
  }
  return Object.fromEntries(entries);
}

/** An object without the text keys named in `keys`, which go into `texts` under `path`. */
function withoutText(object, path, texts, keys = TEXT_KEYWORDS) {
  const entries = [];
  for (const [key, value] of Object.entries(object)) {
    if (keys.has(key) && typeof value === 'string') texts.set(`${path}/${key}`, value);
    else entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

/** Only the title of the annotations is descriptive text; any other annotation is shape. */
const ANNOTATION_TEXT = new Set(['title']);

function splitTool(tool, texts) {
  const path = `/tools/${tool.name}`;
  const shape = withoutText(tool, path, texts);
  if (isObject(shape.annotations)) {
    shape.annotations = withoutText(
      shape.annotations,
      `${path}/annotations`,
      texts,
      ANNOTATION_TEXT,
    );
  }
  for (const key of ['inputSchema', 'outputSchema']) {
    if (Object.hasOwn(shape, key)) shape[key] = splitSchema(shape[key], `${path}/${key}`, texts);
  }
  return shape;
}

/** Something that can be matched by name: an object with a string name. */
function named(value) {
  return isObject(value) && typeof value.name === 'string';
}

function splitPrompt(prompt, texts) {
  const path = `/prompts/${prompt.name}`;
  const shape = withoutText(prompt, path, texts);
  const argumentOrder = [];
  if (Array.isArray(shape.arguments)) {
    // An argument that cannot be matched by name, or a repeated name, is compared whole by index.
    shape.arguments = Object.fromEntries(
      shape.arguments.map((arg, i) => {
        if (!named(arg) || argumentOrder.includes(arg.name)) return [`[${i}]`, arg];
        argumentOrder.push(arg.name);
        return [arg.name, withoutText(arg, `${path}/arguments/${arg.name}`, texts)];
      }),
    );
  }
  return { shape, argumentOrder };
}

/**
 * The definitions (the snapshot's `{ instructions, prompts, tools }`) split into their shape,
 * keyed by name, and their descriptive text, by path. A tool or prompt that cannot be matched by
 * name (not an object, no string name, a repeated name) is compared whole, by index, as `rest`.
 */
export function splitDefinitions(definitions) {
  const texts = new Map();
  const tools = new Map();
  const prompts = new Map();
  const argumentOrders = new Map();
  const rest = [];
  for (const [key, value] of Object.entries(definitions)) {
    if (key === 'instructions' && typeof value === 'string') {
      texts.set('/instructions', value);
    } else if (key === 'tools' && Array.isArray(value)) {
      value.forEach((tool, i) => {
        if (named(tool) && !tools.has(tool.name)) tools.set(tool.name, splitTool(tool, texts));
        else rest.push([`tools[${i}]`, tool]);
      });
    } else if (key === 'prompts' && Array.isArray(value)) {
      value.forEach((prompt, i) => {
        if (named(prompt) && !prompts.has(prompt.name)) {
          const { shape, argumentOrder } = splitPrompt(prompt, texts);
          prompts.set(prompt.name, shape);
          argumentOrders.set(prompt.name, argumentOrder);
        } else {
          rest.push([`prompts[${i}]`, prompt]);
        }
      });
    } else {
      rest.push([key, value]);
    }
  }
  return {
    tools,
    toolOrder: [...tools.keys()],
    prompts,
    promptOrder: [...prompts.keys()],
    argumentOrders,
    rest: Object.fromEntries(rest),
    texts,
  };
}

/** JSON with the keys of every object sorted, so that equal values give equal strings. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** A value as a change line shows it: JSON, cut at 60 characters. */
function show(value) {
  const text = canonical(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** Appends one line per difference between two shapes: added, removed, or changed old -> new. */
function diffShapes(before, after, path, out) {
  if (canonical(before) === canonical(after)) return;
  if (before === undefined) {
    out.push(`${path}: added`);
  } else if (after === undefined) {
    out.push(`${path}: removed`);
  } else if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diffShapes(before[key], after[key], `${path}/${key}`, out);
    }
  } else if (Array.isArray(before) && Array.isArray(after)) {
    const nested = [...before, ...after].some((v) => isObject(v) || Array.isArray(v));
    if (nested && before.length === after.length) {
      for (const [i, v] of before.entries()) diffShapes(v, after[i], `${path}/${i}`, out);
    } else if (nested) {
      out.push(`${path}: changed ${show(before)} -> ${show(after)}`);
    } else {
      // A list of values (enum, required, type): what was added and removed, or its new order.
      const keys = (list) => list.map((v) => canonical(v));
      const added = keys(after).filter((v) => !keys(before).includes(v));
      const removed = keys(before).filter((v) => !keys(after).includes(v));
      const parts = [
        added.length > 0 ? `added ${added.join(', ')}` : null,
        removed.length > 0 ? `removed ${removed.join(', ')}` : null,
      ].filter((p) => p !== null);
      out.push(`${path}: ${parts.length > 0 ? parts.join('; ') : 'order changed'}`);
    }
  } else {
    out.push(`${path}: changed ${show(before)} -> ${show(after)}`);
  }
}

/** Items matched by name: added, removed, reordered, then their differences. */
function diffNamed(kind, before, beforeOrder, after, afterOrder, root, out) {
  for (const name of beforeOrder) if (!after.has(name)) out.push(`${kind} removed: ${name}`);
  for (const name of afterOrder) if (!before.has(name)) out.push(`${kind} added: ${name}`);
  const keptBefore = beforeOrder.filter((name) => after.has(name));
  const keptAfter = afterOrder.filter((name) => before.has(name));
  if (keptBefore.join('\n') !== keptAfter.join('\n')) out.push(`order of the ${kind}s changed`);
  for (const name of afterOrder) {
    if (before.has(name)) diffShapes(before.get(name), after.get(name), `${root}/${name}`, out);
  }
}

/** The tool, prompt or "instructions" a text path belongs to. */
function textOwner(path) {
  const [, kind, name] = path.split('/');
  return kind === 'instructions' ? 'instructions' : name;
}

/**
 * Differences between two sets of definitions: `shapeChanges`, one line each (empty when the
 * shape is the same), `textChanges`, the paths of the descriptive texts that differ, and
 * `textOwners`, the tools and prompts (or "instructions") those texts belong to.
 */
export function compareDefinitions(previous, current) {
  const a = splitDefinitions(previous);
  const b = splitDefinitions(current);
  const shapeChanges = [];
  diffNamed('tool', a.tools, a.toolOrder, b.tools, b.toolOrder, '/tools', shapeChanges);
  diffNamed('prompt', a.prompts, a.promptOrder, b.prompts, b.promptOrder, '/prompts', shapeChanges);
  for (const name of b.promptOrder) {
    const before = (a.argumentOrders.get(name) ?? []).filter((arg) =>
      (b.argumentOrders.get(name) ?? []).includes(arg),
    );
    const after = (b.argumentOrders.get(name) ?? []).filter((arg) =>
      (a.argumentOrders.get(name) ?? []).includes(arg),
    );
    if (a.prompts.has(name) && before.join('\n') !== after.join('\n')) {
      shapeChanges.push(`order of the arguments of prompt ${name} changed`);
    }
  }
  diffShapes(a.rest, b.rest, '', shapeChanges);

  const textChanges = [];
  for (const path of new Set([...b.texts.keys(), ...a.texts.keys()])) {
    if (a.texts.get(path) !== b.texts.get(path)) textChanges.push(path);
  }
  const textOwners = [...new Set(textChanges.map(textOwner))];
  return { shapeChanges, textChanges, textOwners };
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The shape changes as message lines: up to MAX_LISTED_CHANGES, then how many more. */
function listed(changes) {
  const lines = changes.slice(0, MAX_LISTED_CHANGES).map((change) => `  ${change}`);
  if (changes.length > MAX_LISTED_CHANGES) {
    lines.push(`  and ${changes.length - MAX_LISTED_CHANGES} more`);
  }
  return lines;
}

/**
 * The version rule for `version` against the release before it: `verdict`, one line that says
 * what was compared and what changed, and `problems`, one message each (lines joined with "\n").
 * @param {string} version the version being released, e.g. "0.9.3"
 * @param {{ previousVersion: string, previousLabel: string, previous: unknown, current: unknown,
 *   changelog: string, diffCommand: string }} input the release before it, how its definitions
 *   were found (for the verdict, e.g. "v0.9.2"), both definitions (parsed JSON), the text of
 *   CHANGELOG.md, and the command that shows the whole difference (for the messages)
 */
export function definitionsCheck(
  version,
  { previousVersion, previousLabel, previous, current, changelog, diffCommand },
) {
  for (const [which, value] of [
    [previousLabel, previous],
    ['the committed snapshot', current],
  ]) {
    if (!isObject(value)) {
      return {
        verdict: 'definitions not compared: the definitions are not a JSON object.',
        problems: [
          `the definitions in ${which} are not a JSON object, so they cannot be compared.`,
        ],
      };
    }
  }
  const problems = [];
  const bump = versionBump(previousVersion, version);
  if (bump === 'none') {
    problems.push(
      `${version} is not newer than the previous release ${previousVersion} in CHANGELOG.md.`,
    );
  }
  const { shapeChanges, textChanges, textOwners } = compareDefinitions(previous, current);
  const compared = `definitions compared with ${previousLabel}`;
  if (shapeChanges.length === 0) {
    const verdict =
      textChanges.length === 0
        ? `${compared}: no change.`
        : `${compared}: descriptive text only, ${plural(textChanges.length, 'path')} in ${textOwners.join(', ')}; a patch needs no restart note.`;
    return { verdict, problems };
  }

  const verdict = `${compared}: the shape changed (${plural(shapeChanges.length, 'change')}), so ${version} needs a minor or major version and the restart note.`;
  const details = [
    `Shape changes (${shapeChanges.length}):`,
    ...listed(shapeChanges),
    `Full diff: ${diffCommand}`,
  ];
  if (bump === 'patch') {
    problems.push(
      [
        `the definitions changed shape since ${previousVersion}, so ${version} cannot be a patch (DESIGN-BRIEF §5, "The version follows the shape of the definitions"). Release ${nextMinorVersion(previousVersion)} or a later version and start its CHANGELOG.md section with`,
        `  ${RESTART_BANNER}`,
        'or revert the change.',
        ...details,
      ].join('\n'),
    );
  } else if (bump !== 'none') {
    const section = extractSection(changelog, version);
    // A missing section is reported by releaseProblems; the banner is checked once it exists.
    if (section !== null && !hasRestartBanner(section)) {
      problems.push(
        [
          `the definitions changed shape since ${previousVersion}, but the CHANGELOG.md section for ${version} does not start with the restart note. Put this line first in it:`,
          `  ${RESTART_BANNER}`,
          ...details,
        ].join('\n'),
      );
    }
  }
  return { verdict, problems };
}

/**
 * Why the definitions of the previous release could not be read (a failed readSnapshotAt of `ref`),
 * and what to do about it. An unknown ref has two causes: the checkout has no tags (in the release
 * workflow, a publish job without fetch-depth: 0, which a re-run cannot change), or the tag does
 * not exist, because CHANGELOG.md dates a version that was never tagged or whose tag was deleted.
 */
export function unreadableDefinitions(previousVersion, ref, failure, { inWorkflow }) {
  const what = `cannot read the definitions of the previous release ${previousVersion}`;
  const source = `git show ${ref}:${DEFINITIONS_SNAPSHOT}`;
  const noSuchTag = `${previousVersion} is the greatest version with a dated section in CHANGELOG.md below this one, so ${ref} must exist; if it was never tagged, or its tag was deleted, restore the tag or remove that dated section on main.`;
  switch (failure.reason) {
    case 'ref':
      return inWorkflow
        ? `${what}: ${source} failed (${failure.detail}). Either the publish job's checkout lacks fetch-depth: 0 in .github/workflows/release.yml (a re-run uses the workflow of the tag, so fix it on main and tag again), or the tag is missing: ${noSuchTag}`
        : `${what}: ${source} failed (${failure.detail}). Fetch the tags (git pull, or git fetch --tags) and run the check again. If ${ref} is still unknown: ${noSuchTag}`;
    case 'path':
      return `${what}: ${ref} has no ${DEFINITIONS_SNAPSHOT} (the snapshot exists from 0.9.2 on). Outside the release workflow, compare with a file instead: ${PREVIOUS_FLAG} <file>.`;
    case 'json':
      return `${what}: ${source} is not valid JSON (${failure.detail}).`;
    default:
      return `${what}: ${source} failed (${failure.detail}).`;
  }
}

/**
 * The file `path` as git has it in `ref`, parsed as JSON: `{ ok: true, value }`, or
 * `{ ok: false, reason, detail }` with reason `ref` (git does not know the ref), `path` (the ref has
 * no such file), `git` (git failed otherwise) or `json` (not valid JSON). Never throws.
 */
export function readSnapshotAt(ref, path, cwd) {
  const result = spawnSync('git', ['show', `${ref}:${path}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) return { ok: false, reason: 'git', detail: result.error.message };
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim().split('\n')[0] || `exit code ${result.status}`;
    if (/exists on disk, but not in|does not exist in/.test(detail)) {
      return { ok: false, reason: 'path', detail };
    }
    if (/invalid object name|unknown revision|bad revision|not a valid object name/i.test(detail)) {
      return { ok: false, reason: 'ref', detail };
    }
    return { ok: false, reason: 'git', detail };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (err) {
    return { ok: false, reason: 'json', detail: err.message };
  }
}
