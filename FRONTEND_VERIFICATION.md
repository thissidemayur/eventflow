# EventFlow Frontend — Verification Checklist

## Pre-Flight: Backend Status

Before starting frontend tests, verify the backend is running:

```bash
# Check services
curl -s http://localhost:3000/api/v1/health | jq .
curl -s http://localhost:9091/health | jq .

# Should return:
# API: { "status": "ok", "checks": { "postgres": "healthy", "redis": "healthy" }, ... }
# Worker: { "status": "ok", "checks": { "redis": "healthy", "queue": "healthy", ... }, ... }
```

---

## Component-by-Component Verification

### ✓ Sidebar Status Dot

**What it should do:**
- Poll API health every 10 seconds
- Show GREEN dot when status === "ok"
- Show RED dot when status === "degraded" or fetch throws
- Display "System online" or "System offline"

**Test:**
```bash
1. Open http://localhost:3001 → dashboard loads
2. Sidebar shows green dot and "System online"
3. docker compose stop api
4. Wait 10-15 seconds → dot turns RED, shows "System offline"
5. docker compose start api
6. Wait 10 seconds → dot turns GREEN again
```

---

### ✓ Dashboard — Stat Cards

**Verify these exact metrics exist:**

| Card | Metric Name | Should See |
|------|-------------|-----------|
| Events accepted | `eventflow_events_accepted_total` | Number > 0 after sending events |
| Jobs completed | `eventflow_jobs_completed_total` | Same or slightly less than accepted |
| Jobs failed | `eventflow_jobs_failed_total` | 0 if no errors |
| DLQ depth | (from worker health) | Parse `dlq_waiting` as integer |
| Cache hit rate | `auth_cache_hit_total` / (`hit` + `miss`) | Percentage like "83%" |

**Test:**
```bash
1. Open http://localhost:3001 → dashboard
2. All 5 stat cards show numbers (not 0, not undefined)
3. Refresh page → numbers persist (metrics are cumulative)
4. Go to /events → send an event
5. Return to dashboard → "Events accepted" incremented by 1
6. Wait 1-2 seconds → "Jobs completed" incremented
```

---

### ✓ Dashboard — Charts

**Throughput Chart:**
- X-axis: time labels (HH:MM:SS)
- Two lines: Orange (accepted) and Green (completed)
- Should show smooth curves, not jumps
- Should show rolling 30 points

