# EventFlow

A production-grade event ingestion and async processing system. Accepts events via an HTTP API, queues them with BullMQ + Redis, processes them in a separate worker process, persists them in PostgreSQL, and delivers notifications via Discord and email — with full observability (Prometheus + Grafana), distributed tracing (correlation IDs), Redis caching, and a CI/CD pipeline to AWS EC2.

---

## Table of Contents

- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Quickstart (Local)](#quickstart-local)
- [API Reference](#api-reference)
- [API Documentation (Swagger)](#api-documentation-swagger)
- [Admin: Provisioning Tenants](#admin-provisioning-tenants)
- [Rate Limiting](#rate-limiting)
- [Caching](#caching)
- [Correlation IDs / Distributed Tracing](#correlation-ids--distributed-tracing)
- [Reliability: Idempotency, Retries, DLQ](#reliability-idempotency-retries-dlq)
- [Observability: Logs, Metrics, Dashboards](#observability-logs-metrics-dashboards)
- [Load Testing Results](#load-testing-results)
- [CI/CD Pipeline](#cicd-pipeline)
- [Production Deployment (AWS)](#production-deployment-aws)
- [Environment Variables](#environment-variables)
- [Known Limitations and Design Decisions](#known-limitations-and-design-decisions)

---

## Architecture

```
Client
  │
  ▼
[Correlation ID Middleware]   reads/generates x-request-id, threads through API → Worker → DB
  │
  ▼
[IP Rate Limit]                Fixed window — blocks unauthenticated floods, fails OPEN
  │
  ▼
[Auth Middleware]              API key → tenantId, Redis-cached (cache-aside, 60s TTL)
  │
  ▼
[API Key Rate Limit]           Sliding window — per-tenant SLA, fails CLOSED
  │
  ▼
[Validation]                   Zod schema — rejects malformed payloads
  │
  ▼
[BullMQ Queue]  ◄── Redis-backed, decouples ingestion from processing
  │
  ▼
[Worker — separate process]
  │
  ├─▶ [PostgreSQL]             upsert on idempotencyKey, stores correlationId
  │
  ├─▶ [Discord]                token-bucket throttled, insert-first idempotency lock
  │
  └─▶ [Resend Email]           same idempotency lock, parallel with Discord
  │
  └─▶ [events-dlq]             after 3 retries with exponential backoff
```

**Why API and Worker are separate processes:** different failure domains and different scaling shapes. The API is latency-bound (returns 202 in milliseconds regardless of downstream work); the worker is throughput-bound. A slow Discord webhook or a CPU-heavy job in the worker never blocks the API event loop.

**Why a queue instead of synchronous processing:** at-least-once delivery from BullMQ, combined with idempotency at three layers (API, DB upsert, notification insert-lock), gives effectively-exactly-once behavior without a distributed transaction.

---

## Tech Stack

```
Runtime          Node.js 22, TypeScript 5.4.5 (ESM throughout)
API              Express 4.19.2
Queue            BullMQ 5.x + ioredis
Database         PostgreSQL 16, Prisma 7.8.0
Cache / Queue    Redis 7 (AOF persistence)
Validation       Zod 3.x
Logging          Pino (structured JSON, pretty in dev)
Metrics          prom-client (Prometheus exposition format)
API Docs         OpenAPI 3.0 / Swagger UI (swagger-jsdoc + swagger-ui-express)
Notifications    Discord webhook, Resend (email)
Monorepo         npm workspaces
Containers       Docker (multi-stage builds) + Docker Compose
Observability    Prometheus + Grafana + node-exporter
CI/CD            GitHub Actions → Docker Hub → AWS EC2 (Terraform-provisioned)
```

---

## Project Structure

```
eventflow/
├── app/
│   ├── api/                        Express HTTP server (producer)
│   │   └── src/
│   │       ├── config/
│   │       │   ├── queue.ts        BullMQ producer queue
│   │       │   ├── redis.ts        Redis connections (general + queue)
│   │       │   └── swagger.ts      OpenAPI 3.0 spec definition
│   │       ├── middleware/
│   │       │   ├── correlationId.ts   x-request-id generation/propagation
│   │       │   ├── auth.ts            API key auth + Redis cache-aside
│   │       │   ├── adminAuth.ts       admin-secret protected routes
│   │       │   ├── apikeyRateLimit.ts sliding window per API key
│   │       │   ├── ipRateLimit.ts     fixed window per IP
│   │       │   └── validate.ts        Zod request validation
│   │       ├── routes/
│   │       │   ├── events.route.ts    POST/GET /events, GET /events/:jobId
│   │       │   ├── admin.route.ts     POST /admin/tenants
│   │       │   ├── health.route.ts    GET /health
│   │       │   └── metrics.route.ts   GET /metrics, /metrics/json
│   │       ├── types/express.d.ts     Request type extensions
│   │       └── index.ts
│   │
│   └── worker/                     BullMQ consumer (separate process)
│       └── src/
│           ├── processor.ts        core job logic: upsert → notify → complete
│           ├── notifications.ts    Discord + email senders, idempotency lock
│           ├── dlqReplay.ts        manual DLQ replay script
│           ├── metricsServer.ts    /metrics + /health on :9091
│           └── index.ts            worker, DLQ handler, graceful shutdown
│
├── packages/
│   ├── db/                          Prisma schema + client
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/
│   │   └── src/
│   │       ├── client.ts            PrismaClient singleton
│   │       ├── seed.ts              demo tenant + API key provisioning
│   │       └── index.ts
│   │
│   └── shared/                      shared across api and worker
│       └── src/
│           ├── lib/
│           │   ├── apiKey.ts         SHA-256 key hashing
│           │   ├── logger.ts         Pino logger factory
│           │   └── metrics.ts        Prometheus counters/gauges
│           └── types/
│               ├── queue.ts          QUEUE_NAME, EventJob interface
│               └── schema.ts         Zod event schema
│
├── grafana/provisioning/             dashboards + datasource, auto-loaded
├── .github/workflows/                CI/CD pipeline
├── infra/                            Terraform — EC2, security group, EIP
├── docker-compose.yml                local dev (builds from source)
├── docker-compose.prod.yml           production (pulls pre-built images)
├── prometheus.yml
└── .env.example
```

---

## Quickstart (Local)

### Prerequisites

- Docker + Docker Compose
- Node.js 22+ and npm (only needed for running migrations from the host, or local dev without Docker)

### 1. Clone and configure

```bash
git clone https://github.com/thissidemayur/eventflow
cd eventflow
cp .env.example .env
```

Generate your own admin secret:

```bash
openssl rand -hex 32   # paste the result into ADMIN_SECRET in .env
```

### 2. Start everything

```bash
docker compose up -d
```

Starts: postgres, redis, migrate (runs once), seed (runs once), api, worker, prometheus, grafana.

### 3. Get your demo API key

```bash
docker compose logs seed
```

The seed service provisions a demo tenant and prints a raw API key — shown only once on first run:

```bash
export API_KEY="ef_live_..."
export BASE="http://localhost:3000/api/v1"
```

If the demo tenant already exists from a previous run, use `POST /api/v1/admin/tenants` to provision a fresh key.

### 4. Send your first event

```bash
curl -s -X POST $BASE/events \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"type":"user.signup","payload":{"userId":"u1","email":"test@test.com"}}' | jq
```

```json
{ "accepted": true, "jobId": "1", "duplicate": false }
```

### 5. Check its status

```bash
curl -s $BASE/events/1 -H "x-api-key: $API_KEY" | jq
```

### 6. Explore

| Service | URL | Credentials |
|---|---|---|
| Grafana dashboard | <http://localhost:4000> | admin / GRAFANA_PASSWORD |
| Prometheus | <http://localhost:9090> | — |
| Swagger UI | <http://localhost:3000/api/v1/docs> | — |
| API metrics | <http://localhost:3000/api/v1/metrics> | — |
| Worker health | <http://localhost:9091/health> | — |

---

## API Reference

All endpoints except `/health`, `/metrics`, `/metrics/json`, `/docs`, and `/admin/*` require:

```
x-api-key: ef_live_...
```

Every response includes `x-request-id` for distributed tracing.

### POST /api/v1/events

```bash
curl -s -X POST $BASE/events \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "type": "user.signup",
    "payload": { "userId": "u_123", "email": "user@example.com" },
    "idempotencyKey": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  }'
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | string | yes | max 100 chars |
| `payload` | object | yes | max 64KB |
| `idempotencyKey` | UUID string | no | enables exactly-once semantics |

**202 — new event:** `{ "accepted": true, "jobId": "42", "duplicate": false }`

**202 — duplicate:** `{ "accepted": false, "jobId": "41", "duplicate": true }`

**400:** `{ "error": "Validation failed", "details": { "type": ["Required"] } }`

**401:** `{ "error": "Missing API key" }` or `{ "error": "Invalid API key" }` — identical message prevents key enumeration

**429:** `{ "error": "Rate limit exceeded", "retryAfter": 60 }`

---

### GET /api/v1/events

Returns the latest 50 events for the caller's tenant, newest first. Served from a 5-second Redis cache.

```bash
curl -s $BASE/events -H "x-api-key: $API_KEY" | jq
```

---

### GET /api/v1/events/:jobId

Returns full event detail including `payload` and `correlationId`. Returns `404` for both "not found" and "belongs to another tenant" — never confirms cross-tenant resource existence.

```bash
curl -s $BASE/events/42 -H "x-api-key: $API_KEY" | jq
```

| `status` | Meaning |
|---|---|
| `pending` | queued |
| `processing` | worker picked it up |
| `completed` | done |
| `failed` | retries exhausted, moved to DLQ |

---

### GET /api/v1/health

No auth required. Used by load balancers and Docker healthchecks.

```bash
curl -s $BASE/health | jq
# { "status": "ok", "checks": { "postgres": "healthy", "redis": "healthy" }, "timestamp": "..." }
```

Returns 503 if either dependency is down.

---

### GET /api/v1/metrics

Prometheus exposition format, scraped every 15s. No auth required (internal network only in production).

`GET /api/v1/metrics/json` returns the same data as JSON.

---

## API Documentation (Swagger)

Interactive API documentation at:

```
http://localhost:3000/api/v1/docs
```

Built with OpenAPI 3.0 using `swagger-jsdoc` + `swagger-ui-express`. The spec is generated at runtime from `@openapi` JSDoc annotations on each route handler — annotations live next to the implementation in the same file, keeping the spec in sync with the code automatically.

Features:

- **Authorize button** — paste your API key once, all "Try it out" requests use it automatically
- **Try it out** — send real HTTP requests to your running API directly from the browser
- **Request duration** — observe cache hit vs miss latency differences live
- **All schemas documented** — EventSummary, EventDetail, ValidationError, UnauthorizedError, RateLimitError

Raw OpenAPI spec (importable into Postman):

```bash
curl -s http://localhost:3000/api/v1/docs/spec | jq '.paths | keys'
# ["/api/v1/admin/tenants", "/api/v1/events", "/api/v1/events/{jobId}",
#  "/api/v1/health", "/api/v1/metrics", "/api/v1/metrics/json"]
```

---

## Admin: Provisioning Tenants

`POST /api/v1/admin/tenants` simulates the platform-side tenant provisioning step that a real signup flow would call.

```bash
curl -s -X POST $BASE/admin/tenants \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"tenantId": "tenant-acme-corp"}' | jq
```

```json
{
  "tenantId": "tenant-acme-corp",
  "apiKeyId": "...",
  "rawAPiKey": "ef_live_...",
  "warning": "Store this key now. It cannot be retrieved again"
}
```

`tenantId` is optional — omit to auto-generate. Protected by `ADMIN_SECRET` (shared operator secret, not stored in the database, not a tenant credential).

---

## Rate Limiting

| Layer | Algorithm | Limit | Scope | Fail mode |
|---|---|---|---|---|
| IP protection | Fixed window (INCR + EXPIRE) | 200/min | per IP | open — Redis down allows |
| API key quota | Sliding window (sorted set, pipelined) | 100/min | per tenant | closed — Redis down returns 503 |
| Discord outbound | Token bucket (Lua script, atomic) | 30/min (0.5/s refill) | shared across all workers | closed — BullMQ retries |

IP limiting runs before auth — cheap rejection of unauthenticated floods. API key limiting runs after auth — enforces per-tenant SLAs using a sliding window (no boundary-reset exploit). The Discord token bucket uses an atomic Lua script so concurrent workers cannot double-spend tokens via a read-then-write race.

429 responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` headers.

---

## Caching

Cache-aside (lazy loading) with Redis for two read paths.

### API key authentication — `apikey:cache:{sha256(key)}`, TTL 60s

```
Request → cache hit?
  yes → use cached {apiKeyId, tenantId, active} — no DB call
  no  → query Postgres
          → key valid?   cache {active: true},  proceed
          → key revoked? cache {active: false}, return 401
          → key unknown? do not cache (avoid bloating Redis with garbage), return 401
```

Negative caching matters: a revoked key cached as `{active: false}` prevents a misbehaving client from hammering Postgres on every retry. The 401 is identical either way — only the source (Redis vs Postgres) changes.

Tradeoff: a revoked key remains valid for up to 60 seconds.

### Event list — `events:list:{tenantId}`, TTL 5s

TTL-based expiry rather than invalidate-on-write — simpler, avoids invalidation bugs, and 5-second-stale list data is normal UX for a dashboard.

Not cached: `GET /events/:jobId` (single-row indexed lookup, already sub-millisecond) and `/health` (must always reflect live dependency state).

Metrics: `auth_cache_hit/miss_total`, `events_list_cache_hit/miss_total`.

---

## Correlation IDs / Distributed Tracing

Every request gets an `x-request-id` — read from the incoming header if supplied, otherwise generated as a UUID. Threaded through the full pipeline:

```
Client sends x-request-id (or API generates one)
  → attached to req.correlationId
  → logged on every API request log line
  → passed into BullMQ job data
  → worker reads it, attaches to pino child logger
    → every worker log line includes correlationId
  → stored on the Event row (indexed)
  → preserved in DLQ entries
```

```bash
curl -s -i -X POST $BASE/events \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -H "x-request-id: trace-demo-001" \
  -d '{"type":"trace.test","payload":{"x":1}}'
# response: x-request-id: trace-demo-001

curl -s $BASE/events -H "x-api-key: $API_KEY" | jq '.[0].correlationId'
# "trace-demo-001"
```

To reconstruct the full lifecycle of a request across both processes:

```bash
# grep API logs:
docker compose logs api | grep trace-demo-001

# grep worker logs:
docker compose logs worker | grep trace-demo-001

# or query the database directly:
# SELECT * FROM events WHERE correlation_id = 'trace-demo-001';
```

---

## Reliability: Idempotency, Retries, DLQ

### Idempotency — three layers

1. **API layer** — client-supplied `idempotencyKey`; `findUnique` before enqueue returns the existing `jobId` on duplicate. A `P2002` unique-constraint race (two concurrent identical requests) is caught and resolved to the winner's `jobId`.
2. **DB write (worker)** — `prisma.event.upsert` on `idempotencyKey`; falls back to `job-{jobId}` if none supplied.
3. **Notifications** — `notification_log` row inserted before sending; unique constraint acts as a mutex. `P2002` means already sent, skip. Discord and email run in parallel via `Promise.all`.

BullMQ guarantees at-least-once delivery. These three layers make it effectively exactly-once.

### Retries

```
attempts: 3, backoff: exponential (1s → 2s → 4s, jitter 0.5)
after 3 failures → events-dlq
```

### Dead Letter Queue

```bash
curl -s http://localhost:9091/health | jq '.checks.dlq_waiting'
docker compose exec worker node app/worker/dist/dlqReplay.js
```

### Graceful shutdown

SIGTERM → close worker → close queue events/DLQ → quit Redis connections → disconnect Prisma → exit 0.

---

## Observability: Logs, Metrics, Dashboards

### Structured logging (Pino)

JSON in production, pretty-printed in development. Every log line includes `service` and `correlationId`:

```json
{"level":"info","time":"...","service":"worker:processor","jobId":"42","tenantId":"tenant-demo","correlationId":"trace-demo-001","durationMs":850,"msg":"job completed"}
```

### Metrics (Prometheus)

Both API (:3000/api/v1/metrics) and worker (:9091/metrics) expose Prometheus-format metrics. Custom counters cover auth, rate limiting, events, jobs, notifications, DLQ, and cache hit/miss rates. Node.js defaults (heap, event loop lag, GC) are also collected.

### Grafana

Pre-provisioned dashboard at <http://localhost:4000> (no manual setup). Panels:

- Events accepted / jobs completed vs failed (throughput)
- Rate limit rejections, auth failures (security)
- Event loop lag, heap usage (Node.js internals)
- DLQ inflow + lifetime total
- Notification send/fail rates

### node-exporter (production only)

`docker-compose.prod.yml` adds node-exporter on :9100 — host-level CPU, memory, disk, and network metrics scraped by Prometheus alongside application metrics.

---

## Load Testing Results

Tested with [autocannon](https://github.com/mcollina/autocannon).

### Test 1 — Rate limiter under 20 concurrent connections (GET /events)

```bash
npx autocannon -c 20 -d 10 -H "x-api-key: $API_KEY" $BASE/events
```

```
Latency:  p50 1ms  |  p99 5ms  |  max 46ms
Req/Sec:  avg 10,535  |  min 8,828  |  max 11,135
Result:   105k requests in 10s — 97 × 2xx, 105,257 × 429, 0 errors
```

The sliding-window rate limiter correctly rejected ~105k excess requests under real concurrent load with zero connection errors. Every rejected request received a proper 429 JSON response — no dropped connections, no timeouts. p99 of 5ms means even rejected requests are served fast.

### Test 2 — 30 concurrent connections

```bash
npx autocannon -c 30 -d 10 -H "x-api-key: $API_KEY" $BASE/events
```

```
Latency:  p50 2ms  |  p99 6ms  |  max 38ms
Req/Sec:  avg 10,739
Result:   108k requests in 10s — 0 × 2xx, 107,383 × 429, 0 errors
```

Going from 20 to 30 connections doubled median latency from 1ms to 2ms — expected behavior. More concurrent requests contend for the same Redis sorted-set operations in the sliding window algorithm, creating measurable queuing. System remained stable with zero errors.

### Test 3 — Idempotency race condition (POST /events, 10 concurrent)

```bash
npx autocannon -c 10 -d 1 -m POST \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -b '{"type":"race.test","payload":{"x":1},"idempotencyKey":"f47ac10b-58cc-4372-a567-0e02b2c3d479"}' \
  $BASE/events
```

```
Latency:  p50 1ms  |  p99 7ms  |  max 34ms
Result:   ~6,300 requests in 1s — 100 × 2xx, 6,232 × 429, 0 errors
```

After the test, exactly one row exists in the database for that idempotency key. Ten concurrent connections firing the same key simultaneously produced one event — the P2002 unique-constraint race handling works correctly under real concurrency.

---

## CI/CD Pipeline

`.github/workflows/ci-cd.yml` runs on every push/PR to `main`:

```
1. npm ci
2. Build: shared → db → api → worker (dependency order enforced)
3. Docker build (api, worker) — validates Dockerfiles
4. Smoke test: compose up → migrate → health check → compose down
```

On push to main only:

```
5. Push images to Docker Hub (:latest + :<git-sha> — SHA enables rollback)
6. Deploy to EC2: write .env from Secrets, scp compose file, docker compose pull && up -d
```

---

## Production Deployment (AWS)

Infrastructure in `infra/` (Terraform): EC2 instance, security group, Elastic IP. `user_data.sh` installs Docker on first boot.

```bash
cd infra
terraform init
terraform apply     # outputs public IP
git push origin main   # triggers CI/CD → deploys
terraform destroy   # tears down cleanly
```

---

## Environment Variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `REDIS_URL` | yes | Redis connection string |
| `ADMIN_SECRET` | yes | Protects /admin/*. Generate: openssl rand -hex 32 |
| `DISCORD_WEBHOOK_URL` | no | Discord notification target |
| `RESEND_API_KEY` / `NOTIFICATION_EMAIL` | no | Email via Resend |
| `LOG_LEVEL` | no | default info |
| `GRAFANA_USER` / `GRAFANA_PASSWORD` | no | default admin / eventflow |

---

## Known Limitations and Design Decisions

- **Tenant signup flow** — out of scope. The data model supports it; provisioning is operator-driven via seed or POST /admin/tenants.
- **API key revocation propagation** — up to 60s delay due to auth cache TTL. Documented tradeoff.
- **Single EC2 instance** — no load balancer. The API/worker separation means horizontal scaling is a config change, not a redesign.
- **No Jenkins** — GitHub Actions chosen for visibility and zero infrastructure overhead.
- **Loki** — not included. Structured JSON logs are ready for Loki ingestion; natural next step to complete metrics + logs + traces.
