# EventFlow — Interview Cheat Sheet

Every question below is answered using what was actually built and verified.
No generic answers. Every number is real. Every tradeoff is documented.

---

## HOW TO USE THIS FILE

- Read the question out loud, then answer from memory
- Check your answer against the one below
- The goal is not to memorize word-for-word — understand the reasoning so you can answer naturally
- When an interviewer asks a follow-up, the "Likely follow-ups" section prepares you

---

## SECTION 1: ARCHITECTURE & DESIGN

---

### Q1: "Walk me through the EventFlow architecture."

> "EventFlow is a production-grade event ingestion system. The core design decision is separating ingestion from processing. When a client sends a POST to /events, the request passes through five middleware layers — correlation ID generation, IP rate limiting, API key authentication with Redis caching, per-tenant sliding window rate limiting, and Zod validation — then gets enqueued into BullMQ backed by Redis, and the API returns 202 Accepted in under 20 milliseconds. The actual processing happens in a completely separate worker process: it upserts the event to PostgreSQL, sends Discord and email notifications in parallel, and marks the job complete. If it fails, BullMQ retries with exponential backoff up to 3 times before moving it to a dead letter queue.
>
> The reason for the separation is that failure domains and scaling shapes are different. The API is latency-bound — it needs to respond fast. The worker is throughput-bound — it needs to process reliably. Keeping them together would mean a slow Discord webhook blocks the API's event loop for every concurrent request."

**Likely follow-ups:**

- Why BullMQ specifically? → Redis-backed, at-least-once delivery, stalled job detection built-in, good TypeScript support
- What happens if the queue gets full? → BullMQ does not have a hard queue limit by default; the concern is Redis memory, which you'd monitor via the heap metrics already in Prometheus
- How does the worker know which events to process? → BullMQ uses Redis lists and sorted sets internally; workers call `worker.process()` which blocks on BLMOVE (blocking list move) — no polling

---

### Q2: "Why did you separate API and Worker into different processes instead of keeping it in one?"

> "Three concrete reasons. First, failure isolation — if the worker crashes during a slow Discord API call, the API keeps accepting events. They queue up and drain when the worker restarts. Neither process takes down the other. Second, independent scaling — the API scales horizontally behind a load balancer because it's latency-bound. The worker scales vertically or by adding more consumer instances because it's throughput-bound. They have fundamentally different bottlenecks. Third, event loop protection — Node.js is single-threaded. If Discord webhooks taking 500ms ran inside the API process, every slow notification would block the event loop and increase API response time for every concurrent request. Separate process means the API event loop is never polluted by downstream I/O."

**Likely follow-ups:**

- How do they share data? → Via the BullMQ queue (Redis). API writes jobs, worker reads jobs. They don't share memory or sockets.
- What if both crash? → Events in the queue survive because Redis has AOF persistence (`--appendonly yes`). When both restart, the worker picks up from where it left off.

---

### Q3: "Why use a message queue instead of processing events synchronously?"

> "Three reasons. First, latency decoupling — the API returns 202 in under 20ms regardless of how long PostgreSQL writes or Discord notifications take. Without a queue, a slow downstream service directly increases API response time. Second, reliability — BullMQ gives at-least-once delivery with automatic stalled job re-queuing. If the worker crashes mid-job, BullMQ detects it (every 30 seconds) and re-queues it automatically. Third, backpressure handling — during a traffic spike, events buffer in the queue and the worker processes them at its own pace. Without a queue, a spike would either crash the worker or cause timeouts for clients."

**Likely follow-ups:**

- What's the difference between at-least-once and exactly-once? → At-least-once means a job runs at minimum once but possibly more (on crash + re-queue). Exactly-once means it runs exactly once, which requires distributed transactions. EventFlow simulates exactly-once via idempotency at three layers without needing a distributed transaction.
- What is the queue depth right now? → Visible at `curl http://localhost:9091/health` — shows `queue_waiting`, `queue_active`, `dlq_waiting`

---

### Q4: "If you had to scale this to 10x traffic, what breaks first?"

