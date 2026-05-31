const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const redis = require('redis');
const crypto = require('crypto');
const db = require('./db');
const routes = require('./routes');

const app = express();
app.use(express.json());

// Enable CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

app.use('/api', routes);
app.use('/', routes); // Support root-level calls like /metrics and /Metrics

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Active WS connections
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`WebSocket client connected. Total clients: ${clients.size}`);
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`WebSocket client disconnected. Total clients: ${clients.size}`);
  });
});

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// Ingestion endpoint for pipeline
app.post('/api/ingest', async (req, res) => {
  const event = req.body;
  if (!event || !event.event_type || !event.customer_id) {
    return res.status(400).json({ error: "Invalid event format" });
  }
  try {
    await processEvent(event);
    res.json({ success: true });
  } catch (err) {
    console.error("Error processing ingested event:", err);
    res.status(500).json({ error: err.message });
  }
});

// Process event and update database
async function processEvent(event) {
  const id = crypto.randomUUID(); // always use a proper UUID for DB (pipeline IDs like evt_XXXX are not valid UUIDs)
  const timestamp = event.timestamp || new Date().toISOString();
  const camera_id = event.camera_id || 'CAM_UNKNOWN';
  const type = event.event_type;
  const customerId = event.customer_id;
  const groupId = event.group_id || null;
  const zone = event.zone || null;
  const brand = event.brand || null;
  const isStaff = event.is_staff || false;
  const payload = event.payload || {};

  // 1. Insert into events table
  await db.query(`
    INSERT INTO events (id, timestamp, camera_id, event_type, customer_id, group_id, zone, brand, is_staff, raw_payload)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (id) DO NOTHING
  `, [id, timestamp, camera_id, type, customerId, groupId, zone, brand, isStaff, JSON.stringify(payload)]);

  // 2. Manage sessions
  if (type === 'ENTRY') {
    await db.query(`
      INSERT INTO sessions (customer_id, start_time, is_staff, group_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (customer_id) DO UPDATE
      SET re_entries = sessions.re_entries + 1
    `, [customerId, timestamp, isStaff, groupId]);
  } else if (type === 'EXIT') {
    await db.query(`
      UPDATE sessions 
      SET end_time = $2 
      WHERE customer_id = $1 AND end_time IS NULL
    `, [customerId, timestamp]);
  }

  // 3. Track brand dwell times
  if (type === 'ZONE_EXIT' && brand && payload.dwell_seconds) {
    const dwellSeconds = parseInt(payload.dwell_seconds, 10);
    await db.query(`
      INSERT INTO brand_dwell (customer_id, brand, dwell_seconds, timestamp)
      VALUES ($1, $2, $3, $4)
    `, [customerId, brand, dwellSeconds, timestamp]);
  }

  // 4. Real-time Anomaly Detection Rules
  if (!isStaff) {
    // Rule A: Loitering at Cash Counter without checkout
    if (type === 'ZONE_EXIT' && zone === 'Cash Counter' && payload.dwell_seconds > 180) {
      await logAnomaly(
        timestamp, 
        'LOITERING', 
        `Customer ${customerId} loitered at the Cash Counter for ${Math.round(payload.dwell_seconds / 60)} minutes without checking out.`, 
        'LOW', 
        customerId
      );
    }

    // Rule B: Unauthorized Zone Access (Restricted Area)
    if (type === 'ZONE_ENTRY' && zone === 'Restricted Area') {
      await logAnomaly(
        timestamp, 
        'UNAUTHORIZED_ACCESS', 
        `Customer ${customerId} entered a restricted employee-only zone.`, 
        'HIGH', 
        customerId
      );
    }

    // Rule C: Queue Congestion Warning
    if (type === 'ZONE_ENTRY' && zone === 'Cash Counter') {
      const queueRes = await db.query(`
        SELECT COUNT(DISTINCT customer_id) as count 
        FROM events 
        WHERE zone = 'Cash Counter' AND event_type = 'ZONE_ENTRY' 
          AND timestamp > NOW() - INTERVAL '5 minutes'
      `);
      const queueCount = parseInt(queueRes.rows[0].count || '0', 10);
      if (queueCount >= 5) {
        await logAnomaly(
          timestamp, 
          'QUEUE_CONGESTION', 
          `High queue congestion detected at Cash Counter. ${queueCount} customers waiting.`, 
          'MEDIUM'
        );
      }
    }
  }

  // Broadcast event to WS clients for real-time dashboard feed
  broadcast({
    event_id: id,
    timestamp,
    camera_id,
    event_type: type,
    customer_id: customerId,
    zone,
    brand,
    is_staff: isStaff,
    payload
  });
}

async function logAnomaly(timestamp, type, description, severity, customerId = null) {
  try {
    const res = await db.query(`
      INSERT INTO anomalies (timestamp, type, description, severity, customer_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [timestamp, type, description, severity, customerId]);
    
    // Broadcast anomaly instantly
    broadcast({
      event_type: 'ANOMALY_DETECTED',
      anomaly: res.rows[0]
    });
    console.log(`[ANOMALY ALERT] ${type}: ${description}`);
  } catch (err) {
    console.error("Error inserting anomaly record:", err);
  }
}

// Connect to Redis and subscribe to events
async function startRedisSubscription() {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  console.log(`Connecting to Redis at: ${redisUrl}`);
  const client = redis.createClient({ url: redisUrl });
  
  client.on('error', (err) => console.error('Redis Client Error:', err));
  
  await client.connect();
  console.log("Connected to Redis successfully.");

  const subscriber = client.duplicate();
  await subscriber.connect();

  await subscriber.subscribe('store_events', async (message) => {
    try {
      const event = JSON.parse(message);
      await processEvent(event);
    } catch (e) {
      console.error("Error processing Redis subscribed message:", e);
    }
  });

  console.log("Subscribed to Redis channel 'store_events'.");
}

async function start() {
  const port = process.env.PORT || 3000;
  try {
    // Wait for database to initialize tables
    await db.initDB();
    
    // Start Redis client subscription
    await startRedisSubscription().catch(e => {
      console.warn("Could not start Redis subscription (fallback to HTTP ingestion):", e.message);
    });

    server.listen(port, () => {
      console.log(`Store Intelligence API Server is running on port ${port}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
