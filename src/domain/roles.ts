/**
 * Node role bit flags (catapult NodeRoles): 1 = Peer, 2 = API, 4 = Voting, 64 = IPv4, 128 = IPv6.
 */
export type NodeRole = 'Peer' | 'API' | 'Voting' | 'IPv4' | 'IPv6';

const ROLE_BITS: ReadonlyArray<readonly [number, NodeRole]> = [
  [1, 'Peer'],
  [2, 'API'],
  [4, 'Voting'],
  [64, 'IPv4'],
  [128, 'IPv6'],
];

export function decodeRoles(roles: number): NodeRole[] {
  if (!Number.isInteger(roles) || roles < 0) throw new Error(`invalid roles value: ${roles}`);
  return ROLE_BITS.filter(([bit]) => (roles & bit) !== 0).map(([, name]) => name);
}
