import { NextRequest } from "next/server";
import { z } from "zod";
import { handleApi, ok } from "@/lib/api";
import { auditLog, notifyUser } from "@/lib/audit";
import { requireAdmin, requestIpAndAgent } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { computeApprovalDebit } from "@/lib/domain";
import { sendTransactionalEmail, transferStatusEmailEvent } from "@/lib/transactional-email";
import { getManualReservation, markManualReservation } from "@/lib/manual-payouts";

const schema = z.object({
  status: z.enum(["UNDER_REVIEW", "APPROVED", "REJECTED", "CANCELLED"]),
  adminNote: z.string().min(3)
});

const TERMINAL_STATUSES = new Set(["APPROVED", "REJECTED", "CANCELLED"]);

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const input = schema.parse(await request.json());
    const { ip, userAgent } = await requestIpAndAgent();

    const existing = await prisma.transferRequest.findUnique({
      where: { id },
      include: { fromAccount: true, user: true }
    });
    if (!existing) throw new Response("Transfer request not found.", { status: 404 });
    if (TERMINAL_STATUSES.has(existing.status)) {
      throw new Response(`Transfer is already ${existing.status.toLowerCase()} and cannot be modified.`, { status: 409 });
    }

    const reservation = await getManualReservation(id);
    const hasReservedFunds = reservation?.kind === "BANK" && reservation.status === "ACTIVE";

    if (input.status === "APPROVED") {
      const outcome = computeApprovalDebit({
        currentStatus: existing.status,
        amount: Number(existing.amount),
        account: {
          balance: Number(existing.fromAccount.balance),
          availableBalance: Number(existing.fromAccount.availableBalance) + (hasReservedFunds ? Number(existing.amount) : 0),
          status: existing.fromAccount.status
        }
      });
      if (!outcome.ok) throw new Response(outcome.reason, { status: 400 });

      try {
        await prisma.$transaction(async (tx) => {
          const claim = await tx.transferRequest.updateMany({
            where: { id, status: { notIn: ["APPROVED", "REJECTED", "CANCELLED"] } },
            data: { status: "UNDER_REVIEW" }
          });
          if (claim.count !== 1) throw new Response("Transfer was already finalized by another reviewer.", { status: 409 });

          const debited = await tx.account.updateMany({
            where: {
              id: existing.fromAccount.id,
              status: "ACTIVE",
              balance: { gte: outcome.debit },
              ...(hasReservedFunds ? {} : { availableBalance: { gte: outcome.debit } })
            },
            data: hasReservedFunds
              ? { balance: { decrement: outcome.debit } }
              : { availableBalance: { decrement: outcome.debit }, balance: { decrement: outcome.debit } }
          });
          if (debited.count !== 1) {
            throw new Response("Insufficient balance at approval time. Refresh and review the account before retrying.", { status: 409 });
          }

          await tx.transaction.create({
            data: {
              accountId: existing.fromAccount.id,
              type: "TRANSFER_DEBIT",
              amount: -outcome.debit,
              currency: existing.currency,
              description: `Transfer to ${existing.beneficiaryName}`,
              reference: `TRF-${existing.id}`,
              status: "POSTED"
            }
          });
          await tx.transferRequest.update({ where: { id }, data: { status: "APPROVED", adminNote: input.adminNote } });
        });
        if (hasReservedFunds) await markManualReservation(id, "APPROVED");
      } catch (error) {
        if (error instanceof Response) throw error;
        await auditLog({
          actorId: admin.id,
          action: "ADMIN_TRANSFER_APPROVAL_FAILED",
          entity: "TransferRequest",
          entityId: id,
          metadata: { reason: error instanceof Error ? error.message : "Unknown ledger failure" },
          ip,
          userAgent
        });
        throw new Response("Transfer approval could not be committed atomically. Confirm the production MongoDB deployment supports transactions, then retry.", { status: 503 });
      }
    } else if ((input.status === "REJECTED" || input.status === "CANCELLED") && hasReservedFunds) {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.transferRequest.updateMany({
          where: { id, status: { notIn: ["APPROVED", "REJECTED", "CANCELLED"] } },
          data: { status: input.status, adminNote: input.adminNote }
        });
        if (updated.count !== 1) throw new Response("Transfer was already finalized by another reviewer.", { status: 409 });
        await tx.account.update({
          where: { id: existing.fromAccount.id },
          data: { availableBalance: { increment: Number(existing.amount) } }
        });
      });
      await markManualReservation(id, "RELEASED");
    } else {
      await prisma.transferRequest.update({ where: { id }, data: { status: input.status, adminNote: input.adminNote } });
    }

    const transfer = await prisma.transferRequest.findUnique({ where: { id } });

    await notifyUser(existing.userId, {
      type: "SYSTEM",
      title: `Transfer ${input.status.replace("_", " ").toLowerCase()}`,
      body: input.adminNote
    });
    await auditLog({
      actorId: admin.id,
      action: "ADMIN_REVIEWED_TRANSFER",
      entity: "TransferRequest",
      entityId: id,
      metadata: { ...input, hadReservation: hasReservedFunds },
      ip,
      userAgent
    });
    await sendTransactionalEmail({
      event: transferStatusEmailEvent(input.status),
      to: existing.user.email,
      idempotencyKey: `transfer-status:${id}:${input.status}`,
      relatedUserId: existing.userId,
      relatedEntityType: "TransferRequest",
      relatedEntityId: id,
      data: {
        customerName: `${existing.user.firstName} ${existing.user.lastName}`,
        transactionType: existing.type,
        amount: existing.amount,
        currency: existing.currency,
        status: input.status,
        maskedAccount: `•••• ${existing.fromAccount.accountNumber.slice(-4)}`,
        transactionReference: `GCLB-${id.slice(-8).toUpperCase()}`,
        explanation: input.adminNote,
        timestamp: new Date(),
        nextStep: input.status === "APPROVED" ? "The approved amount has been debited and operations will complete the external transfer." : input.status === "REJECTED" || input.status === "CANCELLED" ? "The reserved amount has been released back to your available balance." : "No action is required while the transfer is pending."
      }
    });

    return ok({ transfer });
  });
}
