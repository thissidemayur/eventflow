# EventFlow - Problems and Solutions

**Project:** Docker-based microservice event processing system with Express API and BullMQ worker queues

---

## Table of Contents

1. [TypeScript Module Configuration Error](#1-typescript-module-configuration-error)
2. [Redis Port Mapping](#2-redis-port-mapping)
3. [Docker Compose Scaling Failure](#3-docker-compose-scaling-failure)
4. [Prisma Environment Variable Resolution](#4-prisma-environment-variable-resolution-failure)
5. [Prisma Config Discovery](#5-prisma-config-discovery-failure)
6. [Wrong Dockerfile for Worker Service](#6-wrong-dockerfile-used-for-worker-service)
7. [Missing Source Files During Build](#7-missing-source-files-during-docker-build)
8. [BullMQ Dead Letter Queue Bug](#8-bullmq-dead-letter-queue-architecture-bug)
9. [Environment Loading Architecture](#9-environment-loading-architecture-problem)
10. [Node.js ESM Import Resolution](#10-nodejs-esm-import-resolution-failure)
11. [Prisma Client Runtime Resolution](#11-prisma-client-runtime-resolution-failure)

---

## 1. TypeScript Module Configuration Error

### Problem

Build process failed when running `docker compose up -d`:

```
src/lib/loadEnv.ts(5,48): error TS1343: The 'import.meta' meta-property is only allowed 
when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
```

Error occurred during: `npm run build -w @eventflow/shared`

### Root Cause

**File:** `packages/shared/src/lib/loadEnv.ts` (line 5)

```typescript
export function loadEnv(relativeFrom: string = import.meta.url) 
```

**Mismatch:** Code uses ES module syntax (`import.meta`), but TypeScript was configured for CommonJS:

```json
"module": "CommonJS"
```

The `import.meta` meta-property only works with: es2020, es2022, esnext, system, node16, or nodenext.

### Solution

Updated `tsconfig.base.json`:

**Before:**

```json
{
  "compilerOptions": {
    "module": "CommonJS"
  }
}
```

**After:**

```json
{
  "compilerOptions": {
    "module": "ES2022"
  }
}
```

### Result

✅ TypeScript compiler now properly handles `import.meta.url` syntax and generates ES module-compatible code.

---

## 2. Redis Port Mapping

### Decision

Redis port mapping was removed from `docker-compose.yml`.

### Rationale

- **Internal Communication Only:** Redis is only used for internal microservice communication between Express API, BullMQ workers, and rate limiting middleware
- **Docker DNS Networking:** Docker Compose provides internal DNS-based networking between services—no host mapping needed
- **Reduced Exposure:** Removed unnecessary external exposure of infrastructure services
- **Port Collision Avoidance:** Prevents local port conflicts
- **Production-Grade:** Aligns with production architecture where internal services aren't exposed to the host

---

## 3. Docker Compose Scaling Failure

### Problem

Worker scaling failed:

```bash
docker compose up --scale worker=3
```

### Root Cause

`container_name` was hardcoded in docker-compose.yml:

```yaml
container_name: eventflow_worker
```

When scaling, Docker attempts to create:

- `eventflow_worker_1`
- `eventflow_worker_2`
- `eventflow_worker_3`

Hardcoded names prevent this creation.

### Solution

Removed `container_name` from scalable services in `docker-compose.yml`.

### Learning

Docker's scaling mechanism requires containers without hardcoded names to generate unique identifiers automatically.

---

## 4. Prisma Environment Variable Resolution Failure

### Problem

Prisma client generation failed during Docker build:

```
PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL
```

Failed command: `RUN npm run generate -w @eventflow/db`

### Root Cause

**Key Insight:** Build-time and runtime environments are completely separate.

- Prisma client generation executed during Docker image build
- Docker Compose environment variables only exist after containers start
- No containers running during Docker build phase

**Incorrect Assumption:**

```yaml
environment:
  DATABASE_URL: ...
```

This does NOT exist during Docker build—only at runtime.

### Solution

Used Docker build arguments in Dockerfile:

```dockerfile
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL
```

And in `docker-compose.yml`:

```yaml
args:
  DATABASE_URL: postgresql://dummy:dummy@localhost:5432/dummy
```

### Why Dummy URL Works

- `prisma generate` only validates datasource configuration
- It does NOT require an actual database connection
- This keeps builds:
  - ✅ Deterministic
  - ✅ Infrastructure-independent
  - ✅ CI/CD friendly

### Learning

Build-time configuration cannot depend on runtime environment variables. Use build arguments (`ARG`) for compile-time dependencies.

---

## 5. Prisma Config Discovery Failure

### Problem

Migration container failed:

```
Could not find Prisma Schema that is required for this command
```

### Root Cause

Multi-stage Docker builds create isolated filesystems per stage:

- `prisma.config.ts` existed in builder stage
- NOT copied to runtime image
- Runtime container cannot access builder stage files

### Solution

Explicitly copy Prisma config to runtime stage:

```dockerfile
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
```

### Learning

**Critical Rule:** Builder stage filesystem does NOT automatically exist in runtime image. Only explicitly copied artifacts survive the multi-stage build process.

---

## 6. Wrong Dockerfile Used for Worker Service

### Problem

Worker service built the wrong application.

### Root Cause

`docker-compose.yml` referenced API Dockerfile for worker service:

```yaml
services:
  worker:
    dockerfile: app/api/Dockerfile  # ❌ WRONG
```

### Solution

Corrected to use worker Dockerfile:

```yaml
services:
  worker:
    dockerfile: app/worker/Dockerfile  # ✅ CORRECT
```

---

## 7. Missing Source Files During Docker Build

### Problem

TypeScript build failed—source files were missing during Docker image build.

### Root Cause

Dockerfile only copied `package.json` files:

```dockerfile
COPY package.json ./
COPY app/api/package.json ./app/api/
COPY packages/db/package.json ./packages/db/
```

Actual source code directories were never copied.

### Solution

Added explicit source code copy operations:

```dockerfile
COPY packages/shared/ ./packages/shared/
COPY packages/db/ ./packages/db/
COPY app/worker/ ./app/worker/
```

### Learning

**Docker Layer Caching Best Practice:**

1. Copy package manifests first (`package.json`)
2. Install dependencies
3. Copy source code

This optimization maximizes cache reuse—dependency installs aren't repeated unnecessarily.

---

## 8. BullMQ Dead Letter Queue Architecture Bug

### Problem

Failed jobs were accidentally re-entering the primary queue instead of staying in DLQ.

### Root Cause

DLQ used the same queue name:

```typescript
new Queue(QUEUE_NAME)  // ❌ Same name as primary queue
```

### Solution

Created isolated DLQ:

```typescript
new Queue("events-dlq")  // ✅ Dedicated queue name
```

### Learning

**DLQ Isolation Rule:** Dead-letter queues MUST remain isolated from primary processing queues.

Without isolation:

- ❌ Retries become confusing
- ❌ Observability degrades
- ❌ Replay logic becomes dangerous
- ❌ Job tracking fails

---

## 9. Environment Loading Architecture Problem

### Problem

Custom `loadEnv()` utility created fragile runtime behavior.

### Root Cause

Application runtime manually searched filesystem for `.env`:

```typescript
// ❌ Fragile: couples runtime to filesystem
application runtime → searches filesystem → loads .env
```

This tightly coupled:

- Application runtime
- Filesystem layout
- Monorepo structure
- Docker container paths

### Solution

Removed custom runtime env loading. Used:

- **Local Development:** `dotenv-cli`

  ```json
  "dev": "dotenv -e ../../.env -- ts-node-dev ..."
  ```

- **Docker Containers:** Docker Compose `environment:` section

### Learning

**Responsibility Boundary:** Environment bootstrapping belongs to:

- ✅ Launcher / shell
- ✅ Orchestrator (Docker Compose)
- ✅ CI/CD pipeline

NOT to application business logic runtime.

---

## 10. Node.js ESM Import Resolution Failure

### Problem

Runtime crashed:

```
Cannot find module './client'
```

### Root Cause

Node.js ESM requires explicit file extensions for local relative imports:

```typescript
// ❌ ESM: Cannot resolve './client'
import { prisma } from "./client";

// ✅ ESM: Requires explicit extension
import { prisma } from "./client.js";
```

TypeScript preserves import specifiers during compilation. This is automatic in CommonJS but manual in ESM.

### Solution

Changed import to include file extension:

```typescript
import { prisma } from "./client.js";
```

### Learning

**ESM Import Rules:**

| Import Type | Requires Extension |
|---|---|
| Local relative imports | ✅ YES (`./client.js`) |
| Package imports | ❌ NO (`@eventflow/db`) |
| Node builtins | ❌ NO (`node:fs`) |

This is one of the biggest ESM migration pain points.

---

## 11. Prisma Client Runtime Resolution Failure

### Problem

Runtime failed:

```
Cannot find module '/app/packages/db/dist/client'
```

### Root Cause

Incorrect assumption about Prisma client location:

- ❌ Assumed Prisma client existed inside `dist/` (compiled output)
- ✅ Reality: Prisma client is generated into `node_modules/@prisma/client`

Prisma client is a generated runtime dependency, NOT local TypeScript source code.

### Solution

Exported Prisma directly from package entry point:

```typescript
// packages/db/src/client.ts
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
```

Used this in application:

```typescript
import { prisma } from "@eventflow/db";
```

### Learning

**Dependency Classification:**

- **Compiled Code:** TypeScript → JavaScript (goes in `dist/`)
- **Generated Code (Prisma Client):** Stays in `node_modules/@prisma/client`
- **Export Pattern:** Package exports should reference generated deps correctly, not assume they're in build output

---

## Summary

| # | Issue | Category | Status |
|---|---|---|---|
| 1 | TypeScript Module Config | Build Config | ✅ Fixed |
| 2 | Redis Port Mapping | Architecture | ✅ Optimized |
| 3 | Docker Scaling | Docker Config | ✅ Fixed |
| 4 | Prisma Env Variables | Docker Build | ✅ Fixed |
| 5 | Prisma Config Discovery | Docker Staging | ✅ Fixed |
| 6 | Wrong Dockerfile | Docker Config | ✅ Fixed |
| 7 | Missing Source Files | Docker Build | ✅ Fixed |
| 8 | DLQ Architecture | BullMQ Design | ✅ Fixed |
| 9 | Env Loading | Architecture | ✅ Refactored |
| 10 | ESM Import Resolution | Node.js/ESM | ✅ Fixed |
| 11 | Prisma Client Resolution | Dependency Management | ✅ Fixed |
