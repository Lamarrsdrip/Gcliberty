"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle, Clock, MessageCircle, XCircle } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

type Withdrawal = {
  id: string;
  asset: string;
  network: string;
  amount: number;
  recipientAddress: string;
  status: string;
  adminMessage: string | null;
  reference: string;
  createdAt: string;
};

const STATUS_CONFIG: Record<string, { icon: React.ElementType; color: string; bg: string; label: string; heading: string; body: string }> = {
  PENDING_REVIEW: {
    icon: Clock,
    color: "text-amber-400",
    bg: "bg-amber-400/10 border-amber-400/25",
    label: "Pending",
    heading: "Transfer submitted",
    body: "Your crypto transfer has been submitted and is pending admin approval. The amount is reserved from your available balance while it is pending."
  },
  APPROVED: {
    icon: CheckCircle,
    color: "text-emerald-400",
    bg: "bg-emerald-400/10 border-emerald-400/25",
    label: "Approved",
    heading: "Transfer approved",
    body: "The approved amount has been debited from your crypto balance. Bank operations will complete the external transfer."
  },
  FAILED: {
    icon: XCircle,
    color: "text-red-400",
    bg: "bg-red-400/10 border-red-400/25",
    label: "Failed",
    heading: "Transfer not approved",
    body: "The transfer was not approved. Any reserved amount has been released back to your available crypto balance."
  }
};

export function WithdrawalStatusView({ withdrawal: initial }: { withdrawal: Withdrawal }) {
  const [withdrawal, setWithdrawal] = useState(initial);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/crypto/withdrawals/${withdrawal.id}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.withdrawal) setWithdrawal(data.withdrawal);
      } catch {}
    }, 12000);
    return () => clearInterval(interval);
  }, [withdrawal.id]);

  function openChat() {
    window.dispatchEvent(new CustomEvent("open-support-chat"));
  }

  const cfg = STATUS_CONFIG[withdrawal.status] ?? {
    icon: Clock,
    color: "text-white/60",
    bg: "bg-white/5 border-white/10",
    label: withdrawal.status,
    heading: "Transfer status",
    body: "Your transfer status is being updated."
  };
  const StatusIcon = cfg.icon;

  return (
    <div className="mx-auto max-w-2xl space-y-5 fade-up">
      <Link href="/wallet" className="inline-flex items-center gap-1.5 text-sm font-semibold text-white/40 hover:text-white transition">
        <ArrowLeft className="size-4" />
        Back to Wallet
      </Link>

      <div className="luxury-hero p-8 text-center">
        <div className={`mx-auto mb-5 size-20 rounded-full border-2 flex items-center justify-center ${cfg.bg}`}>
          <StatusIcon className={`size-10 ${cfg.color}`} />
        </div>
        <h1 className="text-3xl font-black text-white">{cfg.heading}</h1>
        <p className="mt-3 text-sm text-white/55 leading-relaxed whitespace-pre-line">{cfg.body}</p>
        <div className={`mx-auto mt-5 w-fit rounded-full border px-5 py-2 text-xs font-black uppercase tracking-wider ${cfg.bg} ${cfg.color}`}>
          Status: {cfg.label}
        </div>
        {withdrawal.adminMessage && (
          <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm text-white/65 text-left">
            {withdrawal.adminMessage}
          </div>
        )}
      </div>

      <div className="card-dark p-5 space-y-3">
        <p className="text-sm font-black text-white mb-4">Transaction Details</p>
        {([
          ["Asset", `${withdrawal.asset} (${withdrawal.network})`],
          ["Amount", `${withdrawal.amount} ${withdrawal.asset}`],
          ["Recipient Address", withdrawal.recipientAddress],
          ["Reference", withdrawal.reference],
          ["Submitted", new Date(withdrawal.createdAt).toLocaleString()]
        ] as [string, string][]).map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 text-sm border-b border-white/5 pb-2 last:border-0 last:pb-0">
            <span className="text-white/40 shrink-0">{label}</span>
            <span className="font-semibold text-white text-right break-all">{value}</span>
          </div>
        ))}
      </div>

      <Button onClick={openChat} variant="secondary" className="w-full h-12 gap-2 font-black">
        <MessageCircle className="size-5" />
        Need help? Contact Support
      </Button>

      <p className="text-center text-xs text-white/25">
        This page updates automatically. Ref: {withdrawal.reference}
      </p>
    </div>
  );
}
