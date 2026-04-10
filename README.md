# EventFlow

## Overview

EventFlow is a backend system designed to **ingest, process, and react to events reliably at scale**.

It decouples request handling from heavy processing using an asynchronous queue-based architecture, ensuring high reliability, scalability, and fault tolerance.

---

## 🚀 Core Capabilities

* Asynchronous event processing using BullMQ
* Reliable job execution with retries and failure handling
* Horizontal scaling via worker-based architecture
* API key–based event ingestion
* Queue-backed decoupling of system components

---

## 🧭 System Overview

![EventFlow Architecture](https://mayurpalproject.s3.ap-south-1.amazonaws.com/readme_photo/eventflow_system_overview.svg)

---

## ⚙️ How It Works

1. Client sends event via HTTP API
2. API validates request and enqueues job in Redis (BullMQ)
3. Worker pulls job from queue
4. Worker processes event and stores result in database
5. Notification service triggers alerts (Discord/Email)

---

## Solution

EventFlow introduces an **asynchronous processing pipeline**:

```
Client → API → Queue → Worker → Processing → Notification + Storage
```

* API remains lightweight and responsive
* Workers process tasks independently
* Failures are retried automatically
* System scales horizontally

---

## Key Concepts

### 1. Event Ingestion

External systems send events via HTTP API using API keys.

### 2. Queue-Based Processing

All events are pushed to a Redis-backed queue (BullMQ), enabling asynchronous execution.

### 3. Worker System

Dedicated workers pull jobs from the queue and process them safely.

### 4. Reliability Mechanisms

* Retry with exponential backoff
* Failure isolation
* Idempotent job handling

### 5. Observability (Planned)

* Structured logging
* Event status tracking
* Failure monitoring

---

## Problem Statement

In traditional systems, APIs often handle heavy tasks synchronously:

* Sending notifications
* Processing events
* Running workflows

This leads to:

* Slow response times
* Poor scalability under load
* Failure propagation (one failure breaks entire request)

---

## Architecture

```
eventflow/
├── apps/
│   ├── api/        # Express API (event ingestion, auth, validation)
│   └── worker/     # BullMQ workers (event processing)
├── packages/
│   ├── db/         # Prisma schema and database access
│   └── shared/     # Shared types and validation (Zod)
├── docker-compose.yml  # Redis + PostgreSQL
└── package.json
```

---

## Tech Stack

* Backend: Node.js, Express
* Queue: BullMQ (Redis)
* Database: PostgreSQL (Prisma)
* Validation: Zod
* Infra: Docker

---

## Why Pull-Based Architecture?

Workers **pull jobs from the queue** instead of being pushed tasks.

This enables:

* Backpressure control (workers decide load)
* Horizontal scaling (multiple workers without coordination)
* Fault tolerance (jobs persist even if workers crash)
* Decoupled system design

---

## Current Status

🚧 In active development

Planned features:

* Event ingestion API
* Queue-based processing
* Worker system
* Retry + failure handling
* Rate limiting
* Observability

---

## Design Philosophy

* Keep API layer lightweight
* Offload heavy work to background workers
* Design for failure first
* Build scalable, decoupled systems

---

## Future Enhancements

* Dead Letter Queue (DLQ)
* Metrics and monitoring (Prometheus/Grafana)
* Multi-tenant API key management
* Webhook and email notifications
* Dashboard for event tracking

---

## Author

Mayur — Backend-focused engineer building production-grade systems.

---

