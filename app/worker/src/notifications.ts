import { prisma } from "@eventflow/db";
import { createLogger, metrics } from "@eventflow/shared";
import { Prisma } from "@prisma/client";

interface NotificationPayload {
  eventType: string;
  tenantId: string;
  payload: Prisma.InputJsonValue;
}

const logger = createLogger("worker:notification")

// send Discord message
async function sendDiscordNotification(
  data: NotificationPayload,
  _idempotencyKey: string,
): Promise<void> {
  const webhookURL = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookURL) {
    logger.warn("DISCORD_WEBHOOK_URL missing- skipping discord notification")
    return;
  }

  const payloadPreview = JSON.stringify(data.payload).slice(0, 900);

  const response = await fetch(webhookURL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({
      content: `New Event: **${data.eventType}**`,
      embeds: [
        {
          title: data.eventType,
          fields: [
            { name: "Tenant", value: data.tenantId, inline: true },
            {
              name: "Payload",
              value: `\`\`\`json\n${payloadPreview}\n\`\`\``,
              inline: false,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    metrics.increment("notifications.discord.failed")
    throw new Error(`Discord webhook failed: ${response.status}`);
  }
  metrics.increment("notifications.discord.sent");
}

// send email
async function sendEmailNotification(
  data: NotificationPayload,
  idempotencyKey: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.NOTIFICATION_EMAIL;

  if (!apiKey || !toEmail) {
    logger.warn(
      "RESEND_API_KEY or NOTIFICATION_EMAIL missing — skipping email",
    );
        return;
  }

  const payloadPreview = JSON.stringify(data.payload, null, 2).slice(0, 2000);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      from: "EventFlow <notifications@thissidemayur.me>",
      to: [toEmail],
      subject: `[EventFlow] New event: ${data.eventType}`,
      html: `
        <div style="font-family: monospace; padding: 24px; background: #0e0f11; color: #e8eaed;">
          <h2 style="color: #3ddc84; margin: 0 0 16px;">EventFlow Notification</h2>
          <table style="border-collapse: collapse; width: 100%;">
            <tr>
              <td style="padding: 8px; color: #9aa0aa; width: 140px;">Event type</td>
              <td style="padding: 8px; color: #e8eaed;">${data.eventType}</td>
            </tr>
            <tr>
              <td style="padding: 8px; color: #9aa0aa;">Tenant</td>
              <td style="padding: 8px; color: #e8eaed;">${data.tenantId}</td>
            </tr>
            <tr>
              <td style="padding: 8px; color: #9aa0aa;">Idempotency key</td>
              <td style="padding: 8px; color: #e8eaed;">${idempotencyKey}</td>
            </tr>
            <tr>
              <td style="padding: 8px; color: #9aa0aa;">Timestamp</td>
              <td style="padding: 8px; color: #e8eaed;">${new Date().toISOString()}</td>
            </tr>
          </table>
          <h3 style="color: #9aa0aa; margin: 24px 0 8px;">Payload</h3>
          <pre style="background: #161719; padding: 16px; border-radius: 6px; overflow-x: auto; color: #3ddc84;">${payloadPreview}</pre>
        </div>
      `,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    metrics.increment("notifications.email.failed");
    throw new Error(`Resend email failed: ${response.status} — ${body}`);
  }
  metrics.increment("notifications.email.sent");
}

// ─── Main exported function ──────────────────────────────────────────────────

export async function sendNotification(
  data: NotificationPayload,
  idempotencyKey: string,
): Promise<void> {
  // Discord idempotency lock
  const discordKey = `discord-${idempotencyKey}`;
  try {
    await prisma.notificationLog.create({
      data: { idempotencyKey: discordKey, channel: "discord" },
    });
  } catch (error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      logger.info({key:discordKey}," notification already sent- skipping discord notification")
      metrics.increment("notifications.skipped");
      // do not return — email may still need to send

    } else {
      throw error;
    }
  }

  // Email idempotency lock
  const emailKey = `email-${idempotencyKey}`;
  try {
    await prisma.notificationLog.create({
      data: { idempotencyKey: emailKey, channel: "email" },
    });
  } catch (error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
          logger.info(
            { key: emailKey },
            " notification already sent- skipping email notification",
          );
        metrics.increment("notifications.skipped");

      // both already sent, nothing to do
      return;
    }
    throw error;
  }

  // Send both — run in parallel, both must succeed
  // If either fails, BullMQ retries the whole job
  // On retry, the insert-first lock above skips the already-sent channel
  await Promise.all([
    sendDiscordNotification(data, idempotencyKey),
    sendEmailNotification(data, idempotencyKey),
  ]);
}
