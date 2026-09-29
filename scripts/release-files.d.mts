/** Types for scripts/release-files.mjs, so the TypeScript tests can import it. */

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

export declare function extractSection(markdown: string, version: string): string[] | null;

export declare function releaseProblems(version: string, files: ReleaseFiles): string[];

export declare const RESTART_BANNER: string;

export declare function parseReleaseVersion(version: string): [number, number, number] | null;

export declare function previousReleaseVersion(changelog: string, version: string): string | null;

export declare function versionBump(
  previous: string,
  next: string,
): 'major' | 'minor' | 'patch' | 'none';

export declare function nextMinorVersion(version: string): string;

export declare function hasRestartBanner(section: readonly string[]): boolean;
