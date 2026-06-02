#!/usr/bin/env python3
"""
process_videos.py — Local CCTV Processor (runs on Mac, no Docker required)

Processes all MP4 video files in ./CCTV Footage (or any path given as the first
argument) using YOLOv8 person detection and the StoreTracker state machine.

Events are pushed to:
  1. Redis on localhost:6379 (if running `docker compose up`)
  2. API on localhost:3000   (direct HTTP fallback)

Usage:
    python3 process_videos.py [VIDEO_DIR]

Where VIDEO_DIR defaults to "./CCTV Footage".

Supports dynamic camera naming from Store 1 and Store 2 zip archives:
  • "CAM 3 - entry.mp4"   → entry_exit
  • "CAM 5 - billing.mp4" → checkout
  • "billing_area.mp4"    → checkout
  • "entry 1.mp4"         → entry_exit
  • "zone.mp4"            → zone (Skincare)
  • "CAM 2 - zone.mp4"    → zone (Makeup)
"""

import os
import sys
import cv2
import json
import time
import uuid
import redis
import random
import datetime
import requests

try:
    from ultralytics import YOLO
    YOLO_AVAILABLE = True
except ImportError:
    YOLO_AVAILABLE = False
    print("⚠️  ultralytics not installed — using motion-detection fallback")

# Import our tracker (adjust path when running from the workspace root)
_script_dir = os.path.dirname(os.path.abspath(__file__))
_pipeline_dir = os.path.join(_script_dir, "pipeline")
if _pipeline_dir not in sys.path:
    sys.path.insert(0, _pipeline_dir)

from tracker import StoreTracker, classify_camera, STORE_CODE, _pick_demographics

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
CCTV_DIR   = sys.argv[1] if len(sys.argv) > 1 else os.path.join(_script_dir, "CCTV Footage")
REDIS_URL  = "redis://localhost:6379"
API_URL    = "http://localhost:3000/api/ingest"
FRAME_SKIP = 30          # process 1 frame per second (30-fps footage)
MIN_CONF   = 0.35        # YOLO confidence threshold

# ---------------------------------------------------------------------------
# Connections
# ---------------------------------------------------------------------------
print("\n" + "="*60)
print("  Purplle Store Intelligence — CCTV Video Processor (Local)")
print("="*60)
print(f"  Video directory : {CCTV_DIR}")

r = None
try:
    r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    r.ping()
    print(f"✅ Redis connected at {REDIS_URL}")
except Exception as e:
    print(f"⚠️  Redis unavailable ({e}). Using HTTP fallback.")


def publish(event: dict):
    """Publish event to Redis or fall back to direct API POST."""
    event.setdefault("event_id",  f"evt_{uuid.uuid4().hex[:8]}")
    event.setdefault("timestamp", datetime.datetime.now().isoformat())

    published = False
    if r:
        try:
            r.publish("store_events", json.dumps(event))
            published = True
        except Exception:
            pass
    if not published:
        try:
            requests.post(API_URL, json=event, timeout=2)
            published = True
        except Exception:
            pass

    etype  = event.get("event_type", "?")
    cid    = event.get("customer_id") or event.get("id_token") or event.get("track_id", "?")
    zone   = event.get("zone") or event.get("zone_name", "")
    status = "✅" if published else "❌"
    print(f"  {status} [{etype:<22s}] ID: {cid}  Zone: {zone}")


# ---------------------------------------------------------------------------
# Motion-detection fallback (when YOLO is unavailable)
# ---------------------------------------------------------------------------
def detect_motion(prev_gray, curr_gray):
    diff = cv2.absdiff(prev_gray, curr_gray)
    _, th = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)
    th = cv2.dilate(th, None, iterations=2)
    cnts, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    dets = []
    for c in cnts:
        if cv2.contourArea(c) > 1500:
            x, y, w, h = cv2.boundingRect(c)
            dets.append([x, y, x+w, y+h, 0.60])
    return dets


