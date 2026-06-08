
import { prisma } from "@eventflow/db";
import { Router } from "express";
import { redis } from "../config/redis.js";
import { createLogger } from "@eventflow/shared";



const healthRouter = Router()
const logger = createLogger("api:health");

healthRouter.get("/health",async(_,res)=>{
    const checks = {
      postgres: "unknown",
      redis: "unknown",
    };

    try {
        await prisma.$queryRaw`SELECT 1`;
        checks.postgres = "healthy"
    } catch(error:any) {
        checks.postgres = "unhealthy"
        logger.error({error:error?.message},"postgress health check failed")
    }

    try {
       await redis.ping()
       checks.redis = "healthy"
 
    } catch (error: any) {
        checks.redis = "unhealthy"
        logger.error(
                  { error:error.message },
                  "redis health check failed",
        );

    }

    const allHealthy = Object.values(checks).every(v=>v === "healthy")

    return res.status(allHealthy ? 200 : 503).json({
      status: allHealthy ? "ok" : "degraded",
      checks,
      timestamp: new Date().toISOString(),
    });
})

export  {healthRouter}