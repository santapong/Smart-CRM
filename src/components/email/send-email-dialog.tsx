"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { sendTrackedEmail } from "@/server/actions/email";
import { aiDraftEmail } from "@/server/actions/ai";

export function SendEmailDialog({
  contactId,
  dealId,
  disabled,
}: {
  contactId?: string;
  dealId?: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const res = await sendTrackedEmail({ contactId, dealId, subject, body });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.fieldErrors?.subject?.[0] ?? res.fieldErrors?.body?.[0] ?? res.error);
      return;
    }
    toast.success(res.data.status === "skipped" ? "Email recorded" : "Email sent");
    setOpen(false);
    router.refresh();
  }

  async function onDraft() {
    setDrafting(true);
    const res = await aiDraftEmail({ contactId, dealId, instructions: subject || body });
    setDrafting(false);
    if (!res.ok) {
      toast.error(res.error === "AI is not configured" ? "AI not configured" : res.error);
      return;
    }
    setSubject(res.data.subject);
    setBody(res.data.body);
    toast.success("Draft ready — review before sending");
  }

  if (disabled) {
    return (
      <Button size="sm" variant="outline" disabled title="No email address on file">
        Send email
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Send email</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send email</DialogTitle>
          <DialogDescription>Compose a message. It will be tracked on this record.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="email-subject">Subject</Label>
              <Button type="button" size="sm" variant="ghost" onClick={onDraft} disabled={drafting}>
                <Sparkles className="mr-1 h-3.5 w-3.5" />
                {drafting ? "Drafting…" : "Draft with AI"}
              </Button>
            </div>
            <Input
              id="email-subject"
              name="subject"
              required
              maxLength={200}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email-body">Message</Label>
            <Textarea
              id="email-body"
              name="body"
              required
              maxLength={20000}
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
