import express, { NextFunction, Response, Request } from "express";
import "dotenv/config";
import { eventRouter } from "./routes/events.route";
import { createLogger } from "@eventflow/shared";
import { metricRouter } from "./routes/metrics.route";


const app = express()

const logger = createLogger("api")

app.use((req:Request,res:Response,next:NextFunction)=>{
  const start = Date.now()
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
app.use("/api/v1",eventRouter)
app.use("/api/v1", metricRouter);
app.get("/health",(_,res:Response)=>{
   res.json({
    status:"ok",
    timestamp: new Date().toISOString()
  })
})

const PORT = process.env.PORT ?? 3000

app.listen(PORT,()=>{
	console.log(`API listening on port ${PORT}`)
})

