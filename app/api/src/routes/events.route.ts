import { Router,Response,Request } from "express";
import { authMiddleware } from "../middleware/auth";
import { validateEvent } from "../middleware/validate";



const router = Router()

router.post("/events",authMiddleware,validateEvent,async(req:Request,res:Response)=>{

    // add bussiness logic + enqeue logic
    res.status(202).json({message:"Event accepted"})
})