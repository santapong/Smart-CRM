"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { createCampaign, type AudienceFilter } from "@/server/actions/campaigns";

type Option = { id: string; name: string };

const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function NewCampaignForm({ tags, companies }: { tags: Option[]; companies: Option[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [audienceType, setAudienceType] = useState<AudienceFilter["type"]>("all");
  const [tagId, setTagId] = useState("");
  const [companyId, setCompanyId] = useState("");

  function buildAudience(): AudienceFilter | null {
    if (audienceType === "tag") {
      if (!tagId) return null;
      return { type: "tag", tagId };
    }
    if (audienceType === "company") {
      if (!companyId) return null;
      return { type: "company", companyId };
    }
    return { type: "all" };
  }

  function onCreate() {
    if (!name.trim() || !subject.trim() || !bodyHtml.trim()) {
      toast.error("Name, subject, and body are required");
      return;
    }
    const audience = buildAudience();
    if (!audience) {
      toast.error("Pick a tag or company for the audience");
      return;
    }
    start(async () => {
      const r = await createCampaign({ name: name.trim(), subject: subject.trim(), bodyHtml, audience });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Campaign created");
      router.push(`/campaigns/${r.data.id}`);
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="cmp-name">Name</Label>
        <Input id="cmp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. June newsletter" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cmp-subject">Subject</Label>
        <Input id="cmp-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Email subject line" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cmp-body">Body (HTML)</Label>
        <textarea
          id="cmp-body"
          value={bodyHtml}
          onChange={(e) => setBodyHtml(e.target.value)}
          rows={8}
          placeholder="<p>Hello there…</p>"
          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cmp-audience">Audience</Label>
        <select
          id="cmp-audience"
          className={SELECT_CLASS}
          value={audienceType}
          onChange={(e) => setAudienceType(e.target.value as AudienceFilter["type"])}
        >
          <option value="all">All contacts with an email</option>
          <option value="tag">Contacts with a tag</option>
          <option value="company">Contacts at a company</option>
        </select>
      </div>
      {audienceType === "tag" && (
        <div className="space-y-1.5">
          <Label htmlFor="cmp-tag">Tag</Label>
          <select id="cmp-tag" className={SELECT_CLASS} value={tagId} onChange={(e) => setTagId(e.target.value)}>
            <option value="">Select a tag…</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {audienceType === "company" && (
        <div className="space-y-1.5">
          <Label htmlFor="cmp-company">Company</Label>
          <select id="cmp-company" className={SELECT_CLASS} value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">Select a company…</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Suppressed and duplicate addresses are removed automatically when the campaign is sent.
      </p>
      <Button type="button" onClick={onCreate} disabled={pending}>
        {pending ? "Creating…" : "Create campaign"}
      </Button>
    </div>
  );
}
