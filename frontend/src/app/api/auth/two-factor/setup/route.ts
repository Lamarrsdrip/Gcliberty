import qrcode from "qrcode";
import speakeasy from "speakeasy";
import { handleApi, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function POST() {
  return handleApi(async () => {
    const user = await requireUser();
    const secret = speakeasy.generateSecret({
      name: `Gcliberty (${user.email})`,
      issuer: "Gcliberty"
    });
    await prisma.user.update({ where: { id: user.id }, data: { twoFactorSecret: secret.base32, twoFactorEnabled: false } });
    const qrCode = await qrcode.toDataURL(secret.otpauth_url ?? "");

    return ok({ secret: secret.base32, qrCode });
  });
}
