# EventFlow — Architectural Deep-Dive & Knowledge Base

Everything documented here reflects the actual system built and verified in production.
Use this file for interview preparation — every answer is backed by real implementation.

---

## 1. PROJECT OVERVIEW

**What it is:**
EventFlow is a production-grade event ingestion and async processing system. It accepts events via an authenticated HTTP API, queues them with BullMQ + Redis, processes them in a separate worker process, persists results in PostgreSQL, and delivers notifications via Discord and Resend email — with full observability, distributed tracing, Redis caching, and CI/CD to AWS EC2.

**The core problem it solves:**
Synchronous event processing creates tight coupling between ingestion latency and processing latency. If Discord is slow or the DB is under load, the client waits. EventFlow decouples these: the API acknowledges receipt in <20ms (202 Accepted) regardless of what happens downstream.

**Multi-tenancy model:**
Every API key is scoped to a `tenantId`. All data queries are tenant-scoped — tenants cannot see each other's events. The platform operator provisions tenants via `POST /api/v1/admin/tenants` (protected by a separate `ADMIN_SECRET` header, not a tenant credential). A `seed` service auto-provisions a demo tenant on first `docker compose up`.

---

## 2. ARCHITECTURE

### Request flow (happy path)

```
Client
  │
  ▼
[Correlation ID Middleware]
  reads x-request-id header or generates UUID
  attaches to req.correlationId, sets x-request-id response header
  │
  ▼
[IP Rate Limit]
  Fixed window — Redis INCR + EXPIRE
  200 req/min per IP, checked BEFORE auth
  Fail mode: OPEN (Redis down = allow, don't block all traffic)
  │
  ▼
[Auth Middleware]
  SHA-256 hash of x-api-key header
  Redis cache-aside lookup first (apikey:cache:{hash}, TTL 60s)
  Cache miss → PostgreSQL → populate cache
  Attaches req.apiKeyId and req.tenantId
  Fail mode: CLOSED (Redis error falls through to DB, DB error = 500)
  │
  ▼
[API Key Rate Limit]
  Sliding window — Redis sorted set, 4 commands pipelined
  100 req/min per API key
  Fail mode: CLOSED (Redis down = 503, can't enforce SLA without state)
  │
  ▼
[Validation]
  Zod safeParse on request body
  Returns field-level errors on failure
  │
  ▼
[Idempotency check]
  If idempotencyKey provided: findUnique before enqueue
  Existing record → return existing jobId with duplicate: true
  │
  ▼
[BullMQ enqueue]
  Adds job to Redis-backed queue
  Returns 202 with jobId in <20ms
  │
  ▼ (async, separate process)
[Worker]
  Picks up job from queue
  upsert Event to PostgreSQL (idempotency layer 2)
  Send Discord notification (token bucket throttled, idempotency layer 3)
  Send email via Resend (parallel with Discord, same idempotency lock)
  Update Event status to completed
  On failure: exponential backoff (1s → 2s → 4s), then events-dlq
```

### Why API and Worker are separate processes

- Different failure domains: worker crash does not crash API
- Different scaling shapes: API is latency-bound (horizontal), worker is throughput-bound (vertical)
- CPU-bound or slow I/O in worker (Discord, email) does not starve the API event loop
- Independent restart: `docker compose restart worker` without touching API

### Why queue instead of synchronous processing

- At-least-once delivery from BullMQ: if worker crashes mid-job, BullMQ detects stalled jobs (every 30s) and re-queues automatically
- Combined with idempotency at three layers, this gives effectively-exactly-once behavior without a distributed transaction
- API throughput is completely decoupled from notification latency (Discord can take 500ms, API still responds in <20ms)

---

## 3. TECH STACK

```
Runtime          Node.js 22, TypeScript 5.4.5 (ESM throughout, "type": "module")
API              Express 4.19.2
Queue            BullMQ 5.x + ioredis 5.x
Database         PostgreSQL 16, Prisma 7.8.0
Cache / Queue    Redis 7 (AOF persistence, --appendonly yes)
Validation       Zod 3.x
Logging          Pino (structured JSON in prod, pino-pretty in dev)
Metrics          prom-client 15.x (Prometheus exposition format)
API Docs         OpenAPI 3.0 — swagger-jsdoc + swagger-ui-express
Notifications    Discord webhook, Resend API (fetch, no SDK)
Monorepo         npm workspaces (app/*, packages/*)
Containers       Docker (multi-stage builds) + Docker Compose
Observability    Prometheus + Grafana + node-exporter
CI/CD            GitHub Actions → Docker Hub → AWS EC2
Infra as Code    Terraform (EC2, security group, Elastic IP, S3 state backend)
Dev runner       tsx watch (replaces ts-node-dev)
```

