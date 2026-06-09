import { Request, Response, NextFunction } from "express";
import { createLogger, hashApiKey, metrics } from "@eventflow/shared";
import { prisma } from "@eventflow/db";

const logger = createLogger("api:auth")

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
 
   const keyRecord = await prisma.apiKey.findUnique({
     where: { keyHash: hashed },
   });
 
   if (!keyRecord || !keyRecord.active) {
    logger.warn({keyHashPrefix:hashed.slice(0,8)} ,"Invalid API key")
    metrics.increment("auth.invalid_key")
     return res.status(401).json({ error: "Invalid API key" });
   }
 
   req.apiKeyId = keyRecord.id
   req.tenantId = keyRecord.tenantId
   metrics.increment("auth.success");
   return next();
 } catch (error) {
    logger.error({error:(error as Error).message},"auth DB lookup failed")
    metrics.increment("auth.error")
    return res.status(500).json({ error: "Internal server error" });
 }
}
