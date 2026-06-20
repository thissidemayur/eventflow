import { prisma } from "@eventflow/db";
import { Router } from "express";
import { redis } from "../config/redis.js";
import { createLogger, metrics } from "@eventflow/shared";

const healthRouter = Router();
const logger = createLogger("api:health");



/**
 * @openapi
 * /api/v1/health:
 *   get:
 *     summary: Dependency health check
 *     description: |
 *       Returns live status of PostgreSQL and Redis.
 *       Used by Docker healthcheck and load balancers.
 *       **Do not cache** — must always reflect live dependency state.
 *     tags: [System]
 *     security: []
 *     responses:
 *       200:
 *         description: All dependencies healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 checks:
 *                   type: object
 *                   properties:
 *                     postgres:
 *                       type: string
 *                       example: healthy
 *                     redis:
 *                       type: string
 *                       example: healthy
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *             example:
 *               status: ok
 *               checks:
 *                 postgres: healthy
 *                 redis: healthy
 *               timestamp: "2026-06-15T03:13:30.706Z"
 *       503:
 *         description: One or more dependencies degraded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: degraded
 *                 checks:
 *                   type: object
 *             example:
 *               status: degraded
 *               checks:
 *                 postgres: unhealthy
 *                 redis: healthy
 *               timestamp: "2026-06-15T03:13:30.706Z"
 */
healthRouter.get("/health", async (_, res) => {
  const checks = {
    postgres: "unknown",
    redis: "unknown",
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.postgres = "healthy";
  } catch (error: any) {
    checks.postgres = "unhealthy";
    logger.error({ error: error?.message }, "postgress health check failed");
    metrics.increment("postgres.down");
  }

  try {
    await redis.ping();
    checks.redis = "healthy";
  } catch (error: any) {
    checks.redis = "unhealthy";
    logger.error({ error: error.message }, "redis health check failed");
    metrics.increment("redis.down");
  }

  const allHealthy = Object.values(checks).every((v) => v === "healthy");

  return res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? "ok" : "degraded",
    checks,
    timestamp: new Date().toISOString(),
  });
});

export { healthRouter };
