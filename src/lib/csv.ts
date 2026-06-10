function escapeCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCsv(rows: (string | null | undefined)[][]): string {
  return rows.map((row) => row.map((cell) => escapeCell(cell ?? "")).join(",")).join("\r\n") + "\r\n";
}
