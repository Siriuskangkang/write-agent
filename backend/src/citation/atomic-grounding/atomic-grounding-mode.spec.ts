import {
  parseAtomicGroundingMode,
  type AtomicGroundingMode,
} from './atomic-grounding-mode.js';
import { dispositionForAtomicFailure } from './failure-policy.js';

describe('parseAtomicGroundingMode', () => {
  it.each([
    ['shadow_no_persist', 'shadow_no_persist'],
    ['off', 'off'],
    [undefined, 'off'],
    ['enforce', 'off'],
    ['SHADOW_NO_PERSIST', 'off'],
    ['unexpected', 'off'],
  ] as const)('maps %p to the fail-safe mode %s', (value, expected) => {
    expect(parseAtomicGroundingMode(value)).toBe(expected);
  });

  it.each([undefined, '', 'enforce', 'unexpected'])(
    'keeps unavailable disposition for non-shadow mode %p',
    (value) => {
      const mode: AtomicGroundingMode = parseAtomicGroundingMode(value);
      expect(
        dispositionForAtomicFailure(
          mode === 'off' ? 'ATOMIC_GROUNDING_DISABLED' : 'INTERNAL_FAIL_CLOSED',
          0,
        ),
      ).toEqual({
        internal_reason: 'ATOMIC_GROUNDING_DISABLED',
        public_code: 'ATOMIC_GROUNDING_UNAVAILABLE',
        transition: 'FAILED',
      });
    },
  );
});
