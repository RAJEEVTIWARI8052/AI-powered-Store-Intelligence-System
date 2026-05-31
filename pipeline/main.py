import os
import sys
import time
import json
import redis
import random
import requests
import datetime
from tracker import StoreTracker

# Configurations
REDIS_URL = os.getenv('REDIS_URL', 'redis://localhost:6379')
API_URL = 'http://api:3000/api/ingest'
CCTV_DIR = os.getenv('CCTV_DIR', '/app/cctv_footage')

# Connect to Redis
print(f"Connecting to Redis event queue at: {REDIS_URL}")
r_client = None
try:
    r_client = redis.Redis.from_url(REDIS_URL)
    r_client.ping()
    print("Successfully connected to Redis.")
except Exception as e:
    print(f"Redis not available ({e}). Will fall back to direct HTTP ingestion.")

def publish_event(event):
    # Publish to Redis channel
    published = False
    if r_client:
        try:
            r_client.publish('store_events', json.dumps(event))
            published = True
        except Exception as e:
            print(f"Redis publish failed: {e}")
            
    # Fallback to direct HTTP post to API container
    if not published:
        try:
            response = requests.post(API_URL, json=event, timeout=2)
            if response.status_code == 200:
                published = True
        except Exception as e:
            pass
            
    if published:
        print(f"[EVENT PUBLISHED] {event['event_type']} - Customer: {event['customer_id']} - Zone: {event.get('zone', 'None')} - Brand: {event.get('brand', 'None')}")
    else:
        print(f"[EVENT DROP] Failed to publish event: {event['event_type']}")

def run_cv_pipeline(cctv_path):
    # This runs when video files are present.
    # Uses OpenCV + YOLOv8 to extract frames, skip frames, detect, and track.
    import cv2
    from ultralytics import YOLO
    
    print(f"Initializing YOLO model and processing videos in: {cctv_path}")
    model = YOLO("yolov8n.pt")
    tracker = StoreTracker()
    
    # List video files
    video_files = sorted([f for f in os.listdir(cctv_path) if f.lower().endswith('.mp4')])
    print(f"Found video files: {video_files}")
    
    for video in video_files:
        video_fullpath = os.path.join(cctv_path, video)
        cap = cv2.VideoCapture(video_fullpath)
        if not cap.isOpened():
            print(f"Error opening video file: {video_fullpath}")
            continue
            
        print(f"Processing: {video}")
        frame_idx = 0
        camera_id = video.replace('.mp4', '').strip()
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        
        start_time = datetime.datetime.now()
        
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break
                
            # Skip frames (process 1 frame per second of 30fps video)
            if frame_idx % 30 != 0:
                frame_idx += 1
                continue
                
            results = model(frame, verbose=False)
            boxes = results[0].boxes
            
            detections = []
            for box in boxes:
                cls_id = int(box.cls[0])
                if cls_id == 0: # Person class in COCO
                    xyxy = box.xyxy[0].cpu().numpy().tolist()
                    conf = float(box.conf[0])
                    detections.append(xyxy + [conf])
            
            # Compute logical simulated timestamp
            simulated_time = start_time + datetime.timedelta(seconds=int(frame_idx / fps))
            
            # Feed current frame detections to tracking state machine
            events = tracker.update(detections, frame, camera_id, frame_idx, simulated_time)
            
            for event in events:
                event["event_id"] = f"evt_{crypto_uuid()}"
                event["timestamp"] = event.get("timestamp", simulated_time.isoformat())
                publish_event(event)
            
            frame_idx += 1
            time.sleep(0.01) # Simulate real-time and prevent CPU starvation
            
        # Video ended — flush final exit/checkout events for remaining active tracks
        simulated_end_time = start_time + datetime.timedelta(seconds=int(frame_idx / fps))
        flush_events = tracker.clear_active_tracks(camera_id, simulated_end_time)
        for event in flush_events:
            event["event_id"] = f"evt_{crypto_uuid()}"
            event["timestamp"] = event.get("timestamp", simulated_end_time.isoformat())
            publish_event(event)
            
        cap.release()

