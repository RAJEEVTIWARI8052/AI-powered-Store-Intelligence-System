const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const redis   = require('redis');
const crypto  = require('crypto');
const db      = require('./db');
const routes  = require('./routes');
const logger  = require('./logger');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');

let redisPublisher = null;

// ---------------------------------------------------------------------------
// Prometheus metrics setup
// ---------------------------------------------------------------------------
let promClient, httpRequestCounter, httpRequestDuration, eventsProcessed, anomaliesTriggered;
try {
  promClient = require('prom-client');
  promClient.collectDefaultMetrics({ prefix: 'store_api_' });

  httpRequestCounter = new promClient.Counter({
    name: 'store_api_http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
  });

  httpRequestDuration = new promClient.Histogram({
    name: 'store_api_http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1.0, 2.0],
  });

  eventsProcessed = new promClient.Counter({
    name: 'store_api_events_processed_total',
    help: 'Total pipeline events processed',
    labelNames: ['event_type'],
  });

  anomaliesTriggered = new promClient.Counter({
    name: 'store_api_anomalies_total',
    help: 'Total anomalies detected',
    labelNames: ['anomaly_type', 'severity'],
  });

  logger.info('Prometheus metrics initialised');
} catch (e) {
  logger.warn('prom-client not available — metrics endpoint disabled', { error: e.message });
}

const app = express();
app.use(express.json());

// HTTP request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const route = req.path.replace(/\/[0-9a-f-]{36}/gi, '/:id');
    logger.http(`${req.method} ${req.path}`, { status: res.statusCode, ms });
    if (httpRequestCounter)  httpRequestCounter.inc({ method: req.method, route, status: res.statusCode });
    if (httpRequestDuration) httpRequestDuration.observe({ method: req.method, route }, ms / 1000);
  });
  next();
});

// Enable CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

app.use('/api', routes);
app.use('/', routes); // Support root-level calls like /metrics and /Metrics

// Configure multer for video upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = '/app/uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Keep original name but add timestamp to avoid collisions
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    cb(null, `${basename}_${Date.now()}${ext}`);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit
});

app.post('/api/upload-video', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file provided' });
  }
  
  logger.info('Video uploaded successfully', { filename: req.file.filename, size: req.file.size });
  
  // Publish message to Redis to trigger pipeline
  if (redisPublisher) {
    redisPublisher.publish('process_video', JSON.stringify({
      filename: req.file.filename,
      filepath: req.file.path
    })).catch(err => {
      logger.error('Failed to publish process_video event', { error: err.message });
    });
  }
  
  res.json({ 
    success: true, 
    message: 'Video uploaded and processing triggered',
    filename: req.file.filename
  });
});


