"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, ArrowUp, ArrowDown, Plus, Mail, ListChecks, Clock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { addStep, removeStep, reorderSteps } from "@/server/actions/sequences";

type StepType = "email" | "task" | "wait";

type Step = {
  id: string;
  order: number;
  type: string;
  subject: string | null;
  body: string | null;
  waitDays: number;
};

const inputClass = "flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

const TYPE_META: Record<StepType, { label: string; Icon: typeof Mail }> = {
  email: { label: "Email", Icon: Mail },
  task: { label: "Task", Icon: ListChecks },
  wait: { label: "Wait", Icon: Clock },
};

function describe(step: Step): string {
  if (step.type === "wait") return `Wait ${step.waitDays} day(s)`;
  return step.subject || (step.type === "email" ? "(no subject)" : "(no title)");
}

export function StepsEditor({ sequenceId, steps }: { sequenceId: string; steps: Step[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [type, setType] = useState<StepType>("email");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [waitDays, setWaitDays] = useState("3");

  function resetForm() {
    setSubject("");
    setBody("");
    setWaitDays("3");
  }

  function onAdd() {
    if (type !== "wait" && !subject.trim()) {
      toast.error(type === "email" ? "Subject is required" : "Title is required");
      return;
    }
    start(async () => {
      const r = await addStep(sequenceId, {
        type,
        subject: type === "wait" ? undefined : subject.trim(),
        body: type === "wait" ? undefined : body,
        waitDays: type === "wait" ? waitDays : 0,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Step added");
      resetForm();
      router.refresh();
    });
  }

  function onRemove(id: string) {
    start(async () => {
      const r = await removeStep(id);
      if (!r.ok) toast.error(r.error);
      else {
        toast.success("Step removed");
        router.refresh();
      }
    });
  }

  function move(index: number, dir: -1 | 1) {
    const next = index + dir;
    if (next < 0 || next >= steps.length) return;
    const ids = steps.map((s) => s.id);
    [ids[index], ids[next]] = [ids[next], ids[index]];
    start(async () => {
      const r = await reorderSteps(sequenceId, { stepIds: ids });
      if (!r.ok) toast.error(r.error);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Steps</h2>
        {steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No steps yet. Add one below.</p>
        ) : (
          <ol className="divide-y rounded-md border">
            {steps.map((step, i) => {
              const meta = TYPE_META[step.type as StepType] ?? TYPE_META.task;
              const Icon = meta.Icon;
              return (
                <li key={step.id} className="flex items-center justify-between gap-2 p-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{describe(step)}</p>
                      <p className="text-xs text-muted-foreground">{meta.label}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={pending || i === 0}
                      aria-label="Move up"
                      onClick={() => move(i, -1)}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={pending || i === steps.length - 1}
                      aria-label="Move down"
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={pending}
                      aria-label="Remove step"
                      onClick={() => onRemove(step.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="grid gap-3 border-t pt-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Add step</h2>
        <div className="space-y-1.5">
          <Label htmlFor="step-type">Type</Label>
          <select
            id="step-type"
            value={type}
            onChange={(e) => setType(e.target.value as StepType)}
            className={inputClass}
          >
            <option value="email">Email</option>
            <option value="task">Task</option>
            <option value="wait">Wait</option>
          </select>
        </div>

        {type === "wait" ? (
          <div className="space-y-1.5">
            <Label htmlFor="step-wait">Wait days</Label>
            <Input
              id="step-wait"
              type="number"
              min="0"
              max="365"
              value={waitDays}
              onChange={(e) => setWaitDays(e.target.value)}
            />
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="step-subject">{type === "email" ? "Subject" : "Title"}</Label>
              <Input id="step-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="step-body">Body</Label>
              <Textarea id="step-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
          </>
        )}

        <Button type="button" onClick={onAdd} disabled={pending}>
          <Plus className="h-4 w-4" /> {pending ? "Saving…" : "Add step"}
        </Button>
      </div>
    </div>
  );
}
