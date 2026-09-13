/**
 * MCP prompts: operator checklists that drive the symbol_* tools in a fixed order.
 *
 * Every prompt takes exactly one argument, `account` (base32 address). Bodies are templates with
 * the literal token {account}; they must not contain any real address, host, key or date
 * (test/tools/prompts.test.ts checks the templates). Prompts are registered in array order so
 * `prompts/list` is deterministic, like the tools.
 */
import type { GetPromptResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { isValidBase32Address, normalizeAddressInput } from '../domain/address.js';

export const ACCOUNT_TOKEN = '{account}';

export const PromptArgsSchema = z.object({
  account: z
    .string()
    .min(1)
    .describe('Base32 address (39 characters) of the voting / harvesting account to check.'),
});

export interface PromptDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Prompt body; every {account} token is replaced by the validated address. */
  readonly template: string;
}

export function definePrompt(def: PromptDefinition): PromptDefinition {
  return def;
}

export function renderPrompt(def: PromptDefinition, address: string): string {
  return def.template.split(ACCOUNT_TOKEN).join(address);
}

/** Registers prompts in the given (fixed) order so `prompts/list` is deterministic. */
export function registerPrompts(server: McpServer, prompts: readonly PromptDefinition[]): void {
  for (const prompt of prompts) {
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: PromptArgsSchema },
      ({ account }): GetPromptResult => {
        const address = normalizeAddressInput(account);
        if (!isValidBase32Address(address)) {
          throw new Error(
            `"${account.trim().slice(0, 16)}" is not a Symbol address. The account argument must be the 39-character base32 address (starts with N on mainnet, T on testnet); convert a public key with symbol_address_parse first.`,
          );
        }
        return {
          description: prompt.description,
          messages: [
            { role: 'user', content: { type: 'text', text: renderPrompt(prompt, address) } },
          ],
        };
      },
    );
  }
}
