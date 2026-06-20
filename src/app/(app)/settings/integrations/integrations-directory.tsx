"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  connectSlack,
  updateSlack,
  disconnect,
  testSlack,
  type IntegrationListing,
} from "@/server/actions/integrations";

// Logical Slack alerts a connection can subscribe to. Kept inline (rather than
// imported from the server-only slack lib) so this client bundle stays free of
// node:crypto. The server validates the same set via SLACK_EVENTS.
const SLACK_EVENTS = ["deal.won", "deal.stage_changed", "lead.created"] as const;

const EVENT_LABELS: Record<string, string> = {
  "deal.won": "Deal won",
  "deal.stage_changed": "Deal moved stage",
  "lead.created": "Lead created",
};

function StatusBadge({ configured, connected }: { configured: boolean; connected: boolean }) {
  if (connected) return <Badge variant="default">Connected</Badge>;
  if (configured) return <Badge variant="secondary">Available</Badge>;
  return <Badge variant="outline">Not configured</Badge>;
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="rounded-lg border bg-card p-6">{children}</section>;
}

function SlackCard({ provider }: { provider: IntegrationListing }) {
  const router = useRouter();
  const existing = provider.connections[0] ?? null;
  const [busy, setBusy] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [events, setEvents] = useState<string[]>(
    existing ? existing.events : [...SLACK_EVENTS],
  );

  function toggle(name: string) {
    setEvents((prev) => (prev.includes(name) ? prev.filter((e) => e !== name) : [...prev, name]));
  }

  async function onConnect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (events.length === 0) return toast.error("Select at least one event");
    setBusy(true);
    const r = await connectSlack({ webhookUrl, events });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Slack connected");
    setWebhookUrl("");
    router.refresh();
  }

  async function saveEvents() {
    if (!existing) return;
    setBusy(true);
    const r = await updateSlack({ connectionId: existing.id, events });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Saved");
    router.refresh();
  }

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold">{provider.name}</h2>
        <StatusBadge configured={provider.configured} connected={!!existing} />
      </div>
      <p className="mb-4 text-sm text-muted-foreground">{provider.description}</p>

      <div className="space-y-3">
        <Label>Notify on</Label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {SLACK_EVENTS.map((name) => (
            <label key={name} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={events.includes(name)} onChange={() => toggle(name)} />
              {EVENT_LABELS[name] ?? name}
            </label>
          ))}
        </div>
      </div>

      {existing ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={saveEvents} disabled={busy}>
            {busy ? "Saving…" : "Save events"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await testSlack(existing.id);
              setBusy(false);
              if (!r.ok) toast.error(r.error);
              else toast.success("Test message sent");
            }}
          >
            Send test
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              if (!confirm("Disconnect Slack?")) return;
              const r = await disconnect(existing.id);
              if (!r.ok) toast.error(r.error);
              else {
                toast.success("Disconnected");
                router.refresh();
              }
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <form onSubmit={onConnect} className="mt-4 space-y-3 border-t pt-4">
          <div className="space-y-1.5">
            <Label htmlFor="slack-url">Incoming webhook URL</Label>
            <Input
              id="slack-url"
              type="url"
              placeholder="https://hooks.slack.com/services/…"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              Create one at api.slack.com → Incoming Webhooks. Stored encrypted.
            </p>
          </div>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Connecting…" : "Connect Slack"}
          </Button>
        </form>
      )}
    </Card>
  );
}

function OAuthCard({ provider, nangoConfigured }: { provider: IntegrationListing; nangoConfigured: boolean }) {
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold">{provider.name}</h2>
        <StatusBadge configured={provider.configured} connected={provider.connections.length > 0} />
      </div>
      <p className="mb-4 text-sm text-muted-foreground">{provider.description}</p>
      <Button size="sm" disabled title={nangoConfigured ? undefined : "Set NANGO_* to enable"}>
        Connect
      </Button>
      {!nangoConfigured && (
        <p className="mt-2 text-xs text-muted-foreground">Set NANGO_* to enable.</p>
      )}
    </Card>
  );
}

function ZapierCard({ provider }: { provider: IntegrationListing }) {
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold">{provider.name}</h2>
        <StatusBadge configured={provider.configured} connected={false} />
      </div>
      <p className="mb-4 text-sm text-muted-foreground">{provider.description}</p>
      <p className="text-sm text-muted-foreground">
        Zapier connects through the public REST API and outbound webhooks. Manage{" "}
        <Link href="/settings" className="font-medium underline underline-offset-2">
          API keys &amp; webhooks
        </Link>{" "}
        in Settings.
      </p>
    </Card>
  );
}

export function IntegrationsDirectory({
  providers,
  nangoConfigured,
}: {
  providers: IntegrationListing[];
  nangoConfigured: boolean;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {providers.map((p) => {
        if (p.key === "slack") return <SlackCard key={p.key} provider={p} />;
        if (p.key === "zapier") return <ZapierCard key={p.key} provider={p} />;
        return <OAuthCard key={p.key} provider={p} nangoConfigured={nangoConfigured} />;
      })}
    </div>
  );
}
