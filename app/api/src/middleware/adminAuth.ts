import { createLogger, metrics } from "@eventflow/shared";
import {Request,Response,NextFunction} from "express"

const logger = createLogger("api:admin-auth")


export function adminAUthMiddleware(req:Request,res:Response,next:NextFunction):void{


    const providedSecret = req.headers["x-admin-secret"];
    const expectedSecret = process.env.ADMIN_SECRET

    if(!expectedSecret) {
        logger.error("ADMIN_SECRET not configured in environment");
        res.status(500).json({error:"Admin endpoints not configured"})
        return;
    }
    if(!providedSecret || providedSecret !!== expectedSecret){
        logger.warn({correlationId:req.correlationId},"admin auth failed")
        metrics.increment("admin.auth_failed");
        res.status(401).json({error:"Invalid admin secret"});
        return;
    }

    next();
}