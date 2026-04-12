import { Router, Response, Request } from "express";
import { authMiddleware } from "../middleware/auth";
import { validateEvent } from "../middleware/validate";
import { eventQueue } from "../config/queue";



const router = Router()

router.post("/events", authMiddleware, validateEvent, async (req: Request, res: Response) => {
    // add bussiness logic + enqeue logic
    const job = await eventQueue.add("process-event", {
        eventType:req.validatedEvent?.type!,
        payload:req.validatedEvent?.payload!,
        tenantId:req.tenantId!,
        idempotencyKey :req.validatedEvent?.idempotencyKey,
        apikeyId:req.apiKeyId!,
        receivedAt: new Date().toISOString()
    })

    res.status(202).json({ activated:true,jobId:job.id  })

})

export const eventRouter = router