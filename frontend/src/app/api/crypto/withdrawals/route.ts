import { NextRequest } from "next/server";
import { z } from "zod";
import { created, handleApi, ok } from "@/lib/api";
import { auditLog, notifyUser } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { plainText } from "@/lib/sanitize";
import { getAdminCryptoPrices, resolveRateFromMap } from "@/lib/crypto-prices";
import { sendTransactionalEmail } from "@/lib/transactional-email";
import {
  createManualReservation,
  getManualPayoutSettings,
  releaseCryptoReservation,
  reserveCryptoBalance
} from "@/lib/manual-payouts";

const schema = z.object({
  asset: z.string().min(2).max(12),
  network: z.string().min(2).max(40),
  amount: z.coerce.number().positive(),
  recipientAddress: z.string().min(4).max(160),
  notes: z.string().max(500).optional()
});

export async function GET() {
  return handleApi(async () => {
    const user = await requireUser();
    const withdrawals = await prisma.cryptoWithdrawalRequest.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 30
    });
    return ok({ withdrawals });
  });
}

export async function POST(request: NextRequest) {
  return handleApi(async () => {
    const user = await requireUser();
    const input = schema.parse(await request.json());
    const asset = input.asset.toUpperCase();
    const settings = await getManualPayoutSettings();

    if (!settings.cryptoTransferEnabled) {
      throw Object.assign(new Error("Manual crypto transfers are currently unavailable."), { status: 400 });
    }

    const cryptoBal = await prisma.userCryptoBalance.findUnique({
      where: { userId_symbol: { userId: user.id, symbol: asset } }
    });
    if (!cryptoBal || cryptoBal.balance < input.amount) {
      throw Object.assign(new Error(`Insufficient ${asset} balance.`), { status: 400 });
    }

    const reserved = await reserveCryptoBalance(user.id, asset, input.amount);
    if (!reserved) {
      throw Object.assign(new Error(`Insufficient available ${asset} balance. Some funds may already be pending.`), { status: 400 });
    }

    const reference = `CWDRAW-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    let withdrawal: Awaited<ReturnType<typeof prisma.cryptoWithdrawalRequest.create>> | null = null;

    try {
      withdrawal = await prisma.cryptoWithdrawalRequest.create({
        data: {
          userId: user.id,
          asset,
          network: input.network,
          amount: input.amount,
          recipientAddress: plainText(input.recipientAddress, 160),
          notes: input.notes ? plainText(input.notes, 500) : null,
          status: "PENDING_REVIEW",
          adminMessage: "Transfer submitted. Pending admin approval.",
          reference
        }
      });

      await createManualReservation({
        id: withdrawal.id,
        kind: "CRYPTO",
        userId: user.id,
        asset,
        amount: input.amount,
        currency: asset
      });
    } catch (error) {
      if (withdrawal) {
        await prisma.cryptoWithdrawalRequest.delete({ where: { id: withdrawal.id } }).catch(() => undefined);
      }
      await releaseCryptoReservation(user.id, asset, input.amount).catch(() => undefined);
      throw error;
    }

    const cryptoAccount = await prisma.account.findFirst({ where: { userId: user.id, type: "CRYPTO" } });
    if (cryptoAccount) {
      try {
        const prices = await getAdminCryptoPrices();
        const rateUSD = resolveRateFromMap(asset, prices);
        if (rateUSD) {
          await prisma.transaction.create({
            data: {
              accountId: cryptoAccount.id,
              type: "CRYPTO_WITHDRAW",
              amount: -Math.abs(input.amount * rateUSD),
              currency: "USD",
              description: plainText(`Withdraw ${input.amount} ${asset} on ${input.network}`, 180),
              reference: `TX-${reference}`,
              status: "REVIEW"
            }
          });
        }
      } catch (err) {
        console.error("[crypto/withdrawals] transaction record failed:", err);
      }
    }

    await notifyUser(user.id, {
      type: "SYSTEM",
      title: "Crypto transfer submitted",
      body: "Your transfer has been submitted and is pending admin approval."
    });

    await auditLog({
      actorId: user.id,
      action: "CRYPTO_WITHDRAW_REQUESTED",
      entity: "CryptoWithdrawalRequest",
      entityId: withdrawal.id,
      metadata: { asset, network: input.network, amount: input.amount, reference, fundsReserved: true }
    });
    await sendTransactionalEmail({
      event: "CRYPTO_WITHDRAWAL_REQUESTED",
      to: user.email,
      idempotencyKey: `crypto-withdrawal-requested:${withdrawal.id}`,
      relatedUserId: user.id,
      relatedEntityType: "CryptoWithdrawalRequest",
      relatedEntityId: withdrawal.id,
      data: {
        customerName: `${user.firstName} ${user.lastName}`,
        transactionType: `${asset} withdrawal on ${input.network}`,
        amount: input.amount,
        currency: asset,
        status: withdrawal.status,
        transactionReference: reference,
        timestamp: withdrawal.createdAt,
        nextStep: "Submitted. The amount is reserved and pending admin approval."
      }
    });

    return created({
      withdrawalId: withdrawal.id,
      reference,
      status: "PENDING_REVIEW",
      message: "Transfer submitted. Status: Pending."
    });
  });
}
