import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { created, handleApi, ok } from "@/lib/api";
import { auditLog, notifyUser } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { defaultTransferSettings, canSubmitTransfer, formatTransferReference } from "@/lib/domain";
import { transferSchema } from "@/lib/validators";
import { sendTransactionalEmail } from "@/lib/transactional-email";
import { createManualReservation, getManualPayoutSettings } from "@/lib/manual-payouts";

export async function GET() {
  return handleApi(async () => {
    const user = await requireUser();
    const transfers = await prisma.transferRequest.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: { fromAccount: true }
    });
    const settings = await prisma.transferSetting.findUnique({ where: { id: 1 } });
    return ok({ transfers, settings: settings ?? defaultTransferSettings });
  });
}

export async function POST(request: NextRequest) {
  return handleApi(async () => {
    const user = await requireUser();
    const input = transferSchema.parse(await request.json());
    const transferId = createHash("sha256").update(`${user.id}:${input.clientRequestId}`).digest("hex").slice(0, 24);
    const prior = await prisma.transferRequest.findUnique({ where: { id: transferId } });
    if (prior) {
      const policy = (await prisma.transferSetting.findUnique({ where: { id: 1 } })) ?? defaultTransferSettings;
      return ok({ transfer: prior, duplicate: true, message: { ...policy, reference: formatTransferReference(policy.referencePrefix, prior.id), status: prior.status } });
    }

    const account = await prisma.account.findFirst({
      where: { id: input.fromAccountId, userId: user.id, status: "ACTIVE" }
    });
    const settings = await prisma.transferSetting.findUnique({ where: { id: 1 } });
    const policy = settings ?? defaultTransferSettings;
    const manualPayouts = await getManualPayoutSettings();

    if (!account) {
      throw new Response(policy.blockedMessage, { status: 400 });
    }

    const eligibility = canSubmitTransfer({
      amount: input.amount,
      currency: input.currency,
      account: {
        availableBalance: Number(account.availableBalance),
        currency: account.currency,
        status: account.status
      }
    });
    if (!eligibility.ok) {
      throw new Response(`${policy.blockedMessage} ${eligibility.reason}`, { status: 400 });
    }

    let fundsReserved = false;
    if (manualPayouts.bankTransferEnabled) {
      const reserved = await prisma.account.updateMany({
        where: {
          id: account.id,
          userId: user.id,
          status: "ACTIVE",
          availableBalance: { gte: input.amount }
        },
        data: { availableBalance: { decrement: input.amount } }
      });
      if (reserved.count !== 1) {
        throw new Response("Insufficient available balance. Some funds may already be pending.", { status: 409 });
      }
      fundsReserved = true;
    }

    let transfer: Awaited<ReturnType<typeof prisma.transferRequest.create>> | null = null;
    try {
      transfer = await prisma.transferRequest.create({
        data: {
          id: transferId,
          userId: user.id,
          fromAccountId: input.fromAccountId,
          type: input.type,
          beneficiaryName: input.beneficiaryName,
          beneficiaryBank: input.beneficiaryBank,
          beneficiaryAccount: input.beneficiaryAccount,
          ibanSwift: input.ibanSwift,
          recipientCountry: input.recipientCountry,
          amount: input.amount,
          currency: input.currency,
          purpose: input.purpose,
          status: "SUBMITTED"
        }
      });

      if (fundsReserved) {
        await createManualReservation({
          id: transfer.id,
          kind: "BANK",
          userId: user.id,
          accountId: account.id,
          amount: Number(input.amount),
          currency: input.currency
        });
      }
    } catch (error) {
      if (transfer) await prisma.transferRequest.delete({ where: { id: transfer.id } }).catch(() => undefined);
      if (fundsReserved) {
        await prisma.account.update({ where: { id: account.id }, data: { availableBalance: { increment: input.amount } } }).catch(() => undefined);
      }
      throw error;
    }

    if (input.saveBeneficiary) {
      const benefId = randomBytes(12).toString("hex");
      const now = new Date().toISOString();
      await prisma.$runCommandRaw({
        insert: "SavedBeneficiary",
        documents: [{
          _id: { $oid: benefId }, userId: { $oid: user.id }, nickname: input.beneficiaryNickname || null,
          recipientName: input.beneficiaryName, bankName: input.beneficiaryBank ?? "", accountNumber: input.beneficiaryAccount ?? "",
          routingSwift: input.ibanSwift || null, recipientCountry: input.recipientCountry, currency: input.currency,
          createdAt: { $date: now }, updatedAt: { $date: now }
        }],
        writeConcern: { w: 1 }
      });
    }

    const pendingMessage = fundsReserved
      ? "Transfer submitted successfully. Status: Pending admin approval."
      : policy.reviewMessage;

    await notifyUser(user.id, {
      type: "TRANSFER_SUBMITTED",
      title: "Transfer submitted",
      body: pendingMessage
    });
    await auditLog({
      actorId: user.id,
      action: "TRANSFER_SUBMITTED",
      entity: "TransferRequest",
      entityId: transfer.id,
      metadata: { fundsReserved }
    });
    await sendTransactionalEmail({
      event: "BANK_TRANSFER_CREATED",
      to: user.email,
      idempotencyKey: `transfer-created:${transfer.id}`,
      relatedUserId: user.id,
      relatedEntityType: "TransferRequest",
      relatedEntityId: transfer.id,
      data: {
        customerName: `${user.firstName} ${user.lastName}`,
        transactionType: transfer.type,
        amount: transfer.amount,
        currency: transfer.currency,
        status: transfer.status,
        maskedAccount: `•••• ${account.accountNumber.slice(-4)}`,
        transactionReference: formatTransferReference(policy.referencePrefix, transfer.id),
        timestamp: transfer.createdAt,
        nextStep: fundsReserved ? "Submitted. The amount is reserved and pending admin approval." : policy.reviewMessage
      }
    });

    return created({
      transfer,
      message: {
        ...policy,
        successMessage: fundsReserved ? "Transfer submitted successfully." : policy.successMessage,
        reviewMessage: pendingMessage,
        reasonText: fundsReserved ? "Your transfer is pending admin approval. No action is required." : policy.reasonText,
        reference: formatTransferReference(policy.referencePrefix, transfer.id),
        status: fundsReserved ? "PENDING" : "UNDER_REVIEW"
      }
    });
  });
}
