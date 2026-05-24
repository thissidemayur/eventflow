# EventFlow

A production-grade event ingestion and processing system. Accepts events via HTTP API, processes them asynchronously using BullMQ + Redis, stores them in PostgreSQL, and sends notifications to Discord.

---

## Architecture

```
Client
  │
  ▼
[IP Rate Limit]          Fixed window — blocks unauthenticated floods
  │
  ▼
[Auth Middleware]        API key lookup → attaches tenantId to request
  │
  ▼
[API Key Rate Limit]     Sliding window — per-key quota enforcement
  │
  ▼
[Authorization]          Tenant isolation — prevents cross-tenant access
  │
  ▼
[Validation]             Zod schema — rejects malformed payloads
  │
  ▼
[BullMQ Queue]           Redis-backed job queue
  │
  ▼
[Worker]                 Processes jobs: DB write → notification → complete
  │
  ├─▶ [PostgreSQL]       Stores events with full audit trail
  │
  └─▶ [Discord]          Sends notifications (token bucket throttled)
```

---

## Project Structure

```
eventflow/
├── app/
│   ├── api/                    Express HTTP server (producer)
│   │   └── src/
│   │       ├── config/
│   │       │   └── redis.ts    Redis connection management
│   │       ├── middleware/
│   │       │   ├── auth.ts           API key authentication
│   │       │   ├── authorization.ts  Tenant isolation
│   │       │   ├── rateLimiters.ts   IP + API key rate limits
│   │       │   └── validate.ts       Zod request validation
│   │       ├── routes/
│   │       │   ├── events.ts   POST /events, GET /events/:jobId
│   │       │   ├── health.ts   GET /health
│   │       │   └── metrics.ts  GET /metrics
│   │       └── index.ts
│   │
│   └── worker/                 BullMQ consumer (separate process)
│       └── src/
│           ├── processor.ts    Core job processing logic
│           ├── notifications.ts Discord sender + idempotency
│           ├── rateLimiters.ts Redis token bucket for Discord
│           ├── dlqReplay.ts    Manual DLQ replay script
│           └── index.ts        Worker + DLQ handler + graceful shutdown
│
├── packages/
│   ├── db/                     Prisma schema + client
│   │   └── prisma/
│   │       └── schema.prisma
│   └── shared/                 Shared types, schemas, utilities
│       └── src/
│           ├── schemas.ts      Zod event schema
│           ├── queue.ts        Queue name + job types
│           ├── apiKey.ts       Key hashing utility
│           ├── logger.ts       Pino logger factory
│           └── metrics.ts      In-process metrics counters
│
├── docker-compose.yml
├── tsconfig.base.json
└── .env.example
```

---

## Prerequisites

- Node.js 22.22.0+
- npm 10.9.4+
- Docker + Docker Compose

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/thissidemayur/eventflow
cd eventflow
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
DATABASE_URL="postgresql://eventflow:secret@localhost:5432/eventflow"
REDIS_URL="redis://localhost:6379"
PORT=3000
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."   # optional
LOG_LEVEL="info"
NODE_ENV="development"
```

### 3. Start infrastructure

```bash
docker-compose up -d
docker-compose ps   # verify both services show "healthy"
```

### 4. Run database migration

```bash
npm run migrate -w @eventflow/db
# When prompted: enter migration name "init"
```

### 5. Generate Prisma client

```bash
npm run generate -w @eventflow/db
```

### 6. Seed an API key

```bash
npm run seed -w @eventflow/db
```

This prints your raw API key — save it, it is shown only once:

```
API Key created:
{
  rawKey: 'ef_live_e00a518a27817d6931ac9271957cf1d3f6c8a03fc1035b3e',
  keyHash: '074a2b42979f7e9837e9caa2238cb8c7979c03c4e6a0e2f2a1e3615146232fd5',
  id: 'a0ec281f-e700-40d5-b23d-e9b37af6c5b6'
}
```

---

## Running

### Development (two terminals)

```bash
# Terminal 1 — API server
npm run dev:api

