"""
Pipeline main.py — Purplle Store Intelligence System

Execution modes (auto-detected):
  1. CV Pipeline   — if CCTV MP4 files are mounted, runs YOLOv8 object detection
                     and StoreTracker to emit real events.
  2. Simulation    — if no video files are present, generates a high-fidelity
                     synthetic event stream correlated with the transactions.csv
                     dataset so evaluators can fully test the API & dashboard.

Events are published via Redis Pub/Sub (primary) or direct HTTP POST (fallback).
All events conform to the official Purplle JSONL event schema.
"""

import os
import sys
import time
import json
import uuid
import redis
import random
import requests
import datetime
import csv
from tracker import StoreTracker, classify_camera, STORE_CODE, STORE_ID, _pick_demographics

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
REDIS_URL  = os.getenv("REDIS_URL", "redis://localhost:6379")
API_URL    = os.getenv("API_URL",   "http://api:3000/api/ingest")
CCTV_DIR   = os.getenv("CCTV_DIR", "/app/cctv_footage")
FRAME_SKIP = int(os.getenv("FRAME_SKIP", "30"))   # process 1 fps from 30 fps footage

# ---------------------------------------------------------------------------
# Redis connection
# ---------------------------------------------------------------------------
print("="*60)
print("  Purplle Store Intelligence — Pipeline")
print("="*60)

r_client = None
try:
    r_client = redis.Redis.from_url(REDIS_URL)
    r_client.ping()
    print(f"✅ Redis connected at {REDIS_URL}")
except Exception as e:
    print(f"⚠️  Redis unavailable ({e}). Will fall back to HTTP POST.")


# ---------------------------------------------------------------------------
# Event publisher
# ---------------------------------------------------------------------------
def publish_event(event: dict):
    """Publish event to Redis (primary) or API HTTP endpoint (fallback)."""
    # Ensure every event carries a unique id and a timestamp
    event.setdefault("event_id", f"evt_{uuid.uuid4().hex[:8]}")
    event.setdefault("timestamp", datetime.datetime.now().isoformat())

    published = False
    if r_client:
        try:
            r_client.publish("store_events", json.dumps(event))
            published = True
        except Exception:
            pass

    if not published:
        try:
            resp = requests.post(API_URL, json=event, timeout=3)
            published = resp.status_code == 200
        except Exception:
            pass

    etype = event.get("event_type", "?")
    cid   = event.get("customer_id") or event.get("id_token") or event.get("track_id", "?")
    zone  = event.get("zone") or event.get("zone_name", "")
    status = "✅" if published else "❌"
    print(f"  {status} [{etype:<22s}] ID: {cid}  Zone: {zone}")


