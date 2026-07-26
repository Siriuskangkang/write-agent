export type AtomicGroundingMode = 'off' | 'shadow_no_persist';

export function parseAtomicGroundingMode(value: unknown): AtomicGroundingMode {
  return value === 'shadow_no_persist' ? 'shadow_no_persist' : 'off';
}