// Prometheus metrics endpoint
app.get('/api/system/metrics', async (req, res) => {
  if (!promClient) return res.status(503).json({ error: 'Metrics not available' });
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

// Health-check endpoint
app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'degraded', db: 'disconnected', error: e.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Active WS connections
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  logger.info('WebSocket client connected', { total: clients.size });

  ws.on('close', () => {
    clients.delete(ws);
    logger.info('WebSocket client disconnected', { total: clients.size });
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

// Ingestion endpoint for pipeline — accepts official Purplle JSONL schema
// Supports: id_token (entry/exit), track_id (zone/queue), or legacy customer_id
app.post('/api/ingest', async (req, res) => {
  const event = req.body;
  if (!event || !event.event_type) {
    return res.status(400).json({ error: "Invalid event: event_type is required" });
  }
  const hasId = event.customer_id || event.id_token || event.track_id;
  if (!hasId) {
    return res.status(400).json({ error: "Invalid event: one of customer_id, id_token, or track_id is required" });
  }
  try {
    await processEvent(event);
    if (eventsProcessed) eventsProcessed.inc({ event_type: event.event_type });
    res.json({ success: true });
  } catch (err) {
    logger.error('Error processing ingested event', { error: err.message, event_type: event.event_type });
    res.status(500).json({ error: err.message });
  }
});

// Process event and update database
// Normalises both the official Purplle JSONL schema and the legacy internal schema.
async function processEvent(event) {
  const rawType = (event.event_type || '').trim();

  // Map official schema event types → internal DB types
  const typeMap = {
    'entry':            'ENTRY',
    'exit':             'EXIT',
    'zone_entered':     'ZONE_ENTRY',
    'zone_exited':      'ZONE_EXIT',
    'queue_completed':  'CHECKOUT_COMPLETE',
    'queue_abandoned':  'CHECKOUT_ABANDONED',
    // Legacy internal types (already uppercase) pass through unchanged
  };
  let type = typeMap[rawType] || rawType.toUpperCase();

  // Resolve customer identifier — official schema uses id_token (entry/exit)
  // or track_id (zone/queue); legacy schema uses customer_id directly.
  let customerId = event.customer_id;
  if (!customerId && event.id_token) {
    customerId = String(event.id_token);
  } else if (!customerId && event.track_id !== undefined) {
    customerId = `track_${event.track_id}`;
  } else if (!customerId) {
    customerId = 'cust_unknown';
  }

  const timestamp = event.event_timestamp || event.event_time || event.queue_join_ts || event.timestamp || new Date().toISOString();
  const camera_id = event.camera_id || 'CAM_UNKNOWN';
  const groupId   = event.group_id || null;

  // Resolve zone — official schema uses zone_name, legacy uses zone
  let zone = event.zone_name || event.zone || null;
  if (type === 'CHECKOUT_COMPLETE' || type === 'CHECKOUT_ABANDONED') {
    zone = zone || 'Cash Counter';
  }

  let brand = event.brand || null;
  if (!brand && zone) {
    // Dynamically associate shelf layout areas to brands to keep analytics functioning
    const zoneBrands = {
      'Makeup': ["Maybelline", "Lakme", "Faces Canada", "Swiss Beauty"],
      'Skincare': ["Minimalist", "Neutrogena", "Aqualogica", "COSRX", "Foxtale"],
      'Haircare': ["Bare Anatomy", "Garnier", "Pilgrim", "Good Vibes"],
      'Left Shelf': ["Maybelline", "Lakme"],
      'Lipstick Aisle': ["Faces Canada", "Swiss Beauty"],
      'Center Display': ["Minimalist", "Aqualogica"],
      'Billing Counter Queue': ["Purplle"]
    };
    const brands = zoneBrands[zone] || ["Unknown"];
    const idNum = parseInt(customerId.replace(/\D/g, '') || '0', 10) || 1;
    brand = brands[idNum % brands.length];
  }

  const isStaff = event.is_staff || false;
  let payload = event.payload || {};
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch(e) { payload = {}; }
  }

  // Calculate dwell_seconds if zone_exited occurs and it is not in the payload
  if (!payload.dwell_seconds && type === 'ZONE_EXIT') {
    try {
      const enterRes = await db.query(
        "SELECT timestamp FROM events WHERE customer_id = $1 AND event_type = 'ZONE_ENTRY' AND zone = $2 ORDER BY timestamp DESC LIMIT 1",
        [customerId, zone]
      );
      if (enterRes.rows.length > 0) {
        const enterTime = new Date(enterRes.rows[0].timestamp);
        const exitTime = new Date(timestamp);
        payload.dwell_seconds = Math.max(1, Math.round((exitTime - enterTime) / 1000));
      } else {
        payload.dwell_seconds = 30; // fallback standard
      }
    } catch(err) {
      payload.dwell_seconds = 30;
    }
  }

  if (type === 'CHECKOUT_COMPLETE') {
    if (event.wait_seconds !== undefined) {
      payload.dwell_seconds = parseInt(event.wait_seconds, 10);
    } else if (event.queue_exit_ts && event.queue_join_ts) {
      const enterTime = new Date(event.queue_join_ts);
      const exitTime = new Date(event.queue_exit_ts);
      payload.dwell_seconds = Math.max(1, Math.round((exitTime - enterTime) / 1000));
    }
    payload.purchase_completed = !(event.abandoned || false);
    payload.salesperson = event.salesperson || "Zufishan Khazra";
  }

  const id = crypto.randomUUID(); // always use a proper UUID for DB
  
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
    // Rule A: Loitering at Cash Counter without completing checkout
    // Threshold: 45s — realistic for a simulated tick cycle
    if (type === 'ZONE_EXIT' && zone === 'Cash Counter' && payload.dwell_seconds > 45) {
      const alreadyCheckedOut = await db.query(
        `SELECT COUNT(*) as c FROM events WHERE customer_id=$1 AND event_type IN ('CHECKOUT_COMPLETE','CHECKOUT_ABANDONED') AND timestamp > NOW() - INTERVAL '10 minutes'`,
        [customerId]
      );
      if (parseInt(alreadyCheckedOut.rows[0].c, 10) === 0) {
        await logAnomaly(
          timestamp,
          'LOITERING',
          `Customer ${customerId} loitered at the Cash Counter for ${payload.dwell_seconds}s without completing checkout — possible confusion or abandonment.`,
          'MEDIUM',
          customerId
        );
      }
    }

    // Rule B: Unauthorized Zone Access (Restricted Area)
    if (type === 'ZONE_ENTRY' && zone === 'Restricted Area') {
      await logAnomaly(
        timestamp,
        'UNAUTHORIZED_ACCESS',
        `SECURITY ALERT: Customer ${customerId} breached the restricted employee-only zone. Immediate staff response required.`,
        'HIGH',
        customerId
      );
    }

    // Rule C: Queue Congestion Warning — 3+ customers at Cash Counter in 10 minutes
    if (type === 'ZONE_ENTRY' && (zone === 'Cash Counter' || zone === 'Billing Counter Queue')) {
      const queueRes = await db.query(`
        SELECT COUNT(DISTINCT customer_id) as count
        FROM events
        WHERE zone IN ('Cash Counter','Billing Counter Queue')
          AND event_type IN ('ZONE_ENTRY','CHECKOUT_COMPLETE','CHECKOUT_ABANDONED')
          AND timestamp > NOW() - INTERVAL '10 minutes'
          AND is_staff = FALSE
      `);
      const queueCount = parseInt(queueRes.rows[0].count || '0', 10);
      if (queueCount >= 3) {
        // Deduplicate — only alert once per 2-minute window
        const recentCongestion = await db.query(
          `SELECT COUNT(*) as c FROM anomalies WHERE type='QUEUE_CONGESTION' AND timestamp > NOW() - INTERVAL '2 minutes'`
        );
        if (parseInt(recentCongestion.rows[0].c, 10) === 0) {
          await logAnomaly(
            timestamp,
            'QUEUE_CONGESTION',
            `Queue congestion at billing counter — ${queueCount} customers in the last 10 minutes. Consider opening an additional checkout lane.`,
            'MEDIUM'
          );
        }
      }
    }

    // Rule D: High dwell at shelf zone — potential shoplifting or deep product engagement
    if (type === 'ZONE_EXIT' && zone !== 'Cash Counter' && zone !== 'Restricted Area' && payload.dwell_seconds > 90) {
      // Only flag if no purchase follows (cannot know yet, so flag as INFO for staff awareness)
      await logAnomaly(
        timestamp,
        'HIGH_DWELL',
        `Customer ${customerId} spent ${payload.dwell_seconds}s at the ${zone} shelf — high engagement detected. Staff may want to assist.`,
        'LOW',
        customerId
      );
    }

    // Rule E: Checkout abandonment — customer left queue without buying
    if (type === 'CHECKOUT_ABANDONED') {
      await logAnomaly(
        timestamp,
        'CHECKOUT_ABANDONED',
        `Customer ${customerId} abandoned the checkout queue after ${payload.dwell_seconds || '?'}s wait. Review queue staffing or pricing friction.`,
        'MEDIUM',
        customerId
      );
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

    broadcast({ event_type: 'ANOMALY_DETECTED', anomaly: res.rows[0] });
    if (anomaliesTriggered) anomaliesTriggered.inc({ anomaly_type: type, severity });
    logger.warn('Anomaly detected', { type, severity, customer_id: customerId, description });
  } catch (err) {
    logger.error('Error inserting anomaly record', { error: err.message });
  }
}

// Connect to Redis and subscribe to events
async function startRedisSubscription() {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  logger.info(`Connecting to Redis`, { url: redisUrl });
  const client = redis.createClient({ url: redisUrl });

  client.on('error', (err) => logger.error('Redis Client Error', { error: err.message }));

  await client.connect();
  redisPublisher = client;
  logger.info('Connected to Redis successfully');

  const subscriber = client.duplicate();
  await subscriber.connect();

  await subscriber.subscribe('store_events', async (message) => {
    try {
      const event = JSON.parse(message);
      await processEvent(event);
      if (eventsProcessed) eventsProcessed.inc({ event_type: event.event_type || 'unknown' });
    } catch (e) {
      logger.error('Error processing Redis event', { error: e.message });
    }
  });

  logger.info("Subscribed to Redis channel 'store_events'");
}

async function start() {
  const port = process.env.PORT || 3000;
  try {
    await db.initDB();
    await startRedisSubscription().catch(e => {
      logger.warn('Could not start Redis subscription (fallback to HTTP ingestion)', { error: e.message });
    });

    server.listen(port, () => {
      logger.info(`Store Intelligence API running`, { port, env: process.env.NODE_ENV || 'development' });
    });
  } catch (err) {
    logger.error('Fatal: failed to start server', { error: err.message });
    process.exit(1);
  }
}

start();
