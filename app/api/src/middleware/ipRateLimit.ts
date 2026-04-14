// fixed window rate limit: protect from abusive unauthenticated Rqsts
import { NextFunction,Request,Response } from "express";
import {redis} from "../config/redis"
import { error } from "console";


const WINDOW_SECONDS = 60;
const MAX_REQUESTS_PER_IP = 200

function getClientIp(req:Request):string {
    return req.ip || req.socket.remoteAddress ||"unknown"
}
function normalizeIp(ip:string):string {
    if(ip.startsWith("::ffff:")) {
        return ip.replace("::ffff:","")
    }
    return ip;
}

export async function ipRateLimit(req:Request,res:Response,next:NextFunction) {
   try {
    const ip = normalizeIp(getClientIp(req))
    const key = `ratelimit:ip:${ip}`


    const count = await redis.incr(key)
    if(count ===1) {
        await redis.expire(key,WINDOW_SECONDS)
    }

    res.setHeader("x-RateLimit-Limit",MAX_REQUESTS_PER_IP)
    res.setHeader("X-RateLimit-Remaining",Math.max(0,MAX_REQUESTS_PER_IP-count))

    if(count > MAX_REQUESTS_PER_IP) {
        console.warn(`[Rate limit exceeded for IP: ${ip}]`);
        return res.status(429).json({error:"Too many requests"})
    }
    return next()
   } catch (error:any) {
        console.error(`[Rate limiter error: ]`, error);
        return next()
   }
}