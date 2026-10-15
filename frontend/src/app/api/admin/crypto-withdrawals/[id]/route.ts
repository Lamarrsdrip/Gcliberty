import { NextRequest } from "next/server";
import { z } from "zod";
import { handleApi, ok } from "@/lib/api";
import { auditLog, notifyUser } from "@/lib/audit";
import { requireAdmin, requestIpAndAgent } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sendTransactionalEmail } from "@/lib/transactional-email";
import {
  approveCryptoReservation,
  getManualReservation,
  markManualReservation,
  releaseCryptoReservation
} from "@/lib/manual-payouts";

const schema = z.object({
  status: z.enum(["PENDING_REVIEW", "APPROVED", "FAILED"]),
  adminMessage: z.string().min(1).max(500)
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const input = schema.parse(await request.json());
    const { ip, userAgent } = await requestIpAndAgent();

    const existing = await prisma.cryptoWithdrawalRequest.findUnique({ where: { id }, include: { user: true } });
    if (!existing) {
      throw Object.assign(new Error("Withdrawal request not found."), { status: 404 });
    }
    if (["APPROVED", "FAILED"].includes(existing.status)) {
      throw Object.assign(new Error(`This withdrawal is already ${existing.status.toLowerCase()}.`), { status: 409 });
    }

    const reservation = await getManualReservation(id);
    const hasReservedFunds = reservation?.kind === "CRYPTO" && reservation.status === "ACTIVE";

    const claimed = await prisma.cryptoWithdrawalRequest.updateMany({
      where: { id, status: { notIn: ["APPROVED", "FAILED"] } },
      data: { status: "PENDING_REVIEW", adminMessage: input.adminMessage }
    });
    if (claimed.count !== 1) {
      throw Object.assign(new Error("Withdrawal was finalized by another reviewer."), { status: 409 });
    }

    if (input.status === "APPROVED") {
      if (hasReservedFunds) {
        const debited = await approveCryptoReservation(existing.userId, existing.asset, Number(existing.amount));
        if (!debited) {
          throw Object.assign(new Error(`Cannot approve: reserved ${existing.asset} funds are no longer available.`), { status: 409 });
        }
      } else {
        const debited = await prisma.userCryptoBalance.updateMany({
          where: { userId: existing.userId, symbol: existing.asset, balance: { gte: existing.amount } },
          data: { balance: { decrement: existing.amount } }
        });
        if (debited.count !== 1) {
          throw Object.assign(new Error(`Cannot approve: user does not have sufficient ${existing.asset} balance.`), { status: 400 });
        }
      }

      await prisma.cryptoWithdrawalRequest.update({
        where: { id },
        data: { status: "APPROVED", adminMessage: input.adminMessage }
      });
      if (hasReservedFunds) await markManualReservation(id, "APPROVED");
    } else if (input.status === "FAILED") {
      if (hasReservedFunds) {
        const released = await releaseCryptoReservation(existing.userId, existing.asset, Number(existing.amount));
        if (!released) {
          throw Object.assign(new Error("Could not release the reserved crypto balance. Refresh and retry."), { status: 409 });
        }
      }
      await prisma.cryptoWithdrawalRequest.update({
        where: { id },
        data: { status: "FAILED", adminMessage: input.adminMessage }
      });
      if (hasReservedFunds) await markManualReservation(id, "RELEASED");
    }

    const withdrawal = await prisma.cryptoWithdrawalRequest.findUnique({ where: { id } });
    const statusLabel =
      input.status === "PENDING_REVIEW" ? "pending" :
      input.status === "APPROVED" ? "approved" : "failed";

    await notifyUser(existing.userId, {
      type: "SYSTEM",
      title: `Crypto transfer ${statusLabel}`,
      body: input.adminMessage
    });

    await auditLog({
      actorId: admin.id,
      action: "ADMIN_CRYPTO_WITHDRAWAL_UPDATED",
      entity: "CryptoWithdrawalRequest",
      entityId: id,
      metadata: { status: input.status, adminMessage: input.adminMessage, hadReservation: hasReservedFunds },
      ip,
      userAgent
    });
    await sendTransactionalEmail({
      event: input.status === "APPROVED" ? "CRYPTO_WITHDRAWAL_APPROVED" : input.status === "FAILED" ? "CRYPTO_WITHDRAWAL_FAILED" : "CRYPTO_WITHDRAWAL_PENDING",
      to: existing.user.email,
      idempotencyKey: `crypto-withdrawal-status:${id}:${input.status}`,
      relatedUserId: existing.userId,
      relatedEntityType: "CryptoWithdrawalRequest",
      relatedEntityId: id,
      data: {
        customerName: `${existing.user.firstName} ${existing.user.lastName}`,
        transactionType: `${existing.asset} transfer on ${existing.network}`,
        amount: existing.amount,
        currency: existing.asset,
        status: input.status,
        transactionReference: existing.reference,
        explanation: input.adminMessage,
        timestamp: withdrawal?.updatedAt ?? new Date(),
        nextStep: input.status === "APPROVED" ? "The approved amount has been debited and operations will complete the external transfer." : input.status === "FAILED" ? "The reserved amount has been released back to your available balance." : "No action is required while the transfer is pending."
      }
    });

    return ok({ withdrawal });
  });
}
