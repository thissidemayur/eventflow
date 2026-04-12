import express,{Response} from "express"
import "dotenv/config";
import { eventRouter } from "./routes/events.route";

const app = express()
app.use(express.json())

app.use("/api/v1",eventRouter)
app.get("/health",(_,res:Response)=>{
   res.json({
    status:"ok",
    timestamp: new Date().toISOString()
  })
})

const PORT = process.env.PORT ?? 3000

app.listen(PORT,()=>{
	console.log(`API listening on port ${PORT}`)
})

