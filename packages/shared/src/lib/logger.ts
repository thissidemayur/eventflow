import pino from "pino";

const allowedLevels = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;

type LogLevel = (typeof allowedLevels)[number];

function resolveLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL;

  if (envLevel && allowedLevels.includes(envLevel as LogLevel)) {
    return envLevel as LogLevel;
  }

  return "info";
}

export function createLogger(service: string) {
  return pino({
    level: resolveLogLevel(),

    base: {
      service,
    },

    transport:
      process.env.NODE_ENV !== "production"
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
            },
          }
        : undefined,

    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
