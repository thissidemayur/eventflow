import { Request, Response, NextFunction } from "express";
import { hashApiKey } from "@eventflow/shared";
import { prisma } from "@eventflow/db";

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (!apiKey) return res.status(401).json({ error: "Missing API key" });

  const hashed = hashApiKey(apiKey);

  const keyRecord = await prisma.apiKey.findUnique({
    where: { keyHash: hashed },
  });

  


  if (!keyRecord || !keyRecord.active) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  return next();
}
