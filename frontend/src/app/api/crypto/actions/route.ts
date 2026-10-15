import { NextRequest } from "next/server";
import { z } from "zod";
import { created, handleApi, ok } from "@/lib/api";
import { auditLog, notifyUser } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { plainText } from "@/lib/sanitize";
import {
  createManualReservation,
  getManualPayoutSettings,
  releaseCryptoReservation,
  reserveCryptoBalance
} from "@/lib/manual-payouts";

const schema = z.object({
  action: z.enum(["WITHDRAW", "SEND", "SWAP"]),
  asset: z.string().min(2).max(12),
  network: z.string().min(2).max(40),
  amount: z.coerce.number().positive(),
  toAsset: z.string().min(2).max(12).optional(),
  recipientAddress: z.string().min(8).max(160).optional(),
  notes: z.string().max(500).optional()
});

export async function GET() {
  return handleApi(async () => {
    const user = await requireUser();
    const cryptoAccount = await prisma.account.findFirst({
      where: { userId: user.id, type: "CRYPTO" },
      include: { transactions: { orderBy: { createdAt: "desc" }, take: 20 } }
    });
    return ok({ history: cryptoAccount?.transactions ?? [] });
  });
}

export async function POST(request: NextRequest) {
  return handleApi(async () => {
    const user = await requireUser();
    const input = schema.parse(await request.json());
    const asset = input.asset.toUpperCase();

    if ((input.action === "WITHDRAW" || input.action === "SEND") && !input.recipientAddress) {
      throw new Response("Recipient wallet address is required.", { status: 400 });
    }
    if (input.action === "SWAP" && !input.toAsset) {
      throw new Response("Select the asset you want to receive.", { status: 400 });
    }

    if (input.action === "WITHDRAW" || input.action === "SEND") {
      const settings = await getManualPayoutSettings();
      if (!settings.cryptoTransferEnabled) {
        throw new Response("Manual crypto transfers are currently unavailable.", { status: 400 });
      }

      const cryptoBal = await prisma.userCryptoBalance.findUnique({
        where: { userId_symbol: { userId: user.id, symbol: asset } }
      });
      if (!cryptoBal || cryptoBal.balance < input.amount) {
        throw new Response(`Insufficient ${asset} balance.`, { status: 400 });
      }

      const reserved = await reserveCryptoBalance(user.id, asset, input.amount);
      if (!reserved) {
        throw new Response(`Insufficient available ${asset} balance. Some funds may already be pending.`, { status: 400 });
      }

      const reference = `${input.action === "SEND" ? "CSEND" : "CWDRAW"}-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      let withdrawal: Awaited<ReturnType<typeof prisma.cryptoWithdrawalRequest.create>> | null = null;
      try {
        withdrawal = await prisma.cryptoWithdrawalRequest.create({
          data: {
            userId: user.id,
            asset,
            network: input.network,
            amount: input.amount,
            recipientAddress: plainText(input.recipientAddress!, 160),
            notes: plainText(`[${input.action}] ${input.notes ?? ""}`.trim(), 500),
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

      await notifyUser(user.id, {
        type: "SYSTEM",
        title: "Crypto transfer submitted",
        body: "Your transfer has been submitted and is pending admin approval."
      });
      await auditLog({
        actorId: user.id,
        action: `CRYPTO_${input.action}_REQUESTED`,
        entity: "CryptoWithdrawalRequest",
        entityId: withdrawal.id,
        metadata: {
          asset,
          network: input.network,
          amount: input.amount,
          recipientAddress: input.recipientAddress,
          reference,
          fundsReserved: true
        }
      });

      return created({
        withdrawalId: withdrawal.id,
        reference,
        status: "PENDING_REVIEW",
        message: "Transfer submitted. Status: Pending."
      });
    }

    const cryptoAccount = await prisma.account.findFirst({ where: { userId: user.id, type: "CRYPTO" } });
    if (!cryptoAccount) {
      throw new Response("Crypto wallet account is not available for swaps.", { status: 400 });
    }

    const reference = `CRYPTO-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const transaction = await prisma.transaction.create({
      data: {
        accountId: cryptoAccount.id,
        type: "CRYPTO_SWAP",
        amount: -Math.abs(input.amount),
        currency: "USD",
        description: plainText(`Swap ${asset} to ${input.toAsset}`, 180),
        reference,
        status: "REVIEW"
      }
    });

    await notifyUser(user.id, {
      type: "SYSTEM",
      title: "Crypto request submitted",
      body: "Your crypto swap request is pending review."
    });
    await auditLog({
      actorId: user.id,
      action: "CRYPTO_SWAP_REQUESTED",
      entity: "Transaction",
      entityId: transaction.id,
      metadata: { asset, toAsset: input.toAsset, network: input.network, notes: input.notes }
    });

    return created({ transaction, message: "Your crypto swap request has been submitted for review." });
  });
}
