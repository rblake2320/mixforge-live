import { JsonStore } from "./db.js";
import { PostgresStore } from "./postgres-store.js";

// Selects the persistence backend. Postgres when DATABASE_URL is set (or the
// backend is explicitly "postgres"); otherwise the flat-file JsonStore, which
// stays the zero-config default for local/single-node use.
export function createStore(cfg) {
  const backend = cfg.storeBackend || (cfg.databaseUrl ? "postgres" : "json");
  if (backend === "postgres") {
    return new PostgresStore(cfg);
  }
  return new JsonStore(cfg.dataFile);
}
