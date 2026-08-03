const { Pool } = require('pg');

// One pool, one database. The atlas tables live in the `atlas` schema and the
// app tables live in `public`; every query in this codebase names its schema
// explicitly, and the search_path below is a second line of defence rather
// than the mechanism. `public` stays on it so the citext type resolves.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('connect', (client) => {
    client.query('SET search_path = atlas, public');
});

pool.on('error', (err) => {
    console.error('Postgres pool error:', err.message);
});

module.exports = pool;
