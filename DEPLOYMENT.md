# Deployment Guide

## Database Migrations

The OpenSocial API uses [Kysely](https://kysely.dev) for database migrations to safely manage schema changes. All database schema changes are managed through version-controlled migration files in the `/migrations` directory.

### Migration Commands

- **Apply all pending migrations**: `npm run migrate:up`
- **Rollback the last migration**: `npm run migrate:down`
- **Check migration status**: `npm run migrate:status`

### Initial Setup

When deploying the application for the first time:

1. Ensure your `DATABASE_URL` environment variable is set
2. Run migrations to create the database schema:
   ```bash
   npm run migrate:up
   ```

### Production Deployment

Before deploying a new version to production:

1. **Always backup your database first**:
   ```bash
   ./scripts/backup-db.sh
   ```

2. **Check migration status** to see what will be applied:
   ```bash
   npm run migrate:status
   ```

3. **Apply migrations**:
   ```bash
   npm run migrate:up
   ```

4. **Start the application**:
   ```bash
   npm start
   ```

### Migration Files

Migration files are located in `/migrations` and follow a numbered naming convention:

- `001_initial_schema.ts` - OAuth and apps tables
- `002_communities_table.ts` - Communities table with metadata
- `003_v2_features.ts` - Rate limits, webhooks, audit log, pending members
- `004_permissions_tables.ts` - Permission and moderation tables
- `005_add_indexes.ts` - Database indexes for performance

Each migration file contains:
- `up()` function - Applies the migration
- `down()` function - Rolls back the migration

### Rollback Procedure

If you need to rollback a migration:

1. **Stop the application**
2. **Rollback the last migration**:
   ```bash
   npm run migrate:down
   ```
3. **Verify the rollback**:
   ```bash
   npm run migrate:status
   ```

### Creating New Migrations

To create a new migration:

1. Create a new file in `/migrations` with the next sequential number
2. Follow the naming pattern: `NNN_description.ts`
3. Implement both `up()` and `down()` functions
4. Use `IF NOT EXISTS` / `IF EXISTS` clauses for idempotency
5. Test both up and down migrations

Example migration structure:

```typescript
import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Apply schema changes
  await db.schema
    .createTable('new_table')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Rollback schema changes
  await db.schema.dropTable('new_table').ifExists().execute();
}
```

### Migration History

Kysely tracks migration history in a `kysely_migration` table (created automatically). This table records:
- Migration name
- Execution timestamp
- Status

### Best Practices

1. **Always backup before migrations** - Especially in production
2. **Test migrations locally first** - Run on dev/staging before production
3. **Make migrations idempotent** - Use `IF EXISTS` / `IF NOT EXISTS`
4. **Keep migrations focused** - One logical change per migration file
5. **Never modify applied migrations** - Create new migrations instead
6. **Test rollback procedures** - Ensure `down()` functions work correctly
7. **Document breaking changes** - Add comments for complex migrations

### Troubleshooting

#### Migration fails with "relation already exists"
- This can happen if inline migrations were run before. The migration system uses `IF NOT EXISTS` clauses to handle this gracefully.

#### Need to reset the database completely
```bash
npm run db:reset
npm run migrate:up
```

#### Check current schema
```bash
psql $DATABASE_URL -c "\dt"  # List tables
psql $DATABASE_URL -c "\d table_name"  # Describe table
```

### Environment Variables

Ensure these are set before running migrations:

- `DATABASE_URL` - PostgreSQL connection string
- `LOG_LEVEL` - Logging level (default: 'info')

### Monitoring

After applying migrations, check:
- Application logs for errors
- Database connection health
- API endpoint responses
- Migration history: `npm run migrate:status`
