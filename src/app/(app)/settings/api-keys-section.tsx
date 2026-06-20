"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { createApiKey, revokeApiKey, API_SCOPES } from "@/server/actions/api-keys";

export type ApiKeyRow = {
  id: string;
  name: string;
  lookupPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
};

export function ApiKeysSection({ keys }: { keys: ApiKeyRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["contacts:read"]);
  const [revealed, setRevealed] = useState<string | null>(null);

  function toggleScope(scope: string) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (scopes.length === 0) return toast.error("Select at least one scope");
    setBusy(true);
    const r = await createApiKey({ name, scopes });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    setRevealed(r.data.key);
    setName("");
    setScopes(["contacts:read"]);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {revealed && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
          <p className="mb-1 font-medium">Copy your API key now — it won&apos;t be shown again.</p>
          <code className="block break-all rounded bg-background p-2 font-mono text-xs">{revealed}</code>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                navigator.clipboard?.writeText(revealed).then(
                  () => toast.success("Copied"),
                  () => toast.error("Copy failed"),
                );
              }}
            >
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <ul className="divide-y rounded-md border">
        {keys.length === 0 && <li className="p-3 text-sm text-muted-foreground">No API keys yet.</li>}
        {keys.map((k) => (
          <li key={k.id} className="flex items-center justify-between p-3">
            <div>
              <p className="text-sm font-medium">{k.name}</p>
              <p className="text-xs text-muted-foreground">
                <code>sk_{k.lookupPrefix}_…</code> · {k.scopes.join(", ")}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                if (!confirm(`Revoke "${k.name}"? Apps using it will stop working.`)) return;
                const r = await revokeApiKey(k.id);
                if (!r.ok) toast.error(r.error);
                else {
                  toast.success("Revoked");
                  router.refresh();
                }
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>

      <form onSubmit={create} className="space-y-3 border-t pt-6">
        <div className="space-y-1.5">
          <Label htmlFor="key-name">Key name</Label>
          <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </div>
        <div className="space-y-1.5">
          <Label>Scopes</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {API_SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} />
                <code className="text-xs">{scope}</code>
              </label>
            ))}
          </div>
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create key"}
        </Button>
      </form>
    </div>
  );
}