# Terminal 2 — Worker
npm run dev:worker
```

### Production build

```bash
npm run build:packages
npm run build
```

---

## API Reference

### Authentication

All endpoints (except `/health` and `/metrics`) require an API key:

```
x-api-key: ef_live_your_key_here
```

---

### POST /events

Accepts an event for asynchronous processing.

**Request**

```bash
curl -X POST http://localhost:3000/events \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_KEY" \
  -d '{
    "type": "user.signup",
    "payload": {
      "userId": "u_123",
      "email": "user@example.com"
    },
    "idempotencyKey": "unique-client-key-001"
  }'
```

**Body schema**

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | ✅ | Event type. Max 100 chars. |
| `payload` | object | ✅ | Arbitrary event data. Max 64KB. |
| `idempotencyKey` | string (UUID) | ✗ | Prevents duplicate processing on retry. |
| `timestamp` | ISO datetime | ✗ | Client-side event timestamp. |

**Response 202 — accepted**

```json
{
  "accepted": true,
  "jobId": "42"
}
```

**Response 400 — validation failed**

```json
{
  "error": "Validation failed",
  "details": {
    "type": ["Required"]
  }
}
```

**Response 401 — authentication failed**

```json
{ "error": "Missing API key" }
```

**Response 429 — rate limited**

```json
{
  "error": "Rate limit exceeded",
  "retryAfter": 60
}
```

Headers included on 429:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1718000120
Retry-After: 60
```

---

### GET /events/:jobId

Returns the current processing status of an event.

```bash
curl http://localhost:3000/events/42 \
  -H "x-api-key: YOUR_KEY"
```

**Response 200**

```json
{
  "id": "uuid",
  "jobId": "42",
  "eventType": "user.signup",
  "status": "completed",
  "tenantId": "tenant-abc",
  "attemptCount": 1,
  "processingDurationMs": 87,
  "receivedAt": "2024-06-10T14:30:00.000Z",
  "processedAt": "2024-06-10T14:30:00.087Z",
  "createdAt": "2024-06-10T14:30:00.010Z"
}
```

**Status values**

| Status | Meaning |
|---|---|
| `pending` | Queued, not yet picked up by worker |
| `processing` | Worker is currently processing |
| `completed` | Successfully processed |
| `failed` | All retries exhausted, in DLQ |

---

### GET /health

Dependency health check. Used by load balancers.

```bash
curl http://localhost:3000/health
```

**Response 200 — healthy**

```json
{
  "status": "ok",
  "checks": {
    "postgres": "healthy",
    "redis": "healthy"
  },
  "timestamp": "2024-06-10T14:30:00.000Z"
}
```

**Response 503 — degraded**

```json
{
  "status": "degraded",
  "checks": {
    "postgres": "unhealthy",
    "redis": "healthy"
  },
  "timestamp": "2024-06-10T14:30:00.000Z"
}
```

---

### GET /metrics

Internal metrics snapshot. Firewall this endpoint — do not expose publicly.

```bash
curl http://localhost:3000/metrics
```

**Response 200**

```json
{
  "counters": {
    "events.accepted": 1847,
    "jobs.completed": 1835,
    "jobs.failed": 12,
    "notifications.sent": 1820,
    "notifications.skipped.idempotent": 15,
    "ratelimit.apikey.rejected": 4,
    "ratelimit.ip.rejected": 1,
    "auth.success": 1851,
    "auth.invalid_key": 3
  },
  "gauges": {
    "jobs.duration_ms": 87
  },
  "timestamp": "2024-06-10T14:32:00.000Z"
}
```

---

## Rate Limiting

Three layers of rate limiting protect the system:

| Layer | Algorithm | Limit | Scope |
|---|---|---|---|
| IP protection | Fixed window | 200 req/min | Per IP address |
| API key quota | Sliding window | 100 req/min | Per API key |
| Discord outbound | Token bucket | 30 req/min | Shared across all workers |

