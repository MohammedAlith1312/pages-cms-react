import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

const client = postgres(process.env.DATABASE_URL!, {
  // Keep conservative pool size to avoid connection spikes.
  max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS || "5", 10),
});

export const db = drizzle(client, { schema });
