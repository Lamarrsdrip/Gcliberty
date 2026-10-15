import { prisma } from "@/lib/db";

export type ManualPayoutSettings = {
  bankTransferEnabled: boolean;
  cryptoTransferEnabled: boolean;
};

export type ManualReservation = {
  id: string;
  kind: "BANK" | "CRYPTO";
  userId: string;
  accountId?: string | null;
  asset?: string | null;
  amount: number;
  currency?: string | null;
  status: "ACTIVE" | "APPROVED" | "RELEASED";
};

const defaults: ManualPayoutSettings = {
  bankTransferEnabled: true,
  cryptoTransferEnabled: true
};

function firstBatch(result: unknown): Array<Record<string, unknown>> {
  const cursor = (result as { cursor?: { firstBatch?: Array<Record<string, unknown>> } })?.cursor;
  return Array.isArray(cursor?.firstBatch) ? cursor.firstBatch : [];
}

function modifiedCount(result: unknown): number {
  const value = result as { n?: number; nModified?: number };
  return Number(value.nModified ?? value.n ?? 0);
}

export async function getManualPayoutSettings(): Promise<ManualPayoutSettings> {
  try {
    const result = await prisma.$runCommandRaw({
      find: "ManualPayoutSetting",
      filter: { _id: "global" },
      limit: 1
    });
    const row = firstBatch(result)[0];
    return {
      bankTransferEnabled: row?.bankTransferEnabled !== false,
      cryptoTransferEnabled: row?.cryptoTransferEnabled !== false
    };
  } catch (error) {
    console.error("[manual-payouts] settings read failed", error);
    return defaults;
  }
}

export async function saveManualPayoutSettings(input: ManualPayoutSettings) {
  await prisma.$runCommandRaw({
    update: "ManualPayoutSetting",
    updates: [
      {
        q: { _id: "global" },
        u: {
          $set: {
            bankTransferEnabled: input.bankTransferEnabled,
            cryptoTransferEnabled: input.cryptoTransferEnabled,
            updatedAt: new Date().toISOString()
          }
        },
        upsert: true
      }
    ]
  });
  return input;
}

export async function createManualReservation(input: Omit<ManualReservation, "status">) {
  await prisma.$runCommandRaw({
    insert: "ManualPayoutReservation",
    documents: [
      {
        _id: input.id,
        kind: input.kind,
        userId: input.userId,
        accountId: input.accountId ?? null,
        asset: input.asset ?? null,
        amount: input.amount,
        currency: input.currency ?? null,
        status: "ACTIVE",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    writeConcern: { w: 1 }
  });
}

export async function getManualReservation(id: string): Promise<ManualReservation | null> {
  try {
    const result = await prisma.$runCommandRaw({
      find: "ManualPayoutReservation",
      filter: { _id: id },
      limit: 1
    });
    const row = firstBatch(result)[0];
    if (!row) return null;
    return {
      id,
      kind: row.kind === "CRYPTO" ? "CRYPTO" : "BANK",
      userId: String(row.userId ?? ""),
      accountId: row.accountId ? String(row.accountId) : null,
      asset: row.asset ? String(row.asset) : null,
      amount: Number(row.amount ?? 0),
      currency: row.currency ? String(row.currency) : null,
      status: row.status === "APPROVED" ? "APPROVED" : row.status === "RELEASED" ? "RELEASED" : "ACTIVE"
    };
  } catch (error) {
    console.error("[manual-payouts] reservation read failed", error);
    return null;
  }
}

export async function markManualReservation(id: string, status: "APPROVED" | "RELEASED") {
  await prisma.$runCommandRaw({
    update: "ManualPayoutReservation",
    updates: [
      {
        q: { _id: id, status: "ACTIVE" },
        u: { $set: { status, updatedAt: new Date().toISOString() } }
      }
    ]
  });
}

export async function reserveCryptoBalance(userId: string, symbol: string, amount: number) {
  const result = await prisma.$runCommandRaw({
    update: "UserCryptoBalance",
    updates: [
      {
        q: {
          userId: { $oid: userId },
          symbol,
          $expr: {
            $gte: [
              { $subtract: ["$balance", { $ifNull: ["$reservedBalance", 0] }] },
              amount
            ]
          }
        },
        u: { $inc: { reservedBalance: amount } }
      }
    ]
  });
  return modifiedCount(result) === 1;
}

export async function releaseCryptoReservation(userId: string, symbol: string, amount: number) {
  const result = await prisma.$runCommandRaw({
    update: "UserCryptoBalance",
    updates: [
      {
        q: {
          userId: { $oid: userId },
          symbol,
          reservedBalance: { $gte: amount }
        },
        u: { $inc: { reservedBalance: -amount } }
      }
    ]
  });
  return modifiedCount(result) === 1;
}

export async function approveCryptoReservation(userId: string, symbol: string, amount: number) {
  const result = await prisma.$runCommandRaw({
    update: "UserCryptoBalance",
    updates: [
      {
        q: {
          userId: { $oid: userId },
          symbol,
          balance: { $gte: amount },
          reservedBalance: { $gte: amount }
        },
        u: { $inc: { balance: -amount, reservedBalance: -amount } }
      }
    ]
  });
  return modifiedCount(result) === 1;
}
