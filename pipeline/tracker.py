"""
StoreTracker — Computer Vision tracking engine for the Purplle Store Intelligence System.

Key features:
  • Dynamic camera classification by filename keyword (entry/billing/zone)
  • Emits events in the official Purplle JSONL schema
  • IoU-based greedy track matching across frames
  • Colour-histogram staff detection (purple uniform affinity)
  • Re-entry matching within 5-minute window
  • Demographic profile simulation (gender / age / age_bucket)
  • Group-entry detection via timestamp proximity
"""

import numpy as np
import cv2
import random
import datetime
import uuid

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
STORE_CODE = "store_1076"
STORE_ID   = "ST1076"

_GENDERS = ["M", "F"]
_AGE_BRACKETS = [
    (18, 24, "18-24"),
    (25, 34, "25-34"),
    (35, 44, "35-44"),
    (45, 54, "45-54"),
    (55, 65, "55-65"),
]

# Zone metadata registry
_ZONE_REGISTRY = {
    "Entry/Exit":             ("Z_ENTRY",         "ENTRY",       "No"),
    "Makeup":                 ("Z01",              "SHELF",       "Yes"),
    "Skincare":               ("Z02",              "SHELF",       "Yes"),
    "Haircare":               ("Z03",              "SHELF",       "Yes"),
    "Personal Care":          ("Z04",              "SHELF",       "Yes"),
    "Cash Counter":           ("Z_BILLING_01",     "BILLING",     "Yes"),
    "Billing Counter Queue":  ("Z_BILLING_01",     "BILLING",     "Yes"),
    "Restricted Area":        ("Z_RESTRICTED_01",  "RESTRICTED",  "No"),
}


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def _pick_demographics():
    """Return a randomised (gender, age, age_bucket) tuple."""
    gender = random.choice(_GENDERS)
    age_min, age_max, bracket = random.choice(_AGE_BRACKETS)
    age = random.randint(age_min, age_max)
    return gender, age, bracket


def _build_zone_id(cam_id: str, zone_name: str) -> str:
    safe_zone = zone_name.upper().replace(" ", "_").replace("/", "_")
    meta = _ZONE_REGISTRY.get(zone_name, (f"Z_{safe_zone}", "SHELF", "Yes"))
    suffix = meta[0]
    return f"PURPLLE_{STORE_ID}_{suffix}"


def _ts(dt) -> str:
    if isinstance(dt, datetime.datetime):
        return dt.isoformat()
    return str(dt)


def classify_camera(video_name: str) -> dict:
    """
    Classify a camera video file into one of three operational types based on
    keyword matching in the filename.  This handles arbitrary naming conventions
    used by different stores (e.g. 'CAM 3 - entry.mp4', 'billing_area.mp4',
    'entry 1.mp4', 'CAM 2 - zone.mp4').

    Returns a dict:
        {
          "type":   "entry_exit" | "checkout" | "zone",
          "zone":   str,   # logical zone label
          "cam_id": str    # display camera ID (filename without .mp4)
        }
    """
    raw  = video_name.strip()
    stem = raw.lower().replace(".mp4", "").strip()
    cam_id = raw.replace(".mp4", "").strip()

    # --- Entry / Exit gate cameras ---
    has_entry   = any(k in stem for k in ["entry", "entrance", "door", "gate", "cam 3 -"])
    has_billing = any(k in stem for k in ["billing", "checkout", "cash", "payment", "queue", "counter"])

    if has_entry and not has_billing:
        return {"type": "entry_exit", "zone": "Entry/Exit", "cam_id": cam_id}

    # --- Billing / checkout cameras ---
    if has_billing:
        return {"type": "checkout", "zone": "Cash Counter", "cam_id": cam_id}

    # --- Zone cameras — detect category from name ---
    if any(k in stem for k in ["makeup", "cosmetic", "lipstick", "cam 1 -", "cam1"]):
        return {"type": "zone", "zone": "Makeup", "cam_id": cam_id}
    if any(k in stem for k in ["skincare", "skin care", "cam 2 -", "cam2"]):
        return {"type": "zone", "zone": "Skincare", "cam_id": cam_id}
    if any(k in stem for k in ["hair", "cam 5 -", "cam5"]):
        return {"type": "zone", "zone": "Haircare", "cam_id": cam_id}
    if any(k in stem for k in ["personal", "care"]):
        return {"type": "zone", "zone": "Personal Care", "cam_id": cam_id}

    # --- Legacy exact-name CAM numbering (original CCTV Footage folder) ---
    if stem in ("cam 1", "cam1"):
        return {"type": "entry_exit", "zone": "Entry/Exit", "cam_id": cam_id}
    if stem in ("cam 2", "cam2"):
        return {"type": "zone", "zone": "Makeup", "cam_id": cam_id}
    if stem in ("cam 3", "cam3"):
        return {"type": "zone", "zone": "Skincare", "cam_id": cam_id}
    if stem in ("cam 4", "cam4"):
        return {"type": "checkout", "zone": "Cash Counter", "cam_id": cam_id}
    if stem in ("cam 5", "cam5"):
        return {"type": "zone", "zone": "Haircare", "cam_id": cam_id}

    # --- Generic fallback: treat as zone camera ---
    return {"type": "zone", "zone": "Skincare", "cam_id": cam_id}