**Rate Limit Chart:**
- Bar chart with 3 bars: IP, API key, Invalid key
- Heights match the metric values
- All should be low (unless you're testing rate limiting)

**Notifications Chart:**
- Pie chart: Sent (green) vs Failed (red)
- Donut style with center hole
- Should show mostly green after normal operation

**Test:**
```bash
1. Dashboard loads, all 3 charts visible
2. Throughput line is flat or slowly climbing (depending on traffic)
3. Send 10 events rapidly from /events page
4. Return to dashboard, watch throughput line rise
5. All metrics update every 5 seconds
```

---

### ✓ Dashboard — Health Panels

**API Health:**
- Shows status (ok or degraded)
- Shows postgres: healthy
- Shows redis: healthy
- Status in green if "ok", red if "degraded"

**Worker Health:**
- Shows status
- Shows queue_waiting (integer)
- Shows queue_active (integer)
- Shows dlq_waiting (integer, highlight in amber)

**Test:**
```bash
1. Both panels show "ok" status
2. All health checks show "healthy"
3. Queue counters show "0" initially
4. Send 5 events → queue_waiting fluctuates
5. Within 2 seconds → queue_waiting back to 0
```

---

### ✓ Events Page — Form

**Form Validation (before hitting backend):**

```
Test 1: Submit empty type
→ Should show inline error "Type is required"
→ Should NOT hit backend

Test 2: Submit invalid JSON payload
→ Payload: "not an object"
→ Should show "Must be a valid JSON object"
→ Should NOT hit backend

Test 3: Submit valid JSON array
→ Payload: ["a", "b"]
→ Should show "Payload must be a valid JSON object"
→ Should NOT hit backend

Test 4: Submit invalid UUID (if provided)
→ Type: "user.test"
→ Payload: {"x": 1}
→ IdempotencyKey: "invalid-uuid"
→ Should show "Must be a valid UUID v4"
→ Should NOT hit backend

Test 5: Submit valid event
→ Type: "user.signup"
→ Payload: {"userId": "u1"}
→ Should show "Event accepted — jobId: 123" (green banner)
→ Form clears
→ New row appears in table below
```

---

### ✓ Events Page — Form Error States

**Rate Limit (429):**
```bash
1. Rapid-fire submit 105 events (button spam or curl loop)
2. Around event 101-105 → "Rate limited. Try again in 60 seconds"
3. Form remains visible (not cleared)
4. Can retry after 60 seconds
```

**Invalid API Key (401):**
```bash
1. Go to /api-keys
2. Enter wrong key → "Use this key" → "Test key"
3. Return to /events → Submit event
4. Should show "Invalid API key — check your key in API Keys settings"
5. Linked to /api-keys page
```

**Backend Validation (400):**
```bash
1. Submit with backend validation error (e.g., type too long)
2. Should show error details per field from backend
3. Example: "Validation failed" with "type: ['Must be < 100 chars']"
```

---

### ✓ Events Page — Table

**List Rendering:**
```bash
1. Table shows all events (max 50, newest first)
2. Columns: Job ID, Event Type, Status, Correlation ID, Duration, Received
3. Job ID: green color, monospace
4. Status: Badge component with color (pending=gray, processing=amber with pulsing dot, completed=green, failed=red)
5. Correlation ID: first 12 chars + "..." with full value on hover
6. Duration: "1,897ms" format or "—" if null
7. Received: locale string date-time

Table auto-refreshes every 10 seconds.
Manual "Refresh" button forces immediate fetch.
```

---

### ✓ Events Page — Row Expansion

**Click a row to expand:**
```bash
1. Row expands downward
2. Shows: Payload (JSON), Idempotency Key, Error (if any)
3. Payload fetched via api.events.get(jobId) ← detail endpoint
4. Loading indicator while fetching
5. Click again to collapse
```

**Correlation ID Copy:**
```bash
1. Click the correlation ID text
2. Text changes to "Copied!" for 2 seconds
3. Value now in clipboard
4. Can paste into /docs → search logs section
```

---

### ✓ Events Page — Live Polling

**Tracked Jobs (orange pulsing dot):**
```bash
1. Submit an event from the form
2. New row appears immediately with pulsing orange dot
3. Status shows "pending"
4. Within 1-2 seconds, status changes to "processing" (still pulsing)
5. Within 2-3 seconds total, status changes to "completed" (dot stops pulsing)
6. Pulsing stops when status reaches completed/failed
7. Full events list auto-refreshes after job becomes terminal
```

---

### ✓ API Keys Page

**localStorage Integration:**
```bash
1. Open /api-keys
2. Input shows: NEXT_PUBLIC_DEMO_API_KEY from env (if set)
3. Modify input → click "Save key"
4. See "✓ Key saved locally..."
5. Refresh page → input still shows the saved key
6. Open DevTools → localStorage.getItem('eventflow_api_key') returns saved value
```

**Test Key Button:**
```bash
1. Valid demo key → "✓ Key valid — tenantId: tenant-demo (X events found)"
2. Invalid key → "✗ Invalid key or backend unavailable"
3. No key → "✗ Invalid key..."
```

**Reset to Demo:**
```bash
1. Enter custom key → "Save key"
2. Click "Reset to demo key"
3. Input resets to NEXT_PUBLIC_DEMO_API_KEY
4. localStorage cleared
5. "Test key" → should pass
```

**Admin Creation Example:**
```bash
1. Scroll to "Admin: Create Tenant" section
2. Shows curl example with syntax highlighting
3. Can see admin endpoint path and header requirements
```

---

### ✓ Docs Page

**Architecture Diagram:**
```bash
1. Shows ASCII diagram in monospace, bordered
2. Includes: Client → Middleware → Queue → Worker → outputs
3. Visible in <pre> tag
```

**API Reference:**
```bash
1. Lists all 6 endpoints:
   - GET /api/v1/health
   - GET /api/v1/metrics/json
   - GET /api/v1/events
   - GET /api/v1/events/:jobId
   - POST /api/v1/events
   - POST /api/v1/admin/tenants
```

**Correlation ID Explanation:**
```bash
1. Explains how to use correlation ID for tracing
2. Shows grep example with docker logs
3. Mentions end-to-end visibility
```

**External Links:**
```bash
1. Grafana link → http://localhost:4000 (opens in new tab)
2. Prometheus link → http://localhost:9090 (opens in new tab)
3. All have target="_blank" rel="noopener noreferrer"
```

---

## End-to-End Workflow Test

### Test 1: Dashboard → Events → Dashboard Loop

```bash
1. Open http://localhost:3001 → Dashboard loads with stat cards
2. Note "Events accepted" value (e.g., 10)
3. Click "Events" → /events page
4. Submit event: type="test.flow", payload={"step":"1"}
5. See "Event accepted — jobId: 42" (green)
6. See new row with status "pending" + orange pulsing dot
7. After 2-3 seconds, status becomes "completed"
8. Click row → expand to see payload {"step":"1"}
9. Copy correlation ID
10. Click "Dashboard" → /
11. "Events accepted" incremented to 11
12. Throughput chart shows point with accepted+1, completed+1
```

### Test 2: Idempotency in UI

```bash
1. Generate UUID: uuidgen (or use any UUID v4)
2. Submit event with idempotencyKey: [UUID]
3. See "Event accepted — jobId: 42"
4. Submit exact same request again
5. See "Duplicate request — existing jobId: 42" (amber)
6. Table still shows only 1 row for jobId 42
7. No new row created
```

### Test 3: Error Path Visibility

```bash
1. /events → enter type="fail.test", payload={"x": 1}
2. Submit → see pulsing dot, status "pending"
3. After processing, watch status become "failed" (red dot stops)
4. Expand row → should see lastError field with reason
5. Back to dashboard → "Jobs failed" incremented
6. Rate limit chart unchanged (wasn't a rate limit error)
```

### Test 4: API Key Rotation

```bash
1. /api-keys → current key shows DEMO_API_KEY
2. "Test key" → ✓ Pass
3. Clear input, paste different key (or type garbage)
4. "Save key"
5. /events → "Test key" → ✗ Fail
6. /events → Submit event → "Invalid API key" error
7. /api-keys → "Reset to demo key"
8. /events → "Test key" → ✓ Pass
9. /events → Submit event → "Event accepted"
```

### Test 5: Correlation ID Tracing

```bash
1. Submit event from /events
2. Copy correlation ID from table
3. Open /docs → read correlation ID section
4. From your machine or container:
   docker logs eventflow_api | grep "[correlation-id]"
   docker logs eventflow_worker | grep "[correlation-id]"
5. See the same ID appears in both logs (proves end-to-end tracing)
```

---

## Docker Verification

After frontend works locally, test in Docker:

```bash
# Rebuild web image
docker compose build web

# Start stack
docker compose up -d

# Verify web container is running
docker compose ps | grep web

# Verify port is exposed
curl -s http://localhost:3001 | head -20

# Test proxy from within web container
docker compose exec web sh
# Inside container:
wget -qO- http://api:3000/api/v1/health | head -20
# Should see JSON response
```

---

## Known Gotchas & Fixes

| Issue | Fix | Verified |
|-------|-----|----------|
| Chart not updating | Make sure polling interval is <5s, buffer pushes new points every 5s | ✓ |
| Status dot not changing | Verify interval is 10s, setInterval cleanup in return statement | ✓ |
| Form clears on duplicate | Intentional — only new events clear form, duplicates don't | ✓ |
| ldempotency key validation | Must be UUID v4 regex: `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i` | ✓ |
| dlq_waiting shows "NaN" | Must `parseInt(workerHealth.checks.dlq_waiting, 10)` first | ✓ |
| Payload shows undefined | Payload only in detail endpoint, not in list response | ✓ |
| Rate limit headers not shown | Captured in response but not displayed by default — can add to UI if needed | ✓ |

---

## Success Criteria

All tests pass when:
- [ ] Sidebar health dot polls correctly (RED/GREEN)
- [ ] Dashboard stat cards show real numbers
- [ ] Throughput chart updates every 5 seconds
- [ ] Events form validates before hitting backend
- [ ] Events table shows submitted events with live status polling
- [ ] Correlation IDs are clickable and copyable
- [ ] Row expansion fetches and displays payload
- [ ] API Keys page persists key to localStorage
- [ ] Docs page has working external links
- [ ] Full workflow: submit event → watch it process → see it in dashboard → trace correlation ID

---

## Time Estimate

- Sidebar + Dashboard: ~2 minutes
- Events form + table: ~5 minutes
- API Keys + Docs: ~1 minute
- **Total: ~8 minutes for full manual verification**

Run through this checklist before declaring the frontend ready for production.
