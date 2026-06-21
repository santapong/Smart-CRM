"use client";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { formatCurrency } from "@/lib/utils";

type Datum = { name: string; value: number; weighted: number; color: string };

export function PipelineChart({ data }: { data: Datum[] }) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} barGap={2}>
          <XAxis dataKey="name" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
          <YAxis
            tickFormatter={(v) => formatCurrency(Number(v))}
            tick={{ fontSize: 12 }}
            stroke="hsl(var(--muted-foreground))"
            width={80}
          />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))" }}
            contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
            labelStyle={{ color: "hsl(var(--foreground))" }}
            formatter={(v: number, name) => [
              formatCurrency(v),
              name === "weighted" ? "Weighted" : "Total",
            ]}
          />
          <Bar dataKey="value" name="value" radius={[6, 6, 0, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.color} />
            ))}
          </Bar>
          <Bar dataKey="weighted" name="weighted" radius={[6, 6, 0, 0]} fillOpacity={0.45}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
