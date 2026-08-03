#!/usr/bin/env node
//
// Applies every unapplied file in api/migrations, in filename order.
//
//     node scripts/migrate.js            apply what is outstanding
//     node scripts/migrate.js --status   list without applying
//
// Each file is applied in one transaction along with the row that records it,
// so a migration is either fully applied and recorded, or neither.

if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config({ quiet: true });
}

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DIR = path.join(__dirname, '..', 'migrations');

async function main() {
    const statusOnly = process.argv.includes('--status');

    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set.');
        process.exit(1);
    }

    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
    await client.connect();

    try {
        // The ledger has to exist before the first migration can be recorded,
        // and the first migration is the one that creates the schema.
        await client.query('CREATE SCHEMA IF NOT EXISTS atlas');
        await client.query(`
            CREATE TABLE IF NOT EXISTS atlas.schema_migrations (
                version    TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        const applied = new Set(
            (await client.query('SELECT version FROM atlas.schema_migrations')).rows
                .map((r) => r.version)
        );

        const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
        const pending = files.filter((f) => !applied.has(f));

        if (statusOnly) {
            for (const f of files) {
                console.log(`${applied.has(f) ? 'applied ' : 'pending '} ${f}`);
            }
            return;
        }

        if (pending.length === 0) {
            console.log('Nothing to apply.');
            return;
        }

        for (const file of pending) {
            const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
            process.stdout.write(`Applying ${file} ... `);
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query(
                    'INSERT INTO atlas.schema_migrations (version) VALUES ($1)',
                    [file]
                );
                await client.query('COMMIT');
                console.log('ok');
            } catch (err) {
                await client.query('ROLLBACK');
                console.log('failed');
                throw err;
            }
        }
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
