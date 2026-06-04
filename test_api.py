#!/usr/bin/env python3
"""
API Smoke Test Suite — AURA Store Intelligence System
=====================================================
Tests all mandatory API endpoints for correctness, schema, and logical
consistency as specified in the HackerEarth evaluation framework.

Usage:
    python3 test_api.py                     # test localhost (Docker)
    python3 test_api.py http://localhost:3000  # test specific URL

Exit code:
    0 — All tests passed
    1 — One or more tests failed
"""

import sys
import json
import time
import requests
from datetime import datetime

BASE_URL = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost"
API = f"{BASE_URL}/api"

# ── Colours ──────────────────────────────────────────────────────────
GREEN = "\033[92m"
RED   = "\033[91m"
CYAN  = "\033[96m"
BOLD  = "\033[1m"
RESET = "\033[0m"

passed = 0
failed = 0
results = []


def ok(name, detail=""):
    global passed
    passed += 1
    tag = f"{GREEN}✅ PASS{RESET}"
    print(f"  {tag}  {name}" + (f"  — {detail}" if detail else ""))
    results.append(("PASS", name, detail))


def fail(name, detail=""):
    global failed
    failed += 1
    tag = f"{RED}❌ FAIL{RESET}"
    print(f"  {tag}  {name}" + (f"  — {detail}" if detail else ""))
    results.append(("FAIL", name, detail))


def section(title):
    print(f"\n{BOLD}{CYAN}── {title} ──{RESET}")


def get(path, timeout=10):
    url = f"{API}{path}"
    r = requests.get(url, timeout=timeout)
    r.raise_for_status()
    return r.json()


