import { Kysely, Migrator, FileMigrationProvider } from "kysely";
import * as path from "path";
import * as fs from "fs/promises";
import { logger } from "./logger";

/**
 * Runs all pending Kysely migrations at server startup.
 *
 * Migration folder resolution:
 *  - Development (tsx):  __dirname = src/lib  → ../../migrations
 *  - Production (node):  __dirname = dist/lib → ../../migrations  (compiled .js copies)
 *
 * The Dockerfile copies compiled migration .js files to /app/migrations/ so the
 * path resolves identically in both environments.
 */
export async function autoMigrate(db: Kysely<any>): Promise<void> {
  const migrationFolder = path.resolve(__dirname, "../../migrations");

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder,
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((it) => {
    if (it.status === "Success") {
      logger.info(
        { migrationName: it.migrationName },
        `Migration "${it.migrationName}" executed successfully`,
      );
    } else if (it.status === "Error") {
      logger.error(
        { migrationName: it.migrationName },
        `Failed to execute migration "${it.migrationName}"`,
      );
    }
  });

  if (error) {
    logger.fatal({ error }, "Auto-migration failed");
    throw error;
  }

  const applied = results?.filter((r) => r.status === "Success").length ?? 0;
  if (applied > 0) {
    logger.info({ applied }, `Applied ${applied} pending migration(s)`);
  } else {
    logger.info("Database schema is up to date");
  }
}
