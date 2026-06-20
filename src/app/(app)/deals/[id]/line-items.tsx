"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { dealRevenue, BILLING_PERIODS, type BillingPeriod } from "@/lib/products";
import { addLineItem, removeLineItem } from "@/server/actions/deal-products";

type LineItem = {
  id: string;
  productId: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
  discount: number | null;
  billing: string;
};

type CatalogProduct = { id: string; name: string; price: number };

const BILLING_LABELS: Record<BillingPeriod, string> = {
  one_time: "One-time",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annually: "Annually",
};

const inputClass = "flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

function money(currency: string, n: number): string {
  return `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function LineItems({
  dealId,
  currency,
  items,
  products,
}: {
  dealId: string;
  currency: string;
  items: LineItem[];
  products: CatalogProduct[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [productId, setProductId] = useState("");
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("0");
  const [discount, setDiscount] = useState("");
  const [billing, setBilling] = useState<BillingPeriod>("one_time");

  const revenue = dealRevenue(items);

  function onPickProduct(id: string) {
    setProductId(id);
    const p = products.find((x) => x.id === id);
    if (p) {
      setName(p.name);
      setUnitPrice(String(p.price));
    }
  }

  function resetForm() {
    setProductId("");
    setName("");
    setQuantity("1");
    setUnitPrice("0");
    setDiscount("");
    setBilling("one_time");
  }

  function onAdd() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    start(async () => {
      const r = await addLineItem(dealId, {
        productId: productId || undefined,
        name: name.trim(),
        quantity: quantity || "1",
        unitPrice: unitPrice || "0",
        discount: discount === "" ? undefined : discount,
        billing,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Line item added");
      resetForm();
      router.refresh();
    });
  }

  function onRemove(id: string) {
    start(async () => {
      const r = await removeLineItem(id);
      if (!r.ok) toast.error(r.error);
      else {
        toast.success("Removed");
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-4">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No products on this deal yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map((it) => {
            const total =
              it.quantity * it.unitPrice - (it.discount ?? 0) > 0
                ? it.quantity * it.unitPrice - (it.discount ?? 0)
                : 0;
            return (
              <li key={it.id} className="flex items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{it.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {it.quantity} × {money(currency, it.unitPrice)}
                    {it.discount ? ` − ${money(currency, it.discount)}` : ""} ·{" "}
                    {BILLING_LABELS[it.billing as BillingPeriod] ?? it.billing}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium tabular-nums">{money(currency, total)}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={pending}
                    aria-label={`Remove ${it.name}`}
                    onClick={() => onRemove(it.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap gap-4 rounded-md border bg-muted/30 p-3 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Subtotal (one-time)</p>
          <p className="font-semibold tabular-nums">{money(currency, revenue.oneTime)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">MRR</p>
          <p className="font-semibold tabular-nums">{money(currency, revenue.mrr)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">ARR</p>
          <p className="font-semibold tabular-nums">{money(currency, revenue.arr)}</p>
        </div>
      </div>

      <div className="grid gap-3 border-t pt-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <label className="text-xs font-medium text-muted-foreground">From catalog (optional)</label>
          <select
            value={productId}
            onChange={(e) => onPickProduct(e.target.value)}
            className={inputClass}
          >
            <option value="">Ad-hoc item…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({money(currency, p.price)})
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <label className="text-xs font-medium text-muted-foreground">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Line item name" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Quantity</label>
          <Input type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Unit price</label>
          <Input type="number" min="0" step="any" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Discount</label>
          <Input type="number" min="0" step="any" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Billing</label>
          <select value={billing} onChange={(e) => setBilling(e.target.value as BillingPeriod)} className={inputClass}>
            {BILLING_PERIODS.map((b) => (
              <option key={b} value={b}>
                {BILLING_LABELS[b]}
              </option>
            ))}
          </select>
        </div>
        <Button type="button" onClick={onAdd} disabled={pending} className="sm:col-span-2">
          <Plus className="h-4 w-4" /> {pending ? "Saving…" : "Add line item"}
        </Button>
      </div>
    </div>
  );
}
