import { PRODUCT_FIELDS } from "./types";
import type { Product } from "./types";

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Builds the delta CSV from PRODUCT_FIELDS, so a new field is a one-place change (types.ts). */
export function buildCsv(rows: Product[]): string {
  const header = PRODUCT_FIELDS.join(",");
  const lines = rows.map((row) => PRODUCT_FIELDS.map((field) => escapeCsvField(row[field])).join(","));
  return [header, ...lines].join("\r\n") + "\r\n";
}
