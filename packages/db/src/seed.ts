import { prisma } from "./client.js";
import { createHash, randomBytes } from "crypto";

const DEMO_TENANT_ID = "tenant-demo";

async function main() {
  const existing = await prisma.apiKey.findFirst({
    where: { tenantId: DEMO_TENANT_ID, active: true },
  });

  if (existing) {
    console.log("=".repeat(60));
    console.log("Demo tenant already provisioned.");
    console.log(`tenantId: ${DEMO_TENANT_ID}`);
    console.log("API key was shown only on first run.");
    console.log("To generate a new one, use POST /api/v1/admin/tenants");
    console.log("=".repeat(60));
    return;
  }

  const rawKey = `ef_live_${randomBytes(24).toString("hex")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  const apiKey = await prisma.apiKey.create({
    data: {
      keyHash,
      tenantId: DEMO_TENANT_ID,
      active: true,
    },
  });

  console.log("=".repeat(60));
  console.log("DEMO API KEY CREATED — for local testing only");
  console.log("=".repeat(60));
  console.log(`  tenantId:    ${DEMO_TENANT_ID}`);
  console.log(`  apiKeyId:    ${apiKey.id}`);
  console.log(`  API_KEY:     ${rawKey}`);
  console.log("=".repeat(60));
  console.log("Use this for testing:");
  console.log(`  export API_KEY="${rawKey}"`);
  console.log(`  export BASE="http://localhost:3000/api/v1"`);
  console.log("=".repeat(60));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
