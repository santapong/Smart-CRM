"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  createWebhookEndpoint,
  updateWebhookEndpoint,
  deleteWebhookEndpoint,
} from "@/server/actions/webhooks";

export type WebhookRow = {
  id: string;
  url: string;
  secret: string;
  enabledEvents: string[];
  status: string;
  createdAt: string;
};

export function WebhooksSection({
  endpoints,
  availableEvents,
}: {
  endpoints: WebhookRow[];
  availableEvents: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["*"]);
  const [showSecret, setShowSecret] = useState<string | null>(null);

  function toggleEvent(name: string) {
    setEvents((prev) => (prev.includes(name) ? prev.filter((e) => e !== name) : [...prev, name]));
  }

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (events.length === 0) return toast.error("Select at least one event");
    setBusy(true);
    const r = await createWebhookEndpoint({ url, enabledEvents: events });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Endpoint created");
    setUrl("");
    setEvents(["*"]);
    router.refresh();
  }

  const eventChoices = ["*", ...availableEvents];

  return (
    <div className="space-y-6">
      <ul className="divide-y rounded-md border">
        {endpoints.length === 0 && <li className="p-3 text-sm text-muted-foreground">No webhook endpoints yet.</li>}
        {endpoints.map((w) => (
          <li key={w.id} className="space-y-2 p-3">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{w.url}</p>
                <p className="text-xs text-muted-foreground">
                  {w.status} · {w.enabledEvents.join(", ")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const next = w.status === "active" ? "disabled" : "active";
                    const r = await updateWebhookEndpoint(w.id, { status: next });
                    if (!r.ok) toast.error(r.error);
                    else {
                      toast.success(next === "active" ? "Enabled" : "Disabled");
                      router.refresh();
                    }
                  }}
                >
                  {w.status === "active" ? "Disable" : "Enable"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    if (!confirm("Delete this endpoint?")) return;
                    const r = await deleteWebhookEndpoint(w.id);
                    if (!r.ok) toast.error(r.error);
                    else {
                      toast.success("Deleted");
                      router.refresh();
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="text-xs">
              <Button size="sm" variant="ghost" onClick={() => setShowSecret(showSecret === w.id ? null : w.id)}>
                {showSecret === w.id ? "Hide signing secret" : "Reveal signing secret"}
              </Button>
              {showSecret === w.id && (
                <code className="mt-1 block break-all rounded bg-muted p-2 font-mono">{w.secret}</code>
              )}
            </div>
          </li>
        ))}
      </ul>

      <form onSubmit={create} className="space-y-3 border-t pt-6">
        <div className="space-y-1.5">
          <Label htmlFor="wh-url">Endpoint URL</Label>
          <Input
            id="wh-url"
            type="url"
            placeholder="https://example.com/webhooks/smartcrm"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label>Events</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {eventChoices.map((name) => (
              <label key={name} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={events.includes(name)} onChange={() => toggleEvent(name)} />
                <code className="text-xs">{name}</code>
              </label>
            ))}
          </div>
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Add endpoint"}
        </Button>
      </form>
    </div>
  );
}
