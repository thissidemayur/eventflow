import express, { NextFunction, Response, Request } from "express";
import { eventRouter } from "./routes/events.route.js";
import { createLogger, metrics } from "@eventflow/shared";
import { metricRouter } from "./routes/metrics.route.js";
import { healthRouter } from "./routes/health.route.js";
import { correlationIdMiddleware } from "./middleware/correlationId.js";
import { adminRouter } from "./routes/admin.route.js";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./config/swagger.js";

const app = express();
const logger = createLogger("api:index");

app.use(correlationIdMiddleware)

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  // tell every rqst.
  res.on("finish", () => {
    const normalizedPath = req.path
      .replace(/\/[0-9]+/g, "/:id") // /events/317 → /events/:id
      .replace(/\/[a-f0-9-]{36}/g, "/:uuid"); // UUIDs → :uuid

    metrics.trackRequest(req.method, normalizedPath, res.statusCode);
    
    logger.info(
      {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration: Date.now() - start,
        apiKeyId: req.apiKeyId ?? null,
        tenantId: req.tenantId ?? null,
        correlationId: req.correlationId
      },
      "request completed",
    );

    
  });
  next();

  
});

app.use(express.json());
app.set("trust proxy", false); // no proxy use


// expose raw spec as JSON - useful for imorting into postman
app.get("/api/v1/docs/spec",(_,res)=>{
  return res.json(swaggerSpec)
})

// swagger UI- interractive API docs
app.use(
  "/api/v1/docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customSiteTitle: "Eventflow API Docs",
    swaggerOptions: {
      persistAuthorization: true, // keeps API key between page refreshes
      displayRequestDuration: true, // shows how long each request took
      filter: true, // search box to filter endpoints
    },
  }),
);


// routes
app.use("/api/v1", eventRouter);
app.use("/api/v1", metricRouter);
app.use("/api/v1", healthRouter);
app.use("/api/v1", adminRouter);

const PORT = process.env.PORT ?? 3000;

app.listen(PORT, () => {
  logger.info({ port: PORT }, `API listening on port `);
});