# ════════════════════════════════════════════════════════════════
print(f"\n{BOLD}AURA Store Intelligence — API Smoke Test{RESET}")
print(f"Target: {BASE_URL}")
print(f"Time:   {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
print("=" * 56)

# ── Wait for API to be ready ─────────────────────────────────────
section("Acceptance Gate — API Reachability")
for attempt in range(10):
    try:
        r = requests.get(f"{API}/health", timeout=5)
        if r.status_code == 200:
            ok("/api/health", f"HTTP 200 in {r.elapsed.total_seconds()*1000:.0f}ms")
            break
    except Exception:
        pass
    print(f"  Waiting for API... ({attempt+1}/10)")
    time.sleep(3)
else:
    fail("/api/health", "API did not become available after 30s")
    sys.exit(1)

# ── Case-insensitive route aliases ────────────────────────────────
section("Acceptance Gate — Case-Insensitive Routes")
for alias in ["/Metrics", "/Funnel", "/Anomaly", "/Sales", "/Status"]:
    try:
        r = requests.get(f"{API}{alias}", timeout=8)
        if r.status_code == 200:
            ok(f"{API}{alias}", "returns HTTP 200")
        else:
            fail(f"{API}{alias}", f"HTTP {r.status_code}")
    except Exception as e:
        fail(f"{API}{alias}", str(e))

# ── /metrics ──────────────────────────────────────────────────────
section("5.2 API Correctness — /api/metrics")
try:
    m = get("/metrics")
    required_keys = ["footfall", "activeCustomers", "staffInStore",
                     "avgDwellMinutes", "totalOrders", "conversionRate", "totalGMV"]
    for key in required_keys:
        if key in m:
            ok(f"key '{key}' present", str(m[key]))
        else:
            fail(f"key '{key}' missing from /metrics response")

    # Logical consistency checks
    if m.get("footfall", 0) >= 0:
        ok("footfall is non-negative", str(m["footfall"]))
    else:
        fail("footfall must be >= 0")

    if 0 <= m.get("conversionRate", -1) <= 100:
        ok("conversionRate in [0, 100]", f"{m['conversionRate']}%")
    else:
        fail("conversionRate out of bounds", str(m.get("conversionRate")))

    if m.get("activeCustomers", 0) <= m.get("footfall", 0):
        ok("activeCustomers <= footfall (logical)")
    else:
        fail("activeCustomers > footfall (impossible)")

    if m.get("totalGMV", 0) >= 0:
        ok("totalGMV is non-negative", f"₹{m['totalGMV']}")
    else:
        fail("totalGMV must be >= 0")

    if m.get("avgDwellMinutes", 0) >= 0:
        ok("avgDwellMinutes is non-negative")
    else:
        fail("avgDwellMinutes must be >= 0")

except Exception as e:
    fail("/metrics request failed", str(e))

# ── /funnel ───────────────────────────────────────────────────────
section("5.2 API Correctness — /api/funnel")
try:
    f = get("/funnel")

    if isinstance(f, list):
        ok("response is a list")
    else:
        fail("response must be a list")

    if len(f) == 5:
        ok("exactly 5 funnel steps")
    else:
        fail("expected 5 funnel steps", f"got {len(f)}")

    expected_steps = ["Entered Store", "Visited Shelves", "Engaged Products",
                      "Initiated Checkout", "Purchased"]
    for i, step_name in enumerate(expected_steps):
        if i < len(f) and f[i].get("step") == step_name:
            ok(f"step {i+1}: '{step_name}'", f"count={f[i].get('count', '?')}")
        else:
            fail(f"step {i+1} name mismatch", f"expected '{step_name}', got '{f[i].get('step') if i < len(f) else 'missing'}'")

    # Monotonic drop-off
    counts = [s.get("count", 0) for s in f]
    monotonic = all(counts[i] >= counts[i+1] for i in range(len(counts)-1))
    if monotonic:
        ok("funnel is monotonically decreasing", " > ".join(str(c) for c in counts))
    else:
        fail("funnel counts are NOT monotonically decreasing", str(counts))

    # First step == 100%
    if f[0].get("percentage") == 100:
        ok("first step percentage == 100%")
    else:
        fail("first step percentage must be 100", str(f[0].get("percentage")))

    # All percentages in [0, 100]
    all_valid = all(0 <= s.get("percentage", -1) <= 100 for s in f)
    if all_valid:
        ok("all percentages in [0, 100]")
    else:
        fail("some percentages out of [0, 100] range")

except Exception as e:
    fail("/funnel request failed", str(e))

# ── /anomaly ──────────────────────────────────────────────────────
section("5.2 API Correctness — /api/anomaly")
try:
    a = get("/anomaly")
    if isinstance(a, list):
        ok("response is a list", f"{len(a)} anomalies")
    else:
        fail("response must be a list")

    if len(a) > 0:
        required_anom_keys = ["type", "severity", "description", "timestamp"]
        for key in required_anom_keys:
            if key in a[0]:
                ok(f"anomaly key '{key}' present", str(a[0][key])[:60])
            else:
                fail(f"anomaly key '{key}' missing")

        valid_severities = {"HIGH", "MEDIUM", "LOW"}
        if a[0].get("severity") in valid_severities:
            ok("severity is valid", a[0]["severity"])
        else:
            fail("severity must be HIGH/MEDIUM/LOW", str(a[0].get("severity")))
    else:
        ok("no anomalies (system clean)", "0 alerts")

except Exception as e:
    fail("/anomaly request failed", str(e))

# ── /sales ────────────────────────────────────────────────────────
section("5.2 API Correctness — /api/sales")
try:
    s = get("/sales")
    required_sales_keys = ["brandCorrelation", "salespersonPerformance", "planogramFeedback"]
    for key in required_sales_keys:
        if key in s:
            ok(f"key '{key}' present")
        else:
            fail(f"key '{key}' missing from /sales response")

    brands = s.get("brandCorrelation", [])
    if isinstance(brands, list):
        ok("brandCorrelation is a list", f"{len(brands)} brands")
    else:
        fail("brandCorrelation must be a list")

    if brands:
        brand_keys = ["brand", "gmv", "orders", "dwellHours", "dwellSessions",
                      "conversionRate", "dwellRevenueIndex"]
        for key in brand_keys:
            if key in brands[0]:
                ok(f"brand key '{key}' present")
            else:
                fail(f"brand key '{key}' missing")

        # GMV should be non-negative
        if all(b.get("gmv", 0) >= 0 for b in brands):
            ok("all brand GMV values non-negative")
        else:
            fail("some brand GMV values are negative")

    planogram = s.get("planogramFeedback", {})
    if isinstance(planogram.get("recommendation"), str) and len(planogram["recommendation"]) > 10:
        ok("planogram recommendation is non-trivial", planogram["recommendation"][:60])
    else:
        fail("planogram recommendation missing or too short")

except Exception as e:
    fail("/sales request failed", str(e))

# ── /status ───────────────────────────────────────────────────────
section("5.3 Production Readiness — /api/status")
try:
    st = get("/status")
    if st.get("status") == "operational":
        ok("system status is 'operational'")
    else:
        fail("system status not 'operational'", str(st.get("status")))

    for key in ["events", "sessions", "anomalies", "brandsTracked"]:
        if key in st:
            ok(f"status key '{key}' present", str(st[key]))
        else:
            fail(f"status key '{key}' missing")

    if st.get("events", {}).get("total", 0) > 0:
        ok("events table has data", f"total={st['events']['total']}")
    else:
        fail("events table appears empty")

except Exception as e:
    fail("/status request failed", str(e))

# ── events.jsonl schema validation ────────────────────────────────
section("Deliverable — events.jsonl Schema Validation")
try:
    import os
    jsonl_path = os.path.join(os.path.dirname(__file__), "events.jsonl")
    if os.path.exists(jsonl_path):
        with open(jsonl_path) as f:
            lines = [l.strip() for l in f if l.strip()]

        ok("events.jsonl exists", f"{len(lines)} lines")

        parsed = 0
        schema_errors = []
        event_types_found = set()

        for i, line in enumerate(lines):
            try:
                ev = json.loads(line)
                parsed += 1
                et = ev.get("event_type")
                event_types_found.add(et)

                # entry/exit must have id_token
                if et in ("entry", "exit") and "id_token" not in ev:
                    schema_errors.append(f"line {i+1}: entry/exit missing 'id_token'")
                # zone events must have zone_id
                if et in ("zone_entered", "zone_exited") and "zone_id" not in ev:
                    schema_errors.append(f"line {i+1}: zone event missing 'zone_id'")
                # queue events must have queue_join_ts
                if et in ("queue_completed", "queue_abandoned") and "queue_join_ts" not in ev:
                    schema_errors.append(f"line {i+1}: queue event missing 'queue_join_ts'")
            except json.JSONDecodeError as e:
                schema_errors.append(f"line {i+1}: invalid JSON — {e}")

        if parsed == len(lines):
            ok("all lines are valid JSON", f"{parsed}/{len(lines)}")
        else:
            fail("some lines are invalid JSON", f"{parsed}/{len(lines)} valid")

        if not schema_errors:
            ok("schema validation passed", "all events conform to Purplle spec")
        else:
            for err in schema_errors[:5]:
                fail("schema error", err)

        ok("event types found", ", ".join(sorted(event_types_found)))
    else:
        fail("events.jsonl not found", jsonl_path)

except Exception as e:
    fail("events.jsonl validation failed", str(e))

# ── WebSocket availability ────────────────────────────────────────
section("5.3 Production Readiness — WebSocket Probe")
try:
    import socket
    host = BASE_URL.replace("http://", "").replace("https://", "").split(":")[0]
    port = 80 if "localhost" in BASE_URL and ":3000" not in BASE_URL else 3000
    s_sock = socket.create_connection((host, port), timeout=5)
    s_sock.close()
    ok("WebSocket port reachable", f"{host}:{port}")
except Exception as e:
    fail("WebSocket port not reachable", str(e))

# ════════════════════════════════════════════════════════════════
# Summary
print(f"\n{'='*56}")
print(f"{BOLD}TEST SUMMARY{RESET}")
print(f"{'='*56}")
total = passed + failed
print(f"  {GREEN}Passed: {passed}/{total}{RESET}")
if failed:
    print(f"  {RED}Failed: {failed}/{total}{RESET}")
else:
    print(f"  {GREEN}All tests passed! 🎉{RESET}")
print(f"{'='*56}\n")

sys.exit(0 if failed == 0 else 1)
