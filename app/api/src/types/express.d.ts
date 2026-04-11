import { EventInput } from "@eventflow/shared";
import "express"
declare module "express-serve-static-core" {
  interface Request {
    apiKeyId?: string;
    tenantId?: string;
    validatedEvent?:EventInput
  }
}