> "In order:
>
> First — the single PostgreSQL instance. At 10x write load, connection pool exhaustion is the primary failure mode. Workers × concurrency × queries-per-job must stay under Postgres's max_connections (default 100). Fix: connection pool tuning (PgBouncer), then read replicas for GET /events queries.
>
> Second — Redis under the sliding window rate limiters. Sorted set operations at 100k+ req/s create meaningful write contention. Fix: Redis Cluster, or accept slightly less precise rate limiting with a simpler algorithm at extreme scale.
>
> Third — the single worker process. Fix: scale horizontally — BullMQ is designed for multiple consumers on the same queue. The idempotency layer (upsert on idempotencyKey) already handles the case where two workers pick up the same job.
>
> Fourth — the single EC2 instance for the API. Fix: ALB + multiple API instances. Since the API is stateless (all state is in Redis and Postgres), horizontal scaling is a config change, not a redesign.
>
> The architecture was specifically designed so each of these is an independent scaling decision."

---

### Q5: "How does data consistency work across your services?"

> "EventFlow uses eventual consistency for non-critical paths and synchronous operations for critical paths.
>
> For event processing: the API acknowledges receipt immediately (202) and the worker processes asynchronously. The client doesn't know the final status until they poll GET /events/:jobId. This is eventual consistency — the event is guaranteed to be processed eventually, but not immediately.
>
> For idempotency: the DB is the source of truth. The idempotency key constraint on the events table enforces consistency even under concurrent writes — Postgres's unique constraint is the final arbiter, not application code.
>
> For caching: Redis is a read-optimization layer, not a source of truth. Cache TTL (60s for auth keys, 5s for event lists) means there's a short window of potential staleness, which is explicitly documented as an acceptable tradeoff."

---

## SECTION 2: RATE LIMITING

---

### Q6: "Walk me through your three rate limiting algorithms."

> "Three algorithms, three different concerns.
>
> First, fixed window on IP address. This runs before authentication — it's cheap, stateless-ish, and stops unauthenticated floods before they hit the database. Redis INCR on the key, EXPIRE to reset each minute. Fails OPEN — if Redis is down, requests are allowed through, because a Redis failure shouldn't block all your users.
>
> Second, sliding window on API key. Runs after auth, enforces per-tenant SLA. Uses a Redis sorted set — score is the timestamp, member is a UUID. Four commands pipelined: ZREMRANGEBYSCORE removes expired entries, ZADD adds the current request, ZCARD counts the window, EXPIRE resets TTL. Fails CLOSED — if Redis is down, return 503. You can't enforce an SLA without shared state.
>
> Third, token bucket for outbound Discord. Shared across all worker instances via a single Redis hash. Implemented as a Lua script because the read-calculate-write must be atomic — without atomicity, two workers reading tokens=1 simultaneously both see 'available' and both send, double-spending the token. Lua scripts run atomically in Redis."

**Likely follow-ups:**

- Why sliding window over fixed for API keys? → Fixed window has a boundary exploit: 100 req at 12:59:59 + 100 req at 1:00:01 = 200 req in 2 seconds, both in separate windows. Sliding window always checks the last 60 seconds from NOW, no boundary to exploit.
- Why not sliding window for Discord too? → Token bucket allows legitimate bursting. If workers are idle for 2 minutes, they've "earned" 60 tokens and can send a burst. Sliding window would cap at 30/min regardless of idle time. Discord's actual behavior allows bursting.
- What does "pipelined" mean? → Instead of 4 sequential Redis round trips (4× network latency), pipeline sends all 4 commands in one TCP packet and reads all 4 responses in one reply. Cuts Redis round trips from 4 to 1 on every authenticated request.

---

### Q7: "What's the difference between fail-open and fail-closed? When do you use each?"

> "Fail-open means: if the dependency is unavailable, allow the request through. Fail-closed means: if the dependency is unavailable, reject the request.
>
> For the IP rate limiter, I chose fail-open. If Redis is down, we can't check the rate limit — but blocking all users because of a Redis failure would be worse than the risk of a brief flood getting through. The principle is: availability trumps rate limiting enforcement at the IP level.
>
> For the API key rate limiter, I chose fail-closed. If I can't check whether a tenant has exceeded their quota, I can't enforce their SLA. Allowing unlimited requests through would violate the contract I've made with other tenants who are sharing the system. The principle is: better to briefly 503 one tenant than to silently let them hammer shared infrastructure.
>
> For auth caching: Redis failure falls through to PostgreSQL. This is neither open nor closed — it degrades gracefully. Slower but correct."