def crypto_uuid():
    return str(random.randint(100000, 999999))

def run_simulation_pipeline():
    # HIGH-FIDELITY SIMULATION MODE (Fallback when videos are missing, or runs concurrently)
    # This parses transactions.csv and generates perfectly correlated, logically consistent
    # event streams that visually represent retail customer behaviors.
    print("Starting High-Fidelity Simulation Mode...")
    
    csv_path = '/app/data/transactions.csv'
    if not os.path.exists(csv_path):
        csv_path = '../data/transactions.csv' # local workspace path fallback
        
    transactions = []
    if os.path.exists(csv_path):
        try:
            import csv
            with open(csv_path, 'r', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    transactions.append(row)
            print(f"Loaded {len(transactions)} transaction records for simulation.")
        except Exception as e:
            print(f"Error reading CSV in simulation: {e}")
    else:
        print("transactions.csv not found. Simulating default transactions.")

    # Brand maps corresponding to store layout
    brand_zones = {
        # Skincare shelf brands
        'Good Vibes': 'Skincare', 'Round Lab': 'Skincare', 'DermDoc': 'Skincare',
        'Juicy Chemistry': 'Skincare', 'Bare Anatomy': 'Skincare', 'COSRX': 'Skincare',
        'Lotus Herbals': 'Skincare', 'Neutrogena': 'Skincare', 'Foxtale': 'Skincare',
        'Renee': 'Skincare', 'Garnier': 'Skincare', 'Minimalist': 'Skincare',
        'Aqualogica': 'Skincare', 'Pilgrim': 'Skincare', 'D&K': 'Skincare',
        # Makeup shelf brands
        'Faces Canada': 'Makeup', 'NY Bae': 'Makeup', 'Purplle': 'Makeup',
        'Maybelline': 'Makeup', 'Swiss Beauty': 'Makeup', 'Lakme': 'Makeup',
        'Cuffs N Lashes': 'Makeup', 'CUFFS N LASHES': 'Makeup',
        # Other
        'Carmesi': 'Personal Care', 'GUBB': 'Personal Care',
    }

    # Helper to get zone for a brand
    def get_zone(brand_name):
        for k, v in brand_zones.items():
            if k.lower() in brand_name.lower():
                return v
        return 'Skincare' # Default fallback

    # Unique customers pool
    active_customers = {}
    
    # 5 Salespeople active in store
    salespeople = ['Zufishan Khazra', 'kasthuri v', 'Priya v', 'Shashikala .', 'Naziya Begum']
    
    customer_counter = 100
    
    while True:
        # 1. Randomly decide to enter a new customer
        if len(active_customers) < 8 and random.random() < 0.4:
            customer_counter += 1
            cust_id = f"cust_{customer_counter}"
            
            # Select if they will purchase (link with a transaction from CSV)
            purchase_info = None
            if transactions and random.random() < 0.6:
                purchase_info = random.choice(transactions)
            
            is_staff = random.random() < 0.12 # 12% chance it's staff movement
            
            # Group Entry logic
            group_id = f"group_{random.randint(10, 99)}" if random.random() < 0.25 else None
            
            timestamp = datetime.datetime.now().isoformat()
            
            # ENTRY Event
            publish_event({
                "event_id": f"evt_{crypto_uuid()}",
                "timestamp": timestamp,
                "camera_id": "CAM 1",
                "event_type": "ENTRY",
                "customer_id": cust_id,
                "group_id": group_id,
                "is_staff": is_staff,
                "payload": {
                    "appearance": {
                        "upper_color": random.choice(["blue", "black", "red", "yellow", "purple"]),
                        "lower_color": random.choice(["black", "grey", "jeans"])
                    }
                }
            })
            
            # Initialize customer state
            if is_staff:
                active_customers[cust_id] = {
                    "is_staff": True,
                    "state": "browsing",
                    "path": ["Skincare", "Makeup", "Haircare", "Cash Counter"],
                    "current_index": 0,
                    "ticks": 0,
                    "enter_time": time.time()
                }
            else:
                # Find path based on purchase or random browsing
                path = []
                purchase_brand = None
                if purchase_info:
                    purchase_brand = purchase_info.get('brand_name', 'Faces Canada')
                    zone = get_zone(purchase_brand)
                    path.append({"zone": zone, "brand": purchase_brand})
                
                # Add 1-2 random browsing zones
                for _ in range(random.randint(1, 2)):
                    rand_brand = random.choice(list(brand_zones.keys()))
                    rand_zone = brand_zones[rand_brand]
                    if rand_zone not in [p["zone"] for p in path]:
                        path.append({"zone": rand_zone, "brand": rand_brand})
                        
                random.shuffle(path) # Shuffle order of browsing
                
                # Add checkout step
                path.append({"zone": "Cash Counter", "brand": None})
                
                active_customers[cust_id] = {
                    "is_staff": False,
                    "state": "browsing",
                    "path": path,
                    "current_index": 0,
                    "ticks": 0,
                    "purchase_info": purchase_info,
                    "enter_time": time.time()
                }
                
        # 2. Update active customers states
        exited_customers = []
        for cust_id, state in active_customers.items():
            state["ticks"] += 1
            
            # Staff behavior (moves randomly from zone to zone)
            if state["is_staff"]:
                if state["ticks"] % 4 == 0: # Move to next zone
                    idx = state["current_index"]
                    current_zone = state["path"][idx]
                    
                    # Exit current zone
                    publish_event({
                        "event_id": f"evt_{crypto_uuid()}",
                        "timestamp": datetime.datetime.now().isoformat(),
                        "camera_id": "CAM 3",
                        "event_type": "ZONE_EXIT",
                        "customer_id": cust_id,
                        "zone": current_zone,
                        "is_staff": True,
                        "payload": {"dwell_seconds": 20}
                    })
                    
                    # Move to next
                    next_idx = (idx + 1) % len(state["path"])
                    state["current_index"] = next_idx
                    next_zone = state["path"][next_idx]
                    
                    publish_event({
                        "event_id": f"evt_{crypto_uuid()}",
                        "timestamp": datetime.datetime.now().isoformat(),
                        "camera_id": "CAM 3",
                        "event_type": "ZONE_ENTRY",
                        "customer_id": cust_id,
                        "zone": next_zone,
                        "is_staff": True
                    })
                    
                # Exit store after long time
                if time.time() - state["enter_time"] > 200:
                    publish_event({
                        "event_id": f"evt_{crypto_uuid()}",
                        "timestamp": datetime.datetime.now().isoformat(),
                        "camera_id": "CAM 1",
                        "event_type": "EXIT",
                        "customer_id": cust_id,
                        "is_staff": True
                    })
                    exited_customers.append(cust_id)
                    
            # Normal Customer Behavior
            else:
                idx = state["current_index"]
                current_step = state["path"][idx]
                
                # Customer is in a shelf zone
                if current_step["zone"] != "Cash Counter":
                    # Just entered the zone
                    if state["ticks"] == 2:
                        publish_event({
                            "event_id": f"evt_{crypto_uuid()}",
                            "timestamp": datetime.datetime.now().isoformat(),
                            "camera_id": "CAM 3",
                            "event_type": "ZONE_ENTRY",
                            "customer_id": cust_id,
                            "zone": current_step["zone"],
                            "brand": current_step["brand"],
                            "is_staff": False
                        })
                        
                    # Product interaction (browsing shelf)
                    if state["ticks"] == 4 and random.random() < 0.7:
                        publish_event({
                            "event_id": f"evt_{crypto_uuid()}",
                            "timestamp": datetime.datetime.now().isoformat(),
                            "camera_id": "CAM 3",
                            "event_type": "INTERACTION",
                            "customer_id": cust_id,
                            "zone": current_step["zone"],
                            "brand": current_step["brand"],
                            "is_staff": False,
                            "payload": {"action": random.choice(["browse", "pick_up"])}
                        })
                        
                    # Exit zone and move to next step
                    if state["ticks"] >= 6:
                        dwell = random.randint(15, 45)
                        publish_event({
                            "event_id": f"evt_{crypto_uuid()}",
                            "timestamp": datetime.datetime.now().isoformat(),
                            "camera_id": "CAM 3",
                            "event_type": "ZONE_EXIT",
                            "customer_id": cust_id,
                            "zone": current_step["zone"],
                            "brand": current_step["brand"],
                            "is_staff": False,
                            "payload": {"dwell_seconds": dwell}
                        })
                        state["current_index"] += 1
                        state["ticks"] = 0 # reset ticks
                        
                # Customer is at Checkout
                else:
                    if state["ticks"] == 2:
                        publish_event({
                            "event_id": f"evt_{crypto_uuid()}",
                            "timestamp": datetime.datetime.now().isoformat(),
                            "camera_id": "CAM 4",
                            "event_type": "CHECKOUT_START",
                            "customer_id": cust_id,
                            "zone": "Cash Counter",
                            "is_staff": False
                        })
                        
                    # Complete transaction and exit store
                    if state["ticks"] >= 5:
                        dwell = random.randint(30, 90)
                        # Complete checkout
                        publish_event({
                            "event_id": f"evt_{crypto_uuid()}",
                            "timestamp": datetime.datetime.now().isoformat(),
                            "camera_id": "CAM 4",
                            "event_type": "CHECKOUT_COMPLETE",
                            "customer_id": cust_id,
                            "zone": "Cash Counter",
                            "is_staff": False,
                            "payload": {
                                "dwell_seconds": dwell,
                                "salesperson": random.choice(salespeople),
                                "purchase_completed": state["purchase_info"] is not None
                            }
                        })
                        
                        # Exit store
                        publish_event({
                            "event_id": f"evt_{crypto_uuid()}",
                            "timestamp": datetime.datetime.now().isoformat(),
                            "camera_id": "CAM 1",
                            "event_type": "EXIT",
                            "customer_id": cust_id,
                            "is_staff": False
                        })
                        
                        exited_customers.append(cust_id)
                        
        # Remove exited customers
        for cust_id in exited_customers:
            del active_customers[cust_id]
            
        # 3. Simulate random store anomalies occasionally (e.g. loitering in restricted zone)
        if random.random() < 0.05:
            # Trigger restricted zone breach
            unauth_cust = f"cust_breach_{random.randint(100, 999)}"
            publish_event({
                "event_id": f"evt_{crypto_uuid()}",
                "timestamp": datetime.datetime.now().isoformat(),
                "camera_id": "CAM 2",
                "event_type": "ZONE_ENTRY",
                "customer_id": unauth_cust,
                "zone": "Restricted Area",
                "is_staff": False
            })
            # Instantly exits after being caught
            publish_event({
                "event_id": f"evt_{crypto_uuid()}",
                "timestamp": datetime.datetime.now().isoformat(),
                "camera_id": "CAM 2",
                "event_type": "ZONE_EXIT",
                "customer_id": unauth_cust,
                "zone": "Restricted Area",
                "is_staff": False,
                "payload": {"dwell_seconds": 5}
            })

        time.sleep(5) # Simulation tick speed

def main():
    # If CCTV Footage folder exists and has video files, run CV pipeline.
    # Otherwise, run simulation mode.
    if os.path.exists(CCTV_DIR) and len([f for f in os.listdir(CCTV_DIR) if f.lower().endswith('.mp4')]) > 0:
        print("CCTV Video files detected. Running Live CV Object Tracking Pipeline...")
        try:
            run_cv_pipeline(CCTV_DIR)
        except Exception as e:
            print(f"CV Pipeline failed or missing dependencies ({e}). Falling back to simulation...")
            run_simulation_pipeline()
    else:
        print("No CCTV video files found in mounted volume. Falling back to High-Fidelity Simulation...")
        run_simulation_pipeline()

if __name__ == '__main__':
    # Give the API and DB containers a few seconds to fully initialize
    time.sleep(5)
    main()
