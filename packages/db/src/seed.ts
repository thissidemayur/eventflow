import { prisma } from "./client";
import { createHash, randomBytes } from "crypto";

async function main() {
  const rawKey = `ef_live_${randomBytes(24).toString("hex")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  const apiKey = await prisma.apiKey.create({
    data: {
      keyHash,
      tenantId: "tenant-test-001",
      active: true,
    },
  });

  console.log("API Key created:");
  console.log({ rawKey, keyHash, id: apiKey.id });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
