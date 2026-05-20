import { Router, Response, Request } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { validateEvent } from "../middleware/validate.js";
import { eventQueue } from "../config/queue.js";
import { ipRateLimit } from "../middleware/ipRateLimit.js";

const router = Router()

router.post("/events",ipRateLimit, authMiddleware, validateEvent, async (req: Request, res: Response) => {
    // add bussiness logic + enqeue logic
    const job = await eventQueue.add("process-event", {
        eventType:req.validatedEvent?.type!,
        payload:req.validatedEvent?.payload!,
        tenantId:req.tenantId!,
        idempotencyKey :req.validatedEvent?.idempotencyKey,
        apikeyId:req.apiKeyId!,
        receivedAt: new Date().toISOString()
    })
    console.log("JOB: ", job);

    res.status(202).json({ activated:true,jobId:job.id  })

})

export const eventRouter = router