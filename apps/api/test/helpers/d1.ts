/**
 * A D1Database implementation backed by node:sqlite.
 *
 * The point is to run the API's real SQL against the real migrations. A hand-rolled fake that
 * pattern-matches query strings would pass while the SQL was wrong, which is the opposite of
 * useful for a module whose whole job is to read a schema correctly — and it would not have
 * caught the foreign-key problem that made migration 0002 necessary.
 *
 * Only the surface this Worker actually uses is implemented: prepare/bind/first/all/run and
 * batch. Anything else throws rather than returning a plausible-looking empty result.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

const MIGRATIONS_DIR = new URL('../../../../packages/db/migrations', import.meta.url).pathname;

export interface TestDb {
  d1: D1Database;
  raw: DatabaseSync;
  close(): void;
}

export function createTestDb(): TestDb {
  const raw = new DatabaseSync(':memory:');
  // D1 enforces foreign keys. Running the tests without this would hide exactly the class of
  // bug that migration 0002 exists to avoid.
  raw.exec('PRAGMA foreign_keys = ON;');

  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    raw.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }

  return { d1: new SqliteD1(raw) as unknown as D1Database, raw, close: () => raw.close() };
}

type Bindable = string | number | bigint | null;

class SqliteStatement {
  private bound: Bindable[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    const next = new SqliteStatement(this.db, this.sql);
    next.bound = values.map(coerce);
    return next;
  }

  // node:sqlite is synchronous, so none of the four below has anything to await. They still
  // return promises because that is the D1 surface the Worker codes against; a synchronous
  // throw from node:sqlite surfaces at the caller's `await` either way.
  first<T>(column?: string): Promise<T | null> {
    const row = this.stmt().get(...this.bound) as Record<string, unknown> | undefined;
    if (row === undefined) return Promise.resolve(null);
    if (column !== undefined) return Promise.resolve((row[column] ?? null) as T);
    return Promise.resolve(row as T);
  }

  all<T>(): Promise<D1Result<T>> {
    const rows = this.stmt().all(...this.bound) as T[];
    return Promise.resolve({
      results: rows,
      success: true,
      meta: meta(0),
    } as unknown as D1Result<T>);
  }

  run<T>(): Promise<D1Result<T>> {
    const result = this.stmt().run(...this.bound);
    return Promise.resolve({
      results: [] as T[],
      success: true,
      meta: meta(Number(result.changes), Number(result.lastInsertRowid)),
    } as unknown as D1Result<T>);
  }

  raw<T>(): Promise<T[]> {
    const rows = this.stmt().all(...this.bound) as Record<string, unknown>[];
    return Promise.resolve(rows.map((row) => Object.values(row)) as T[]);
  }

  /**
   * `db.batch` in D1 runs statements and returns one result per statement. Statements that
   * mutate must report `changes`, and statements that read must report `results` — the API's
   * paginated queries depend on both coming back from the same call.
   */
  execute(): D1Result<unknown> {
    const statement = this.stmt();
    const isRead = /^\s*(select|with)\b/i.test(this.sql);
    if (isRead) {
      return {
        results: statement.all(...this.bound),
        success: true,
        meta: meta(0),
      } as unknown as D1Result<unknown>;
    }
    // INSERT/UPDATE/DELETE ... RETURNING is a write that also produces rows.
    if (/\breturning\b/i.test(this.sql)) {
      const rows = statement.all(...this.bound);
      return {
        results: rows,
        success: true,
        meta: meta(rows.length),
      } as unknown as D1Result<unknown>;
    }
    const result = statement.run(...this.bound);
    return {
      results: [],
      success: true,
      meta: meta(Number(result.changes), Number(result.lastInsertRowid)),
    } as unknown as D1Result<unknown>;
  }

  private stmt(): StatementSync {
    return this.db.prepare(this.sql);
  }
}

class SqliteD1 {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db, sql);
  }

  batch<T>(statements: SqliteStatement[]): Promise<D1Result<T>[]> {
    return Promise.resolve(statements.map((s) => s.execute() as D1Result<T>));
  }

  exec(sql: string): Promise<D1ExecResult> {
    this.db.exec(sql);
    return Promise.resolve({ count: 0, duration: 0 });
  }

  dump(): Promise<ArrayBuffer> {
    throw new Error('dump() is not implemented in the test D1 shim');
  }

  withSession(): never {
    throw new Error('withSession() is not implemented in the test D1 shim');
  }
}

/**
 * node:sqlite accepts only null, number, bigint, string and Uint8Array.
 *
 * Anything else used to fall through to `String(value)`, which turns an object into the literal
 * '[object Object]' and stores it. A test that binds the wrong shape would then pass against a
 * value real D1 would have refused, so the fallback is a throw rather than a coercion.
 */
function coerce(value: unknown): Bindable {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') {
    return value;
  }
  throw new TypeError(`test D1 shim cannot bind a value of type ${typeof value}`);
}

function meta(changes: number, lastRowId = 0) {
  return {
    changes,
    last_row_id: lastRowId,
    duration: 0,
    rows_read: 0,
    rows_written: changes,
    size_after: 0,
    served_by: 'test',
    changed_db: changes > 0,
  };
}
