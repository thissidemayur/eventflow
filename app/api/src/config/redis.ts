import { Redis } from "ioredis";
import dotenv from "dotenv"
import path from "node:path";

dotenv.config({
  path: path.resolve(process.cwd(), "../../.env"),
});

export const redis = new Redis(process.env.REDIS_URL!,{})