
import { prisma } from "@eventflow/db";
import { Router } from "express";
import { redis } from "../config/redis.js";



const healthRouter = Router()

healthRouter.get("/health",async(_,res)=>{
    const checks = {
      postgres: "unknown",
      redis: "unknown",
    };

    try {
        await prisma.$queryRaw`SELECT 1`;
        checks.postgres = "healthy"
    } catch {
        checks.postgres = "unhealthy"
    }

    try {
       await redis.ping()
       checks.redis = "healthy" 
    } catch  {
        checks.redis = "unhealthy"
    }

    const allHealthy = Object.values(checks).every(v=>v === "healthy")

    return res.status(allHealthy ? 200 : 503).json({
      status: allHealthy ? "ok" : "degraded",
      checks,
      timestamp: new Date().toISOString(),
    });
})

export  {healthRouter}