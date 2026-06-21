import Papa from "papaparse";

/**
 * Parsed CSV: ordered `headers` from the header row plus `rows` as
 * header→cell-string objects. Empty cells become "" so mapping/validation see a
 * consistent shape. Used by the import runner and preview (M13c).
 */
export type ParsedCsv = {
  headers: string[];
  rows: Record<string, string>[];
};

/**
 * Parse CSV `text` with a header row via papaparse. Tolerant of quoting,
 * embedded commas/newlines and Windows line endings; blank lines are skipped.
 * Cells are coerced to trimmed strings.
 */
export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });

  const headers = (result.meta.fields ?? []).map((h) => h.trim()).filter((h) => h.length > 0);

  const rows: Record<string, string>[] = [];
  for (const raw of result.data) {
    if (!raw || typeof raw !== "object") continue;
    const row: Record<string, string> = {};
    let hasValue = false;
    for (const h of headers) {
      const v = raw[h];
      const cell = v == null ? "" : String(v).trim();
      row[h] = cell;
      if (cell.length > 0) hasValue = true;
    }
    if (hasValue) rows.push(row);
  }

  return { headers, rows };
}
