/** Types for scripts/release-check.mjs, so the TypeScript tests can import it. */

export interface ReleaseFiles {
  /** Parsed package.json. */
  packageJson: { name?: unknown; version?: unknown; mcpName?: unknown };
  /** Parsed package-lock.json. */
  packageLock: { version?: unknown; packages?: Record<string, { version?: unknown }> };
  /** Parsed server.json. */
  serverJson: {
    name?: unknown;
    version?: unknown;
    packages?: ReadonlyArray<{ registryType?: unknown; identifier?: unknown; version?: unknown }>;
  };
  /** The text of CHANGELOG.md. */
  changelog: string;
}

export declare function releaseProblems(version: string, files: ReleaseFiles): string[];
