"use client";
import { useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { aiSearch, type AiSearchResult } from "@/server/actions/ai";

/**
 * AI ask box (M14) for the /assistant page. Calls aiSearch with a
 * natural-language query and renders the grounded answer plus any matching
 * contacts/deals. Gracefully surfaces the not-configured message.
 */
export function AssistantBox() {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiSearchResult | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    const res = await aiSearch({ query });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error === "AI is not configured" ? "AI not configured" : res.error);
      return;
    }
    setResult(res.data);
  }

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="flex gap-2">
        <Input
          placeholder="Ask about your pipeline, or search contacts and deals…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={500}
        />
        <Button type="submit" disabled={busy}>
          <Sparkles className="mr-1 h-4 w-4" />
          {busy ? "Asking…" : "Ask"}
        </Button>
      </form>

      {result && (
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-6">
              <p className="whitespace-pre-wrap text-sm">{result.answer}</p>
            </CardContent>
          </Card>

          {(result.contacts.length > 0 || result.deals.length > 0) && (
            <div className="grid gap-4 sm:grid-cols-2">
              {result.contacts.length > 0 && (
                <Card>
                  <CardContent className="space-y-2 pt-6">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Contacts</p>
                    <ul className="space-y-1 text-sm">
                      {result.contacts.map((c) => (
                        <li key={c.id}>
                          <Link href={`/contacts/${c.id}`} className="hover:underline">
                            {c.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}
              {result.deals.length > 0 && (
                <Card>
                  <CardContent className="space-y-2 pt-6">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Deals</p>
                    <ul className="space-y-1 text-sm">
                      {result.deals.map((d) => (
                        <li key={d.id} className="flex justify-between gap-2">
                          <Link href={`/deals/${d.id}`} className="hover:underline">
                            {d.title}
                          </Link>
                          <span className="text-muted-foreground">{d.stage ?? "—"}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
