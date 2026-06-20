import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";

type EmailRow = {
  id: string;
  subject: string;
  toAddr: string;
  status: string;
  createdAt: Date;
  openCount: number;
  clickCount: number;
};

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "sent") return "default";
  if (status === "failed") return "destructive";
  if (status === "skipped") return "secondary";
  return "outline";
}

export function EmailList({ emails, hint }: { emails: EmailRow[]; hint?: string }) {
  if (emails.length === 0) {
    return <p className="text-sm text-muted-foreground">{hint ?? "No emails yet."}</p>;
  }
  return (
    <ul className="space-y-3">
      {emails.map((m) => (
        <li key={m.id} className="space-y-1">
          <div className="flex items-start justify-between gap-2">
            <span className="text-sm font-medium">{m.subject}</span>
            <Badge variant={statusVariant(m.status)}>{m.status}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">{m.toAddr}</p>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{format(m.createdAt, "PP")}</span>
            {m.openCount > 0 && <span>{m.openCount} opens</span>}
            {m.clickCount > 0 && <span>{m.clickCount} clicks</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
