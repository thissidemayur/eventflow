import { createHash } from "crypto";

export const hashApiKey = (key:string):string => {
    const hash =  createHash("sha256").update(key).digest("hex")
    return hash
}
