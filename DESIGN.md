# AURA — Store Intelligence System: Architecture & Design

AURA is a production-grade, end-to-end AI-powered Store Intelligence System built for Purplle. It ingests raw CCTV video footage, tracks customer movement using computer vision, correlates behaviour with POS transactions, and delivers real-time analytics via a live dashboard.

---

## 1. System Architecture

```
  ┌──────────────────────────────────────────┐
  │  CCTV Video Files (any naming convention) │
  │  Store 1: CAM 3 - entry.mp4, etc.        │
  │  Store 2: entry 1.mp4, billing_area.mp4  │
  └────────────────────┬─────────────────────┘
                       │
                       ▼
  ┌──────────────────────────────────────────┐
  │         Python Detection Pipeline        │
  │  YOLOv8-nano  ·  StoreTracker            │
  │  Dynamic camera classifier               │
  │  Emits: official Purplle JSONL schema    │
  └────────────────────┬─────────────────────┘
                       │  Redis Pub/Sub  (primary)
                       │  HTTP POST      (fallback)
                       ▼
  ┌──────────────────────────────────────────┐
  │        Node.js Express REST API          │
  │  Schema normaliser · Session tracker     │
  │  Anomaly engine  · POS correlator        │
  └──────┬───────────────────────────────────┘
         │  Write                │  Read
         ▼                       ▼
  ┌────────────┐     ┌──────────────────────┐
  │ PostgreSQL │     │  transactions.csv    │
  │ events     │     │  (Brigade Bangalore  │
  │ sessions   │     │   detailed POS data) │
  │ anomalies  │     └──────────────────────┘
  │ brand_dwell│
  └────────────┘
         ▲
         │  REST + WebSocket
  ┌──────┴────────────────────────────────────┐
  │   Vite + React Live Dashboard             │
  │   Footfall · Funnel · Heatmap · Alerts    │
  └───────────────────────────────────────────┘
```

### Container topology (`docker compose up`)

| Container | Role | Port |
|-----------|------|------|
| `store_intel_db` | PostgreSQL 15 | 5432 |
| `store_intel_redis` | Redis 7 | 6379 |
| `store_intel_api` | Express API + WebSocket | 3000 |
| `store_intel_pipeline` | Python CV + Simulation | — |
| `store_intel_dashboard` | Nginx → Vite SPA | 80 |

---

## 2. Event Schema (Official Purplle JSONL Format)

The pipeline emits events in the official Purplle JSONL schema. Three event families are supported:

### 2a. Entry / Exit  (CAM at store gate)
```json
{
  "event_type":      "entry",
  "id_token":        "ID_60001",
  "store_code":      "store_1076",
  "camera_id":       "CAM 3 - entry",
  "event_timestamp": "2026-03-08T18:10:05.120000",
  "is_staff":        false,
  "gender_pred":     "F",
  "age_pred":        28,
  "age_bucket":      "25-34",
  "is_face_hidden":  false,
  "group_id":        null,
  "group_size":      null
}
```

### 2b. Zone Entry / Exit  (shelf-area cameras)
```json
{
  "event_type":      "zone_entered",
  "track_id":        60101,
  "store_id":        "ST1076",
  "camera_id":       "CAM 2 - zone",
  "zone_id":         "PURPLLE_ST1076_Z01",
  "zone_name":       "Makeup",
  "zone_type":       "SHELF",
  "is_revenue_zone": "Yes",
  "event_time":      "2026-03-08T18:10:45.280000",
  "zone_hotspot_x":  412.6,
  "zone_hotspot_y":  238.4,
  "gender":          "F",
  "age":             28,
  "age_bucket":      "25-34"
}
```

### 2c. Queue Events  (billing counter camera)
```json
{
  "queue_event_id":        "uuid-v4",
  "event_type":            "queue_completed",
  "track_id":              60102,
  "store_id":              "ST1076",
  "camera_id":             "CAM 5 - billing",
  "zone_id":               "PURPLLE_ST1076_Z_BILLING_01",
  "zone_name":             "Billing Counter Queue",
  "zone_type":             "BILLING",
  "is_revenue_zone":       "Yes",
  "queue_join_ts":         "2026-03-08T18:13:05.080000",
  "queue_served_ts":       "2026-03-08T18:13:13.240000",
  "queue_exit_ts":         "2026-03-08T18:15:31.840000",
  "wait_seconds":          8,
  "queue_position_at_join": 2,
  "abandoned":             false,
  "zone_hotspot_x":        602.8,
  "zone_hotspot_y":        183.4,
  "gender":                "M",
  "age":                   31,
  "age_bucket":            "25-34"
}
```

The API's `/api/ingest` endpoint normalises all three schemas into the internal DB representation automatically.

---

## 3. Dynamic Camera Classifier

The `classify_camera(video_name)` function in `tracker.py` handles arbitrary naming conventions used across different stores, using ranked keyword matching:

| Priority | Keywords matched (case-insensitive) | Assigned type |
|----------|-------------------------------------|---------------|
| 1 | `entry`, `entrance`, `door`, `gate` | `entry_exit` |
| 2 | `billing`, `checkout`, `cash`, `payment`, `queue`, `counter` | `checkout` |
| 3 | `makeup`, `cosmetic`, `lipstick` | `zone → Makeup` |
| 4 | `skincare`, `skin` | `zone → Skincare` |
| 5 | `hair` | `zone → Haircare` |
| 6 | Legacy: `CAM 1`–`CAM 5` pattern | mapped to type by number |
| 7 | Default fallback | `zone → Skincare` |