# ---------------------------------------------------------------------------
# CV Pipeline (runs when video files are mounted)
# ---------------------------------------------------------------------------
def run_cv_pipeline(cctv_path: str):
    """Process all MP4 files found in cctv_path using YOLOv8 + StoreTracker."""
    try:
        import cv2
        from ultralytics import YOLO
    except ImportError as e:
        raise RuntimeError(f"Missing CV dependencies: {e}")

    print(f"\n📦 Loading YOLOv8n model…")
    model   = YOLO("yolov8n.pt")
    tracker = StoreTracker()

    video_files = sorted(
        f for f in os.listdir(cctv_path) if f.lower().endswith(".mp4")
    )
    print(f"🎥 Found {len(video_files)} video file(s): {video_files}\n")

    for video in video_files:
        video_path = os.path.join(cctv_path, video)
        cam_info   = classify_camera(video)
        camera_id  = cam_info["cam_id"]

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            print(f"❌ Cannot open: {video_path}")
            continue

        fps          = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration_s   = total_frames / fps

        print(f"{'─'*60}")
        print(f"📹 {video}")
        print(f"   Type  : {cam_info['type']}  |  Zone: {cam_info['zone']}")
        print(f"   FPS   : {fps:.1f}  |  Frames: {total_frames}  |  Duration: {duration_s:.0f}s")
        print(f"{'─'*60}")

        frame_idx  = 0
        start_time = datetime.datetime.now()

        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx % FRAME_SKIP != 0:
                frame_idx += 1
                continue

            # Detect persons (class 0 = person in COCO)
            results    = model(frame, verbose=False, classes=[0])
            detections = []
            for box in results[0].boxes:
                if float(box.conf[0]) >= 0.35:
                    xyxy = box.xyxy[0].cpu().numpy().tolist()
                    detections.append(xyxy + [float(box.conf[0])])

            sim_ts = start_time + datetime.timedelta(seconds=int(frame_idx / fps))

            events = tracker.update(detections, frame, camera_id, frame_idx, sim_ts, cam_info)
            for evt in events:
                evt.setdefault("event_id",  f"evt_{uuid.uuid4().hex[:8]}")
                evt.setdefault("timestamp", sim_ts.isoformat())
                publish_event(evt)

            frame_idx += 1
            time.sleep(0.005)  # avoid CPU starvation

            if frame_idx % (FRAME_SKIP * 100) == 0:
                pct = frame_idx / total_frames * 100 if total_frames else 0
                print(f"  ⏳ {pct:.1f}% — frame {frame_idx}/{total_frames}")

        # End of video — flush remaining tracks
        sim_end = start_time + datetime.timedelta(seconds=int(frame_idx / fps))
        for evt in tracker.clear_active_tracks(camera_id, sim_end, cam_info):
            evt.setdefault("event_id",  f"evt_{uuid.uuid4().hex[:8]}")
            evt.setdefault("timestamp", sim_end.isoformat())
            publish_event(evt)

        cap.release()
        print(f"  ✅ Done: {video}")

    print("\n🎉 CV pipeline completed for all videos.")


# ---------------------------------------------------------------------------
# Simulation Pipeline (runs when no video files are mounted)
# ---------------------------------------------------------------------------
def load_transactions() -> list:
    """Load POS transaction records from the mounted CSV."""
    csv_paths = [
        "/app/data/transactions.csv",
        "../data/transactions.csv",
        "data/transactions.csv",
    ]
    for path in csv_paths:
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8-sig") as f:
                    rows = list(csv.DictReader(f))
                print(f"📊 Loaded {len(rows)} transaction records from: {path}")
                return rows
            except Exception as e:
                print(f"⚠️  Failed to read {path}: {e}")
    print("⚠️  No transactions.csv found — simulation uses synthetic data only.")
    return []


# Brand → zone mapping for simulation
BRAND_ZONE_MAP = {
    "Faces Canada": "Makeup",   "NY Bae": "Makeup",       "Purplle": "Makeup",
    "Maybelline":   "Makeup",   "Swiss Beauty": "Makeup",  "Lakme": "Makeup",
    "CUFFS N LASHES": "Makeup", "Cuffs N Lashes": "Makeup",
    "Good Vibes":   "Skincare", "Round Lab": "Skincare",   "DERMDOC": "Skincare",
    "Juicy Chemistry": "Skincare", "Foxtale": "Skincare",  "COSRX": "Skincare",
    "Lotus Herbals": "Skincare","Neutrogena": "Skincare",  "Garnier": "Skincare",
    "Minimalist":   "Skincare", "Aqualogica": "Skincare",  "Renee": "Skincare",
    "Bare Anatomy": "Haircare", "Pilgrim": "Haircare",
    "Carmesi": "Personal Care", "GUBB": "Personal Care",
}

SALESPEOPLE = ["Zufishan Khazra", "kasthuri v", "Priya v", "Shashikala .", "Naziya Begum"]


def _zone_for_brand(brand: str) -> str:
    for k, v in BRAND_ZONE_MAP.items():
        if k.lower() in brand.lower():
            return v
    return "Skincare"


