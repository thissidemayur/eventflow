import { createLogger, metrics } from "@eventflow/shared";
import { Request, Response,Router } from "express";
import { adminAUthMiddleware } from "../middleware/adminAuth.js";
import { createHash, randomBytes, randomUUID } from "crypto";
import { prisma } from "@eventflow/db";

const router = Router();

const logger = createLogger("api:admin");

/**
 * @openapi
 * /api/v1/admin/tenants:
 *   post:
 *     summary: Provision a new tenant and API key
 *     description: |
 *       Creates a new tenant with an active API key. The raw API key is returned
 *       exactly once and cannot be retrieved again — store it immediately.
 *
 *       This endpoint is operator-only, protected by x-admin-secret (not a tenant API key).
 *       In a real multi-tenant SaaS, this would be called by a signup flow. Here it
 *       simulates that provisioning step.
 *     tags: [Admin]
 *     security:
 *       - AdminSecretAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               tenantId:
 *                 type: string
 *                 description: Optional. Auto-generated UUID if omitted.
 *                 example: tenant-acme-corp
 *           examples:
 *             named_tenant:
 *               summary: Named tenant
 *               value:
 *                 tenantId: tenant-acme-corp
 *             auto_generated:
 *               summary: Auto-generated tenantId
 *               value: {}
 *     responses:
 *       201:
 *         description: Tenant and API key created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tenantId:
 *                   type: string
 *                   example: tenant-acme-corp
 *                 apiKeyId:
 *                   type: string
 *                   format: uuid
 *                   example: 93048f50-376d-433c-b3f5-c4763caa5221
 *                 rawAPiKey:
 *                   type: string
 *                   description: Raw API key — shown ONCE, never retrievable again
 *                   example: ep_live363738514d6fc7c108c2431013219574b200bd7dcb5d2bcd
 *                 warning:
 *                   type: string
 *                   example: Store this key now. It cannot be retrieved again
 *       401:
 *         description: Invalid or missing admin secret
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnauthorizedError'
 *       500:
 *         description: Failed to provision tenant
 */
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