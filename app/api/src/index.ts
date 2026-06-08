import express, { NextFunction, Response, Request } from "express";
import { eventRouter } from "./routes/events.route.js";
import { createLogger } from "@eventflow/shared";
import { metricRouter } from "./routes/metrics.route.js";
import { healthRouter } from "./routes/health.route.js";

const app = express()

const logger = createLogger("api:index")

app.use((req:Request,res:Response,next:NextFunction)=>{
  const start = Date.now()
  // tell every rqst. 
  res.on("finish",()=>{
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: Date.now() - start,
      apiKeyId:req.apiKeyId ?? null,
      tenantId:req.tenantId ?? null,
    },"request completed");

  })

  next()
})

app.use(express.json())
app.set("trust proxy",false) // no proxy use

// routes 
app.use("/api/v1",eventRouter)
app.use("/api/v1", metricRouter);
app.use("/api/v1", healthRouter);


const PORT = process.env.PORT ?? 3000

app.listen(PORT,()=>{
	logger.info({port:PORT},`API listening on port `)
})