**IP rate limit** runs before authentication. Blocks unauthenticated floods cheaply.

**API key rate limit** runs after authentication. Enforces per-customer SLA. No boundary exploit — uses sliding window.

**Discord token bucket** is shared across all worker instances via Redis. Capacity 30, refill 0.5/second. Workers that have been idle bank tokens for legitimate bursts.

---

## Reliability

### Retry strategy

Failed jobs are retried with exponential backoff:

```
Attempt 1 — immediate
Attempt 2 — 1s delay
Attempt 3 — 2s delay
→ Dead Letter Queue
```

### Idempotency

Three layers prevent duplicate processing:

1. **API layer** — client supplies `idempotencyKey` (UUID)
2. **DB write** — `upsert` on `idempotencyKey` prevents duplicate rows
3. **Notifications** — insert-first lock in `notification_log` prevents duplicate Discord messages

### Dead Letter Queue

Jobs exhausting all retries land in the `events-dlq` queue for manual inspection.

To replay after fixing the root cause:

```bash
npm run replay-dlq -w @eventflow/worker
```

Default: replays 10 jobs per batch, 2s between batches. Edit `dlqReplay.ts` to adjust.

### Stalled job detection

BullMQ automatically re-queues jobs whose workers crashed mid-processing. The `stalled` event is logged for observability.

---

## Observability

### Structured logging

All logs are JSON (pino). In development, pretty-printed with colour.

```json
{
  "level": "info",
  "time": "2024-06-10T14:30:00.087Z",
  "service": "worker:processor",
  "jobId": "42",
  "tenantId": "tenant-abc",
  "durationMs": 87,
  "msg": "job completed"
}
```

Set `LOG_LEVEL` in `.env` to control verbosity: `debug` | `info` | `warn` | `error`.

### Metrics

Counter-based metrics available at `GET /metrics`. Key metrics to monitor:

| Metric | Alert condition |
|---|---|
| `jobs.failed` | Any value > 0 sustained |
| `jobs.dead_lettered` | Any value > 0 |
| `ratelimit.ip.rejected` | Spike > baseline (DDoS) |
| `auth.invalid_key` | Spike (credential stuffing) |
| `authz.tenant_violation` | Any value > 0 (security incident) |

---

## Security

- API keys are stored as SHA-256 hashes — plaintext keys never touch the database
- Auth errors return identical messages regardless of whether the key exists (prevents enumeration)
- Tenant isolation enforced on all data-access routes — tenants cannot query each other's events
- Cross-tenant access attempts return 404 (not 403) to avoid confirming resource existence
- Rate limiting at three independent layers with fail-safe behavior

---

## Development Scripts

| Command | Description |
|---|---|
| `npm run dev:api` | Start API server with hot reload |
| `npm run dev:worker` | Start worker with hot reload |
| `npm run build:packages` | Build shared + db packages |
| `npm run build` | Build everything |
| `npm run migrate -w @eventflow/db` | Run Prisma migrations |
| `npm run generate -w @eventflow/db` | Regenerate Prisma client |
| `npm run seed -w @eventflow/db` | Create a test API key |
| `npm run replay-dlq -w @eventflow/worker` | Replay dead-lettered jobs |

---

## Docker Compose Services

| Service | Port | Purpose |
|---|---|---|
| postgres | 5432 | Primary database |
| redis | 6379 | Queue + rate limiting |

Both services have health checks. Postgres data persists in `postgres_data` volume. Redis uses AOF persistence (`--appendonly yes`) so queued jobs survive restarts.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `REDIS_URL` | ✅ | Redis connection string |
| `PORT` | ✗ | API port (default: 3000) |
| `DISCORD_WEBHOOK_URL` | ✗ | Discord webhook for notifications |
| `LOG_LEVEL` | ✗ | Pino log level (default: info) |
| `NODE_ENV` | ✗ | `development` or `production` |
