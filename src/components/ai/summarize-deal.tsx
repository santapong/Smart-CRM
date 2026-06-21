"use client";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { aiSummarizeDeal } from "@/server/actions/ai";

/**
 * "Summarize with AI" control for the deal detail page (M14). Calls
 * aiSummarizeDeal and renders the result inline in a card. Gracefully shows the
 * not-configured message when no key is set.
 */
export function SummarizeDeal({ dealId }: { dealId: string }) {
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  async function onSummarize() {
    setBusy(true);
    const res = await aiSummarizeDeal(dealId);
    setBusy(false);
    if (!res.ok) {
      const msg = res.error === "AI is not configured" ? "AI not configured" : res.error;
      toast.error(msg);
      setSummary(null);
      return;
    }
    setSummary(res.data.summary);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">AI summary</h3>
        <Button type="button" size="sm" variant="outline" onClick={onSummarize} disabled={busy}>
          <Sparkles className="mr-1 h-3.5 w-3.5" />
          {busy ? "Summarizing…" : "Summarize with AI"}
        </Button>
      </div>
      {summary ? (
        <p className="whitespace-pre-wrap text-sm text-foreground">{summary}</p>
      ) : (
        <p className="text-sm text-muted-foreground">Generate a summary, risk read, and suggested next step.</p>
      )}
    </div>
  );
}
