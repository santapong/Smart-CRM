"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deleteAttachment, type AttachmentEntity } from "@/server/actions/attachments";

export type AttachmentRow = {
  id: string;
  filename: string;
  size: number;
  storageKey: string;
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The form field name the upload route reads for the entity link, per entity. */
const LINK_FIELD: Record<AttachmentEntity, string> = {
  deal: "dealId",
  contact: "contactId",
  company: "companyId",
  document: "documentId",
};

/**
 * Attachments panel: upload a file (multipart POST to /api/files/upload) linked
 * to the given entity, list existing files with download links, and delete.
 * Used on the deal detail page and the document detail page.
 */
export function Attachments({
  entity,
  entityId,
  attachments,
}: {
  entity: AttachmentEntity;
  entityId: string;
  attachments: AttachmentRow[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [pending, start] = useTransition();

  async function onFile(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append(LINK_FIELD[entity], entityId);
      const res = await fetch("/api/files/upload", { method: "POST", body: fd });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error ?? "Upload failed");
        return;
      }
      toast.success("Uploaded");
      router.refresh();
    } catch {
      toast.error("Upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function onDelete(id: string) {
    if (!confirm("Delete this file?")) return;
    start(async () => {
      const r = await deleteAttachment(id);
      if (!r.ok) toast.error(r.error);
      else {
        toast.success("Deleted");
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-3">
      {attachments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No files.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 p-2">
              <a
                href={`/api/files/${encodeURI(a.storageKey)}`}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center gap-2 text-sm hover:underline"
              >
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{a.filename}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{humanSize(a.size)}</span>
              </a>
              <Button
                size="icon"
                variant="ghost"
                disabled={pending}
                aria-label={`Delete ${a.filename}`}
                onClick={() => onDelete(a.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? "Uploading…" : "Upload file"}
        </Button>
      </div>
    </div>
  );
}
