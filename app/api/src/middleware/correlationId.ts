import {Request,Response, NextFunction} from "express"
import {randomUUID} from "crypto"

export function correlationIdMiddleware(req:Request,res:Response,next:NextFunction):void
{
    const correlationId = (req.headers["x-request-id"] as string) ?? randomUUID();
    req.correlationId = correlationId

    // echo it back in response header
    res.setHeader("x-request-id",correlationId)

    next()
}