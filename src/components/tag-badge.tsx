export function TagBadge({ name, color }: { name: string; color: string }) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4"
      style={{ borderColor: color, color, backgroundColor: `${color}1a` }}
    >
      {name}
    </span>
  );
}
