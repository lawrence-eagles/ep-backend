import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { getEnv } from "../lib/env";

const env = getEnv();

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,

  max: 5,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  keepAlive: true,
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});

export { schema };

export const db = drizzle(pool, { schema });