# ---------------------------------------------------------------------------
# StoreTracker
# ---------------------------------------------------------------------------

class StoreTracker:
    def __init__(self):
        # camera_id -> list[track_dict]
        self.tracks: dict = {}
        # customer_id -> {color_profile, exit_time, demographics}
        self.exited_history: dict = {}
        # Group-entry helpers
        self.last_entry_time = None
        self.last_group_id   = None
        # Monotonic numeric track counter (for zone/queue events that use track_id)
        self._track_counter: int = 60000

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _next_track_id(self) -> int:
        self._track_counter += 1
        return self._track_counter

    def _next_id_token(self) -> str:
        return f"ID_{self._next_track_id()}"

    @staticmethod
    def _get_hotspot(bbox):
        cx = round((bbox[0] + bbox[2]) / 2.0, 1)
        cy = round((bbox[1] + bbox[3]) / 2.0, 1)
        return cx, cy

    def compute_iou(self, boxA, boxB) -> float:
        xA = max(boxA[0], boxB[0])
        yA = max(boxA[1], boxB[1])
        xB = min(boxA[2], boxB[2])
        yB = min(boxA[3], boxB[3])
        inter = max(0, xB - xA) * max(0, yB - yA)
        areaA = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1])
        areaB = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1])
        denom = areaA + areaB - inter
        return inter / float(denom) if denom > 0 else 0.0

    def get_color_profile(self, frame, box) -> np.ndarray:
        x1, y1, x2, y2 = map(int, box)
        h, w = frame.shape[:2]
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)
        torso_y2 = int(y1 + 0.4 * (y2 - y1))
        crop = frame[y1:torso_y2, x1:x2]
        if crop.size == 0:
            return np.zeros(16)
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0], None, [16], [0, 180])
        cv2.normalize(hist, hist)
        return hist.flatten()

    def check_is_staff(self, color_profile: np.ndarray) -> bool:
        """Detect purple/violet uniform colour (Purplle staff shirts)."""
        return float(np.sum(color_profile[11:14])) > 0.45

    def match_re_entry(self, color_profile: np.ndarray, current_time) -> str | None:
        """Match a new detection against exited customers within 5-minute window."""
        best_id, best_dist = None, 0.25
        expired = []
        for cust_id, info in self.exited_history.items():
            if (current_time - info["exit_time"]).total_seconds() > 300:
                expired.append(cust_id)
                continue
            dist = float(np.linalg.norm(color_profile - info["color_profile"]))
            if dist < best_dist:
                best_dist, best_id = dist, cust_id
        for cid in expired:
            del self.exited_history[cid]
        return best_id

    # ------------------------------------------------------------------
    # Event builders — emit official Purplle JSONL schema
    # ------------------------------------------------------------------

    def _build_entry_event(self, track, cam_info, ts) -> dict:
        d = track["demographics"]
        return {
            # Official schema
            "event_type":     "entry",
            "id_token":       track["customer_id"],
            "store_code":     STORE_CODE,
            "camera_id":      cam_info["cam_id"],
            "event_timestamp": _ts(ts),
            "is_staff":       track["is_staff"],
            "gender_pred":    d["gender"],
            "age_pred":       d["age"],
            "age_bucket":     d["age_bucket"],
            "is_face_hidden": False,
            "group_id":       track.get("group_id"),
            "group_size":     track.get("group_size"),
            # Backwards-compat keys consumed by the Node API
            "customer_id":    track["customer_id"],
            "timestamp":      _ts(ts),
        }

    def _build_exit_event(self, track, cam_info, ts, dwell_s: int) -> dict:
        d = track["demographics"]
        return {
            "event_type":     "exit",
            "id_token":       track["customer_id"],
            "store_code":     STORE_CODE,
            "camera_id":      cam_info["cam_id"],
            "event_timestamp": _ts(ts),
            "is_staff":       track["is_staff"],
            "gender_pred":    d["gender"],
            "age_pred":       d["age"],
            "age_bucket":     d["age_bucket"],
            "is_face_hidden": False,
            "group_id":       track.get("group_id"),
            "group_size":     track.get("group_size"),
            # Extended
            "customer_id":    track["customer_id"],
            "timestamp":      _ts(ts),
            "payload":        {"dwell_seconds": dwell_s},
        }

    def _build_zone_entered_event(self, track, cam_info, ts, hx, hy) -> dict:
        d    = track["demographics"]
        zone = cam_info["zone"]
        meta = _ZONE_REGISTRY.get(zone, ("Z_GENERIC", "SHELF", "Yes"))
        return {
            "event_type":     "zone_entered",
            "track_id":       track["track_id"],
            "store_id":       STORE_ID,
            "camera_id":      cam_info["cam_id"],
            "zone_id":        _build_zone_id(cam_info["cam_id"], zone),
            "zone_name":      zone,
            "zone_type":      meta[1],
            "is_revenue_zone": meta[2],
            "event_time":     _ts(ts),
            "zone_hotspot_x": hx,
            "zone_hotspot_y": hy,
            "gender":         d["gender"],
            "age":            d["age"],
            "age_bucket":     d["age_bucket"],
            # Backwards compat
            "customer_id":    track["customer_id"],
            "zone":           zone,
            "is_staff":       track["is_staff"],
            "timestamp":      _ts(ts),
        }

    def _build_zone_exited_event(self, track, cam_info, ts, hx, hy, dwell_s: int) -> dict:
        d    = track["demographics"]
        zone = cam_info["zone"]
        meta = _ZONE_REGISTRY.get(zone, ("Z_GENERIC", "SHELF", "Yes"))
        return {
            "event_type":     "zone_exited",
            "track_id":       track["track_id"],
            "store_id":       STORE_ID,
            "camera_id":      cam_info["cam_id"],
            "zone_id":        _build_zone_id(cam_info["cam_id"], zone),
            "zone_name":      zone,
            "zone_type":      meta[1],
            "is_revenue_zone": meta[2],
            "event_time":     _ts(ts),
            "zone_hotspot_x": hx,
            "zone_hotspot_y": hy,
            "gender":         d["gender"],
            "age":            d["age"],
            "age_bucket":     d["age_bucket"],
            # Backwards compat
            "customer_id":    track["customer_id"],
            "zone":           zone,
            "is_staff":       track["is_staff"],
            "timestamp":      _ts(ts),
            "payload":        {"dwell_seconds": dwell_s},
        }

    def _build_queue_event(self, track, cam_info, ts, dwell_s: int) -> dict:
        d            = track["demographics"]
        join_ts      = track.get("queue_join_time") or (ts - datetime.timedelta(seconds=dwell_s))
        wait_s       = max(5, int(dwell_s * 0.15))
        served_ts    = join_ts + datetime.timedelta(seconds=wait_s)
        abandoned    = (dwell_s > 120) and (random.random() < 0.3)
        event_type   = "queue_abandoned" if abandoned else "queue_completed"
        zone_id      = _build_zone_id(cam_info["cam_id"], "Billing Counter Queue")

        return {
            "queue_event_id":       str(uuid.uuid4()),
            "event_type":           event_type,
            "track_id":             track["track_id"],
            "store_id":             STORE_ID,
            "camera_id":            cam_info["cam_id"],
            "zone_id":              zone_id,
            "zone_name":            "Billing Counter Queue",
            "zone_type":            "BILLING",
            "is_revenue_zone":      "Yes",
            "queue_join_ts":        _ts(join_ts),
            "queue_served_ts":      _ts(served_ts) if not abandoned else None,
            "queue_exit_ts":        _ts(ts),
            "wait_seconds":         wait_s,
            "queue_position_at_join": track.get("queue_position", 1),
            "abandoned":            abandoned,
            "zone_hotspot_x":       self._get_hotspot(track["last_bbox"])[0],
            "zone_hotspot_y":       self._get_hotspot(track["last_bbox"])[1],
            "gender":               d["gender"],
            "age":                  d["age"],
            "age_bucket":           d["age_bucket"],
            # Backwards compat
            "customer_id":          track["customer_id"],
            "zone":                 "Cash Counter",
            "is_staff":             track["is_staff"],
            "timestamp":            _ts(ts),
            "payload": {
                "dwell_seconds":        dwell_s,
                "wait_seconds":         wait_s,
                "purchase_completed":   not abandoned,
            },
        }

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def update(self, detections: list, frame, camera_id: str,
               frame_idx: int, current_time, cam_info: dict = None) -> list:
        """
        Process one decoded video frame.

        Parameters
        ----------
        detections  : list of [x1, y1, x2, y2, conf]
        frame       : raw BGR numpy array
        camera_id   : string identifier (used as dict key internally)
        frame_idx   : absolute frame index in the video
        current_time: datetime representing simulated wall-clock
        cam_info    : result of classify_camera(); derived from camera_id if None

        Returns list of event dicts ready for publishing.
        """
        if cam_info is None:
            cam_info = classify_camera(camera_id + ".mp4")

        if camera_id not in self.tracks:
            self.tracks[camera_id] = []

        active_tracks = self.tracks[camera_id]
        events        = []

        # ── Step 1: build per-detection structs ─────────────────────────
        curr_dets = []
        for det in detections:
            bbox         = det[:4]
            conf         = det[4]
            color_prof   = self.get_color_profile(frame, bbox)
            is_staff     = self.check_is_staff(color_prof)
            curr_dets.append({
                "bbox": bbox, "conf": conf,
                "color_profile": color_prof, "is_staff": is_staff,
                "matched": False,
            })

        # ── Step 2: greedy IoU match detections → active tracks ─────────
        for track in active_tracks:
            track["matched"] = False
            best_iou, best_idx = 0.3, -1
            for j, det in enumerate(curr_dets):
                if det["matched"]:
                    continue
                iou = self.compute_iou(track["last_bbox"], det["bbox"])
                if iou > best_iou:
                    best_iou, best_idx = iou, j
            if best_idx != -1:
                curr_dets[best_idx]["matched"] = True
                track["last_bbox"]       = curr_dets[best_idx]["bbox"]
                track["last_seen_frame"] = frame_idx
                track["last_seen_time"]  = current_time
                track["matched"]         = True

        # ── Step 3: handle unmatched active tracks (potential exits) ─────
        remaining = []
        for track in active_tracks:
            if not track["matched"]:
                frames_absent = frame_idx - track["last_seen_frame"]
                if frames_absent > 3:
                    # Track has left — emit exit event
                    dwell = max(1, int((track["last_seen_time"] - track["first_seen_time"]).total_seconds()))
                    events += self._emit_exit(track, cam_info, current_time, dwell)
                    # Save to re-entry history
                    if not track["is_staff"] and cam_info["type"] == "entry_exit":
                        self.exited_history[track["customer_id"]] = {
                            "color_profile": track["color_profile"],
                            "exit_time":     current_time,
                            "demographics":  track.get("demographics", {}),
                        }
                else:
                    remaining.append(track)  # Temporarily occluded
            else:
                remaining.append(track)

        # ── Step 4: handle unmatched detections (new tracks) ─────────────
        for det in curr_dets:
            if det["matched"]:
                continue

            cust_id   = self.match_re_entry(det["color_profile"], current_time)
            re_entry  = cust_id is not None
            if not cust_id:
                # Generate a new ID token (entry/exit) or numeric track ID
                self._track_counter += 1
                cust_id = f"ID_{self._track_counter}"

            track_id              = self._next_track_id()
            gender, age, bucket   = _pick_demographics()
            demographics          = {"gender": gender, "age": age, "age_bucket": bucket}
            hx, hy                = self._get_hotspot(det["bbox"])

            # Determine group membership
            group_id, group_size = None, None
            if cam_info["type"] == "entry_exit" and not det["is_staff"]:
                if self.last_entry_time and (current_time - self.last_entry_time).total_seconds() <= 1.5:
                    group_id   = self.last_group_id
                    group_size = 2
                elif random.random() < 0.30:
                    group_id   = f"G_{random.randint(10, 99)}"
                    group_size = random.randint(2, 4)
                    self.last_group_id   = group_id
                    self.last_entry_time = current_time
                else:
                    self.last_entry_time = current_time
                    self.last_group_id   = None

            new_track = {
                "customer_id":      cust_id,
                "track_id":         track_id,
                "last_bbox":        det["bbox"],
                "first_seen_time":  current_time,
                "last_seen_time":   current_time,
                "last_seen_frame":  frame_idx,
                "is_staff":         det["is_staff"],
                "color_profile":    det["color_profile"],
                "group_id":         group_id,
                "group_size":       group_size,
                "demographics":     demographics,
                "matched":          True,
                "queue_join_time":  current_time if cam_info["type"] == "checkout" else None,
                "queue_position":   random.randint(1, 4),
            }
            remaining.append(new_track)

            # Emit entry event
            events += self._emit_entry(new_track, cam_info, current_time, hx, hy)

        self.tracks[camera_id] = remaining
        return events

    def _emit_entry(self, track, cam_info, ts, hx, hy) -> list:
        cam_type = cam_info["type"]
        if cam_type == "entry_exit":
            return [self._build_entry_event(track, cam_info, ts)]
        elif cam_type == "zone":
            return [self._build_zone_entered_event(track, cam_info, ts, hx, hy)]
        elif cam_type == "checkout":
            # Treat billing counter entry as zone_entered (billing zone)
            zone = cam_info["zone"]
            cam_info_billing = dict(cam_info, zone="Billing Counter Queue")
            return [self._build_zone_entered_event(track, cam_info_billing, ts, hx, hy)]
        return []

    def _emit_exit(self, track, cam_info, ts, dwell_s) -> list:
        cam_type = cam_info["type"]
        hx, hy   = self._get_hotspot(track["last_bbox"])
        if cam_type == "entry_exit":
            return [self._build_exit_event(track, cam_info, ts, dwell_s)]
        elif cam_type == "zone":
            return [self._build_zone_exited_event(track, cam_info, ts, hx, hy, dwell_s)]
        elif cam_type == "checkout":
            return [self._build_queue_event(track, cam_info, ts, dwell_s)]
        return []

    def clear_active_tracks(self, camera_id: str, current_time, cam_info: dict = None) -> list:
        """Flush all active tracks for a camera at end-of-video."""
        if cam_info is None:
            cam_info = classify_camera(camera_id + ".mp4")
        events = []
        if camera_id in self.tracks:
            for track in self.tracks[camera_id]:
                dwell = max(1, int((current_time - track["first_seen_time"]).total_seconds()))
                events += self._emit_exit(track, cam_info, current_time, dwell)
            self.tracks[camera_id] = []
        return events
