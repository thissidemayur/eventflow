import { EventSchema } from "@eventflow/shared"
import {Request,Response,NextFunction} from "express"

export function validateEvent(req:Request,res:Response,next:NextFunction) {

    const result = EventSchema.safeParse(req.body)

    if(!result.success){
        const { fieldErrors } = result.error.flatten()
        return res.status(400).json({
          error: "Validation failed",
          details: fieldErrors,
        });
    }

    req.validatedEvent = result.data
    return next()
}