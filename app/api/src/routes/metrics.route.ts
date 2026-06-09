
import { metrics } from "@eventflow/shared";
import { Router } from "express";



const router = Router()

// No auth on metircs- accessed by internal monitoring only

router.get("/metrics/json",async (_,res)=>{
    const snapshots = await metrics.snapshot();
    return res.json(snapshots)
})

// promotheous endpoints- scraped by pormotheous every 15s
router.get("/metrics",async(_,res)=>{
    try {
        const output = await metrics.prometheusFormat();
        res.set("Content-Type","text/plain; version=0.0.4; charset=utf-8")
        return res.send(output)
    }catch{
        return res.status(500).send("Failed to generate metrics")
    }
    
})

export const metricRouter = router