---

## SECTION 3: CACHING

---

### Q8: "Explain your caching strategy and why you chose cache-aside over write-through."

> "Cache-aside means: on a read, check cache first. If miss, read from DB, populate cache, return. The cache is populated lazily — only for data that's actually requested.
>
> I use it in two places. Auth key lookup: every authenticated request would otherwise hit PostgreSQL. With cache-aside, the first request for a key hits the DB and caches the result for 60 seconds. All subsequent requests for the same key hit Redis instead — roughly 1ms vs 10-20ms.
>
> Event list: the GET /events query is 50 rows, tenant-scoped, ordered by receivedAt. Expensive relative to a cache hit. 5-second TTL means the cache stays warm for a typical user refreshing a dashboard.
>
> Write-through would cache on writes too — every time an event is created, update the cache. But the writer here is the worker process (different from the API). The worker would need to know about and bust the API's cache. That's cross-process coupling I deliberately avoided. TTL expiry is simpler and self-healing."

**Likely follow-ups:**

- What about cache stampede? → With 5s TTL on a low-traffic system, stampede risk is minimal. At scale, you'd add a lock (SETNX) so only one request rebuilds the cache while others wait.
- Why not cache GET /events/:jobId? → Single row lookup by unique indexed jobId — already sub-millisecond from Postgres. Caching it adds invalidation complexity (status changes from processing → completed) for zero measurable gain.
- Why not cache /health? → Health check exists so load balancers can detect dead instances. Caching health means a dead instance serves a stale "healthy" response. That defeats the entire purpose.

---

### Q9: "What is negative caching and why did you implement it?"

> "Negative caching means caching the 'no' answer, not just the 'yes' answer.
>
> Without it: a revoked API key hits Postgres on every single request, forever. If a misbehaving client is retrying 1000 times per minute with a revoked key, that's 1000 DB queries per minute for a query that always returns the same answer.
>
> With negative caching: the first request with the revoked key hits Postgres, confirms it's inactive, and caches `{active: false}` for 60 seconds. Requests 2 through 1000 in that window hit Redis instead — the 401 response is identical, but Postgres is protected.
>
> The tradeoff: if an admin reactivates a key, it takes up to 60 seconds to propagate. Acceptable for this system. Not acceptable in a payment system where immediate key restoration might be critical — there you'd lower the TTL or implement pub/sub cache invalidation."

---

## SECTION 4: IDEMPOTENCY & RELIABILITY

---

### Q10: "Explain your three-layer idempotency implementation."

> "BullMQ guarantees at-least-once delivery — a job can run more than once. Each layer handles a different failure scenario.
>
> Layer 1 — API layer, client-controlled: the client sends an idempotencyKey (UUID v4). Before enqueuing, I do a findUnique on that key. If it exists, return the existing jobId with duplicate:true — no second job created. If two concurrent requests race with the same key (both pass the check before either writes), the one that loses the DB insert race gets a P2002 unique constraint violation, which I catch and resolve to the winner's jobId.
>
> Layer 2 — worker layer, DB-controlled: the worker does prisma.event.upsert on idempotencyKey. If BullMQ delivers the same job twice (stalled re-queue), the second delivery finds the existing row and updates it — no duplicate row. Falls back to job-{jobId} as the key if the client didn't supply one.
>
> Layer 3 — notification layer, insert-first mutex: before sending Discord or email, I insert a row into notification_log with a unique key. If insert succeeds, send notification. If P2002 (already inserted), skip silently — notification was already sent. This is the write-ahead pattern: write durable state before side effects, so retries can detect what already happened."

**Likely follow-ups:**

- What is the write-ahead pattern? → Write to the DB (durable, survives crashes) BEFORE performing the side effect (notification). If the process crashes between write and send, the next retry finds the write and knows to retry the send. If you send first and then crash before writing, you can't tell on retry whether the send happened.
- Why insert-first and not check-then-send? → Check-then-send has a race: two workers check simultaneously, both see "not sent", both send. Insert-first uses the DB unique constraint as a distributed mutex — only one insert wins, the other gets P2002.
- What's the difference between idempotency and deduplication? → Deduplication is the mechanism (detecting and discarding duplicates). Idempotency is the property (running the same operation multiple times produces the same result as running it once). Idempotency is broader — the system doesn't just detect duplicates, it's designed so duplicates are harmless.

