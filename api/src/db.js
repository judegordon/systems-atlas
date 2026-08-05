const { Pool } = require('pg');

// One pool, one database. The atlas tables live in the `atlas` schema and the
// app tables live in `public`; every query in this codebase names its schema
// explicitly, and the search_path below is a second line of defence rather
// than the mechanism. `public` stays on it so the citext type resolves.
// search_path is set as a startup parameter rather than by a query on the
// 'connect' event. That handler cannot be awaited, so the SET raced the first
// real query on the connection and pg 8 warns that it is deprecated. Sent this
// way it is applied by the server before the connection is handed over, and
// there is no window in which it has not taken effect.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: '-c search_path=atlas,public',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
    console.error('Postgres pool error:', err.message);
});

module.exports = pool;
