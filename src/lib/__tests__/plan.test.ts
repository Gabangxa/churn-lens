import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PLANS, isPlan, entitlementForStatus, planForProduct } from '../plan';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.POLAR_PRODUCT_STARTER;
  delete process.env.POLAR_PRODUCT_GROWTH;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

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

describe('entitlementForStatus', () => {
  it.each([
    ['active', 'grant'],
    ['trialing', 'grant'],
    ['past_due', 'grant'],
  ])('grants on %s', (status, expected) => {
    expect(entitlementForStatus(status)).toBe(expected);
  });

  it('keeps a past_due customer entitled', () => {
    // A single declined card must not instantly revoke access — Polar retries
    // before ending the subscription, and the terminal status is what revokes.
    expect(entitlementForStatus('past_due')).toBe('grant');
  });

  it.each([
    ['canceled', 'revoke'],
    ['unpaid', 'revoke'],
    ['incomplete_expired', 'revoke'],
    ['paused', 'revoke'],
  ])('revokes on %s', (status, expected) => {
    expect(entitlementForStatus(status)).toBe(expected);
  });

  it('ignores incomplete, which has never been paid', () => {
    expect(entitlementForStatus('incomplete')).toBe('ignore');
  });

  it('ignores a status Polar adds in future rather than guessing', () => {
    // Defaulting an unknown status to either grant or revoke would silently
    // give away or remove a paid plan the moment Polar extends the enum.
    expect(entitlementForStatus('some_future_status')).toBe('ignore');
  });
});

describe('planForProduct', () => {
  it('maps the configured starter product', () => {
    process.env.POLAR_PRODUCT_STARTER = 'prod_starter';
    expect(planForProduct('prod_starter')).toBe('starter');
  });

  it('maps the configured growth product', () => {
    process.env.POLAR_PRODUCT_GROWTH = 'prod_growth';
    expect(planForProduct('prod_growth')).toBe('growth');
  });

  it('returns null for an unrecognized product', () => {
    process.env.POLAR_PRODUCT_STARTER = 'prod_starter';
    expect(planForProduct('prod_something_else')).toBeNull();
  });

  it('returns null when nothing is configured, rather than defaulting a tier', () => {
    expect(planForProduct('prod_starter')).toBeNull();
  });

  it('does not match an empty product id against unset config', () => {
    // Both sides empty must not be treated as a match, which would grant a plan
    // to any subscription in an environment with no products configured.
    expect(planForProduct('')).toBeNull();
  });

  it('keeps the tiers distinct when both are configured', () => {
    process.env.POLAR_PRODUCT_STARTER = 'prod_starter';
    process.env.POLAR_PRODUCT_GROWTH = 'prod_growth';
    expect(planForProduct('prod_starter')).toBe('starter');
    expect(planForProduct('prod_growth')).toBe('growth');
  });
});
