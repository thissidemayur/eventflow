import swaggerJsdoc from "swagger-jsdoc";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);




const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "EventFlow API",
      version: "1.0.0",
      description: `
Production-grade event ingestion and async processing system.

## Authentication
All endpoints except \`/health\`, \`/metrics\`, and \`/metrics/json\` require an API key
passed in the \`x-api-key\` header.

The admin endpoint \`POST /admin/tenants\` requires a separate \`x-admin-secret\` header.

## Rate Limiting
- **IP level**: 200 req/min per IP (fixed window, fails open)
- **API key level**: 100 req/min per key (sliding window, fails closed)

Rate limit headers on every authenticated response:
\`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\`, \`X-RateLimit-Reset\`

## Correlation IDs
Every request gets an \`x-request-id\` response header.
Supply your own to trace a request through API logs, worker logs, and the database.
      `,
    },
    servers: [
      { url: "http://localhost:3000", description: "Local development" },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "API key — get one from POST /admin/tenants",
        },
        AdminSecretAuth: {
          type: "apiKey",
          in: "header",
          name: "x-admin-secret",
          description: "Admin secret from ADMIN_SECRET env var",
        },
      },
      schemas: {
        EventStatus: {
          type: "string",
          enum: ["pending", "processing", "completed", "failed"],
          description: "Current processing state of the event",
        },

        EventSummary: {
          type: "object",
          properties: {
            id: {
              type: "string",
              format: "uuid",
              example: "4bb94563-b28a-4d3f-9d48-e5878f0bd091",
            },
            jobId: {
              type: "string",
              example: "4",
              description: "BullMQ job ID — use for status polling",
            },
            eventType: { type: "string", example: "user.signup" },
            status: { $ref: "#/components/schemas/EventStatus" },
            tenantId: { type: "string", example: "tenant-demo" },
            attemptCount: { type: "integer", example: 0 },
            processingDurationMs: {
              type: "integer",
              nullable: true,
              example: 1897,
            },
            receivedAt: {
              type: "string",
              format: "date-time",
              example: "2026-06-15T03:29:27.110Z",
            },
            processedAt: {
              type: "string",
              format: "date-time",
              nullable: true,
              example: "2026-06-15T03:29:29.012Z",
            },
            createdAt: { type: "string", format: "date-time" },
            lastError: { type: "string", nullable: true, example: null },
            idempotencyKey: {
              type: "string",
              nullable: true,
              example: "1fc0893e-d272-4330-a40b-ebb6d9c0c3b6",
            },
            correlationId: {
              type: "string",
              nullable: true,
              example: "00c69254-9f0a-46b9-b9d8-697a31bfbdb5",
              description: "x-request-id — use to grep logs",
            },
          },
        },

        EventDetail: {
          allOf: [
            { $ref: "#/components/schemas/EventSummary" },
            {
              type: "object",
              properties: {
                payload: {
                  type: "object",
                  example: { userId: "u1", email: "test@test.com" },
                  description:
                    "Original event payload — only in single-event endpoint",
                },
              },
            },
          ],
        },

        ValidationError: {
          type: "object",
          properties: {
            error: { type: "string", example: "Validation failed" },
            details: {
              type: "object",
              additionalProperties: {
                type: "array",
                items: { type: "string" },
              },
              example: {
                type: ["Required"],
                payload: ["Expected object, received string"],
              },
            },
          },
        },

        UnauthorizedError: {
          type: "object",
          properties: {
            error: {
              type: "string",
              enum: [
                "Missing API key",
                "Invalid API key",
                "Invalid admin secret",
              ],
              example: "Invalid API key",
            },
          },
        },

        RateLimitError: {
          type: "object",
          properties: {
            error: { type: "string", example: "Rate limit exceeded" },
            retryAfter: {
              type: "integer",
              example: 60,
              description: "Seconds to wait before retrying",
            },
          },
        },
      },
    },
    security: [{ ApiKeyAuth: [] }],
  },
  apis: [
    join(__dirname, "../routes/*.ts"),
    join(__dirname, "../routes/*.js"),
  ],
};

export const swaggerSpec = swaggerJsdoc(options);