---

### Q11: "What is a race condition? Give a specific example from your codebase."

> "A race condition is when the correctness of a result depends on the timing of concurrent operations — two processes interleave in a way that produces an incorrect outcome neither would produce alone.
>
> Specific example from EventFlow: the idempotency check at the API layer. Two requests arrive simultaneously with the same idempotencyKey:
>
> Request A: SELECT *FROM events WHERE idempotencyKey = 'abc' → not found
> Request B: SELECT* FROM events WHERE idempotencyKey = 'abc' → not found (A hasn't written yet)
> Request A: INSERT INTO events (idempotencyKey='abc') → succeeds
> Request B: INSERT INTO events (idempotencyKey='abc') → FAILS with P2002
>
> The gap between 'check if it exists' and 'write it' is where the race lives. Application-level checks can't prevent this under concurrency — only the database's unique constraint can, because it's atomic.
>
> I verified this with autocannon: 10 concurrent connections all POST-ing the same idempotencyKey simultaneously. After the test, exactly 1 row in the database — the P2002 handler in the catch block correctly resolved all losers to the winner's jobId."

---

### Q12: "What is your DLQ strategy and how would you use it in a real incident?"

> "The DLQ (dead letter queue) is where jobs go after exhausting all retries — 3 attempts with exponential backoff (1s → 2s → 4s). It's a separate BullMQ queue called events-dlq. Each entry contains the original job data, the failed reason, the timestamp, and the attempt count.
>
> In a real incident: say a downstream service (Discord) had an outage for 30 minutes. All notification jobs fail and drain into the DLQ. The DLQ depth is visible at GET /health on the worker (dlq_waiting field). Once Discord recovers, I fix the root cause, then run the replay script: `node app/worker/dist/dlqReplay.js`. It processes 10 jobs per batch with a 2-second gap between batches — the gap prevents a thundering herd where all 1000 queued jobs hit the DB simultaneously and cause a new incident."

---

## SECTION 5: OBSERVABILITY

---

### Q13: "How would you debug a production incident using your observability stack?"

> "Three data sources, used in order.
>
> First, Grafana — open the EventFlow dashboard and look at the time window of the incident. Which panels spiked? If jobs_failed_total spiked, it's a worker problem. If ratelimit_apikey_rejected spiked, it's a traffic anomaly. If event loop lag spiked, something blocked the Node.js event loop.
>
> Second, Prometheus — query specific metrics for the time window. `rate(eventflow_jobs_failed_total[5m])` shows the failure rate. `eventflow_nodejs_gc_duration_seconds` shows GC pauses. `eventflow_nodejs_eventloop_lag_seconds` shows if the loop was blocked.
>
> Third, Pino logs — take a failing correlationId from the Prometheus data or from a user report, grep both API and worker logs for it. Because correlationId flows from API request → BullMQ job data → worker child logger → DB record, a single grep reconstructs the full lifecycle: when was it accepted, when did the worker pick it up, what error occurred, how many retries.
>
> The whole system was designed so you can answer 'what happened to this specific request' in under 5 minutes."

---

### Q14: "What is a correlation ID and why does it matter in a distributed system?"

> "A correlation ID is a unique identifier attached to a request that flows through every component the request touches. In a system with multiple processes, log lines from different services are interleaved with no natural way to connect them.
>
> Without correlation IDs: I see a worker log saying 'job failed' at 3am. I have no idea which API request caused it, which tenant it belongs to, or what the original payload was.
>
> With correlation IDs: the same worker log line includes correlationId='abc-123'. I grep the API logs for 'abc-123' and see the exact request — headers, tenant, timestamp, payload. I query the DB: `SELECT * FROM events WHERE correlation_id = 'abc-123'` and see the full record including processing duration and error.
>
> In EventFlow, the correlationId comes from the x-request-id header. The client can supply their own (for end-to-end tracing from their system into mine), or the API generates a UUID. It flows: API middleware → req.correlationId → BullMQ job.data.correlationId → worker child logger → PostgreSQL correlation_id column (indexed). Indexed because under an incident you're querying by correlationId, and that query needs to be fast."

---

### Q15: "Explain p50 and p99 latency. Why does p99 matter more than average?"

> "Percentile latency means: sort all request timings from fastest to slowest, then pick the value at that position.
>
> p50 (median): half of all requests completed faster than this. Represents the typical user experience.
> p99: 99% of requests completed faster than this. The worst 1% of users experience this or worse.
>
> Average hides problems. If 99 requests take 5ms and 1 request takes 5000ms, the average is about 55ms — looks acceptable. But that one user waited 5 seconds. In a system handling 10,000 req/min, the 'worst 1%' is 100 real users per minute having a bad experience.
>
> From EventFlow's load test: p50 1ms, p99 5ms, max 46ms. The 5x gap between p99 and max (5ms vs 46ms) shows the tail is well-controlled — not extreme outliers. That max 46ms was likely a GC pause or cold cache miss on the first request, which is visible in the node_gc_duration_seconds metrics."

---

## SECTION 6: CI/CD & DEVOPS

---

### Q16: "Walk me through your CI/CD pipeline."

> "Single GitHub Actions workflow file, two phases.
>
> CI phase runs on every push and pull request to main: install dependencies with npm ci (deterministic, uses lockfile), build packages in dependency order (shared → db → api → worker, because api and worker import from shared and db), build Docker images for api and worker to validate the Dockerfiles, then a smoke test — compose up postgres and redis, run migrations, start api and worker, hit GET /health with curl --fail (non-zero exit on non-2xx), compose down. If any step fails, the whole pipeline fails.
>
> CD phase runs only on push to main — not on pull requests. The condition `github.ref == 'refs/heads/main' && github.event_name == 'push'` is necessary because the same workflow file handles both events. A PR from feature-branch to main is also a 'push' event in some contexts — the condition prevents deploying unmerged code.
>
> CD steps: Docker Hub login, build and push api and worker images with two tags each — :latest for 'current version' and :{git-sha} for exact rollback. Then copy the prod compose file and config to EC2 via SCP, write the .env file from GitHub Secrets via SSH, and run docker compose pull + up -d. Final verification: curl --fail the health endpoint or exit 1."

**Likely follow-ups:**

- Why two Docker tags (latest + SHA)? → :latest means 'current deployed version.' :{sha} means 'I can roll back to exactly this image from this commit.' Without the SHA tag, rollback requires rebuilding or guessing which image corresponds to which deploy.
- Why npm ci instead of npm install? → `npm ci` installs exactly what's in `package-lock.json` with no modifications. `npm install` can update the lockfile. In CI, you want deterministic installs — the same dependencies every time regardless of new releases.
- What's in .env.example for CI? → Safe placeholder values that let the smoke test pass: real Postgres and Redis credentials (matching the compose file defaults), fake Discord/email values (those aren't tested in the smoke test).

