/**
 * Plain-text rendering of a check report for a terminal or a cron mail: no colour, no decoration,
 * one line per item, and the tool's own hint under every warn / fail line.
 */
import type { CheckReport } from './check.js';

/** Details and hints are single lines; a stray newline from a tool text must not break that. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

export function formatCheckText(report: CheckReport): string {
  const when = report.checkedAt.local ?? report.checkedAt.utc;
  const lines = [
    `symbol check: ${report.verdict.toUpperCase()} (${report.node.host}, ${report.node.network}, ${when})`,
  ];
  for (const c of report.checks) {
    lines.push(`[${c.status}] ${c.id}: ${oneLine(c.detail)}`);
    if ((c.status === 'warn' || c.status === 'fail') && c.hint !== null) {
      lines.push(`  hint: ${oneLine(c.hint)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function formatCheckJson(report: CheckReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
