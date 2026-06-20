"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cloneRecipe } from "@/server/actions/workflows";

type RecipeView = { key: string; name: string; description: string };

export function RecipePicker({ recipes }: { recipes: RecipeView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [active, setActive] = useState<string | null>(null);

  function clone(key: string) {
    setActive(key);
    startTransition(async () => {
      const r = await cloneRecipe(key);
      setActive(null);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Automation created from recipe");
      router.push(`/automations/${r.data.id}`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      {recipes.map((r) => (
        <div key={r.key} className="flex items-start gap-3 rounded-md border p-3">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{r.name}</p>
            <p className="text-xs text-muted-foreground">{r.description}</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending && active === r.key}
            onClick={() => clone(r.key)}
          >
            {pending && active === r.key ? "Adding…" : "Use"}
          </Button>
        </div>
      ))}
    </div>
  );
}
