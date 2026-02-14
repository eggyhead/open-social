#!/usr/bin/env tsx
import { Pool } from 'pg';
import { Kysely, Migrator, PostgresDialect, FileMigrationProvider } from 'kysely';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as dotenv from 'dotenv';
import { logger } from '../src/lib/logger';

// Load environment variables
dotenv.config();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  logger.fatal('DATABASE_URL environment variable is required');
  process.exit(1);
}

async function migrateToLatest() {
  const db = new Kysely({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: databaseUrl,
      }),
    }),
  });

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(__dirname, '../migrations'),
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((it) => {
    if (it.status === 'Success') {
      logger.info({ migrationName: it.migrationName }, `Migration "${it.migrationName}" was executed successfully`);
    } else if (it.status === 'Error') {
      logger.error({ migrationName: it.migrationName }, `Failed to execute migration "${it.migrationName}"`);
    }
  });

  if (error) {
    logger.fatal({ error }, 'Failed to migrate');
    await db.destroy();
    process.exit(1);
  }

  await db.destroy();
  logger.info('Migrations completed successfully');
}

async function migrateDown() {
  const db = new Kysely({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: databaseUrl,
      }),
    }),
  });

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(__dirname, '../migrations'),
    }),
  });

  const { error, results } = await migrator.migrateDown();

  results?.forEach((it) => {
    if (it.status === 'Success') {
      logger.info({ migrationName: it.migrationName }, `Rollback "${it.migrationName}" was executed successfully`);
    } else if (it.status === 'Error') {
      logger.error({ migrationName: it.migrationName }, `Failed to rollback migration "${it.migrationName}"`);
    }
  });

  if (error) {
    logger.fatal({ error }, 'Failed to rollback migration');
    await db.destroy();
    process.exit(1);
  }

  await db.destroy();
  logger.info('Rollback completed successfully');
}

async function getMigrationStatus() {
  const db = new Kysely({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: databaseUrl,
      }),
    }),
  });

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(__dirname, '../migrations'),
    }),
  });

  const migrations = await migrator.getMigrations();

  console.log('\nMigration Status:\n');
  console.log('┌─────────────────────────────────┬────────────────┐');
  console.log('│ Migration                       │ Status         │');
  console.log('├─────────────────────────────────┼────────────────┤');

  migrations.forEach((migration) => {
    const name = migration.name.padEnd(31);
    const status = (migration.executedAt ? 'Executed' : 'Pending').padEnd(14);
    console.log(`│ ${name} │ ${status} │`);
  });

  console.log('└─────────────────────────────────┴────────────────┘\n');

  await db.destroy();
}

const command = process.argv[2];

(async () => {
  try {
    switch (command) {
      case 'up':
        await migrateToLatest();
        break;
      case 'down':
        await migrateDown();
        break;
      case 'status':
        await getMigrationStatus();
        break;
      default:
        console.log('Usage: npm run migrate:up | npm run migrate:down | npm run migrate:status');
        process.exit(1);
    }
  } catch (error) {
    logger.fatal({ error }, 'Migration script failed');
    process.exit(1);
  }
})();
