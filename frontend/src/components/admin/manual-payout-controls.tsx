"use client";

import { useState } from "react";
import { Landmark, Bitcoin, CheckCircle2, Loader2 } from "lucide-react";
import { secureFetch } from "@/lib/client-api";

type Settings = {
  bankTransferEnabled: boolean;
  cryptoTransferEnabled: boolean;
};

function ModeCard({
  title,
  description,
  checked,
  onChange,
  icon: Icon
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  icon: React.ElementType;
}) {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
      <div className="flex items-start gap-4">
        <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-emerald-400/10 text-emerald-300">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-black text-white">{title}</h3>
              <p className="mt-1 text-sm leading-6 text-white/45">{description}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={checked}
              onClick={() => onChange(!checked)}
              className={`relative h-8 w-14 shrink-0 rounded-full border transition ${checked ? "border-emerald-300/60 bg-emerald-400" : "border-white/15 bg-white/10"}`}
            >
              <span className={`absolute top-1 size-6 rounded-full bg-white shadow transition ${checked ? "left-7" : "left-1"}`} />
            </button>
          </div>
          <div className={`mt-4 rounded-2xl border px-4 py-3 text-xs font-bold ${checked ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200" : "border-white/10 bg-black/20 text-white/45"}`}>
            {checked
              ? "ON · User submits → amount reserved → Pending → admin approves → balance debited → admin completes external payout."
              : "OFF · This manual payout route is unavailable to users."}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ManualPayoutControls({ initial }: { initial: Settings }) {
  const [settings, setSettings] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const dirty = settings.bankTransferEnabled !== saved.bankTransferEnabled || settings.cryptoTransferEnabled !== saved.cryptoTransferEnabled;

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const result = await secureFetch("/api/admin/manual-payout-settings", {
        method: "PUT",
        body: JSON.stringify(settings)
      });
      const next = result.settings as Settings;
      setSettings(next);
      setSaved(next);
      setMessage("Manual payout controls saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save payout controls.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <ModeCard
        title="Manual bank transfers"
        description="Allow users to submit domestic or international bank transfers for administrator approval."
        checked={settings.bankTransferEnabled}
        onChange={(value) => setSettings((current) => ({ ...current, bankTransferEnabled: value }))}
        icon={Landmark}
      />
      <ModeCard
        title="Manual BTC & crypto transfers"
        description="Allow BTC/crypto Send and Withdraw requests even when no deposit wallet account is activated."
        checked={settings.cryptoTransferEnabled}
        onChange={(value) => setSettings((current) => ({ ...current, cryptoTransferEnabled: value }))}
        icon={Bitcoin}
      />

      {message ? (
        <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white/70">
          <CheckCircle2 className="size-4 text-emerald-300" /> {message}
        </div>
      ) : null}

      <button
        type="button"
        onClick={save}
        disabled={saving || !dirty}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-400 font-black text-black transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving ? <Loader2 className="size-4 animate-spin" /> : null}
        {saving ? "Saving…" : dirty ? "Save payout controls" : "Saved"}
      </button>
    </div>
  );
}
