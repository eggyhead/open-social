import { defineConfig } from 'kysely-migration-cli';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}

export default defineConfig({
  kysely: new Kysely({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: databaseUrl,
      }),
    }),
  }),
  migrations: {
    migrationFolder: path.join(__dirname, 'migrations'),
  },
});