---

### Q17: "What is Terraform and why did you use it instead of manually creating AWS resources?"

> "Terraform is infrastructure-as-code — you describe the infrastructure you want in declarative HCL files, and Terraform creates, updates, or destroys it to match your description.
>
> The problem with manual AWS console: every time you create an EC2 instance, security group, and Elastic IP by hand, you're doing the same work again. If you make a mistake, you fix it manually. If someone else needs to recreate the infrastructure, they have to guess at your configuration. If you want a staging environment that mirrors production, you have to do everything twice.
>
> With Terraform: `terraform apply` creates the EC2 instance, security group with the right ports, Elastic IP, and boots Docker via user_data.sh automatically. `terraform destroy` deletes everything cleanly. `terraform apply` again recreates identically. The whole cycle takes under 5 minutes with zero manual AWS console interaction.
>
> The state is stored in S3 (`backend s3`), not locally or in git. If state was in git, it would expose infrastructure details in plaintext and break when multiple people run apply simultaneously. S3 state is centralized, versioned, and secure."

---

### Q18: "What is a multi-stage Docker build and why does it matter?"

> "A multi-stage Dockerfile has two stages: builder and runner.
>
> Builder stage: installs ALL dependencies (including devDependencies like TypeScript, tsx, @types/*), compiles TypeScript to JavaScript, generates Prisma client. This stage is large — it has the TypeScript compiler, source maps, type definitions, everything.
>
> Runner stage: starts from a clean base image, copies ONLY the compiled output (dist/ folders) and node_modules from the builder. The TypeScript compiler, source files, and dev dependencies never make it into the final image.
>
> Why it matters: production images are smaller (faster to pull in CI/CD, less attack surface), they don't contain source code (no accidental IP exposure), and they don't contain dev tools that don't belong in production.
>
> Concrete example: without multi-stage, the TypeScript compiler (~50MB), all @types packages, tsx, and source .ts files would all be in the production image. With multi-stage, the runner image only has compiled .js files and production node_modules."

---

## SECTION 7: DATABASE & PRISMA

---

### Q19: "Why did you use Prisma instead of raw SQL or another ORM?"

> "Three reasons. First, type safety — Prisma generates TypeScript types directly from the schema. When I add a field like `correlationId` to schema.prisma, run `prisma generate`, and the TypeScript type `EventCreateInput` immediately includes `correlationId`. If I try to insert without a required field, TypeScript catches it at compile time, not at runtime.
>
> Second, migration versioning — `prisma migrate dev` generates SQL migration files with timestamps and names, stored in `prisma/migrations/`. Every schema change is versioned and reproducible. `prisma migrate deploy` applies pending migrations in CI/CD. This is the same principle as Terraform — infrastructure (schema) as code.
>
> Third, the `upsert` primitive — `prisma.event.upsert` is idiomatic and maps directly to PostgreSQL's INSERT ... ON CONFLICT DO UPDATE. Without Prisma, I'd write raw SQL for this, which is more error-prone and harder to read.
>
> The tradeoff: Prisma adds a thin abstraction layer over SQL, so extremely complex queries may need raw SQL via `prisma.$queryRaw`. For the queries in EventFlow, Prisma's generated queries are appropriate."

---

### Q20: "Explain the difference between `prisma migrate` and `prisma generate`."

> "Two completely independent operations that are often confused.
>
> `prisma migrate dev` applies the schema changes to the actual database. It generates a SQL file (e.g., `20260614052634_add_correlation_id/migration.sql`), runs it against PostgreSQL, and records it in the `_prisma_migrations` table. After this, the database has the new column. Your TypeScript code does not yet know about it.
>
> `prisma generate` reads schema.prisma and regenerates the `@prisma/client` package — specifically the TypeScript types like `EventCreateInput`, `EventWhereUniqueInput`, etc. After this, your TypeScript code knows about the new field. The database is unaffected.
>
> Running migrate without generate: database has the column, TypeScript throws 'correlationId does not exist in type EventCreateInput.' Running generate without migrate: TypeScript knows about the field, but the database column doesn't exist, so inserts fail at runtime.
>
> Always run both, in order: migrate first (changes the database), generate second (updates the types)."

---

## SECTION 8: SECURITY

---

### Q21: "How do you store and verify API keys?"

> "API keys are never stored in plaintext. When a key is provisioned, I generate a random 48-byte hex string prefixed with `ef_live_` (or `ep_live_` — the prefix helps identify which system the key belongs to). I then SHA-256 hash it and store only the hash in the database's `api_keys.key_hash` column.
>
> On every request, the incoming key from the `x-api-key` header is hashed with the same SHA-256 function and looked up in the database: `WHERE key_hash = ?`. The plaintext key never touches the database.
>
> Why SHA-256 and not bcrypt? bcrypt is designed to be slow (for password hashing) and adds 50-100ms per request. API key verification happens on every request — that latency is unacceptable. SHA-256 is cryptographically secure for this use case because API keys are long random strings (not low-entropy passwords that benefit from bcrypt's slowness).
>
> The raw key is shown exactly once at provisioning time — matching how AWS displays secret access keys. It cannot be retrieved again because we don't have it."

---

### Q22: "Why does your auth middleware return the same error message for missing and invalid keys?"

> "Both missing and invalid API keys return: `{ 'error': 'Invalid API key' }` (or 'Missing API key' for the completely absent header — actually these are slightly different in the current implementation, but the principle is important).
>
> The security concern is key enumeration. If missing-key returns 'Missing API key' and invalid-key returns 'Invalid API key', an attacker probing your system knows that when they get 'Invalid API key' they've found a valid key format that the system recognizes but rejected. They can use this information to narrow down their brute-force attack.
>
> Similarly: why does GET /events/:jobId return 404 for both 'not found' and 'belongs to another tenant'? Because returning 403 (Forbidden) for cross-tenant access confirms that the resource exists — just not for you. An attacker can enumerate what resources exist by comparing 403 vs 404 responses. Returning 404 in both cases reveals nothing about whether the resource exists."

---

## SECTION 9: LOAD TESTING

---

### Q23: "What did you learn from load testing EventFlow?"

> "Three things.
>
> First, the rate limiter holds correctly under real concurrency. With 20 concurrent connections firing 10,500 requests per second, the sliding window correctly rejected excess traffic with zero connection errors. Every rejection got a proper 429 JSON response. This is the difference between correctness under sequential testing (which is trivially easy to achieve) and correctness under concurrent load (which requires the Redis pipeline to be truly atomic).
>
> Second, latency scales predictably with concurrency. Going from 20 to 30 connections doubled median latency from 1ms to 2ms. This is expected — more goroutines contending for the Redis sorted set operations means more queuing. The relationship is measurable and not surprising, which means the system is behaving deterministically.
>
> Third, the idempotency race condition is actually handled correctly. 10 concurrent connections all hitting POST /events with the same idempotencyKey simultaneously produced exactly one database row. The P2002 catch block that I wrote to handle the race condition actually triggers and works — not just in theory."

---

### Q24: "What is the difference between sequential testing (curl loop) and concurrent load testing (autocannon)?"

> "A for loop of curl commands sends one request, waits for the response, sends the next — sequential. At any given moment, there is exactly one request in flight. This tests correctness (does it return the right response?) but cannot test concurrency behavior.
>
> Autocannon opens N TCP connections simultaneously and fires requests on all of them without waiting. With `-c 20`, 20 requests are in flight simultaneously, all sharing the same Redis connections, the same Postgres connection pool, the same event loop. This creates real resource contention.
>
> The bugs that sequential testing cannot catch: race conditions (require two requests to overlap in time), resource exhaustion (only surfaces when multiple requests compete for the same pool slot simultaneously), and performance characteristics under load (one request at 10ms tells you nothing about what 1000 concurrent requests cost).
>
> My rate limiter passed sequential testing trivially. The interesting test was whether it still worked correctly when 20 requests hit the sorted-set operations at the same millisecond — that's what autocannon verified."

---

## SECTION 10: SWAGGER / API DOCUMENTATION

---

### Q25: "Why did you implement Swagger/OpenAPI documentation? Isn't the README enough?"

> "Three reasons.
>
> First, it stays in sync with the code. The `@openapi` JSDoc annotations live in the same file as the route handler. When you change the route, the annotation is right there — you can't miss it. A README table of endpoints can silently go stale when the code changes. The spec is generated at runtime from the annotations, so it can't drift.
>
> Second, it's interactive. A recruiter or developer can open `/api/v1/docs`, paste their API key in the Authorize button, and send a real request to the live API from the browser. No curl, no Postman setup. This is the fastest possible demo of the backend's capabilities.
>
> Third, the spec is machine-readable. The raw OpenAPI JSON at `/api/v1/docs/spec` can be imported into Postman, used to auto-generate client SDKs, or used in contract testing to verify the API matches its spec in CI."

---

## SECTION 11: GENERAL BACKEND CONCEPTS

---

### Q26: "What is the connection pool problem and how does it apply to EventFlow?"

> "PostgreSQL has a default `max_connections` of 100. Every concurrent query needs its own connection. If you try to open more connections than the limit, new queries queue waiting for a free slot — that queuing time is latency you add on every request.
>
> The math for EventFlow: `worker_instances × concurrency × queries_per_job < max_connections`. With default settings: 1 worker × 5 concurrency × 2 queries (upsert + update) = 10 connections. Well within the limit. But if you scaled to 10 worker instances with concurrency 5, that's 100 connections — hitting the limit. Fix: PgBouncer connection pooler, or Postgres's `max_connections` tuning.
>
> This is why the API and worker are separate processes — they have separate connection pools. The API uses connections for auth lookups and event queries. The worker uses connections for upserts and updates. They don't compete for the same pool."

---

### Q27: "What is AOF persistence in Redis and why does it matter for EventFlow?"

> "AOF (Append-Only File) is a Redis persistence mode where every write command is appended to a log file on disk. If Redis crashes and restarts, it replays the AOF log to restore state — no data loss.
>
> For EventFlow, Redis serves as the BullMQ queue backing store. Jobs sitting in the queue are stored in Redis data structures. Without AOF, a Redis crash or restart means all queued jobs are lost — events accepted by the API but not yet processed simply disappear, with no way to recover them.
>
> With AOF (`--appendonly yes` in docker-compose.yml): Redis replays the log on restart and all jobs are restored. The worker picks them up and processes them normally. Combined with the idempotency layer, even if a job was mid-processing when Redis crashed, re-delivery after restart is handled safely."

---

### Q28: "A senior engineer asks: what would you do differently if building EventFlow again?"

> "Three things.
>
> First, I'd add a proper test suite from the start — not after building. Unit tests for the rate limiting algorithms (especially the Lua token bucket logic), integration tests for the idempotency race condition, and contract tests between API and worker via the EventJob interface. Currently the smoke test in CI only verifies startup, not business logic.
>
> Second, I'd add Loki from the start. The structured Pino logs are production-ready, but they're only visible inside Docker container logs. Loki would aggregate them centrally so you can search across both API and worker logs in Grafana using the correlationId without SSHing into the box.
>
> Third, I'd be more careful about the ESM module setup from day one. The ESM + TypeScript combination requires explicit `.js` extensions on all imports, and this caused a runtime crash in Docker that didn't surface locally because tsx is more lenient. The rule should have been established at project start."

---

## QUICK REFERENCE: KEY NUMBERS

| Metric | Value | Context |
|---|---|---|
| API response time | <20ms (202 Accepted) | Regardless of downstream latency |
| Throughput | 10,535 req/s | 20 concurrent connections, GET /events |
| p50 latency | 1ms | Typical request under load |
| p99 latency | 5ms | Worst 1% under load |
| Rate limit (API key) | 100 req/min | Sliding window, per tenant |
| Rate limit (IP) | 200 req/min | Fixed window, pre-auth |
| Discord rate limit | 30/min (0.5/s refill) | Token bucket, shared across workers |
| Auth cache TTL | 60s | API key cache-aside |
| Event list cache TTL | 5s | Tenant-scoped, GET /events |
| Retry attempts | 3 | Exponential backoff 1s→2s→4s |
| Stalled job check | Every 30s | BullMQ QueueEvents |
| DLQ batch size | 10 jobs | 2s between batches on replay |
| Load test errors | 0 | Across all three autocannon tests |
| Race condition result | 1 DB row | 10 concurrent POSTs, same idempotencyKey |

---

## QUICK REFERENCE: TRADEOFFS TABLE

| Decision | What we chose | What we gave up | Why acceptable |
|---|---|---|---|
| At-least-once delivery | Simplicity, BullMQ handles it | Exactly-once guarantee | Idempotency at 3 layers compensates |
| Cache TTL 60s for auth | Reduced DB load | Revoked keys valid up to 60s | Short enough for security, documented |
| TTL expiry for event list | Simple, no cross-process coupling | Slightly stale data (5s) | Normal for a dashboard |
| Fail-open for IP rate limit | Availability during Redis failure | Enforcement during outage | Brief flood < blocking all users |
| Fail-closed for API key rate limit | SLA enforcement | Brief 503 during Redis failure | Can't enforce quota without state |
| 404 for cross-tenant access | Security (no enumeration) | Less clear error message | Prevents resource enumeration attacks |
| Identical 401 messages | Security (no key enumeration) | Less helpful error for debugging | Prevents brute-force narrowing |
| Single EC2 | Simplicity, cost | Availability, scale | Architecture supports horizontal scale |
| No Loki | Reduced complexity | Centralized log search | Logs are structured, ready for Loki |
