import { createLogger, metrics } from "@eventflow/shared";
import { NextFunction, Response, Request } from "express";
import { redis } from "../config/redis.js";

const logger = createLogger("api:apiKeyRateLimit");

export async function apiKeyRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const apiKeyId = req.apiKeyId;
  if (!apiKeyId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const key = `ratelimit:apikey:${apiKeyId}`;

  const WINDOW = 60;
  const LIMIT = 100;
  const now = Date.now();
  const windowStart = now - WINDOW * 1000;

  try {
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, "-inf", windowStart);
    pipeline.zadd(key, now, `${now}-${Math.random()}`);
    pipeline.zcard(key);
    pipeline.expire(key, WINDOW);

    const results = await pipeline.exec();

    const count = (results?.[2]?.[1] as number) ?? 0;
    const remaining = Math.max(0, LIMIT - count);
    const resetAt = Math.ceil((now + WINDOW * 1000) / 1000);

    res.setHeader("X-RateLimit-Limit", LIMIT);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetAt);

    if (count > LIMIT) {
      metrics.increment("ratelimit.apikey.rejected");
      metrics.increment(`ratelimit.apikey.rejected.${req.tenantId}`);
      logger.warn (
        {
          apiKeyId: req.apiKeyId,
          tenantId: req.tenantId,
          count,
          limit: LIMIT,
        },
        "api key rate limit exceeded",
      );
      
      res.setHeader("Retry-After", WINDOW);
      return res.status(429).json({
        error: "Rate limit exceeded",
        retryAfter: WINDOW,
        resetAt,
      });
    }

    metrics.increment("ratelimit.apikey.allowed");
    return next();

  } catch (err: any) {
    logger.error(
      { error: err.message, apiKeyId: req.apiKeyId },
      "job failed",
    );
    metrics.increment("ratelimit.apikey.failed");
    return res.status(503).json({ error: "Rate limiter unavailable" });
  }
   
}
