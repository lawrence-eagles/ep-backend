import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { getEnv } from "../lib/env";

const env = getEnv();

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle(pool, { schema });
