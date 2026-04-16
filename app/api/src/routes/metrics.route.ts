
import { metrics } from "@eventflow/shared";
import { Router } from "express";



const router = Router()

// No auth on metircs- accessed by internal monitoring only
router.get("/metrics",(_,res)=>{
    return res.json(metrics.snapshot())
})

export const metricRouter = router