# EventFlow

A production-grade event ingestion and async processing system. Accepts events via an HTTP API, queues them with BullMQ + Redis, processes them in a separate worker process, persists them in PostgreSQL, and delivers notifications via Discord and email — with full observability (Prometheus + Grafana), distributed tracing (correlation IDs), Redis caching, and a CI/CD pipeline to AWS EC2.

---

## Table of Contents

- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Quickstart (Local)](#quickstart-local)
- [API Reference](#api-reference)
- [Admin: Provisioning Tenants](#admin-provisioning-tenants)
- [Rate Limiting](#rate-limiting)
- [Caching](#caching)
- [Correlation IDs / Distributed Tracing](#correlation-ids--distributed-tracing)
- [Reliability: Idempotency, Retries, DLQ](#reliability-idempotency-retries-dlq)
- [Observability: Logs, Metrics, Dashboards](#observability-logs-metrics-dashboards)
- [CI/CD Pipeline](#cicd-pipeline)
- [Production Deployment (AWS)](#production-deployment-aws)
- [Environment Variables](#environment-variables)
- [Known Limitations & Design Decisions](#known-limitations--design-decisions)

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
  └─▶ [events-dlq]              after 3 retries with exponential backoff
```

**Why API and Worker are separate processes:** different failure domains and different scaling shapes. The API is latency-bound (returns 202 in milliseconds regardless of downstream work); the worker is throughput-bound. A slow Discord webhook or a CPU-heavy job in the worker never blocks the API's event loop.

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
│   │       │   └── redis.ts        Redis connections (general + queue)
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
│   │       ├── seed.ts               demo tenant + API key provisioning
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

`.env.example` ships with safe local defaults. Generate your own admin secret:

```bash
openssl rand -hex 32   # paste the result into ADMIN_SECRET in .env
```

### 2. Start everything

```bash
docker compose up -d
```

This builds local images and starts: `postgres`, `redis`, `migrate` (runs once), `seed` (runs once), `api`, `worker`, `prometheus`, `grafana`.

### 3. Get your demo API key

```bash
docker compose logs seed
```

The `seed` service provisions a demo tenant (`tenant-demo`) and prints a raw API key — shown only once, on first run. Copy it:

```bash
export API_KEY="ef_live_..."
export BASE="http://localhost:3000/api/v1"
```

If you've run this before and the demo tenant already exists, `seed` logs will say so — use `POST /api/v1/admin/tenants` (see below) to provision a fresh key.

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

### 6. Explore observability

```
Grafana:     http://localhost:4000   (admin / value of GRAFANA_PASSWORD)
Prometheus:  http://localhost:9090
API metrics: http://localhost:3000/api/v1/metrics
Worker:      http://localhost:9091/metrics, http://localhost:9091/health
```

---

## API Reference

All endpoints except `/health`, `/metrics`, and `/admin/*` require an API key:

```
x-api-key: ef_live_...
```

Every response includes `x-request-id` (see [Correlation IDs](#correlation-ids--distributed-tracing)).

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

**202 — new event**

```json
{ "accepted": true, "jobId": "42", "duplicate": false }
```

**202 — duplicate (idempotent replay)**

```json
{ "accepted": false, "jobId": "41", "duplicate": true }
```

**400 — validation failed**

```json
{ "error": "Validation failed", "details": { "type": ["Required"] } }
```

**401** — `{ "error": "Missing API key" }` or `{ "error": "Invalid API key" }` (identical message — prevents key enumeration)

**429** — `{ "error": "Rate limit exceeded", "retryAfter": 60 }`

---

### GET /api/v1/events

Returns the latest 50 events for the caller's tenant, newest first. Served from a 5-second Redis cache (see [Caching](#caching)).

```bash
curl -s $BASE/events -H "x-api-key: $API_KEY" | jq
```

---

### GET /api/v1/events/:jobId

```bash
curl -s $BASE/events/42 -H "x-api-key: $API_KEY" | jq
```

Returns full event detail including `payload` and `correlationId`. Returns `404` for both "not found" and "belongs to another tenant" — never confirms cross-tenant resource existence.

| `status` | Meaning |
|---|---|
| `pending` | queued |
| `processing` | worker picked it up |
| `completed` | done |
| `failed` | retries exhausted, moved to DLQ |

---

### GET /api/v1/health

```bash
curl -s $BASE/health | jq
```

```json
{ "status": "ok", "checks": { "postgres": "healthy", "redis": "healthy" }, "timestamp": "..." }
```

`503` if either dependency is down. No auth required — used by load balancers / Docker healthchecks.

---

### GET /api/v1/metrics

Prometheus exposition format — scraped by Prometheus every 15s. No auth (internal network only in production).

```bash
curl -s $BASE/metrics
```

`GET /api/v1/metrics/json` returns the same data as JSON for ad-hoc inspection.

---

## Admin: Provisioning Tenants

In a real multi-tenant SaaS, `tenantId` represents an account/organization — assigned by the platform when an account is created, not chosen by the client. `POST /api/v1/admin/tenants` simulates that provisioning step.

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
  "rawApiKey": "ef_live_...",
  "warning": "Store this key now. It cannot be retrieved again."
}
```

`tenantId` is optional — omit it to auto-generate one. The raw API key is shown exactly once, matching how AWS/Stripe display secret keys at creation time. Protected by `ADMIN_SECRET` (a shared operator secret, not a tenant credential, not stored in the database).

---

## Rate Limiting

| Layer | Algorithm | Limit | Scope | Fail mode |
|---|---|---|---|---|
| IP protection | Fixed window (`INCR` + `EXPIRE`) | 200/min | per IP | **open** — Redis down ⇒ allow |
| API key quota | Sliding window (sorted set, pipelined) | 100/min | per tenant | **closed** — Redis down ⇒ 503 |
| Discord outbound | Token bucket (Lua script, atomic) | 30/min (0.5/s refill) | shared across all workers | closed — BullMQ retries |

IP limiting runs **before** auth — cheap rejection of unauthenticated floods. API key limiting runs **after** auth and enforces per-tenant SLAs with a sliding window (no boundary-reset exploit like fixed windows have). The Discord token bucket is implemented as an atomic Lua script so concurrent workers can't double-spend tokens via a read-then-write race.

429 responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` headers.

---

## Caching

EventFlow uses **cache-aside (lazy loading)** with Redis for two read paths. Both use the existing `api:general` Redis connection (separate from the BullMQ queue connection).

### 1. API key authentication — `apikey:cache:{sha256(key)}`, TTL 60s

```
Request → cache hit?
  yes → use cached {apiKeyId, tenantId, active} → done (no DB)
  no  → query Postgres
          → key valid?   cache {active: true},  proceed
          → key revoked? cache {active: false}, return 401
          → key unknown? don't cache (avoid caching arbitrary garbage), return 401
```

**Why:** every authenticated request needs this lookup — without caching it's a guaranteed DB round-trip on every request. **Negative caching matters too**: if a key is revoked but a misbehaving client keeps sending it, caching the `{active: false}` result for 60s prevents that client from hammering Postgres on every retry — the 401 is returned identically, but from Redis instead of Postgres.

**Tradeoff:** a revoked key remains valid for up to 60 seconds after revocation. Acceptable for this system; document this if building on top of it.

### 2. Event list — `events:list:{tenantId}`, TTL 5s

```
GET /events → cache hit? return cached array : query DB (50 rows, tenant-scoped, ordered) → cache 5s → return
```

**Why TTL-based instead of invalidate-on-write:** a 50-row tenant-scoped `ORDER BY` query is the most expensive read in the system; a 5-second-stale list view is normal UX (same as an email inbox). TTL expiry is simpler and avoids invalidation bugs (e.g. forgetting to bust the cache from the worker process when a job completes).

**Deliberately NOT cached:** `GET /events/:jobId` (single-row indexed lookup — already sub-millisecond, caching adds invalidation complexity for no measurable gain) and `/health` (a load balancer needs the *live* state of dependencies; a cached health check could mask a dead instance).

Metrics: `auth_cache_hit/miss_total`, `events_list_cache_hit/miss_total`.

---

## Correlation IDs / Distributed Tracing

Every request gets an `x-request-id` — read from the incoming header if the client supplied one, otherwise generated as a UUID. It's echoed back in the response header and threads through the entire pipeline:

```
Client (optional x-request-id)
  → API middleware attaches req.correlationId, logs it on every request log
  → passed into BullMQ job data (EventJob.correlationId)
  → Worker reads job.data.correlationId, attaches via pino child logger
    → every worker log line (job started/completed/failed) includes it
  → stored on the Event row (correlation_id column, indexed)
  → preserved in DLQ entries via originalJob
```

**Why it matters:** with concurrent requests across two processes (API + worker), log lines are otherwise impossible to correlate. With this, `grep <correlationId>` across both services' logs — or `SELECT * FROM events WHERE correlation_id = '...'` — reconstructs the full lifecycle of a single request.

```bash
curl -s -i -X POST $BASE/events \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -H "x-request-id: trace-demo-001" \
  -d '{"type":"trace.test","payload":{"x":1}}'
# response header: x-request-id: trace-demo-001

curl -s $BASE/events -H "x-api-key: $API_KEY" | jq '.[0].correlationId'
# "trace-demo-001"
```

---

## Reliability: Idempotency, Retries, DLQ

### Idempotency — three layers

1. **API layer** — client-supplied `idempotencyKey` (UUID); `findUnique` before enqueue returns the existing `jobId` if already processed. A `P2002` unique-constraint race (two concurrent identical requests) is caught and resolved to the winner's `jobId`.
2. **DB write (worker)** — `prisma.event.upsert` on `idempotencyKey`; falls back to `job-{jobId}` if the client didn't supply one.
3. **Notifications** — `notification_log` row inserted *before* sending; the unique constraint acts as a mutex. `P2002` ⇒ already sent ⇒ skip. Discord and email use separate lock keys and run in parallel via `Promise.all`.

BullMQ guarantees **at-least-once** delivery; these three layers make that **effectively exactly-once**.

### Retries

```
attempts: 3, backoff: exponential (1s → 2s → 4s, jitter 0.5)
after 3 failures → events-dlq
```

### Dead Letter Queue

```bash
# inspect
curl -s http://localhost:9091/health | jq '.checks.dlq_waiting'

# replay (10/batch, 2s between batches)
docker compose exec worker node app/worker/dist/dlqReplay.js
```

### Stalled job detection

BullMQ's `QueueEvents` checks every 30s for jobs stuck in `active` state (worker crashed mid-job) and automatically re-queues them; the `stalled` event is logged.

### Graceful shutdown

`SIGTERM` → close worker → close queue events/DLQ → quit all Redis connections → disconnect Prisma → exit 0. In-flight jobs drain before shutdown completes.

---

## Observability: Logs, Metrics, Dashboards

### Structured logging (Pino)

JSON in production, pretty-printed in development. Every log line includes `service`, and request/job logs include `correlationId`:

```json
{"level":"info","time":"...","service":"worker:processor","jobId":"42","tenantId":"tenant-demo","correlationId":"trace-demo-001","durationMs":850,"msg":"job completed"}
```

`LOG_LEVEL` controls verbosity: `debug | info | warn | error`.

### Metrics (Prometheus)

Both API (`:3000/api/v1/metrics`) and worker (`:9091/metrics`) expose Prometheus-format metrics, including Node.js defaults (heap, event loop lag, GC) and custom counters covering auth, rate limiting, events, jobs, notifications, DLQ, and cache hit/miss rates.

### Grafana

Pre-provisioned at `http://localhost:4000` (folder: **EventFlow**) — no manual setup. Dashboard covers:

- Events accepted / jobs completed vs failed (throughput)
- Rate limit rejections, auth failures (security)
- Event loop lag, heap usage (Node.js internals)
- DLQ inflow + lifetime total
- Notification send/fail rates

Dashboard JSON is provisioned from `grafana/provisioning/dashboards/eventflow.json` — edit via the UI, then export JSON Model back into that file to persist changes.

### node-exporter (production only)

`docker-compose.prod.yml` includes `node-exporter` on `:9100`, scraped by Prometheus — host-level CPU, memory, disk, and network metrics alongside application metrics. Not included in local dev (monitoring your own laptop isn't useful for this project's story).

---

## CI/CD Pipeline

`.github/workflows/ci-cd.yml` runs on every push/PR to `main`:

```
1. Checkout, install deps (npm ci)
2. Build: shared → db → api → worker (in dependency order)
3. Build Docker images (api, worker) — validates Dockerfiles
4. Smoke test:
     docker compose up postgres redis
     run migrations
     docker compose up api worker
     curl --fail /api/v1/health
     docker compose down -v
```

On push to `main` only (not PRs), two additional stages run:

```
5. Build + push images to Docker Hub
     tags: :latest and :<git-sha>   (SHA tag enables exact rollback)
6. Deploy to EC2
     write .env from GitHub Secrets
     scp docker-compose.prod.yml + grafana/ + prometheus.yml
     ssh: docker compose -f docker-compose.prod.yml pull && up -d
     curl --fail /api/v1/health
```

---

## Production Deployment (AWS)

Infrastructure is defined in `infra/` (Terraform): a single EC2 instance, security group (22/3000/4000/9090), and Elastic IP. `user_data.sh` installs Docker + Docker Compose on first boot — no manual server setup.

```bash
cd infra
terraform init
terraform apply     # creates EC2, outputs the public IP
# ... set GitHub Secrets: EC2_HOST, EC2_SSH_KEY, DOCKERHUB_USERNAME, DOCKERHUB_TOKEN,
#     POSTGRES_*, DATABASE_URL, ADMIN_SECRET, GRAFANA_PASSWORD, etc.
git push origin main   # CI/CD builds, pushes images, deploys
terraform destroy   # tears everything down cleanly
```

`docker-compose.prod.yml` differs from local `docker-compose.yml` in two ways: it **pulls** pre-built images from Docker Hub (`${DOCKERHUB_USERNAME}/eventflow-api:latest`) instead of building from source, and it adds `node-exporter`. The `seed` service is local-only — production tenants are provisioned via `POST /api/v1/admin/tenants`.

---

## Environment Variables

See `.env.example` for the full list with inline documentation. Key variables:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `REDIS_URL` | yes | Redis connection string |
| `ADMIN_SECRET` | yes | Protects `/admin/*`. Generate: `openssl rand -hex 32` |
| `DISCORD_WEBHOOK_URL` | no | Discord notification target |
| `RESEND_API_KEY` / `NOTIFICATION_EMAIL` | no | Email notifications via Resend |
| `LOG_LEVEL` | no | default `info` |
| `GRAFANA_USER` / `GRAFANA_PASSWORD` | no | default `admin` / `eventflow` |

---

## Known Limitations & Design Decisions

These are deliberate scope boundaries, not oversights:

- **Tenant signup flow** — out of scope. Tenants are provisioned via `seed` (local demo) or `POST /api/v1/admin/tenants` (operator-driven). A real SaaS would expose this via a signup UI; the data model (`ApiKey.tenantId`) already supports it.
- **API key revocation propagation** — up to 60s delay due to auth caching. Acceptable tradeoff, documented above.
- **Single EC2 instance** — no horizontal scaling/load balancer. Sufficient to demonstrate the architecture; the API/worker separation means scaling each independently (e.g. via ECS or K8s) is a config change, not a redesign.
- **No Jenkins** — GitHub Actions chosen over self-hosted CI for visibility (public green checkmarks) and zero infrastructure to maintain.
- **Loki / centralized log aggregation** — not included. Structured JSON logs are ready for it; would be the natural next addition to complete the metrics+logs+traces observability story.