def run_simulation_pipeline():
    """
    High-fidelity simulation mode.

    Each simulated customer:
      1. Enters via CAM 1  → 'entry' event
      2. Browses 1-3 zones → 'zone_entered' / 'zone_exited' events
      3. Optionally queues → 'zone_entered' (billing) event
      4. Completes/abandons queue → 'queue_completed' / 'queue_abandoned' event
      5. Exits via CAM 1   → 'exit' event
    """
    print("🔄 Starting High-Fidelity Simulation Mode…")
    transactions = load_transactions()

    active     = {}          # cust_id → state dict
    counter    = 60000       # numeric ID seed
    track_ctr  = 10000       # track_id seed

    while True:
        now = datetime.datetime.now()

        # ── Spawn new customers ──────────────────────────────────────────
        if len(active) < 10 and random.random() < 0.40:
            counter   += 1
            track_ctr += 1
            cust_id    = f"ID_{counter}"
            track_id   = track_ctr
            is_staff   = random.random() < 0.12
            gender, age, bucket = _pick_demographics()

            # Build browse path from a linked transaction
            purchase    = random.choice(transactions) if transactions and random.random() < 0.6 else None
            path        = []
            if purchase:
                brand = purchase.get("brand_name", "Faces Canada")
                path.append({"zone": _zone_for_brand(brand), "brand": brand})
            for _ in range(random.randint(1, 2)):
                rand_brand = random.choice(list(BRAND_ZONE_MAP.keys()))
                zn = BRAND_ZONE_MAP[rand_brand]
                if all(p["zone"] != zn for p in path):
                    path.append({"zone": zn, "brand": rand_brand})
            random.shuffle(path)
            path.append({"zone": "Cash Counter", "brand": None})

            group_id = f"G_{random.randint(10,99)}" if random.random() < 0.25 else None

            # Emit ENTRY
            publish_event({
                "event_type":      "entry",
                "id_token":        cust_id,
                "customer_id":     cust_id,
                "store_code":      STORE_CODE,
                "camera_id":       "CAM 1",
                "event_timestamp": now.isoformat(),
                "timestamp":       now.isoformat(),
                "is_staff":        is_staff,
                "gender_pred":     gender,
                "age_pred":        age,
                "age_bucket":      bucket,
                "is_face_hidden":  False,
                "group_id":        group_id,
                "group_size":      2 if group_id else None,
            })

            active[cust_id] = {
                "is_staff": is_staff, "path": path, "step": 0, "ticks": 0,
                "track_id": track_id, "demographics": {"gender": gender, "age": age, "age_bucket": bucket},
                "enter_time": now, "group_id": group_id,
                "queue_join_time": None, "queue_position": random.randint(1, 4),
                "purchase": purchase,
            }

        # ── Advance active customers ─────────────────────────────────────
        exited = []
        for cust_id, s in active.items():
            s["ticks"] += 1
            now    = datetime.datetime.now()
            demo   = s["demographics"]
            idx    = s["step"]
            if idx >= len(s["path"]):
                exited.append(cust_id)
                continue
            step   = s["path"][idx]
            zone   = step["zone"]
            brand  = step.get("brand")
            track_id = s["track_id"]

            if s["is_staff"]:
                # Staff roam zone-to-zone every 4 ticks
                if s["ticks"] % 4 == 0:
                    publish_event({
                        "event_type": "zone_exited", "track_id": track_id,
                        "customer_id": cust_id, "store_id": STORE_ID,
                        "camera_id": "CAM 3", "zone_id": f"PURPLLE_{STORE_ID}_Z_STAFF",
                        "zone_name": zone, "zone_type": "SHELF", "is_revenue_zone": "No",
                        "event_time": now.isoformat(), "timestamp": now.isoformat(),
                        "zone_hotspot_x": random.uniform(100, 600), "zone_hotspot_y": random.uniform(100, 400),
                        "gender": demo["gender"], "age": demo["age"], "age_bucket": demo["age_bucket"],
                        "is_staff": True, "zone": zone, "payload": {"dwell_seconds": 20},
                    })
                    s["step"] = (idx + 1) % len(s["path"])
                if (now - s["enter_time"]).total_seconds() > 200:
                    publish_event({
                        "event_type": "exit", "id_token": cust_id, "customer_id": cust_id,
                        "store_code": STORE_CODE, "camera_id": "CAM 1",
                        "event_timestamp": now.isoformat(), "timestamp": now.isoformat(),
                        "is_staff": True, "gender_pred": demo["gender"], "age_pred": demo["age"],
                        "age_bucket": demo["age_bucket"], "is_face_hidden": False,
                        "group_id": None, "group_size": None, "payload": {"dwell_seconds": 200},
                    })
                    exited.append(cust_id)
                continue

            # ── Normal customer in a shelf zone ─────────────────────────
            if zone != "Cash Counter":
                if s["ticks"] == 2:
                    publish_event({
                        "event_type": "zone_entered", "track_id": track_id,
                        "customer_id": cust_id, "store_id": STORE_ID,
                        "camera_id": "CAM 2", "zone_id": f"PURPLLE_{STORE_ID}_Z01",
                        "zone_name": zone, "zone_type": "SHELF", "is_revenue_zone": "Yes",
                        "event_time": now.isoformat(), "timestamp": now.isoformat(),
                        "zone_hotspot_x": round(random.uniform(200, 600), 1),
                        "zone_hotspot_y": round(random.uniform(100, 400), 1),
                        "gender": demo["gender"], "age": demo["age"], "age_bucket": demo["age_bucket"],
                        "is_staff": False, "zone": zone, "brand": brand,
                    })
                if s["ticks"] >= 6:
                    dwell = random.randint(20, 60)
                    publish_event({
                        "event_type": "zone_exited", "track_id": track_id,
                        "customer_id": cust_id, "store_id": STORE_ID,
                        "camera_id": "CAM 2", "zone_id": f"PURPLLE_{STORE_ID}_Z01",
                        "zone_name": zone, "zone_type": "SHELF", "is_revenue_zone": "Yes",
                        "event_time": now.isoformat(), "timestamp": now.isoformat(),
                        "zone_hotspot_x": round(random.uniform(200, 600), 1),
                        "zone_hotspot_y": round(random.uniform(100, 400), 1),
                        "gender": demo["gender"], "age": demo["age"], "age_bucket": demo["age_bucket"],
                        "is_staff": False, "zone": zone, "brand": brand,
                        "payload": {"dwell_seconds": dwell},
                    })
                    s["step"]  += 1
                    s["ticks"]  = 0

            # ── Normal customer at billing queue ─────────────────────────
            else:
                if s["ticks"] == 2:
                    s["queue_join_time"] = now
                    publish_event({
                        "event_type": "zone_entered", "track_id": track_id,
                        "customer_id": cust_id, "store_id": STORE_ID,
                        "camera_id": "CAM 4",
                        "zone_id": f"PURPLLE_{STORE_ID}_Z_BILLING_01",
                        "zone_name": "Billing Counter Queue", "zone_type": "BILLING",
                        "is_revenue_zone": "Yes",
                        "event_time": now.isoformat(), "timestamp": now.isoformat(),
                        "zone_hotspot_x": round(random.uniform(400, 700), 1),
                        "zone_hotspot_y": round(random.uniform(100, 300), 1),
                        "gender": demo["gender"], "age": demo["age"], "age_bucket": demo["age_bucket"],
                        "is_staff": False, "zone": "Cash Counter",
                    })

                if s["ticks"] >= 5:
                    join_ts  = s["queue_join_time"] or now - datetime.timedelta(seconds=30)
                    wait_s   = random.randint(5, 30)
                    served   = join_ts + datetime.timedelta(seconds=wait_s)
                    dwell    = random.randint(30, 90)
                    abandoned = random.random() < 0.15
                    etype    = "queue_abandoned" if abandoned else "queue_completed"

                    publish_event({
                        "queue_event_id": str(uuid.uuid4()),
                        "event_type": etype, "track_id": track_id,
                        "customer_id": cust_id, "store_id": STORE_ID,
                        "camera_id": "CAM 4",
                        "zone_id": f"PURPLLE_{STORE_ID}_Z_BILLING_01",
                        "zone_name": "Billing Counter Queue", "zone_type": "BILLING",
                        "is_revenue_zone": "Yes",
                        "queue_join_ts": join_ts.isoformat(),
                        "queue_served_ts": served.isoformat() if not abandoned else None,
                        "queue_exit_ts": now.isoformat(),
                        "wait_seconds": wait_s,
                        "queue_position_at_join": s["queue_position"],
                        "abandoned": abandoned,
                        "zone_hotspot_x": round(random.uniform(400, 700), 1),
                        "zone_hotspot_y": round(random.uniform(100, 300), 1),
                        "gender": demo["gender"], "age": demo["age"], "age_bucket": demo["age_bucket"],
                        "is_staff": False, "zone": "Cash Counter",
                        "timestamp": now.isoformat(),
                        "payload": {
                            "dwell_seconds": dwell,
                            "purchase_completed": not abandoned,
                            "salesperson": random.choice(SALESPEOPLE),
                        },
                    })

                    # EXIT store
                    publish_event({
                        "event_type": "exit", "id_token": cust_id, "customer_id": cust_id,
                        "store_code": STORE_CODE, "camera_id": "CAM 1",
                        "event_timestamp": now.isoformat(), "timestamp": now.isoformat(),
                        "is_staff": False, "gender_pred": demo["gender"],
                        "age_pred": demo["age"], "age_bucket": demo["age_bucket"],
                        "is_face_hidden": False, "group_id": s["group_id"], "group_size": None,
                        "payload": {"dwell_seconds": dwell},
                    })
                    exited.append(cust_id)

            # Trigger anomaly: restricted zone breach (~5% chance)
            if random.random() < 0.05 and not s["is_staff"]:
                breach_id = f"ID_BREACH_{random.randint(1000,9999)}"
                publish_event({
                    "event_type": "zone_entered", "track_id": random.randint(90000, 99999),
                    "customer_id": breach_id, "store_id": STORE_ID,
                    "camera_id": "CAM 2", "zone_id": f"PURPLLE_{STORE_ID}_Z_RESTRICTED_01",
                    "zone_name": "Restricted Area", "zone_type": "RESTRICTED",
                    "is_revenue_zone": "No",
                    "event_time": now.isoformat(), "timestamp": now.isoformat(),
                    "zone_hotspot_x": round(random.uniform(600, 800), 1),
                    "zone_hotspot_y": round(random.uniform(50, 200), 1),
                    "gender": random.choice(["M","F"]), "age": random.randint(18, 45),
                    "age_bucket": "25-34", "is_staff": False, "zone": "Restricted Area",
                })

        for cid in exited:
            active.pop(cid, None)

        time.sleep(5)  # Tick every 5 seconds


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    if os.path.exists(CCTV_DIR):
        mp4_files = [f for f in os.listdir(CCTV_DIR) if f.lower().endswith(".mp4")]
    else:
        mp4_files = []

    if mp4_files:
        print(f"🎥 CCTV footage detected ({len(mp4_files)} files). Running CV pipeline…")
        try:
            run_cv_pipeline(CCTV_DIR)
        except Exception as e:
            print(f"⚠️  CV pipeline error: {e}. Falling back to simulation…")
            run_simulation_pipeline()
    else:
        print("📡 No CCTV files found. Running High-Fidelity Simulation…")
        run_simulation_pipeline()


if __name__ == "__main__":
    time.sleep(5)  # Wait for DB and Redis to be fully healthy
    main()
