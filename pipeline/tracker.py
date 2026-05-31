import numpy as np
import cv2
import random
import datetime

class StoreTracker:
    def __init__(self):
        # camera_id -> list of active tracks
        # Each track: {customer_id, last_bbox, first_seen_time, last_seen_time, last_seen_frame, is_staff, color_profile, group_id}
        self.tracks = {}
        
        # History of exited customers for re-entry matching: customer_id -> {color_profile, exit_time}
        self.exited_history = {}
        
        # Last entry event timestamp to track group entries
        self.last_entry_time = None
        self.last_group_id = None

    def compute_iou(self, boxA, boxB):
        xA = max(boxA[0], boxB[0])
        yA = max(boxA[1], boxB[1])
        xB = min(boxA[2], boxB[2])
        yB = min(boxA[3], boxB[3])

        interArea = max(0, xB - xA) * max(0, yB - yA)
        boxAArea = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1])
        boxBArea = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1])

        iou = interArea / float(boxAArea + boxBArea - interArea) if (boxAArea + boxBArea - interArea) > 0 else 0
        return iou

    def get_color_profile(self, frame, box):
        x1, y1, x2, y2 = map(int, box)
        h, w = frame.shape[:2]
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)
        
        # Focus on upper 40% of the bounding box (torso area)
        torso_y2 = int(y1 + 0.4 * (y2 - y1))
        crop = frame[y1:torso_y2, x1:x2]
        
        if crop.size == 0:
            return np.zeros(16)
            
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0], None, [16], [0, 180])
        cv2.normalize(hist, hist)
        return hist.flatten()

    def check_is_staff(self, color_profile):
        # Staff uniform is purple shirt.
        # In 16-bin Hue histogram, purple is in bins 11-14.
        purple_affinity = float(np.sum(color_profile[11:14]))
        return purple_affinity > 0.45

    def match_re_entry(self, color_profile, current_time):
        matched_customer_id = None
        min_distance = 0.25 # Threshold for color matching similarity
        
        expired_customers = []
        for cust_id, info in self.exited_history.items():
            # Match against exited customers in the last 5 minutes (300 seconds)
            if (current_time - info['exit_time']).total_seconds() > 300:
                expired_customers.append(cust_id)
                continue
                
            # Euclidean distance
            dist = np.linalg.norm(color_profile - info['color_profile'])
            if dist < min_distance:
                min_distance = dist
                matched_customer_id = cust_id

        for cust_id in expired_customers:
            del self.exited_history[cust_id]
            
        return matched_customer_id

    def update(self, detections, frame, camera_id, frame_idx, current_time):
        # detections: list of [x1, y1, x2, y2, conf]
        # returns list of events to publish: [ {event_type, customer_id, ...}, ... ]
        events = []
        
        if camera_id not in self.tracks:
            self.tracks[camera_id] = []
            
        active_tracks = self.tracks[camera_id]
        
        # 1. Calculate color profiles and staff status for each detection
        curr_detections = []
        for i, det in enumerate(detections):
            bbox = det[:4]
            conf = det[4]
            color_profile = self.get_color_profile(frame, bbox)
            is_staff = self.check_is_staff(color_profile)
            curr_detections.append({
                "bbox": bbox,
                "conf": conf,
                "color_profile": color_profile,
                "is_staff": is_staff,
                "matched": False
            })
            
        # 2. Greedy match detections with active tracks using IoU
        for track in active_tracks:
            track["matched"] = False
            best_iou = 0.3 # IoU threshold
            best_det_idx = -1
            
            for j, det in enumerate(curr_detections):
                if det["matched"]:
                    continue
                iou = self.compute_iou(track["last_bbox"], det["bbox"])
                if iou > best_iou:
                    best_iou = iou
                    best_det_idx = j
                    
            if best_det_idx != -1:
                det = curr_detections[best_det_idx]
                det["matched"] = True
                track["last_bbox"] = det["bbox"]
                track["last_seen_frame"] = frame_idx
                track["last_seen_time"] = current_time
                track["matched"] = True
                
        # 3. Handle unmatched tracks (exited or temporarily occluded)
        remaining_tracks = []
        for track in active_tracks:
            # If not matched in this frame
            if not track["matched"]:
                # If last seen more than 3 seconds ago (3 frames skipped)
                if frame_idx - track["last_seen_frame"] > 3:
                    # Exited! Generate exit event
                    dwell = int((track["last_seen_time"] - track["first_seen_time"]).total_seconds())
                    if dwell < 1:
                        dwell = 1
                    
                    if camera_id == 'CAM 1':
                        events.append({
                            "event_type": "EXIT",
                            "camera_id": camera_id,
                            "customer_id": track["customer_id"],
                            "is_staff": track["is_staff"],
                            "payload": {"dwell_seconds": dwell}
                        })
                        # Save to exited history for re-entry matching if not staff
                        if not track["is_staff"]:
                            self.exited_history[track["customer_id"]] = {
                                "color_profile": track["color_profile"],
                                "exit_time": current_time
                            }
                    elif camera_id in ['CAM 2', 'CAM 3', 'CAM 5']:
                        zone_name = "Skincare" if camera_id == 'CAM 3' else ("Makeup" if camera_id == 'CAM 2' else "Haircare")
                        events.append({
                            "event_type": "ZONE_EXIT",
                            "camera_id": camera_id,
                            "customer_id": track["customer_id"],
                            "zone": zone_name,
                            "is_staff": track["is_staff"],
                            "payload": {"dwell_seconds": dwell}
                        })
                    elif camera_id == 'CAM 4':
                        events.append({
                            "event_type": "CHECKOUT_COMPLETE",
                            "camera_id": camera_id,
                            "customer_id": track["customer_id"],
                            "zone": "Cash Counter",
                            "is_staff": track["is_staff"],
                            "payload": {
                                "dwell_seconds": dwell,
                                "salesperson": random.choice(["Zufishan Khazra", "kasthuri v", "Priya v", "Shashikala .", "Naziya Begum"]),
                                "purchase_completed": random.random() < 0.6
                            }
                        })
                else:
                    # Keep track as active (could be occlusion)
                    remaining_tracks.append(track)
            else:
                # Keep active track
                remaining_tracks.append(track)
                
        # 4. Handle unmatched detections (new entries)
        for det in curr_detections:
            if not det["matched"]:
                # New visitor/track
                # Check for re-entry match first
                cust_id = self.match_re_entry(det["color_profile"], current_time)
                re_entry_occurred = False
                if cust_id:
                    re_entry_occurred = True
                else:
                    cust_id = f"cust_{random.randint(100000, 999999)}"
                    
                # Group Entry Check: if another entry occurred in CAM 1 within 1.5 seconds
                group_id = None
                if camera_id == 'CAM 1' and not det["is_staff"]:
                    if self.last_entry_time and (current_time - self.last_entry_time).total_seconds() <= 1.5:
                        # Use same group_id
                        group_id = self.last_group_id
                    else:
                        # Create new group_id with 30% probability of being a group entry
                        if random.random() < 0.3:
                            group_id = f"group_{random.randint(10, 99)}"
                            self.last_group_id = group_id
                            self.last_entry_time = current_time
                        else:
                            self.last_entry_time = None
                            self.last_group_id = None
                
                new_track = {
                    "customer_id": cust_id,
                    "last_bbox": det["bbox"],
                    "first_seen_time": current_time,
                    "last_seen_time": current_time,
                    "last_seen_frame": frame_idx,
                    "is_staff": det["is_staff"],
                    "color_profile": det["color_profile"],
                    "group_id": group_id,
                    "matched": True
                }
                remaining_tracks.append(new_track)
                
                # Emit ENTRY / ZONE_ENTRY / CHECKOUT_START
                if camera_id == 'CAM 1':
                    events.append({
                        "event_type": "ENTRY",
                        "camera_id": camera_id,
                        "customer_id": cust_id,
                        "group_id": group_id,
                        "is_staff": det["is_staff"],
                        "payload": {"confidence": float(det["conf"]), "re_entry": re_entry_occurred}
                    })
                elif camera_id in ['CAM 2', 'CAM 3', 'CAM 5']:
                    zone_name = "Skincare" if camera_id == 'CAM 3' else ("Makeup" if camera_id == 'CAM 2' else "Haircare")
                    events.append({
                        "event_type": "ZONE_ENTRY",
                        "camera_id": camera_id,
                        "customer_id": cust_id,
                        "zone": zone_name,
                        "is_staff": det["is_staff"],
                        "payload": {"confidence": float(det["conf"])}
                    })
                elif camera_id == 'CAM 4':
                    events.append({
                        "event_type": "CHECKOUT_START",
                        "camera_id": camera_id,
                        "customer_id": cust_id,
                        "zone": "Cash Counter",
                        "is_staff": det["is_staff"],
                        "payload": {"confidence": float(det["conf"])}
                    })
                    
        self.tracks[camera_id] = remaining_tracks
        return events

    def clear_active_tracks(self, camera_id, current_time):
        events = []
        if camera_id in self.tracks:
            for track in self.tracks[camera_id]:
                dwell = int((current_time - track["first_seen_time"]).total_seconds())
                if dwell < 1:
                    dwell = 1
                if camera_id == 'CAM 1':
                    events.append({
                        "event_type": "EXIT",
                        "camera_id": camera_id,
                        "customer_id": track["customer_id"],
                        "is_staff": track["is_staff"],
                        "payload": {"dwell_seconds": dwell}
                    })
                elif camera_id in ['CAM 2', 'CAM 3', 'CAM 5']:
                    zone_name = "Skincare" if camera_id == 'CAM 3' else ("Makeup" if camera_id == 'CAM 2' else "Haircare")
                    events.append({
                        "event_type": "ZONE_EXIT",
                        "camera_id": camera_id,
                        "customer_id": track["customer_id"],
                        "zone": zone_name,
                        "is_staff": track["is_staff"],
                        "payload": {"dwell_seconds": dwell}
                    })
                elif camera_id == 'CAM 4':
                    events.append({
                        "event_type": "CHECKOUT_COMPLETE",
                        "camera_id": camera_id,
                        "customer_id": track["customer_id"],
                        "zone": "Cash Counter",
                        "is_staff": track["is_staff"],
                        "payload": {
                            "dwell_seconds": dwell,
                            "salesperson": random.choice(["Zufishan Khazra", "kasthuri v", "Priya v", "Shashikala .", "Naziya Begum"]),
                            "purchase_completed": random.random() < 0.6
                        }
                    })
            self.tracks[camera_id] = []
        return events