---

## 4. MONOREPO STRUCTURE

```
3-eventFlow/
├── app/
│   ├── api/                         Express HTTP server (producer)
│   │   └── src/
│   │       ├── config/
│   │       │   ├── queue.ts          BullMQ Queue instance
│   │       │   ├── redis.ts          Redis connections (general + queue, separate per concern)
│   │       │   └── swagger.ts        OpenAPI 3.0 spec definition
│   │       ├── middleware/
│   │       │   ├── correlationId.ts  x-request-id generation/propagation
│   │       │   ├── auth.ts           API key auth + Redis cache-aside (with negative caching)
│   │       │   ├── adminAuth.ts      x-admin-secret middleware for operator routes
│   │       │   ├── apikeyRateLimit.ts sliding window per API key
│   │       │   ├── ipRateLimit.ts    fixed window per IP
│   │       │   └── validate.ts       Zod schema validation
│   │       ├── routes/
│   │       │   ├── events.route.ts   POST/GET /events, GET /events/:jobId
│   │       │   ├── admin.route.ts    POST /admin/tenants
│   │       │   ├── health.route.ts   GET /health
│   │       │   └── metrics.route.ts  GET /metrics (Prometheus), GET /metrics/json
│   │       ├── types/express.d.ts    Express Request extensions (apiKeyId, tenantId, correlationId, validatedEvent)
│   │       └── index.ts              Express setup, middleware chain, swagger mount
│   │
│   └── worker/                       BullMQ consumer (separate process)
│       └── src/
│           ├── processor.ts          job logic: upsert DB → notify → complete
│           ├── notifications.ts      Discord + email, insert-first idempotency lock
│           ├── dlqReplay.ts          manual DLQ replay script (10/batch, 2s gap)
│           ├── metricsServer.ts      HTTP server on :9091 serving /metrics + /health
│           └── index.ts              Worker, QueueEvents, DLQ handler, graceful shutdown
│
├── packages/
│   ├── db/
│   │   ├── prisma/
│   │   │   ├── schema.prisma         Event, ApiKey, NotificationLog models
│   │   │   └── migrations/           versioned SQL migrations
│   │   └── src/
│   │       ├── client.ts             PrismaClient singleton
│   │       ├── seed.ts               demo tenant provisioning (idempotent)
│   │       └── index.ts
│   │
│   └── shared/
│       └── src/
│           ├── lib/
│           │   ├── apiKey.ts         hashApiKey(raw) → SHA-256 hex
│           │   ├── logger.ts         createLogger(service) → pino instance
│           │   └── metrics.ts        Metrics class: prom-client counters/gauges/registry
│           └── types/
│               ├── queue.ts          QUEUE_NAME, EventJob interface (includes correlationId)
│               └── schema.ts         Zod EventSchema
│
├── grafana/provisioning/
│   ├── dashboards/
│   │   ├── dashboard.yml             tells Grafana to scan this directory for JSON files
│   │   └── eventflow.json            pre-built dashboard (8 panels, 4 sections)
│   └── datasources/
│       └── prometheus.yml            Prometheus datasource with uid: prometheus
│
├── .github/workflows/
│   └── ci-cd.yml                     full CI + CD pipeline
│
├── infra/
│   ├── main.tf                       EC2, security group, Elastic IP
│   ├── variables.tf                  aws_region, instance_type, key_name
│   ├── output.tf                     public_ip output
│   ├── provider.tf                   AWS provider + S3 backend for state
│   └── user_data.sh                  Docker install on first EC2 boot
│
├── docker-compose.yml                local dev (8 services, builds from source)
├── docker-compose.prod.yml           production (pulls pre-built images from Docker Hub)
├── prometheus.yml                    scrape configs for api, worker, node-exporter
└── .env.example
```

---

## 5. PRISMA SCHEMA (key models)

