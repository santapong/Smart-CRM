"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AtSign, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { createComment, deleteComment } from "@/server/actions/comments";

export type Member = { userId: string; name: string };
export type CommentView = {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: Date | string;
  canDelete: boolean;
};

export function Comments({
  entityType,
  entityId,
  members,
  initialComments,
}: {
  entityType: "contact" | "company" | "deal" | "lead";
  entityId: string;
  members: Member[];
  initialComments: CommentView[];
}) {
  const router = useRouter();
  const [comments, setComments] = useState<CommentView[]>(initialComments);
  const [body, setBody] = useState("");
  const [mentioned, setMentioned] = useState<Member[]>([]);
  const [busy, setBusy] = useState(false);

  function addMention(m: Member) {
    if (!mentioned.some((x) => x.userId === m.userId)) {
      setMentioned((prev) => [...prev, m]);
    }
    setBody((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}@${m.name} `);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    const res = await createComment({
      entityType,
      entityId,
      body: body.trim(),
      mentionedUserIds: mentioned.map((m) => m.userId),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setBody("");
    setMentioned([]);
    router.refresh();
  }

  async function onDelete(id: string) {
    const res = await deleteComment(id);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setComments((prev) => prev.filter((c) => c.id !== id));
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {comments.map((c) => (
            <li key={c.id} className="group rounded-md border bg-background p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">{c.authorName}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {new Date(c.createdAt).toLocaleString()}
                  </span>
                  {c.canDelete && (
                    <button
                      onClick={() => onDelete(c.id)}
                      className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      aria-label="Delete comment"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <p className="whitespace-pre-wrap text-sm">{c.body}</p>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onSubmit} className="space-y-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a comment… use @ to mention a teammate"
          rows={3}
          maxLength={8000}
        />
        <div className="flex items-center justify-between gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="sm" variant="outline" disabled={members.length === 0}>
                <AtSign className="h-3.5 w-3.5" />
                Mention
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
              {members.map((m) => (
                <DropdownMenuItem key={m.userId} onSelect={() => addMention(m)}>
                  {m.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="submit" size="sm" disabled={busy || !body.trim()}>
            {busy ? "Posting…" : "Comment"}
          </Button>
        </div>
        {mentioned.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Mentioning: {mentioned.map((m) => m.name).join(", ")}
          </p>
        )}
      </form>
    </div>
  );
}
