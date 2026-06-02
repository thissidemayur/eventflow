## what is eventflow:
HTTP API accepts events, validates with Zod, checks API key auth
via SHA-256 hash lookup, enforces per-IP fixed window and per-key
sliding window rate limits, then enqueues to BullMQ backed by Redis
and returns 202 in under 20ms.

A separate worker process dequeues jobs, writes to PostgreSQL with
upsert-based idempotency, sends Discord notifications with an
insert-first lock preventing duplicate sends, and retries with
exponential backoff on failure. Dead-lettered jobs are stored for
manual replay.

The system handles at-least-once delivery safely through three layers
of idempotency. Rate limiting uses three different algorithms for
different concerns. All operations are logged with Pino structured
JSON and counted in a metrics endpoint.

