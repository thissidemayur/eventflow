// fixed window rate limit: protect from abusive unauthenticated Rqsts
import { NextFunction, Request, Response } from "express";
import { redis } from "../config/redis.js"
import { createLogger, metrics } from "@eventflow/shared";


const logger = createLogger("api:ratelimit")

function getClientIp(req: Request): string {
    return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || req.socket.remoteAddress || "unknown"
}

function normalizeIp(ip: string): string {
    if (ip.startsWith("::ffff:")) {
        return ip.replace("::ffff:", "")
    }
    return ip;
}

export async function ipRateLimit(req: Request, res: Response, next: NextFunction) {
    const WINDOW_SECONDS = 60;
    const MAX_REQUESTS_PER_IP = 200;

    try {
        const ip = normalizeIp(getClientIp(req))
        const key = `ipRatelimit:ip:${ip}`


        const count = await redis.incr(key)
        if (count === 1) {
            await redis.expire(key, WINDOW_SECONDS)
        }

        res.setHeader("X-RateLimit-Limit-IP", MAX_REQUESTS_PER_IP)
        res.setHeader("X-RateLimit-Remaining-IP", Math.max(0, MAX_REQUESTS_PER_IP - count))

        if (count > MAX_REQUESTS_PER_IP) {
            // metrics.increment("ratelimit.ip.rejected")
            logger.warn({ip,count},"ip rate limit exceed");
            return res.status(429).json({ error: "Too many requests" })
        }
        // metrics.increment("ratelimit.ip.allowed")
        return next()
    } catch (err: any) {
        logger.error({error:err.message},"ip rate limit redis error- failing open")
        // metrics.increment("ratelimit.ip.error")
        return next()
    }
}