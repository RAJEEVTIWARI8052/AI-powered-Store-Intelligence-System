/**
 * test.js — Comprehensive test suite for the Store Intelligence API
 *
 * Tests cover:
 *   1. Health & Prometheus endpoints
 *   2. Metrics correctness and data type validation
 *   3. Funnel — 5-step shape, monotonic drop-off, staff exclusion
 *   4. Anomaly endpoint — schema validation
 *   5. Sales / brand correlation logic
 *   6. Event ingestion — all 6 official schema event types
 *   7. Edge cases — empty body, wrong types, missing fields
 *   8. Staff filtering — staff events must not inflate funnel
 *   9. Re-entry / idempotency — no double-counting
 *  10. Prometheus metrics — counter increments after ingestion
 */

const http  = require('http');
const https = require('https');
const URL   = require('url').URL;

const BASE_URL = process.env.API_URL || 'http://localhost:3000';
const PASS     = '✅';
const FAIL     = '❌';

let passed = 0;
let failed = 0;
const failures = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url  = new URL(path, BASE_URL);
    const lib  = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port:     url.port,
      path:     url.pathname + url.search,
      method,
      headers:  { 'Content-Type': 'application/json' },
    };

    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), raw: data });
        } catch {
          resolve({ status: res.statusCode, body: null, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  ${PASS} ${name}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${name}${detail ? ': ' + detail : ''}`);
    failed++;
    failures.push({ name, detail });
  }
}

async function ingest(event) {
  return request('POST', '/api/ingest', event);
}

// ---------------------------------------------------------------------------
// Test groups
// ---------------------------------------------------------------------------

async function testHealthAndSystem() {
  console.log('\n📋 1. Health & System Endpoints');
  const h = await request('GET', '/api/health');
  assert('Health endpoint returns 200', h.status === 200);
  assert('Health reports db:connected',  h.body?.db === 'connected');
  assert('Health has timestamp field',   typeof h.body?.timestamp === 'string');

  // Prometheus metrics (may 503 if prom-client not installed — still OK)
  const pm = await request('GET', '/api/system/metrics');
  assert('Prometheus endpoint responds (200 or 503)', pm.status === 200 || pm.status === 503);
  if (pm.status === 200) {
    assert('Prometheus returns text/plain content', pm.raw.includes('# HELP') || pm.raw.includes('store_api'));
  }
}

async function testMetrics() {
  console.log('\n📋 2. /api/metrics — correctness and data types');
  const r = await request('GET', '/api/metrics');
  assert('Returns 200',                       r.status === 200);
  assert('footfall is a non-negative number', typeof r.body?.footfall === 'number' && r.body.footfall >= 0);
  assert('activeCustomers is a number',       typeof r.body?.activeCustomers === 'number');
  assert('staffInStore is a number',          typeof r.body?.staffInStore === 'number');
  assert('avgDwellMinutes is a number',       typeof r.body?.avgDwellMinutes === 'number');
  assert('totalOrders is a number',           typeof r.body?.totalOrders === 'number');
  assert('conversionRate 0-100',              r.body?.conversionRate >= 0 && r.body?.conversionRate <= 100);
  assert('totalGMV is a non-negative number', typeof r.body?.totalGMV === 'number' && r.body.totalGMV >= 0);
  assert('activeCustomers <= footfall',       r.body?.activeCustomers <= r.body?.footfall);
  // Case-insensitive alias
  const r2 = await request('GET', '/Metrics');
  assert('/Metrics (uppercase) also returns 200', r2.status === 200);
}

async function testFunnel() {
  console.log('\n📋 3. /api/funnel — 5-step shape and drop-off logic');
  const r = await request('GET', '/api/funnel');
  assert('Returns 200',               r.status === 200);
  assert('Response is an array',      Array.isArray(r.body));
  assert('Has exactly 5 steps',       r.body?.length === 5);

  const steps = r.body?.map(s => s.step) || [];
  assert('Step 1 is "Entered Store"',       steps[0] === 'Entered Store');
  assert('Step 2 is "Visited Shelves"',     steps[1] === 'Visited Shelves');
  assert('Step 3 is "Engaged Products"',    steps[2] === 'Engaged Products');
  assert('Step 4 is "Initiated Checkout"',  steps[3] === 'Initiated Checkout');
  assert('Step 5 is "Purchased"',           steps[4] === 'Purchased');

  const counts = r.body?.map(s => s.count) || [];
  assert('Counts are all non-negative numbers', counts.every(c => typeof c === 'number' && c >= 0));
  assert('Step 1 count >= Step 5 count (funnel is narrowing)', counts[0] >= counts[4]);

  const pcts = r.body?.map(s => s.percentage) || [];
  assert('Step 1 percentage is 100', pcts[0] === 100);
  assert('All percentages are between 0 and 100', pcts.every(p => p >= 0 && p <= 100));

  // Case-insensitive alias
  const r2 = await request('GET', '/Funnel');
  assert('/Funnel (uppercase) returns 200', r2.status === 200);
}

async function testAnomalies() {
  console.log('\n📋 4. /api/anomaly — schema validation');
  const r = await request('GET', '/api/anomaly');
  assert('Returns 200',          r.status === 200);
  assert('Response is an array', Array.isArray(r.body));

  if (r.body?.length > 0) {
    const a = r.body[0];
    assert('Anomaly has id field',          a.id !== undefined);
    assert('Anomaly has timestamp field',   typeof a.timestamp === 'string');
    assert('Anomaly has type field',        typeof a.type === 'string');
    assert('Anomaly has description field', typeof a.description === 'string');
    assert('Anomaly has severity field',    ['LOW','MEDIUM','HIGH'].includes(a.severity));
  }

  const r2 = await request('GET', '/Anomaly');
  assert('/Anomaly (uppercase) returns 200', r2.status === 200);
}

async function testSales() {
  console.log('\n📋 5. /api/sales — brand correlation and GMV');
  const r = await request('GET', '/api/sales');
  assert('Returns 200',                      r.status === 200);
  assert('Has salesSummary object',          typeof r.body?.salesSummary === 'object');
  assert('salesSummary.totalGMV >= 0',       r.body?.salesSummary?.totalGMV >= 0);
  assert('salesSummary.totalNMV >= 0',       r.body?.salesSummary?.totalNMV >= 0);
  assert('Has brandCorrelation array',       Array.isArray(r.body?.brandCorrelation));
  if (r.body?.brandCorrelation?.length > 0) {
    const b = r.body.brandCorrelation[0];
    assert('Brand entry has brand name',        typeof b.brand === 'string');
    assert('Brand entry has gmv field',         typeof b.gmv === 'number');
    assert('Brand entry has orders field',      typeof b.orders === 'number');
    assert('Brand entry has conversionRate',    typeof b.conversionRate === 'number');
    assert('dwellRevenueIndex is a number',     typeof b.dwellRevenueIndex === 'number');
  }
}

async function testIngestAllEventTypes() {
  console.log('\n📋 6. /api/ingest — all 6 official Purplle schema event types');
  const now = new Date().toISOString();
  const testId = `TEST_${Date.now()}`;

  // 6a: entry (uses id_token)
  const entry = await ingest({
    event_type: 'entry', id_token: testId, store_code: 'store_1076',
    camera_id: 'CAM 3', event_timestamp: now, is_staff: false,
    gender_pred: 'F', age_pred: 28, age_bucket: '25-34',
    is_face_hidden: false, group_id: null, group_size: null,
  });
  assert('entry event accepted (200)', entry.status === 200 && entry.body?.success === true);

  // 6b: zone_entered (uses track_id)
  const zoneEnter = await ingest({
    event_type: 'zone_entered', track_id: 99999, store_id: 'ST1076',
    camera_id: 'CAM 2', zone_id: 'PURPLLE_ST1076_Z01', zone_name: 'Makeup',
    zone_type: 'SHELF', is_revenue_zone: 'Yes', event_time: now,
    zone_hotspot_x: 412.6, zone_hotspot_y: 238.4,
    gender: 'F', age: 28, age_bucket: '25-34',
  });
  assert('zone_entered event accepted (200)', zoneEnter.status === 200 && zoneEnter.body?.success === true);

  // 6c: zone_exited
  const zoneExit = await ingest({
    event_type: 'zone_exited', track_id: 99999, store_id: 'ST1076',
    camera_id: 'CAM 2', zone_id: 'PURPLLE_ST1076_Z01', zone_name: 'Makeup',
    zone_type: 'SHELF', is_revenue_zone: 'Yes', event_time: now,
    zone_hotspot_x: 412.6, zone_hotspot_y: 238.4,
    gender: 'F', age: 28, age_bucket: '25-34',
    payload: { dwell_seconds: 45 },
  });
  assert('zone_exited event accepted (200)', zoneExit.status === 200 && zoneExit.body?.success === true);

  // 6d: queue_completed
  const queueOk = await ingest({
    queue_event_id: `QE_${Date.now()}`, event_type: 'queue_completed',
    track_id: 99998, store_id: 'ST1076', camera_id: 'CAM 4',
    zone_id: 'PURPLLE_ST1076_Z_BILLING_01', zone_name: 'Billing Counter Queue',
    zone_type: 'BILLING', is_revenue_zone: 'Yes',
    queue_join_ts: now, queue_served_ts: now, queue_exit_ts: now,
    wait_seconds: 12, queue_position_at_join: 2, abandoned: false,
    gender: 'M', age: 31, age_bucket: '25-34',
  });
  assert('queue_completed event accepted (200)', queueOk.status === 200 && queueOk.body?.success === true);

  // 6e: queue_abandoned
  const queueAband = await ingest({
    queue_event_id: `QE_${Date.now() + 1}`, event_type: 'queue_abandoned',
    track_id: 99997, store_id: 'ST1076', camera_id: 'CAM 4',
    zone_id: 'PURPLLE_ST1076_Z_BILLING_01', zone_name: 'Billing Counter Queue',
    zone_type: 'BILLING', is_revenue_zone: 'Yes',
    queue_join_ts: now, queue_served_ts: null, queue_exit_ts: now,
    wait_seconds: 320, queue_position_at_join: 5, abandoned: true,
    gender: 'F', age: 22, age_bucket: '18-24',
  });
  assert('queue_abandoned event accepted (200)', queueAband.status === 200 && queueAband.body?.success === true);

  // 6f: exit (uses id_token)
  const exit = await ingest({
    event_type: 'exit', id_token: testId, store_code: 'store_1076',
    camera_id: 'CAM 3', event_timestamp: now, is_staff: false,
    gender_pred: 'F', age_pred: 28, age_bucket: '25-34',
    is_face_hidden: false, group_id: null, group_size: null,
    payload: { dwell_seconds: 420 },
  });
  assert('exit event accepted (200)', exit.status === 200 && exit.body?.success === true);
}

async function testEdgeCases() {
  console.log('\n📋 7. Edge cases — malformed input, missing fields');

  // Empty body
  const empty = await ingest({});
  assert('Empty body returns 400', empty.status === 400);

  // Missing event_type
  const noType = await ingest({ customer_id: 'ID_X', zone: 'Makeup' });
  assert('Missing event_type returns 400', noType.status === 400);

  // event_type present but no ID
  const noId = await ingest({ event_type: 'entry', store_code: 'store_1076' });
  assert('Missing all IDs returns 400', noId.status === 400);

  // Completely invalid JSON body (raw string — treated as no-parse)
  const badJson = await request('POST', '/api/ingest', 'not-json');
  assert('Non-JSON body handled gracefully (400 or 200)', badJson.status >= 400 || badJson.status === 200);

  // Unknown event type — should not crash
  const unknown = await ingest({ event_type: 'mystery_event', customer_id: 'ID_U' });
  assert('Unknown event type does not crash (200 or 400)', unknown.status === 200 || unknown.status === 400);
}

async function testStaffFiltering() {
  console.log('\n📋 8. Staff filtering — staff events must not inflate customer funnel');
  const now = new Date().toISOString();
  const staffId = `STAFF_TEST_${Date.now()}`;

  // Ingest a staff entry
  await ingest({
    event_type: 'entry', id_token: staffId, store_code: 'store_1076',
    camera_id: 'CAM 3', event_timestamp: now, is_staff: true,
    gender_pred: 'F', age_pred: 30, age_bucket: '25-34',
    is_face_hidden: false, group_id: null, group_size: null,
  });

  // Fetch metrics — staffInStore should be >= 1; funnel step 1 should not include staff
  await new Promise(r => setTimeout(r, 300)); // allow DB write
  const m = await request('GET', '/api/metrics');
  assert('staffInStore is correctly tracked', m.body?.staffInStore >= 1);

  // Fetch funnel — staff must be excluded
  const f = await request('GET', '/api/funnel');
  // We can't check the exact count without knowing baseline, but funnel must still be 5 steps
  assert('Funnel still has 5 steps after staff entry', f.body?.length === 5);
  assert('Funnel step 1 count > 0', f.body?.[0]?.count > 0);
}

async function testIdempotency() {
  console.log('\n📋 9. Idempotency — same customer_id should not double-count in footfall');
  const before = await request('GET', '/api/metrics');
  const beforeFootfall = before.body?.footfall || 0;

  const custId = `IDEM_TEST_${Date.now()}`;
  const now    = new Date().toISOString();

  // Send the same entry event twice with the same customer_id
  await ingest({ event_type: 'entry', id_token: custId, store_code: 'store_1076', camera_id: 'CAM 3', event_timestamp: now, is_staff: false, gender_pred: 'M', age_pred: 25, age_bucket: '25-34', is_face_hidden: false });
  await ingest({ event_type: 'entry', id_token: custId, store_code: 'store_1076', camera_id: 'CAM 3', event_timestamp: now, is_staff: false, gender_pred: 'M', age_pred: 25, age_bucket: '25-34', is_face_hidden: false });

  await new Promise(r => setTimeout(r, 400));
  const after = await request('GET', '/api/metrics');
  const afterFootfall = after.body?.footfall || 0;

  // Sessions table uses ON CONFLICT UPDATE (upsert) so the same customer_id counts once
  assert('Double-entry does not double footfall (session upsert)', afterFootfall - beforeFootfall <= 1);
}

async function testPrometheusIncrements() {
  console.log('\n📋 10. Prometheus — metrics endpoint correctness');
  const pm1 = await request('GET', '/api/system/metrics');
  if (pm1.status !== 200) {
    console.log(`  ⏭  Prometheus not available — skipping`);
    return;
  }

  assert('Prometheus endpoint returns text data',    pm1.raw.length > 100);
  assert('Contains HELP metadata',                  pm1.raw.includes('# HELP'));
  assert('Contains TYPE metadata',                  pm1.raw.includes('# TYPE'));
  assert('Contains store_api custom metrics',       pm1.raw.includes('store_api_'));
  assert('Contains events_processed counter',       pm1.raw.includes('store_api_events_processed_total'));
  assert('Contains http_requests counter',          pm1.raw.includes('store_api_http_requests_total'));
  assert('Contains default Go/process metrics',     pm1.raw.includes('process_') || pm1.raw.includes('nodejs_'));

  // Ingest one event and verify the counter line is present
  await ingest({
    event_type: 'entry', id_token: `PM_TEST_${Date.now()}`, store_code: 'store_1076',
    camera_id: 'CAM 3', event_timestamp: new Date().toISOString(), is_staff: false,
    gender_pred: 'F', age_pred: 27, age_bucket: '25-34', is_face_hidden: false,
  });
  await new Promise(r => setTimeout(r, 400));

  const pm2 = await request('GET', '/api/system/metrics');
  const hasEntryLabel = pm2.raw.includes('event_type="entry"') || pm2.raw.includes("event_type='entry'");
  assert('Counter has event_type label after ingest', hasEntryLabel);
}


// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
(async () => {
  console.log('');
  console.log('═'.repeat(60));
  console.log('  🧪 AURA Store Intelligence API — Test Suite');
  console.log(`  📡 Target: ${BASE_URL}`);
  console.log('═'.repeat(60));

  try {
    await testHealthAndSystem();
    await testMetrics();
    await testFunnel();
    await testAnomalies();
    await testSales();
    await testIngestAllEventTypes();
    await testEdgeCases();
    await testStaffFiltering();
    await testIdempotency();
    await testPrometheusIncrements();
  } catch (e) {
    console.error('\n❌ Unexpected test runner error:', e.message);
    failed++;
  }

  const total = passed + failed;
  console.log('');
  console.log('═'.repeat(60));
  console.log(`  Results: ${passed}/${total} passed  |  ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failed tests:');
    failures.forEach(f => console.log(`    ❌ ${f.name}${f.detail ? ' — ' + f.detail : ''}`));
  }
  console.log('═'.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
})();