```prisma
model Event {
  id                   String      @id @default(uuid())
  jobId                String      @unique @map("job_id")
  idempotencyKey       String?     @unique @map("idempotency_key")
  tenantId             String      @map("tenant_id")
  eventType            String      @map("event_type")
  payload              Json
  status               EventStatus
  errorMessage         String?     @map("error_message")
  attemptCount         Int         @default(0) @map("attempt_count")
  lastError            String?     @map("last_error")
  correlationId        String?     @map("correlation_id")   ← added for distributed tracing
  receivedAt           DateTime    @map("received_at")
  processedAt          DateTime?   @map("processed_at")
  processingDurationMs Int?        @map("processing_duration_ms")
  createdAt            DateTime

  @@index([tenantId])
  @@index([status])
  @@index([eventType])
  @@index([receivedAt])
  @@index([idempotencyKey])
  @@index([correlationId])   ← indexed so grep-by-correlationId queries are fast
  @@map("events")
}

model ApiKey {
  id        String   @id @default(uuid())
  keyHash   String   @unique @map("key_hash")   ← SHA-256 of raw key, never plaintext
  tenantId  String   @map("tenant_id")
  active    Boolean  @default(true)
  createdAt DateTime @default(now()) @map("created_at")
  @@map("api_keys")
}

model NotificationLog {
  id             String   @id @default(uuid())
  idempotencyKey String   @unique @map("idempotency_key")  ← mutex for dedup
  channel        String
  sentAt         DateTime @default(now()) @map("sent_at")
  @@map("notification_log")
}
```

---

## 6. API ENDPOINTS (all verified)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /api/v1/events | x-api-key | Submit event for async processing |
| GET | /api/v1/events | x-api-key | List last 50 events (tenant-scoped, 5s cache) |
| GET | /api/v1/events/:jobId | x-api-key | Single event detail with payload |
| POST | /api/v1/admin/tenants | x-admin-secret | Provision tenant + API key |
| GET | /api/v1/health | none | Live dependency status (postgres + redis) |
| GET | /api/v1/metrics | none | Prometheus exposition format |
| GET | /api/v1/metrics/json | none | Same metrics as JSON |
| GET | /api/v1/docs | none | Swagger UI (interactive API docs) |
| GET | /api/v1/docs/spec | none | Raw OpenAPI 3.0 JSON spec |

**Swagger UI:** `http://localhost:3000/api/v1/docs` — paste API key in Authorize button, use "Try it out" to send real requests from the browser. Spec is generated at runtime from `@openapi` JSDoc annotations co-located with route handlers.

---

## 7. RATE LIMITING — THREE ALGORITHMS

### Algorithm 1: Fixed Window (IP protection)

```
Redis key:    ipRatelimit:ip:{ip}
Commands:     INCR + EXPIRE (2 round trips, or 1 if pipelined)
Memory:       O(1) per IP
Limit:        200 req/min per IP
Fail mode:    OPEN — Redis down = allow all (never block traffic for an infrastructure failure)
When checked: BEFORE auth middleware — cheap early rejection of unauthenticated floods
```

### Algorithm 2: Sliding Window (per API key)

```
Redis key:    ratelimit:apikey:{apiKeyId}
Structure:    Sorted set (score = timestamp ms, member = uuid)
Commands:     ZREMRANGEBYSCORE + ZADD + ZCARD + EXPIRE (4 commands, pipelined in 1 round trip)
Memory:       O(requests in window) per key
Limit:        100 req/min per key
Fail mode:    CLOSED — Redis down = 503 (can't enforce SLA without shared state)
When checked: AFTER auth (needs apiKeyId to build the key)

Why sliding over fixed:
  Fixed window resets at minute boundaries — a client can send 100 req at 0:59
  and 100 more at 1:01 (200 in 2 seconds). Sliding window prevents this by
  always checking the last 60 seconds regardless of clock boundaries.
```

### Algorithm 3: Token Bucket (outbound Discord throttle)

```
Redis key:    ratelimit:discord:outbound
Structure:    Hash (tokens, last_refill timestamp)
Algorithm:    Lua script (atomic read-calculate-write — cannot be interrupted)
Capacity:     30 tokens
Refill rate:  0.5 tokens/second = 30/min
Shared:       YES — all worker instances share one Redis key
Fail mode:    CLOSED — BullMQ retries the job

Why Lua:
  Read-calculate-write must be atomic. Without Lua, two workers reading
  tokens=1 simultaneously both see "1 available" and both send — double spend.
  Lua scripts run atomically in Redis; nothing can interleave between read and write.

Why token bucket for Discord (not sliding window):
  Token bucket allows bursting — if workers are idle for 2 minutes, they bank
  60 tokens and can send a burst legitimately. Sliding window would cap at 30/min
  regardless of idle time. Discord's actual limit allows bursting, so token bucket
  is the more accurate model.
```

