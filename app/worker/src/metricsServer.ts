import { QUEUE_NAME, createLogger, metrics } from "@eventflow/shared";
import http from "http";
import Redis from "ioredis"
const logger = createLogger("worker:createServre")
export function startMetricServer(port=9091):http.Server{
    const server = http.createServer(async(req,res)=>{
        if (req.url === "/metrics" && req.method === "GET") {
          try {
            const output = await metrics.prometheusFormat();
            res.writeHead(200, {
              "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
            });
            res.end(output);
          } catch (error) {
            res.writeHead(500);
            res.end("Failed to generate metrics");
          }
        } else if (req.url === "/health" && req.method === "GET") {
          const checks: Record<string,string> = {
            redis: "unknown",
            queue:"unknown",
            dlq:"unknown"
          }

          // check redis connection
          try {
            // const {createClient} = await import("ioredis")
            const testRedis = new (await import("ioredis")).default(
              process.env.REDIS_URL!,
              {maxRetriesPerRequest:1,connectTimeout:2000}
            )
            await testRedis.ping()
            await testRedis.quit();
            checks.redis="healthy"
          } catch (error) {
            checks.redis="unhealthy"
          }

          // check main queue depth
          try {
            const {Queue} = await import("bullmq")
            const q = new Queue(QUEUE_NAME,{connection:new Redis(process.env.REDIS_URL!)})
            const waiting = await q.getWaitingCount();
            const active = await q.getActiveCount();
            await q.close();

            checks.queue= "healthy";
            checks.queue_waiting=String(waiting)
            checks.queue_active=String(active);
          } catch (error) {
            checks.queue = "unhealthy"
          }

          // check dlq depth
          try {
            const { Queue } = await import("bullmq");
            const dlq = new Queue("events-dlq", {
              connection: new Redis(process.env.REDIS_URL!),
            });
            const dlqCount = await dlq.getWaitingCount();
            await dlq.close();
            checks.dlq = "healthy";
            checks.dlq_waiting = String(dlqCount);
          } catch (error) {
            checks.dlq= "unhealthy"
          }

          const allHealthy = Object.values(checks).filter(v=>v === "healthy" || v === "unhealthy" ).every(v=>v === "healthy")

            res.writeHead(allHealthy ? 200: 503 ,{"Content-Type":"application/json"});
            res.end(JSON.stringify({
              status: allHealthy ? "ok" : "degraded",
              checks,
              timestamp: new Date().toISOString()
            }))

        }else {
            res.writeHead(404);
            res.end("Not Found")
        }
    })

    server.listen(port,()=>{
        logger.info({port},"Worjer metrics server listening.")
    })
    return server;
}