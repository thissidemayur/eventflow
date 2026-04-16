
import { prisma } from "@eventflow/db";
import { Router } from "express";
import { redis } from "../config/redis";



const healthRouter = Router()

healthRouter.get("/health",async(req,res)=>{
    const checks = {
        postgress:"unknowm",
        redis:"unknown"
    }

    try {
        await prisma.$queryRaw`SELECT 1`;
        checks.postgress = "healthy"
    } catch {
        checks.postgress = "unhealthy"
    }

    try {
       await redis.ping()
       checks.redis = "healthy" 
    } catch  {
        checks.postgress = "unhealthy"
    }

    const allHealthy = Object.values(checks).every(v=>v === "healthy")

    return res.status(allHealthy ? 200 : 503).json({
        status:allHealthy ? "ok": "degrade",
        checks,
        timestamp:new Date().toISOString()
    })
})
export  {healthRouter}