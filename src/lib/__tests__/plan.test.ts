import { describe, it, expect } from 'vitest';
import { PLANS, isPlan } from '../plan';

describe('isPlan', () => {
  it.each(PLANS)('accepts the valid plan %s', (plan) => {
    expect(isPlan(plan)).toBe(true);
  });

  it.each([
    ['a tier that does not exist', 'enterprise'],
    ['the lifetime tier the landing page advertises', 'lifetime'],
    ['wrong case', 'Starter'],
    ['empty string', ''],
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
    ['an object', { plan: 'starter' }],
  ])('rejects %s', (_label, value) => {
    expect(isPlan(value)).toBe(false);
  });
});
