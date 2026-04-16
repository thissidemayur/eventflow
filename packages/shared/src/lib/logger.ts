import pino from "pino"

export function createLogger(service:string){
    return pino({
        level:process.env.LOG_LEVEL ?? "info",
        base:{
            service
        },
        // in dev pretty print, in production: raw json for log aggregator
        transport: process.env.NODE_ENV!=="production" ? {target:"pino-pretty",options:{colorize:true}} : undefined,
        timestamp:pino.stdTimeFunctions.isoTime
    })
}

export type Logger = ReturnType<typeof createLogger>
