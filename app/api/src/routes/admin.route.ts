import { createLogger, metrics } from "@eventflow/shared";
import { Request, Response,Router } from "express";
import { adminAUthMiddleware } from "../middleware/adminAuth.js";
import { createHash, randomBytes, randomUUID } from "crypto";
import { prisma } from "@eventflow/db";

const router = Router();

const logger = createLogger("api:admin");


router.post("/admin/tenants",adminAUthMiddleware,async(req:Request,res:Response)=>{
    try {
        const tenantId:string = req.body?.tenantId ?? `tenant-${randomUUID()}`
        const rawKey= `ep_live${randomBytes(24).toString("hex")}`
        const keyHash = createHash("sha256").update(rawKey).digest("hex")

        const apiKey = await prisma.apiKey.create({
            data:{
                keyHash,
                tenantId,
                active:true
            }
        })
        logger.info({
            tenantId,apiKeyId:apiKey.id,correlationId:req.correlationId
        })
        metrics.increment("admin.tenant_created")

        return res.status(201).json({
            tenantId,
            apiKeyId:apiKey.id,
            rawAPiKey:rawKey,
            warning: "Store this key now. It cannot be retrieved again"
        })
    } catch (error:any) {
        logger.error({error:error.message,correlationId:req.correlationId},"failed to provison tenant")
        return res.status(500).json({ error: "Failed to provision tenant" });
    }
})

export const adminRouter = router;