# ---------------------------------------------------------------------------
# Main processing loop
# ---------------------------------------------------------------------------
if not os.path.isdir(CCTV_DIR):
    print(f"\n❌ Video directory not found: {CCTV_DIR}")
    sys.exit(1)

video_files = sorted(f for f in os.listdir(CCTV_DIR) if f.lower().endswith(".mp4"))
print(f"\n🎥 Found {len(video_files)} video file(s): {video_files}\n")

# Load YOLO model once
model = None
if YOLO_AVAILABLE:
    model_path = os.path.join(_script_dir, "yolov8n.pt")
    if not os.path.exists(model_path):
        model_path = os.path.join(_pipeline_dir, "yolov8n.pt")
    try:
        print(f"📦 Loading YOLOv8n from: {model_path}")
        model = YOLO(model_path)
        print("✅ YOLOv8n loaded.\n")
    except Exception as e:
        print(f"⚠️  YOLO load failed: {e}. Using motion detection.")

tracker = StoreTracker()

for video_file in video_files:
    cam_info  = classify_camera(video_file)
    camera_id = cam_info["cam_id"]
    video_path = os.path.join(CCTV_DIR, video_file)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"\n❌ Cannot open: {video_path}")
        continue

    fps          = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_s   = total_frames / fps

    print(f"{'─'*60}")
    print(f"📹 {video_file}")
    print(f"   Type     : {cam_info['type']}")
    print(f"   Zone     : {cam_info['zone']}")
    print(f"   Camera   : {camera_id}")
    print(f"   Duration : {duration_s:.0f}s  ({total_frames} frames @ {fps:.1f}fps)")
    print(f"{'─'*60}")

    frame_idx = 0
    processed = 0
    prev_gray = None
    start_ts  = datetime.datetime.now()

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % FRAME_SKIP != 0:
            frame_idx += 1
            continue

        curr_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        curr_gray = cv2.GaussianBlur(curr_gray, (21, 21), 0)

        if model:
            results    = model(frame, verbose=False, classes=[0])
            detections = [
                box.xyxy[0].cpu().numpy().tolist() + [float(box.conf[0])]
                for box in results[0].boxes
                if float(box.conf[0]) >= MIN_CONF
            ]
        elif prev_gray is not None:
            detections = detect_motion(prev_gray, curr_gray)
        else:
            detections = []

        sim_ts = start_ts + datetime.timedelta(seconds=int(frame_idx / fps))

        events = tracker.update(detections, frame, camera_id, frame_idx, sim_ts, cam_info)
        for evt in events:
            evt.setdefault("event_id",  f"evt_{uuid.uuid4().hex[:8]}")
            evt.setdefault("timestamp", sim_ts.isoformat())
            publish(evt)

        prev_gray  = curr_gray
        processed += 1
        frame_idx += 1

        if processed % 100 == 0:
            pct = frame_idx / total_frames * 100 if total_frames else 0
            print(f"  ⏳ {pct:.1f}% — frame {frame_idx}/{total_frames}")

    # End of video — flush remaining tracks
    sim_end = start_ts + datetime.timedelta(seconds=int(frame_idx / fps))
    flush_events = tracker.clear_active_tracks(camera_id, sim_end, cam_info)
    print(f"\n  📤 Flushing {len(flush_events)} remaining track(s) for {video_file}…")
    for evt in flush_events:
        evt.setdefault("event_id",  f"evt_{uuid.uuid4().hex[:8]}")
        evt.setdefault("timestamp", sim_end.isoformat())
        publish(evt)

    cap.release()
    print(f"  ✅ {video_file} complete. Frames processed: {processed}\n")

print("="*60)
print("  🎉 All videos processed!")
print(f"  📊 Dashboard  → http://localhost")
print(f"  🔌 API        → http://localhost:3000/api/metrics")
print("="*60)
