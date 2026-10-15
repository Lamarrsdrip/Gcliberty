import Link from "next/link";
import { redirect } from "next/navigation";
import { Bitcoin, Landmark, ShieldCheck } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getManualPayoutSettings } from "@/lib/manual-payouts";
import { ProtectedShell } from "@/components/layout/protected-shell";
import { ManualPayoutControls } from "@/components/admin/manual-payout-controls";

export const dynamic = "force-dynamic";

export default async function ManualPayoutsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/dashboard");

  const [settings, pendingBank, pendingCrypto] = await Promise.all([
    getManualPayoutSettings(),
    prisma.transferRequest.count({ where: { status: { in: ["SUBMITTED", "UNDER_REVIEW"] } } }),
    prisma.cryptoWithdrawalRequest.count({ where: { status: "PENDING_REVIEW" } })
  ]);

  return (
    <ProtectedShell adminOnly>
      <div className="mx-auto max-w-4xl space-y-5">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.2em] text-emerald-300">Operations control</p>
          <h1 className="mt-1 text-3xl font-black text-white">Manual payouts</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/45">
            Control whether customers can submit bank and crypto transfers into the manual approval queue. Approval debits the customer ledger; operations then completes the real external payout.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Link href="/admin?tab=transfers" className="rounded-3xl border border-white/10 bg-white/5 p-5 transition hover:bg-white/8">
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-2xl bg-emerald-400/10 text-emerald-300"><Landmark className="size-5" /></div>
              <div><p className="font-black text-white">Bank transfer queue</p><p className="text-sm text-white/40">{pendingBank} pending</p></div>
            </div>
          </Link>
          <Link href="/admin?tab=crypto-withdrawals" className="rounded-3xl border border-white/10 bg-white/5 p-5 transition hover:bg-white/8">
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-2xl bg-emerald-400/10 text-emerald-300"><Bitcoin className="size-5" /></div>
              <div><p className="font-black text-white">BTC / crypto queue</p><p className="text-sm text-white/40">{pendingCrypto} pending</p></div>
            </div>
          </Link>
        </div>

        <div className="rounded-3xl border border-emerald-400/15 bg-emerald-400/8 p-5">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-emerald-300" />
            <div>
              <p className="font-black text-white">Money movement rule</p>
              <p className="mt-1 text-sm leading-6 text-white/50">Pending requests reserve funds so the same balance cannot be submitted twice. Approve finalizes the debit. Reject/Fail releases the reserved amount.</p>
            </div>
          </div>
        </div>

        <ManualPayoutControls initial={settings} />
      </div>
    </ProtectedShell>
  );
}
