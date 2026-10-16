/**
 * Integration test: verifies all migrations apply cleanly on a fresh database.
 * Requires DATABASE_URL pointing at a PostgreSQL instance whose user can create
 * temporary databases. Skipped automatically when DATABASE_URL is not set.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Pool } from 'pg';

const configuredDatabaseUrl = process.env.DATABASE_URL;
const RUN = Boolean(configuredDatabaseUrl);
const describeIf = RUN ? describe : describe.skip;

jest.setTimeout(120_000);

function databaseUrlFor(databaseName: string): string {
  if (!configuredDatabaseUrl) return '';
  const url = new URL(configuredDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describeIf('Migration integration', () => {
  const testDatabase = `cooplumen_migrate_${process.pid}_${Date.now()}`;
  const testDatabaseUrl = databaseUrlFor(testDatabase);
  let adminPool: Pool;
  let pool: Pool;
  let firstRunOutput: string;
  let initialTableCount: number;

  function runMigrations(): string {
    return execFileSync(process.execPath, ['-r', 'ts-node/register', 'src/db/migrate.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  async function schemaDefinition(): Promise<unknown> {
    const constraints = await pool.query<{
      table_name: string;
      constraint_name: string;
      definition: string;
    }>(
      `SELECT relation.relname AS table_name,
              constraint_record.conname AS constraint_name,
              pg_get_constraintdef(constraint_record.oid) AS definition
         FROM pg_constraint AS constraint_record
         JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
        ORDER BY relation.relname, constraint_record.conname`
    );
    const indexes = await pool.query<{ tablename: string; indexname: string; indexdef: string }>(
      `SELECT tablename, indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
        ORDER BY tablename, indexname`
    );

    return { constraints: constraints.rows, indexes: indexes.rows };
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor('postgres') });
    await adminPool.query(`CREATE DATABASE "${testDatabase}"`);

    pool = new Pool({ connectionString: testDatabaseUrl });
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pg_tables WHERE schemaname = 'public'`
    );
    initialTableCount = Number(rows[0].count);

    firstRunOutput = runMigrations();
  });

  afterAll(async () => {
    await pool?.end();

    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1
            AND pid <> pg_backend_pid()`,
        [testDatabase]
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${testDatabase}"`);
      await adminPool.end();
    }
  });

  it('applies all migrations in order to an empty database without error', () => {
    expect(initialTableCount).toBe(0);
    expect(firstRunOutput).toMatch(/Migrations applied successfully/i);
  });

  it('schema_migrations contains every migration file', async () => {
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
      .sort();

    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name'
    );
    const applied = rows.map((row) => row.name);

    expect(applied).toEqual(expect.arrayContaining(files));
    expect(applied).toHaveLength(files.length);
  });

  it('records the bootstrap migration exactly once', async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM schema_migrations WHERE name = $1`,
      ['001_schema_migrations.sql']
    );

    expect(Number(rows[0].count)).toBe(1);
  });

  it('schema_migrations is keyed on name and indexed on applied_at', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'schema_migrations'`
    );
    const definitions = rows.map((row) => row.indexdef).join('\n');

    expect(definitions).toMatch(/UNIQUE INDEX schema_migrations_pkey .*\(name\)/);
    expect(definitions).toMatch(/idx_schema_migrations_applied_at .*\(applied_at\)/);
  });

  it('is idempotent and preserves existing data and constraints', async () => {
    const communityId = '11111111-1111-4111-8111-111111111111';
    const stellarPublicKey = `G${'A'.repeat(55)}`;
    await pool.query(
      `INSERT INTO communities
         (id, name, description, issuer_public_key, asset_code, asset_issuer)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        communityId,
        'Migration sentinel',
        'Must survive a rerun',
        stellarPublicKey,
        'TEST',
        stellarPublicKey,
      ]
    );
    const definitionBefore = await schemaDefinition();

    const output = runMigrations();

    const { rows } = await pool.query<{
      id: string;
      name: string;
      description: string;
    }>('SELECT id, name, description FROM communities WHERE id = $1', [communityId]);
    expect(output).toMatch(/No pending migrations/i);
    expect(rows).toEqual([
      {
        id: communityId,
        name: 'Migration sentinel',
        description: 'Must survive a rerun',
      },
    ]);
    expect(await schemaDefinition()).toEqual(definitionBefore);
  });

  it('records a checksum for every applied migration', async () => {
    const { rows } = await pool.query<{ name: string; checksum: string | null }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name'
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('re-applying 019_member_role_check_idempotent.sql leaves one role constraint', async () => {
    const file = path.join(__dirname, '..', 'migrations', '019_member_role_check_idempotent.sql');

    // The runner records migrations by filename and never replays one, so apply
    // the file directly to exercise a manual replay or schema rebuild.
    const sql = await fs.readFile(file, 'utf8');

    await pool.query(sql);
    await pool.query(sql);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pg_constraint
        WHERE conrelid = 'members'::regclass
          AND conname = 'members_role_check'`
    );

    expect(Number(rows[0].count)).toBe(1);
  });

  it('re-applying the KYC activation preserves records and schema objects', async () => {
    const communityId = '22222222-2222-4222-8222-222222222222';
    const stellarAddress = `G${'B'.repeat(55)}`;
    await pool.query(
      `INSERT INTO communities
         (id, name, issuer_public_key, asset_code, asset_issuer)
       VALUES ($1, $2, $3, $4, $5)`,
      [communityId, 'KYC migration sentinel', stellarAddress, 'KYC', stellarAddress]
    );
    await pool.query(
      `INSERT INTO kyc_records (community_id, stellar_address, status, metadata)
       VALUES ($1, $2, 'pending', $3::jsonb)`,
      [communityId, stellarAddress, JSON.stringify({ preserved: true })]
    );

    const file = path.join(__dirname, '..', 'migrations', '025_activate_kyc_records.sql');
    const sql = await fs.readFile(file, 'utf8');
    await pool.query(sql);
    await pool.query(sql);

    const record = await pool.query<{ status: string; metadata: { preserved: boolean } }>(
      'SELECT status, metadata FROM kyc_records WHERE community_id = $1',
      [communityId]
    );
    const constraint = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pg_constraint
        WHERE conrelid = 'kyc_records'::regclass
          AND conname = 'kyc_records_stellar_address_format'`
    );
    const trigger = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pg_trigger
        WHERE tgrelid = 'kyc_records'::regclass
          AND tgname = 'kyc_records_updated_at'
          AND NOT tgisinternal`
    );

    expect(record.rows).toEqual([{ status: 'pending', metadata: { preserved: true } }]);
    expect(Number(constraint.rows[0].count)).toBe(1);
    expect(Number(trigger.rows[0].count)).toBe(1);
  });

  it('fails the run when an applied migration has been edited', async () => {
    await pool.query(
      `UPDATE schema_migrations SET checksum = 'tampered' WHERE name = '001_schema_migrations.sql'`
    );

    try {
      expect(() => runMigrations()).toThrow();
    } finally {
      const sql = await fs.readFile(
        path.join(__dirname, '..', 'migrations', '001_schema_migrations.sql'),
        'utf8'
      );
      await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE name = $2', [
        createHash('sha256').update(sql, 'utf8').digest('hex'),
        '001_schema_migrations.sql',
      ]);
    }
  });

  it('all expected tables exist after migration', async () => {
    const expectedTables = [
      'audit_log',
      'communities',
      'community_settings',
      'idempotency_keys',
      'kyc_records',
      'loan_events',
      'loans',
      'members',
      'multisig_requests',
      'notifications',
      'payments',
      'proposal_delegations',
      'proposals',
      'reputation_scores',
      'schema_migrations',
      'tokens',
      'transactions_log',
      'trustlines',
      'votes',
    ];

    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );

    expect(rows.map((row) => row.tablename)).toEqual(expectedTables);
  });
});
