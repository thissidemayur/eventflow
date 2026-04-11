import { z } from "zod";

export const EventSchema = z.object({
  type: z.string().min(1).max(100),
  payload: z
    .record(z.string(), z.any())
    .refine((p) => JSON.stringify(p).length <= 65536, {
      message: "payload too large (max 64kb)",
    }),
  idempotencyKey: z.uuid().optional(),
  timestamp: z.iso.datetime().optional(),
});

export type EventInput = z.infer<typeof EventSchema>