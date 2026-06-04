# AURA — AI-powered Store Intelligence System

AURA is an end-to-end computer vision and analytics platform that transforms CCTV video footage into actionable business intelligence for retail stores.

## Key Features
- **Computer Vision Pipeline**: Detects people, tracks movement, and identifies staff vs. customers using YOLOv8.
- **Event Streaming**: Emits live events (entry/exit, zone dwell, queue waits) using Redis Pub/Sub.
- **Real-Time Dashboard**: A Vite+React single-page application displaying live metrics, heatmaps, and funnel analytics.
- **REST API**: Node.js/Express backend backed by PostgreSQL for querying funnel data, anomalies, and brand revenue correlation.
- **Official Schema Support**: Fully compliant with the Purplle JSONL event schema.

## Deliverables Checklist
- [x] Event log file (`events.jsonl`)
- [x] `README.md` (This file)
- [x] `DESIGN.md` (Including AI-Assisted Decisions)
- [x] `CHOICES.md` (Architecture and Trade-offs)

## Quick Start (Docker Compose)

The entire system is containerised and can be launched with a single command:

```bash
docker-compose up --build
```

### Services Started:
- **PostgreSQL**: `localhost:5432`
- **Redis**: `localhost:6379`
- **API Server**: `http://localhost:3000`
- **Dashboard**: `http://localhost:80` (nginx)
- **Pipeline**: Runs in background, streams to Redis

## Local Development (Without Docker)

### 1. API
```bash
cd api
npm install
npm start
```

### 2. Dashboard
```bash
cd dashboard
npm install
npm run dev
```

### 3. Pipeline
```bash
cd pipeline
pip install -r requirements.txt
python main.py
```

## Running the Pipeline for Event Log Generation
To generate the final `events.jsonl` log file, place the test MP4 CCTV footage in the `CCTV Footage` directory and run the pipeline. Alternatively, the simulation mode will generate valid schema events into `events.jsonl` if no videos are present.

## API Documentation
The API exposes several endpoints:
- `POST /api/ingest` - Receives events
- `GET /api/metrics` - High-level store metrics
- `GET /api/funnel` - Conversion funnel
- `GET /api/anomaly` - Alerts and security anomalies
- `GET /api/sales` - Revenue index by brand

For a detailed explanation of engineering choices, see [CHOICES.md](CHOICES.md).
For architectural diagrams and schema definitions, see [DESIGN.md](DESIGN.md).