---

## 8. CACHING — CACHE-ASIDE PATTERN

Both caches use the `api:general` Redis connection (separate from queue connection — "separate connection per concern" pattern).

### Cache 1: API Key Auth (`apikey:cache:{sha256(key)}`, TTL 60s)

```
On every authenticated request:

1. Check Redis: GET apikey:cache:{hash}
   HIT  → parse JSON → check active field
          active=true  → attach apiKeyId + tenantId → next()
          active=false → return 401 (cached revocation, no DB call)
   MISS → query PostgreSQL
          found + active   → cache {apiKeyId, tenantId, active:true} → proceed
          found + inactive → cache {apiKeyId, tenantId, active:false} → 401
          not found        → do NOT cache (don't bloat Redis with garbage keys) → 401
```

**Negative caching explained:**
Caching `{active: false}` prevents a misbehaving client with a revoked key from hitting Postgres on every retry forever. Without it, every "is this key valid" check for a revoked key costs a DB round-trip — indefinitely. The 401 response is identical either way; only the data source changes.

**Tradeoff:** Revoked keys stay valid up to 60s. This is a documented acceptable tradeoff.

### Cache 2: Event List (`events:list:{tenantId}`, TTL 5s)

TTL-based expiry, no manual invalidation. The query being cached (50 rows, ORDER BY receivedAt DESC, tenant-scoped) is the most expensive read in the system. A 5-second-stale list is normal UX for a dashboard (equivalent to an email inbox that doesn't refresh instantly).

**Why TTL over invalidate-on-write:**
Invalidation-on-write requires the writer (worker process, different from the API) to know about and bust the API's cache. This creates cross-process coupling. TTL expiry is simpler, self-healing, and avoids missed invalidations when new write paths are added.

**Deliberately NOT cached:**

- `GET /events/:jobId` — single row by unique index, already <1ms, caching adds invalidation complexity for zero gain
- `GET /health` — must always reflect live state; cached health = masked outages = load balancer sending traffic to a dead instance

---

## 9. CORRELATION IDs / DISTRIBUTED TRACING

### The problem

With API and worker running as separate processes, and 50+ concurrent requests in flight simultaneously, log lines from both processes are interleaved with no way to associate a specific API request with its corresponding worker job.

### The implementation

```
Client sends x-request-id header (or omits it)
  │
  ▼
correlationId middleware (runs first, before all other middleware)
  → read x-request-id from incoming header
  → if missing: generate UUID v4
  → attach to req.correlationId
  → set x-request-id on response header (client can log this)
  │
  ▼
Every API log line includes correlationId:
  {"service":"api:events","correlationId":"trace-001","msg":"request completed"}
  │
  ▼
POST /events passes correlationId into BullMQ job data:
  eventQueue.add("process-event", { ...data, correlationId: req.correlationId })
  │
  ▼ (async, worker process)
Worker reads correlationId from job.data:
  const log = logger.child({ jobId, tenantId, correlationId })
  → every log.info/error/warn automatically includes correlationId
  │
  ▼
Worker upsert includes correlationId:
  prisma.event.upsert({ create: { ..., correlationId } })
  → stored in DB, indexed, queryable
  │
  ▼
DLQ entries preserve correlationId via originalJob: job.data
```

### Verification

```bash
curl -s -X POST $BASE/events \
  -H "x-api-key: $API_KEY" \
  -H "x-request-id: trace-demo-001" \
  -d '{"type":"test","payload":{"x":1}}' | jq

# response header includes: x-request-id: trace-demo-001
# DB record has: correlationId = "trace-demo-001"
# API logs have: correlationId = "trace-demo-001"
# Worker logs have: correlationId = "trace-demo-001"

# Reconstruct full request lifecycle:
docker compose logs api | grep trace-demo-001
docker compose logs worker | grep trace-demo-001
```

---

## 10. RELIABILITY: IDEMPOTENCY, RETRIES, DLQ

### Idempotency — three layers

**Why three layers?**
BullMQ guarantees at-least-once delivery — a job can be delivered more than once (stalled job re-queue, AOF replay on Redis restart). Each layer handles a different failure scenario:

**Layer 1 — API (client-controlled):**
Client sends `idempotencyKey` (UUID v4). Before enqueuing, `findUnique` checks if this key exists. If yes, return existing `jobId` with `duplicate: true`. If two concurrent requests race with the same key (both pass the check before either writes), the second one will trigger a `P2002` unique constraint violation on insert, which is caught in the catch block and resolved to the winner's `jobId`.

**Layer 2 — DB Write (worker-controlled):**
Worker does `prisma.event.upsert` on `idempotencyKey`. If BullMQ delivers the same job twice, the second delivery finds the existing row and updates status (not duplicate row). Falls back to `job-{jobId}` if no idempotencyKey was supplied.

**Layer 3 — Notifications (notification_log mutex):**
Before sending Discord/email, worker inserts a row into `notification_log` with a unique `idempotencyKey`. If insert succeeds → send notification. If `P2002` (row already exists, meaning notification was already sent) → skip send silently. Discord and email use separate lock keys (`discord-{key}`, `email-{key}`) and run in parallel via `Promise.all`.

**Write-ahead pattern:** The notification lock is inserted BEFORE the actual send. If the send fails, the lock does not exist — next retry will try again. If the send succeeds and then the lock insert fails (theoretically impossible since insert is first), the unique constraint prevents a duplicate lock on retry. This is the correct ordering.

### Retry strategy

```
attempts: 3
backoff: exponential
delays: ~1s → ~2s → ~4s (with jitter 0.5)
after 3 failures: move to events-dlq
```

### DLQ

```
Queue: events-dlq
Contents: { originalJob, failedReason, failedAt, attemptsMade }
Monitor: curl -s http://localhost:9091/health | jq '.checks.dlq_waiting'
Replay: docker compose exec worker node app/worker/dist/dlqReplay.js
Strategy: 10 jobs/batch, 2s between batches (prevents thundering herd on DB)
```

### Stalled job detection

BullMQ QueueEvents checks every 30s for jobs stuck in `active` state. Worker crash mid-job → stalled → auto re-queued. The `stalled` event is logged with the jobId for observability. Idempotency at the DB layer handles the duplicate delivery safely.

### Graceful shutdown

```
SIGTERM received
  → metricsServer.close()
  → worker.close()            drains in-flight jobs
  → queueEvents.close()
  → dlqQueue.close()
  → workerConnection.quit()
  → eventConnection.quit()
  → dlqConnection.quit()
  → prisma.$disconnect()
  → process.exitCode = 0
```

---

## 11. OBSERVABILITY STACK

### Structured logging (Pino)

- JSON format in production, pino-pretty in development
- Every logger created via `createLogger(service)` — service name on every line
- Request logs: `method, path, status, duration, apiKeyId, tenantId, correlationId`
- Job logs: child logger with `jobId, tenantId, correlationId` bound automatically
- `LOG_LEVEL` env var controls verbosity: `debug | info | warn | error | fatal`

### Prometheus metrics (prom-client)

Two separate registries (API on :3000/api/v1/metrics, Worker on :9091/metrics).
Default Node.js metrics collected with `eventflow_` prefix:

- heap size used/total, GC duration (histogram), event loop lag (p50/p90/p99), active handles

Custom counters defined in `packages/shared/src/lib/metrics.ts`:

```
auth_success_total, auth_missing_key_total, auth_invalid_key_total, auth_error_total
auth_cache_hit_total, auth_cache_miss_total
ratelimit_ip_allowed_total, ratelimit_ip_rejected_total, ratelimit_ip_error_total
ratelimit_apikey_allowed_total, ratelimit_apikey_rejected_total, ratelimit_apikey_error_total
events_accepted_total, events_duplicate_total, events_enqueue_error_total
events_list_cache_hit_total, events_list_cache_miss_total
jobs_started_total, jobs_completed_total, jobs_failed_total
notifications_discord_sent_total, notifications_discord_failed_total
notifications_email_sent_total, notifications_email_failed_total
notifications_skipped_total
dlq_jobs_added_total, dlq_jobs_failed_to_add_total, dlq_job_replayed_total
postgres_down_total, redis_down_total
admin_auth_failed, admin_tenant_created
eventflow_http_requests_total (labels: method, path, status)
```

**HTTP request tracking fix:** `trackRequest` is called inside `res.on("finish")` so `res.statusCode` reflects the actual response status (not always 200 as it would be if called before `next()`).

### Grafana dashboard

Auto-provisioned at startup from `grafana/provisioning/dashboards/eventflow.json`. No manual setup. 8 panels:

- Throughput: events accepted rate, jobs completed vs failed
- Rate Limiting & Auth: rate limit rejections, auth failures
- System Health: event loop lag (API + worker), heap usage (API + worker)
- DLQ: DLQ inflow rate, total DLQ jobs (stat panel with thresholds)

Datasource provisioned from `grafana/provisioning/datasources/prometheus.yml` with `uid: prometheus` — matching the UID referenced in dashboard panel queries.

### node-exporter (production only)

Added to `docker-compose.prod.yml` only. Exposes host-level metrics on :9100 — CPU, memory, disk, network. Scraped by Prometheus via `prometheus.yml`. Not in local dev (monitoring your laptop is not useful for the project story).

### OpenAPI 3.0 / Swagger UI

Interactive docs at `/api/v1/docs`. Generated at runtime from `@openapi` JSDoc annotations on each route handler (in same file as the implementation — spec cannot drift from code without changing both in the same commit). Raw spec at `/api/v1/docs/spec` for Postman import.

---

## 12. LOAD TESTING RESULTS (autocannon)

### What autocannon measures vs curl loops

A `for` loop of curl commands is sequential — one request at a time, each waiting for the previous response. Autocannon opens N TCP connections simultaneously and fires requests on all of them concurrently — creating real contention on Redis, DB connection pools, and Node.js event loop. This is what real traffic looks like.

### Test 1 — Rate limiter under 20 concurrent connections

```
Command: npx autocannon -c 20 -d 10 -H "x-api-key: $API_KEY" $BASE/events
Result:  p50 1ms | p99 5ms | max 46ms | avg 10,535 req/s | 0 errors
         97 × 2xx, 105,257 × 429
```

Proves: sliding window rate limiter correctly rejects excess traffic under real concurrency with zero connection drops or crashes.

### Test 2 — 30 concurrent connections

```
Command: npx autocannon -c 30 -d 10 -H "x-api-key: $API_KEY" $BASE/events
Result:  p50 2ms | p99 6ms | avg 10,739 req/s | 0 errors
         0 × 2xx, 107,383 × 429
```

Observation: median latency doubled from 1ms to 2ms going from 20 to 30 connections. This is the measurable cost of Redis sorted-set contention under higher concurrency.

### Test 3 — Idempotency race condition

```
Command: npx autocannon -c 10 -d 1 -m POST (same idempotencyKey across all connections)
Result:  p50 1ms | p99 7ms | 100 × 2xx, 6,232 × 429 | 0 errors
         DB verification: exactly 1 row for that idempotencyKey
```

Proves: P2002 unique constraint race handling works correctly — 10 concurrent connections with the same key produce exactly one DB row.

### What p50/p99 mean

```
p50 (median) — half of all requests completed faster than this value
               represents the "typical" user experience

p99           — 99% of requests completed faster than this value
               represents the worst 1% of users' experience
               this is the number production engineers monitor
               (average hides tail latency; p99 exposes it)
```

---

## 13. CI/CD PIPELINE

### File: `.github/workflows/ci-cd.yml`

**Triggers:**

- `push` to main → full CI + CD
- `pull_request` to main → CI only (CD steps have `if: github.ref == 'refs/heads/main' && github.event_name == 'push'` guard)

**Why the condition check is needed:**
The same workflow file runs on both push and pull_request events. Without the condition, a PR from `feature-branch → main` would trigger a production deployment of unmerged code. The condition ensures CD only runs on actual merges to main.

**CI steps (all events):**

```
1. actions/checkout@v4
2. actions/setup-node@v4 (Node 22, npm cache)
3. npm ci
4. npm run build -w @eventflow/shared
5. npm run build -w @eventflow/db
6. npm run build -w @eventflow/api
7. npm run build -w @eventflow/worker
   (order enforced — shared + db must build before api + worker import from them)
8. docker build -t eventflow-api:ci ./app/api
9. docker build -t eventflow-worker:ci ./app/worker
10. cp .env.example .env
11. docker compose up -d postgres redis && sleep 10
12. docker compose run --rm migrate
13. docker compose up -d api worker && sleep 10
14. curl --fail http://localhost:3000/api/v1/health
15. docker compose down -v
```

**CD steps (push to main only):**

```
16. docker/login-action@v3 (DockerHub credentials from Secrets)
17. Build + push API image:
    - tag: {DOCKERHUB_USERNAME}/eventflow-api:latest
    - tag: {DOCKERHUB_USERNAME}/eventflow-api:{git-sha}    ← enables exact rollback
18. Build + push Worker image (same dual-tag pattern)
19. appleboy/scp-action — copy docker-compose.prod.yml + grafana/ + prometheus.yml to EC2
20. appleboy/ssh-action — write .env from GitHub Secrets, then:
    docker compose -f docker-compose.prod.yml pull
    docker compose -f docker-compose.prod.yml up -d --remove-orphans
    curl --fail http://localhost:3000/api/v1/health || exit 1
```

**GitHub Secrets required:**

```
DOCKERHUB_USERNAME, DOCKERHUB_TOKEN
EC2_HOST (Elastic IP from terraform output)
EC2_SSH_KEY (contents of .pem file)
POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
DATABASE_URL, REDIS_URL (redis://redis:6379 for Docker internal)
ADMIN_SECRET, DISCORD_WEBHOOK_URL, RESEND_API_KEY, NOTIFICATION_EMAIL
GRAFANA_PASSWORD
```

---

## 14. TERRAFORM INFRASTRUCTURE

### Files

```
infra/
├── provider.tf    AWS provider + S3 backend for state storage
├── main.tf        EC2 instance, security group, Elastic IP
├── variables.tf   aws_region (ap-south-1), instance_type (t3.micro), key_name
├── output.tf      public_ip → displayed after terraform apply
└── user_data.sh   runs on EC2 first boot: installs Docker + Compose, creates /app
```

### State backend (S3)

```hcl
backend "s3" {
  bucket = "eventflow-terraform-state"
  key    = "prod/terraform.tfstate"
  region = "ap-south-1"
}
```

`backend "s3"` is not a `resource` block — it's special Terraform syntax inside the `terraform {}` block specifying WHERE Terraform stores its own state file. The S3 bucket must be created manually once (`aws s3 mb s3://eventflow-terraform-state --region ap-south-1`) before `terraform init`. Terraform will NOT create its own state bucket.

**Why remote state:** if `terraform.tfstate` lived in the repo, it would expose infrastructure details in plaintext, break when multiple people run `terraform apply`, and risk losing state on disk failure. S3 backend centralizes it securely.

### Workflow

```bash
cd infra
terraform init      # download AWS provider, configure S3 backend
terraform plan      # preview what will be created
terraform apply     # create EC2, security group, Elastic IP
                    # outputs the public IP
terraform destroy   # delete everything in ~2 minutes
terraform apply     # recreate identically in ~3 minutes
```

### Security group rules

```
Inbound:  22 (SSH), 3000 (API), 4000 (Grafana), 9090 (Prometheus)
Outbound: all (required for Docker Hub pulls, package installs)
```

Note: SSH port 22 should be restricted to your own IP in production. Currently open to 0.0.0.0/0 for demo convenience.

### docker-compose.prod.yml differences from docker-compose.yml

```
dev (docker-compose.yml):
  - builds images from source (build: context: .)
  - includes seed service for demo key provisioning
  - no node-exporter (monitoring your laptop isn't useful)

prod (docker-compose.prod.yml):
  - pulls pre-built images from Docker Hub (image: ${DOCKERHUB_USERNAME}/eventflow-api:latest)
  - no seed service (production tenants provisioned via POST /admin/tenants)
  - includes node-exporter for host-level metrics
```

---

## 15. INTERVIEW ANSWERS (real, verified, specific)

### "Why did you separate the API and Worker into different processes?"

Three concrete reasons:

1. **Failure isolation:** worker crash → API still accepts events (they queue up and drain when worker restarts). API crash → worker keeps processing queued jobs. Neither takes down the other.
2. **Scaling shape:** API is latency-bound and scales horizontally (more instances behind a load balancer). Worker is throughput-bound and scales vertically (more concurrency within one instance, or more worker instances reading the same queue). They have different bottlenecks.
3. **Event loop protection:** Discord webhooks can take 200-500ms. Email delivery can take longer. If these ran in the API process, every slow notification would block the event loop and increase API latency for all concurrent requests.

### "What happens if Redis goes down?"

Three different answers depending on which Redis usage:

- **IP rate limiter:** fails OPEN — allows all requests. Redis being down shouldn't block all your users.
- **API key rate limiter:** fails CLOSED — returns 503. Can't enforce per-tenant SLA without shared state. Better to temporarily fail than to silently allow unlimited requests.
- **Auth cache:** falls through to PostgreSQL — the DB is the source of truth, Redis is just an optimization. Slower but correct.
- **BullMQ:** jobs cannot be enqueued or processed. This is a hard failure — the queue IS Redis. AOF persistence (`--appendonly yes`) means jobs survive Redis restarts with zero loss.

### "What is at-least-once delivery and how do you make it safe?"

BullMQ may deliver the same job twice: a worker could crash after processing but before acknowledging, causing BullMQ to re-deliver. "At-least-once" means the job runs at least once, possibly more.

EventFlow makes this safe via idempotency at three layers:

1. API layer: `findUnique` on idempotencyKey prevents duplicate DB rows even if the same event is enqueued twice
2. Worker layer: `prisma.event.upsert` on idempotencyKey — retrying the same job updates the existing row, not a new one
3. Notification layer: `notification_log` insert-first lock prevents duplicate Discord/email sends

At-least-once + idempotent operations = effectively exactly-once behavior, without the complexity of a distributed transaction.

### "How does your rate limiter prevent the boundary exploit?"

Fixed windows reset at clock boundaries — a client can send 100 requests at 12:59:59 and 100 more at 1:00:01 (200 in 2 seconds) because they're in different windows.

The sliding window prevents this: it always checks the last 60 seconds from NOW, not from the start of the current minute. The implementation uses a Redis sorted set (score = timestamp): ZREMRANGEBYSCORE removes expired entries, ZADD adds the current request, ZCARD counts — all pipelined in one round trip. If ZCARD > 100, reject.

### "Why is your auth cache TTL 60 seconds specifically?"

It's a documented tradeoff between performance and security. A revoked key stays valid for up to 60 seconds. This means:

- An attacker who steals and uses a key has a 60-second window after revocation
- Every legitimate authenticated request saves a Postgres round-trip for 60 seconds

60 seconds was chosen because it's short enough that security incidents are contained quickly, and long enough that the cache is genuinely effective (not a 1-second TTL that provides no benefit). In a higher-security system, you'd lower this or implement a pub/sub cache invalidation mechanism via Redis.

### "A latency spike happened for 5 minutes then recovered. What could cause this?"

How to investigate (in order):

1. Check GC metrics: `eventflow_nodejs_gc_duration_seconds` — was there a major GC event in that window? (Already in your Prometheus data)
2. Check DB connections: were queries queueing waiting for a free connection pool slot? (`workers × concurrency × queries_per_job < max_connections`)
3. Check downstream: did Discord/Resend API have a slow window? (Check notification counters vs duration)
4. Check Redis: was there an AOF flush or eviction event? (Cache miss rate would spike)
5. Use correlation IDs: pull sample requests from that window, grep logs to see exactly where time was spent

This is precisely what the observability stack is for — if Prometheus was scraping during the incident, you have the data to answer this without guessing.

### "How would you scale this to 10x traffic?"

Current bottlenecks in order:

1. **Single Postgres instance** — read replicas for `GET /events` queries, connection pool tuning
2. **Single Redis instance** — Redis Cluster for the rate limiter sorted sets (they're the most write-heavy)
3. **Single worker process** — scale worker horizontally (BullMQ is designed for multiple consumers on the same queue — idempotency already handles duplicate delivery)
4. **Single EC2 instance** — add a load balancer (ALB) in front of multiple API instances; Terraform makes this a config change
5. **Auth cache TTL** — if Postgres is still a bottleneck, increase TTL or add a read replica specifically for key lookups

The architecture was deliberately designed so each of these is an independent scaling decision — not a redesign.

---

## 16. KNOWN LIMITATIONS (deliberate scope decisions)

| Limitation | Why it's acceptable | What a production system would do |
|---|---|---|
| Tenant signup flow absent | Data model supports it; provisioning is operator-driven | Signup UI → POST /admin/tenants internally |
| Revoked key valid up to 60s | Documented tradeoff for cache performance | Lower TTL or Redis pub/sub invalidation |
| Single EC2 instance | Demonstrates architecture; API/worker separation enables scaling | ALB + ECS or K8s for horizontal scale |
| No Loki | Structured JSON logs are ready for Loki | Add Loki + Promtail to complete metrics+logs+traces |
| No alerting rules | Grafana dashboard shows data | Prometheus Alertmanager + PagerDuty/Slack integration |
| No end-to-end tests | Smoke test in CI validates startup | Add contract tests (Pact) or integration test suite |
