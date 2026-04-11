import "express"
declare module "express-serve-static-core" {
  interface Request {
    apiKeyId?: string;
    tenantId?: string;
  }
}