Examples:
- `CAM 3 - entry.mp4` → `entry_exit`
- `CAM 5 - billing.mp4` → `checkout`
- `billing_area.mp4` → `checkout`
- `entry 1.mp4` → `entry_exit`
- `entry 2.mp4` → `entry_exit`
- `zone.mp4` → `zone → Skincare`
- `CAM 2 - zone.mp4` → `zone → Makeup`

---

## 4. Database Schema

### `events`
Stores all raw events from the pipeline.
- `id` UUID PK · `timestamp` TIMESTAMPTZ · `camera_id` · `event_type`
- `customer_id` · `group_id` · `zone` · `brand` · `is_staff` · `raw_payload` JSONB

### `sessions`
One row per unique customer visit.
- `customer_id` PK · `start_time` · `end_time` · `is_staff` · `re_entries` · `group_id`

### `anomalies`
Real-time alerts from rule-based engine.
- `id` SERIAL PK · `timestamp` · `type` · `description` · `severity` · `customer_id`

### `brand_dwell`
Aggregated shelf-dwell time per brand for Dwell-Revenue Index calculation.
- `id` SERIAL PK · `customer_id` · `brand` · `dwell_seconds` · `timestamp`

---

## 5. API Endpoints

| Method | Path | Description |
|--------|------|--------------|
| `POST` | `/api/ingest` | Receive events from pipeline (Redis fallback) |
| `GET`  | `/api/metrics` | Footfall, active customers, dwell, GMV, conversion rate (capped ≤100%) |
| `GET`  | `/api/funnel` | 5-step customer conversion funnel (brand_dwell-backed) |
| `GET`  | `/api/anomaly` | Last 50 anomalies with type, severity, description |
| `GET`  | `/api/sales` | Brand dwell-to-revenue correlation + planogram analysis |
| `GET`  | `/api/status` | System health summary (events, sessions, anomalies, brands) |
| `GET`  | `/api/health` | DB connectivity probe |
| `GET`  | `/Metrics` | Alias for `/api/metrics` (case-insensitive — all routes dual-registered) |
| `WS`   | `/ws` | WebSocket stream — real-time event and anomaly broadcast via nginx proxy |

---

## 6. Anomaly Detection Rules

The API implements three real-time heuristics:
1. **Loitering** — Customer in Cash Counter zone > 3 minutes without checkout
2. **Unauthorized Access** — Customer enters a `Restricted Area` zone
3. **Queue Congestion** — Billing queue dwell > 5 minutes (`queue_abandoned` with `wait_seconds > 300`)

---

## 7. Dual-Mode Execution

**CV Mode**: When CCTV footage MP4 files are mounted in `/app/cctv_footage`, the pipeline:
1. Classifies each video dynamically via `classify_camera()`
2. Runs YOLOv8-nano person detection at 1 fps
3. Uses IoU-based greedy tracking across frames
4. Emits official schema events

**Simulation Mode**: When no footage is found, generates a correlated, high-fidelity event stream using the `transactions.csv` dataset to drive realistic customer paths (entry → zone browse → billing queue → exit).

---

## 8. POS Data Integration

The system uses the detailed Brigade Road Bangalore POS dataset (`Brigade_Bangalore_10_April_26.csv`) which provides:
- Real GMV and NMV per line item
- Actual salesperson names (kasthuri v, Zufishan Khazra, etc.)
- Brand-level revenue breakdown across 20+ brands
- Sub-category performance metrics

The `/api/sales` endpoint correlates this data with CV-detected dwell times to compute **Dwell-Revenue Index (₹/hr)** per brand — a key planogram optimisation signal.

---

## 9. Real-Time WebSocket Architecture

```
Pipeline (Python)
    │
    │  redis.publish("store_events", json.dumps(event))
    ▼
Redis Pub/Sub  ──────────────────────────────────────┐
    │                                                 │
    ▼                                                 │
API Server (Node.js)                                  │
    │  subscriber.subscribe("store_events")            │
    │  → processEvent(event)                          │
    │  → broadcast(event) to all WS clients           │
    │                                                 │
    ▼                                                 │
WebSocket Server (ws on port 3000)                   │
    │  wss.on("connection") → clients.add(ws)         │
    │                                                 │
    ▼                                                 │
Nginx (/ws proxy_pass → api:3000)                    │
    │  Upgrade: websocket headers forwarded            │
    │  proxy_read_timeout 3600s                        │
    ▼                                                 │
Browser Dashboard (React)                            │
    │  new WebSocket("ws://localhost/ws")              │
    │  onmessage → update Live Feed / Anomaly Logs    │
    └─────────────────────────────────────────────────┘
```

**Key design decisions:**
- WebSocket server is co-located with the HTTP API (shared `http.Server`) to avoid an extra port.
- Nginx proxies `/ws` with `Upgrade` and `Connection: upgrade` headers and a 3600-second read timeout to prevent idle disconnects.
- The dashboard reconnects automatically every 3 seconds on disconnect.
- Anomaly events (`ANOMALY_DETECTED` type) are routed to the Anomaly Logs tab; all other events go to the Live Detection Feed ticker.

---

## 10. Observability Stack

| Layer | Implementation |
|-------|---------------|
| **Structured logging** | Winston JSON logs with level, timestamp, HTTP method, path, status, duration (ms) |
| **Prometheus metrics** | `prom-client` — HTTP request counter, request latency histogram, events processed counter, anomaly counter |
| **Health check** | `GET /api/health` — validates DB connectivity, returns ISO timestamp |
| **System status** | `GET /api/status` — DB event count, session stats, anomaly count, brands tracked |
| **Docker healthchecks** | PostgreSQL `pg_isready`, Redis `redis-cli ping` — both services must pass before dependent containers start |
