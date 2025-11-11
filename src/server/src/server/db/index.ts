import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "~/env";
import * as schema from "./schema";

/**
 * Cache the database connection in development. This avoids creating a new connection on every HMR
 * update.
 */
const globalForDb = globalThis as unknown as {
  conn: postgres.Sql | undefined;
};
// choose based on env or URL
const isLocal =
    env.DATABASE_URL.includes("localhost") || env.DATABASE_URL.includes("127.0.0.1");

const conn =
  globalForDb.conn ??
  postgres(env.DATABASE_URL, {
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 1,
  });
if (env.NODE_ENV !== "production") globalForDb.conn = conn;

export const db = drizzle(conn, { schema });
