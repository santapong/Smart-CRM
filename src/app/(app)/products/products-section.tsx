"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createProduct, updateProduct, deleteProduct } from "@/server/actions/products";

export type ProductRow = {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  price: number;
  cost: number | null;
  currency: string;
  active: boolean;
};

export function ProductsSection({ products }: { products: ProductRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [unit, setUnit] = useState("");
  const [price, setPrice] = useState("0");
  const [cost, setCost] = useState("");
  const [currency, setCurrency] = useState("USD");

  function resetForm() {
    setName("");
    setSku("");
    setUnit("");
    setPrice("0");
    setCost("");
    setCurrency("USD");
  }

  function onCreate() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    start(async () => {
      const r = await createProduct({
        name: name.trim(),
        sku: sku || undefined,
        unit: unit || undefined,
        price: price || "0",
        cost: cost === "" ? undefined : cost,
        currency: currency || "USD",
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Product created");
      resetForm();
      router.refresh();
    });
  }

  function onToggleActive(row: ProductRow) {
    start(async () => {
      const r = await updateProduct(row.id, { active: !row.active });
      if (!r.ok) toast.error(r.error);
      else router.refresh();
    });
  }

  function onDelete(row: ProductRow) {
    if (!confirm(`Delete product "${row.name}"?`)) return;
    start(async () => {
      const r = await deleteProduct(row.id);
      if (!r.ok) toast.error(r.error);
      else {
        toast.success("Deleted");
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-6">
      {products.length === 0 ? (
        <p className="text-sm text-muted-foreground">No products yet.</p>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    {p.name}
                    {p.unit ? <span className="text-muted-foreground"> / {p.unit}</span> : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.sku ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">
                    {p.currency} {p.price.toLocaleString()}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {p.cost != null ? `${p.currency} ${p.cost.toLocaleString()}` : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.active ? "Active" : "Inactive"}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => onToggleActive(p)}>
                        {p.active ? "Deactivate" : "Activate"}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={pending}
                        aria-label={`Delete ${p.name}`}
                        onClick={() => onDelete(p)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="grid gap-3 rounded-lg border bg-card p-6 sm:grid-cols-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground sm:col-span-2">
          Add product
        </h2>
        <div className="space-y-1.5">
          <Label htmlFor="p-name">Name</Label>
          <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-sku">SKU</Label>
          <Input id="p-sku" value={sku} onChange={(e) => setSku(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-price">Price</Label>
          <Input id="p-price" type="number" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-cost">Cost</Label>
          <Input id="p-cost" type="number" min="0" step="any" value={cost} onChange={(e) => setCost(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-unit">Unit</Label>
          <Input id="p-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="seat, hour…" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-currency">Currency</Label>
          <Input id="p-currency" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
        </div>
        <Button type="button" onClick={onCreate} disabled={pending} className="sm:col-span-2">
          {pending ? "Saving…" : "Add product"}
        </Button>
      </div>
    </div>
  );
}
