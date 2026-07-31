/**
 * A D1 binding backed by real SQLite, running the real migrations.
 *
 * Tag behaviour is mostly a question about CONSTRAINTS: "deleting a tag in use
 * is refused" and "renaming a slug cascades to location_tags" are claims about
 * SQLite, and a mock that matches SQL by substring can only restate the belief
 * it was written from. Proving them needs an engine.
 *
 * node:sqlite is experimental, and it is a test-only dependency: nothing here
 * ships to the Worker, which talks to D1.
 *
 * Two behaviours matter and are asserted by the tests that use this:
 * - `PRAGMA foreign_keys = ON`. SQLite defaults it OFF, D1 defaults it ON. With
 *   it off, ON UPDATE CASCADE silently does nothing and every rename orphans
 *   its links, so admin.js re-counts after a rename rather than
 *   trusting the cascade.
 * - `batch()` runs inside a transaction, as D1's does.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Outside test/ on purpose: `node --test` treats every .js/.mjs under a test/
// directory as a test file, and a helper with no tests in it would be reported
// as a passing suite.
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * D1 refuses more than 100 bound parameters in one query, and SQLite does
 * not: its own ceiling is 32766. So a harness that is "a real engine" is still
 * not "the real platform", and an `IN (?, ?, ...)` over 297 locations passed
 * every test here while throwing `D1_ERROR: too many SQL variables` in
 * production.
 *
 * Measured against real D1, not taken from docs: 100 placeholders are accepted,
 * 101 are refused. Enforcing it here is what makes this harness stand in for D1
 * rather than merely for SQLite.
 */
const D1_MAX_BOUND_PARAMS = 100;

/** D1 returns `{results, meta}` from all(), a bare row (or null) from first(). */
function statement(db, sql, args = []) {
  const guard = () => {
    if (args.length > D1_MAX_BOUND_PARAMS) {
      throw new Error(
        `D1_ERROR: too many SQL variables: ${args.length} bound, D1 allows ${D1_MAX_BOUND_PARAMS}`,
      );
    }
  };
  return {
    bind(...next) { return statement(db, sql, next); },
    async first(column) {
      guard();
      const row = db.prepare(sql).get(...args) ?? null;
      if (row === null || column === undefined) return row;
      return row[column];
    },
    async all() {
      guard();
      return { results: db.prepare(sql).all(...args), success: true };
    },
    async run() {
      guard();
      const info = db.prepare(sql).run(...args);
      // `last_row_id` as D1 names it, not node:sqlite's `lastInsertRowid`. A
      // caller reading the D1 name off this harness would otherwise get
      // undefined, and undefined is a plausible-looking id.
      return {
        success: true,
        meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
      };
    },
    // Internal: batch() needs the pieces, not the promise.
    _sql: sql,
    _args: args,
  };
}

/**
 * @param {object} [seed]
 * @param {Array}  [seed.locations]      raw `locations` rows
 * @param {Array}  [seed.locationTags]   `[location_id, tag_slug]` pairs
 * @param {Array}  [seed.users]          raw `users` rows
 * @param {Array}  [seed.tags]           extra tag rows beyond migration 0002's seed
 * @param {Array}  [seed.submissions]    raw `submissions` rows
 * @param {Array}  [seed.nexusCache]     raw `nexus_cache` rows
 * @param {Array}  [seed.dismissed]      raw `dismissed_candidates` rows
 */
export function sqliteD1(seed = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');

  // The real migrations, in order. If a migration stops being valid SQLite this
  // throws here rather than producing a subtly different schema to test against.
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }

  /**
   * Insert whatever columns the fixture names, rather than a fixed list.
   *
   * The alternative is a positional helper per table, and every one of those
   * pins a column order that a later migration can quietly invalidate: the
   * insert still succeeds, with the values in the wrong columns.
   */
  const insertRows = (table, rows) => {
    for (const row of rows ?? []) {
      const cols = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ).run(...cols.map((c) => row[c]));
    }
  };

  insertRows('locations', seed.locations);
  for (const [locationId, tagSlug] of seed.locationTags ?? []) {
    db.prepare('INSERT INTO location_tags (location_id, tag_slug) VALUES (?, ?)')
      .run(locationId, tagSlug);
  }
  for (const row of seed.users ?? []) {
    db.prepare(
      'INSERT INTO users (id, login, is_collaborator, checked_at, first_seen_at) VALUES (?, ?, ?, ?, ?)',
    ).run(row.id, row.login, row.is_collaborator, row.checked_at, row.first_seen_at);
  }
  for (const row of seed.tags ?? []) {
    db.prepare(
      'INSERT INTO tags (slug, name, description, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(row.slug, row.name ?? null, row.description, row.sort_order ?? null,
      row.created_at ?? 'seed', row.updated_at ?? 'seed');
  }
  insertRows('submissions', seed.submissions);
  insertRows('nexus_cache', seed.nexusCache);
  insertRows('dismissed_candidates', seed.dismissed);

  return {
    _db: db,
    prepare: (sql) => statement(db, sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => {
          if (s._args.length > D1_MAX_BOUND_PARAMS) {
            throw new Error(`D1_ERROR: too many SQL variables: ${s._args.length}`);
          }
          const info = db.prepare(s._sql).run(...s._args);
          return {
            success: true,
            meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
          };
        });
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    /** Test conveniences: reads, never writes. */
    rows: (sql, ...args) => db.prepare(sql).all(...args),
    one: (sql, ...args) => db.prepare(sql).get(...args) ?? null,
  };
}
