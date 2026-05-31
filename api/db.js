const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'store_user',
  password: process.env.DB_PASSWORD || 'store_secure_pass_2026',
  database: process.env.DB_NAME || 'store_intelligence',
  port: process.env.DB_PORT || 5432,
});

async function initDB() {
  console.log("Initializing database tables...");
  let client;
  let retries = 5;
  while (retries > 0) {
    try {
      client = await pool.connect();
      break;
    } catch (err) {
      retries -= 1;
      console.log(`Database connection failed. Retries left: ${retries}. Waiting 3 seconds...`);
      if (retries === 0) throw err;
      await new Promise(res => setTimeout(res, 3000));
    }
  }
  try {
    await client.query('BEGIN');

    // Create events table
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id UUID PRIMARY KEY,
        timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
        camera_id VARCHAR(50) NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        customer_id VARCHAR(100) NOT NULL,
        group_id VARCHAR(100),
        zone VARCHAR(100),
        brand VARCHAR(100),
        is_staff BOOLEAN DEFAULT FALSE,
        raw_payload JSONB
      );
    `);

    // Create sessions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        customer_id VARCHAR(100) PRIMARY KEY,
        start_time TIMESTAMP WITH TIME ZONE NOT NULL,
        end_time TIMESTAMP WITH TIME ZONE,
        is_staff BOOLEAN DEFAULT FALSE,
        re_entries INTEGER DEFAULT 0,
        group_id VARCHAR(100)
      );
    `);

    // Create anomalies table
    await client.query(`
      CREATE TABLE IF NOT EXISTS anomalies (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
        type VARCHAR(100) NOT NULL,
        description TEXT NOT NULL,
        severity VARCHAR(50) NOT NULL,
        customer_id VARCHAR(100)
      );
    `);

    // Create brand_dwell table for performance tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS brand_dwell (
        id SERIAL PRIMARY KEY,
        customer_id VARCHAR(100) NOT NULL,
        brand VARCHAR(100) NOT NULL,
        dwell_seconds INTEGER NOT NULL,
        timestamp TIMESTAMP WITH TIME ZONE NOT NULL
      );
    `);

    // Create indexes for efficient querying
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_customer ON events(customer_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_anomalies_timestamp ON anomalies(timestamp);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_brand_dwell ON brand_dwell(brand);`);

    await client.query('COMMIT');
    console.log("Database tables initialized successfully.");
  } catch (e) {
    await client.query('ROLLBACK');
    console.error("Error initializing database tables:", e);
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  initDB
};
