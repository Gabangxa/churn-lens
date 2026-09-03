import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * withTransaction is the only thing standing between signup and a half-created
 * account (an org with no owner user, or a user row pointing at an org that was
 * never committed). Every caller-level test mocks it, so this file is where the
 * BEGIN/COMMIT/ROLLBACK contract is actually verified — against a fake pg client
 * that records the statements it is given.
 */

const clientQueryMock = vi.fn();
const releaseMock = vi.fn();
const poolQueryMock = vi.fn();

vi.mock('pg', () => {
  class Pool {
    query = (...args: unknown[]) => poolQueryMock(...args);
    connect = async () => ({ query: clientQueryMock, release: releaseMock });
    on = () => undefined;
  }
  return { Pool, default: { Pool } };
});

import { withTransaction, query, queryOne, execute } from '../db';

const TEST_DB_URL = 'postgres://user:pw@localhost:5432/churnlens_test';

/** The control statements issued on the dedicated connection, in order. */
function controlStatements(): string[] {
  return clientQueryMock.mock.calls
    .map(([sql]) => sql as string)
    .filter((sql) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql));
}

beforeEach(() => {
  process.env.DATABASE_URL = TEST_DB_URL;
  clientQueryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  releaseMock.mockReset();
  poolQueryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('withTransaction', () => {
  it('wraps a successful callback in BEGIN/COMMIT and returns its value', async () => {
    const result = await withTransaction(async (client) => {
      await client.query('INSERT INTO organizations (id) VALUES ($1)', ['org-1']);
      return 'org-1';
    });

    expect(result).toBe('org-1');
    expect(controlStatements()).toEqual(['BEGIN', 'COMMIT']);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('rolls back and rethrows the original error when the callback fails', async () => {
    const failure = new Error('duplicate key value violates unique constraint');

    await expect(
      withTransaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure); // the real error, not a rollback error masking it

    expect(controlStatements()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(controlStatements()).not.toContain('COMMIT');
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('rolls back the signup shape: org inserted, owner user insert fails', async () => {
    // Exactly what /api/auth/request does inside the transaction. If the users
    // insert fails (e.g. the unique index on lower(email) fires on a racing
    // duplicate signup), the organizations row must not survive.
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO organizations')) return { rows: [{ id: 'org-new' }], rowCount: 1 };
      if (sql.includes('INSERT INTO users')) throw new Error('users insert failed');
      return { rows: [], rowCount: 0 };
    });

    await expect(
      withTransaction(async (client) => {
        const org = await client.query('INSERT INTO organizations (id, name) VALUES ($1, $2) RETURNING id', [
          'org-new',
          'My Organization',
        ]);
        await client.query(`INSERT INTO users (org_id, email, role) VALUES ($1, $2, 'owner')`, [
          org.rows[0].id,
          'founder@example.com',
        ]);
        return org.rows[0].id;
      }),
    ).rejects.toThrow('users insert failed');

    expect(controlStatements()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the original error even when the ROLLBACK itself fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('connection already dead');
      return { rows: [], rowCount: 0 };
    });

    await expect(
      withTransaction(async () => {
        throw new Error('the real failure');
      }),
    ).rejects.toThrow('the real failure');

    expect(errorSpy).toHaveBeenCalled();
    // The connection is still handed back, otherwise the pool leaks one per failure.
    expect(releaseMock).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('releases the connection even when COMMIT fails', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw new Error('commit failed');
      return { rows: [], rowCount: 0 };
    });

    await expect(withTransaction(async () => 'value')).rejects.toThrow('commit failed');

    expect(controlStatements()).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('does not borrow a connection for pool-backed helpers', async () => {
    // query/execute/queryOne go through the pool, so they can never be composed
    // into a transaction — the reason withTransaction exists at all.
    await query('SELECT 1');
    expect(clientQueryMock).not.toHaveBeenCalled();
    expect(poolQueryMock).toHaveBeenCalledWith('SELECT 1', undefined);
  });
});

describe('pool-backed helpers', () => {
  it('queryOne returns the first row, or null when there are none', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }], rowCount: 2 });
    expect(await queryOne('SELECT 1')).toEqual({ id: 'a' });

    poolQueryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await queryOne('SELECT 1')).toBeNull();
  });

  it('execute reports 0 rather than null when pg reports no rowCount', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [], rowCount: null });
    expect(await execute('DELETE FROM login_tokens')).toBe(0);
  });
});

describe('configuration', () => {
  afterEach(() => {
    process.env.DATABASE_URL = TEST_DB_URL;
    vi.resetModules();
  });

  it('throws a clear error on first query when DATABASE_URL is not set', async () => {
    // The pool is a lazy singleton so a Next.js build (which imports route
    // modules before runtime secrets exist) does not fail at import time.
    vi.resetModules();
    delete process.env.DATABASE_URL;
    const fresh = await import('../db');

    await expect(fresh.query('SELECT 1')).rejects.toThrow('DATABASE_URL is not set.');
  });
});
