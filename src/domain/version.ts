/**
 * Node version decoding. `/node/info` returns the version as a 32-bit integer whose bytes are
 * major.minor.patch.build from the most significant byte: 16777993 = 0x01000309 -> "1.0.3.9".
 */
export function decodeVersion(version: number): string {
  if (!Number.isInteger(version) || version < 0 || version > 0xffffffff) {
    throw new Error(`invalid packed version: ${version}`);
  }
  const major = (version >>> 24) & 0xff;
  const minor = (version >>> 16) & 0xff;
  const patch = (version >>> 8) & 0xff;
  const build = version & 0xff;
  return `${major}.${minor}.${patch}.${build}`;
}
