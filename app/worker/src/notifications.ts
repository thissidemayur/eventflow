import { prisma } from "@eventflow/db";
import { Prisma } from "@prisma/client";

interface NotificationPayload {
  eventType: string;
  tenantId: string;
  payload: Prisma.InputJsonValue;
}

export async function sendNotification(
  data: NotificationPayload,
  idempotencyKey: string,
) {
  const key = `discord-${idempotencyKey}`;

  // insert-first idempotency
  // if 2 workers race, only 1 insert succeeds
  try {
    await prisma.notificationLog.create({
      data: {
        idempotencyKey: key,
        channel: "discord",
      },
    });

  } catch (error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      console.log(`[Notification ${key}] already recorded — skipping`);
      return;
    }

    throw error;
  }

  const webhookURL = process.env.DISCORD_WEBHOOK_URL;

  if (!webhookURL) {
    console.warn("DISCORD_WEBHOOK_URL missing — skipping notification");
    return;
  }

  // compact preview avoids discord embed limits
  const payloadPreview = JSON.stringify(data.payload).slice(0, 900);
  
  const response = await fetch(webhookURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },

    // never allow external webhook to hang worker forever
    signal: AbortSignal.timeout(5000),

    body: JSON.stringify({
      content: `New Event: **${data.eventType}**`,

      embeds: [
        {
          title: data.eventType,

          fields: [
            {
              name: "Tenant",
              value: data.tenantId,
              inline: true,
            },

            {
              name: "Payload",

              // discord markdown codeblock
              value: `\`\`\`json\n${payloadPreview}\n\`\`\``,

              inline: false,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    // throw so BullMQ retries properly
    throw new Error(`Discord webhook failed: ${response.status}`);
  }
}
