
import { metrics } from "@eventflow/shared";
import { Router } from "express";



const router = Router()

/**
 * @openapi
 * /api/v1/metrics/json:
 *   get:
 *     summary: Metrics snapshot (JSON)
 *     description: Same metrics as /metrics but in JSON format. Useful for ad-hoc inspection or dashboards.
 *     tags: [System]
 *     security: []
 *     responses:
 *       200:
 *         description: Metrics snapshot
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 metrics:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         example: eventflow_events_accepted_total
 *                       type:
 *                         type: string
 *                         enum: [counter, gauge, histogram, summary]
 *                       values:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             value:
 *                               type: number
 *                             labels:
 *                               type: object
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
router.get("/metrics/json",async (_,res)=>{
    const snapshots = await metrics.snapshot();
    return res.json(snapshots)
})

/**
 * @openapi
 * /api/v1/metrics:
 *   get:
 *     summary: Prometheus metrics
 *     description: |
 *       Returns metrics in Prometheus exposition format (text/plain).
 *       Scraped by Prometheus every 15s. Do not expose publicly in production.
 *       Covers auth, rate limiting, events, jobs, notifications, DLQ, and cache hit/miss rates.
 *     tags: [System]
 *     security: []
 *     responses:
 *       200:
 *         description: Prometheus text format metrics
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *             example: |
 *               # HELP eventflow_events_accepted_total Total events accepted and enqueued
 *               # TYPE eventflow_events_accepted_total counter
 *               eventflow_events_accepted_total 6
 */
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