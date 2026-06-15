import { Request, Response, NextFunction } from "express";
import { createLogger, hashApiKey, metrics } from "@eventflow/shared";
import { prisma } from "@eventflow/db";
import { redis } from "../config/redis.js";

const logger = createLogger("api:auth")
const CACHE_TTL_SECONDS = 60

interface CachedApiKey {
  apiKeyId: string;
  tenantId: string;
  active: boolean;
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {

  const apiKey = req.headers["x-api-key"] as string | undefined;

  if (!apiKey) {
    metrics.increment("auth.missing_key")
    return res.status(401).json({ error: "Missing API key" });
  }

 try {
   const hashed = hashApiKey(apiKey);
   const cacheKey = `apikey:cache:${hashed}`

    // check cache first
    const cached = await redis.get(cacheKey)
    if(cached) {
      const record: CachedApiKey  = JSON.parse(cached)

      if(!record.active) {
        logger.warn({keyHashPrefix: hashed.slice(0,8)},"Invalid API key (cached)")
        metrics.increment("auth.invalid_key")
        return res.status(401).json({error: "Invalid API key"})
      }

      req.apiKeyId = record.apiKeyId
      req.tenantId = record.tenantId
      
      metrics.increment("auth.success")
      metrics.increment("auth.cache_hit")
      return next()
    }

    // cache miss, fall through to DB
    metrics.increment("auth.cache_miss") 
   
   const keyRecord = await prisma.apiKey.findUnique({
     where: { keyHash: hashed },
   });
 
   if (!keyRecord || !keyRecord.active) {
    logger.warn({keyHashPrefix:hashed.slice(0,8)} ,"Invalid API key")
    metrics.increment("auth.invalid_key")
    
    // cached the -ve result too (if record exists but inactive)
    // prevent revokedKey from hammering the DB
    if(keyRecord) {
      const negativeRecord: CachedApiKey = {
        apiKeyId: keyRecord.id,
        tenantId: keyRecord.tenantId,
        active:false
      }
      await redis.set(cacheKey,JSON.stringify(negativeRecord),"EX",CACHE_TTL_SECONDS)
    }
    return res.status(401).json({ error: "Invalid API key" });
   }

  //  populate cached for next responst
  const record: CachedApiKey = {
    apiKeyId:keyRecord.id,
    tenantId:keyRecord.tenantId,
    active:true
  }
  await redis.set(cacheKey,JSON.stringify(record),"EX",CACHE_TTL_SECONDS)

   req.apiKeyId = keyRecord.id
   req.tenantId = keyRecord.tenantId

   metrics.increment("auth.success");
   return next();
 } catch (error:any) {
    logger.error({error:(error as Error).message},"auth DB lookup failed")
    metrics.increment("auth.error")
    return res.status(500).json({ error: "Internal server error" });
 }
}
