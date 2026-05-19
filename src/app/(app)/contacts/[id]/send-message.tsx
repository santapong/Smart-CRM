"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { sendMessageToContact } from "@/server/actions/messages";

type Channel = "EMAIL" | "TELEGRAM" | "LINE";

type Availability = {
  EMAIL: boolean;
  TELEGRAM: boolean;
  LINE: boolean;
};

export function SendMessagePanel({
  contactId,
  availability,
  defaultChannel,
}: {
  contactId: string;
  availability: Availability;
  defaultChannel: Channel;
}) {
  const router = useRouter();
  const [channel, setChannel] = useState<Channel>(defaultChannel);
  const [busy, setBusy] = useState(false);

  const reachable = availability[channel];

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!reachable) {
      toast.error(`Contact has no ${channel.toLowerCase()} handle or has opted out.`);
      return;
    }
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const res = await sendMessageToContact({
      contactId,
      channel,
      subject: form.get("subject")?.toString() ?? "",
      body: form.get("body")?.toString() ?? "",
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Message sent");
    (e.currentTarget as HTMLFormElement).reset();
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="channel">Channel</Label>
        <select
          id="channel"
          value={channel}
          onChange={(e) => setChannel(e.target.value as Channel)}
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="EMAIL" disabled={!availability.EMAIL}>
            Email {availability.EMAIL ? "" : "(unavailable)"}
          </option>
          <option value="TELEGRAM" disabled={!availability.TELEGRAM}>
            Telegram {availability.TELEGRAM ? "" : "(unavailable)"}
          </option>
          <option value="LINE" disabled={!availability.LINE}>
            LINE {availability.LINE ? "" : "(unavailable)"}
          </option>
        </select>
      </div>

      {channel === "EMAIL" && (
        <div className="space-y-1.5">
          <Label htmlFor="subject">Subject</Label>
          <Input id="subject" name="subject" placeholder="Subject line" />
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="body">Message</Label>
        <Textarea
          id="body"
          name="body"
          required
          rows={5}
          placeholder={`Type your message… You can use {{firstName}} and {{lastName}}.`}
        />
      </div>

      <Button type="submit" disabled={busy || !reachable}>
        {busy ? "Sending…" : `Send via ${channel.toLowerCase()}`}
      </Button>
    </form>
  );
}
