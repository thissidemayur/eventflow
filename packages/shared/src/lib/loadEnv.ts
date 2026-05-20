import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnv(relativeFrom: string = import.meta.url) {
  const __filename = fileURLToPath(relativeFrom);
  const __dirname = path.dirname(__filename);
  dotenv.config({
    path: path.resolve(__dirname, "../../../.env"),
  });
}
