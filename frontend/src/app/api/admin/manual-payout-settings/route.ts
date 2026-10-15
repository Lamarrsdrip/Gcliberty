import { NextRequest } from "next/server";
import { z } from "zod";
import { handleApi, ok } from "@/lib/api";
import { auditLog } from "@/lib/audit";
import { requireAdmin, requestIpAndAgent } from "@/lib/auth";
import { getManualPayoutSettings, saveManualPayoutSettings } from "@/lib/manual-payouts";

const schema = z.object({
  bankTransferEnabled: z.boolean(),
  cryptoTransferEnabled: z.boolean()
});

export async function GET() {
  return handleApi(async () => {
    await requireAdmin();
    return ok({ settings: await getManualPayoutSettings() });
  });
}

export async function PUT(request: NextRequest) {
  return handleApi(async () => {
    const admin = await requireAdmin();
    const input = schema.parse(await request.json());
    const settings = await saveManualPayoutSettings(input);
    const { ip, userAgent } = await requestIpAndAgent();
    await auditLog({
      actorId: admin.id,
      action: "ADMIN_UPDATED_MANUAL_PAYOUT_MODE",
      entity: "ManualPayoutSetting",
      entityId: "global",
      metadata: input,
      ip,
      userAgent
    });
    return ok({ settings });
  });
}
