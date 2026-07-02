import pg from "pg";
import { COLLECTIONS, RESEED, now } from "./db.js";

// Table name for a collection. Collections are camelCase; Postgres folds
// unquoted identifiers to lowercase, so we lowercase deterministically.
function tableFor(collection) {
  return `mixforge_${collection.toLowerCase()}`;
}

// Fields that may be used in findBy(). Restricted to a fixed allowlist because
// the field name is interpolated into the SQL (values are always parameterized).
const QUERYABLE_FIELDS = new Set([
  "id",
  "email",
  "userId",
  "stripeCustomerId",
  "providerJobId",
  "token"
]);

// Expression indexes to create per collection for hot lookups.
const INDEXED_FIELDS = {
  users: ["email", "stripeCustomerId"],
  recordings: ["userId"],
  projects: ["userId"],
  stemJobs: ["userId", "providerJobId"],
  payments: ["userId"],
  passwordResets: ["token", "userId"],
  emailVerifications: ["token", "userId"],
  reports: ["userId"],
  dmcaTakedowns: []
};

export class PostgresStore {
  constructor(cfg) {
    if (!cfg.databaseUrl) {
      throw new Error("PostgresStore requires a databaseUrl.");
    }
    this.pool = new pg.Pool({
      connectionString: cfg.databaseUrl,
      max: cfg.pgPoolMax || 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000
    });
    this.ready = false;
  }

  get collectionNames() {
    return [...COLLECTIONS];
  }

  assertCollection(collection) {
    if (!COLLECTIONS.includes(collection)) {
      throw new Error(`Unknown collection: ${collection}`);
    }
  }

  async init() {
    if (this.ready) {
      return;
    }
    const client = await this.pool.connect();
    try {
      for (const collection of COLLECTIONS) {
        const table = tableFor(collection);
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${table} (
             id   text PRIMARY KEY,
             data jsonb NOT NULL,
             seq  bigserial
           )`
        );
        for (const field of INDEXED_FIELDS[collection] || []) {
          const idx = `${table}_${field.toLowerCase()}_idx`;
          await client.query(`CREATE INDEX IF NOT EXISTS ${idx} ON ${table} ((data->>'${field}'))`);
        }
      }
      // Re-seed static collections when empty, mirroring JsonStore.
      for (const [collection, rows] of Object.entries(RESEED)) {
        const table = tableFor(collection);
        const { rows: countRows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
        if (countRows[0].n === 0) {
          for (const row of rows) {
            await client.query(`INSERT INTO ${table} (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING`, [
              row.id,
              JSON.stringify(row)
            ]);
          }
        }
      }
      this.ready = true;
    } finally {
      client.release();
    }
  }

  async list(collection) {
    this.assertCollection(collection);
    const { rows } = await this.pool.query(`SELECT data FROM ${tableFor(collection)} ORDER BY seq ASC`);
    return rows.map((r) => r.data);
  }

  async findById(collection, id) {
    this.assertCollection(collection);
    if (id === undefined || id === null) {
      return null;
    }
    const { rows } = await this.pool.query(`SELECT data FROM ${tableFor(collection)} WHERE id = $1 LIMIT 1`, [
      String(id)
    ]);
    return rows[0]?.data || null;
  }

  async findBy(collection, field, value) {
    this.assertCollection(collection);
    if (!QUERYABLE_FIELDS.has(field)) {
      throw new Error(`Field not queryable: ${field}`);
    }
    if (value === undefined || value === null) {
      return null;
    }
    const { rows } = await this.pool.query(
      `SELECT data FROM ${tableFor(collection)} WHERE data->>'${field}' = $1 ORDER BY seq ASC LIMIT 1`,
      [String(value)]
    );
    return rows[0]?.data || null;
  }

  async listByOwner(collection, userId) {
    this.assertCollection(collection);
    const { rows } = await this.pool.query(
      `SELECT data FROM ${tableFor(collection)}
        WHERE data->>'userId' = $1 OR data->>'userId' IS NULL
        ORDER BY seq ASC`,
      [userId == null ? null : String(userId)]
    );
    return rows.map((r) => r.data);
  }

  async insert(collection, record) {
    this.assertCollection(collection);
    if (!record?.id) {
      throw new Error("insert requires record.id");
    }
    await this.pool.query(`INSERT INTO ${tableFor(collection)} (id, data) VALUES ($1, $2::jsonb)`, [
      String(record.id),
      JSON.stringify(record)
    ]);
    return record;
  }

  async update(collection, id, patch) {
    this.assertCollection(collection);
    // Shallow-merge the patch (plus updatedAt) into the stored jsonb atomically.
    const merged = JSON.stringify({ ...patch, updatedAt: now() });
    const { rows } = await this.pool.query(
      `UPDATE ${tableFor(collection)} SET data = data || $2::jsonb WHERE id = $1 RETURNING data`,
      [String(id), merged]
    );
    return rows[0]?.data || null;
  }

  async remove(collection, id) {
    this.assertCollection(collection);
    const { rowCount } = await this.pool.query(`DELETE FROM ${tableFor(collection)} WHERE id = $1`, [String(id)]);
    return rowCount > 0;
  }

  async close() {
    await this.pool.end();
  }
}
