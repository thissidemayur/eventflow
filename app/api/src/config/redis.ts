import { createLogger } from "@eventflow/shared";
import { Redis } from "ioredis";

const logger = createLogger("api:redis")


function createRedisConnection(name:string, options:object = {}) {
  const client = new Redis(process.env.REDIS_URL!,{
    lazyConnect:true,
    ...options
  })

  client.on("connect",()=>logger.info({connecttion:name},"redis connected"))
  client.on("error", (err) =>
    logger.error({ connection: name, error: err.message }, "redis error"),
  );
  client.on("connecting", () =>
    logger.warn({ connection: name }, "redis reconnecting"),
  );

  return client;
}

// regular commands (rate limiting, caching)
export const redis = createRedisConnection("api:general")

// bullmq queue producer
export const queueConnection = createRedisConnection("api:queue", {
  maxRetriesPerRequest: null,
});