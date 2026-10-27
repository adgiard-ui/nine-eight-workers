import { PRODUCT_FIELDS } from "./types";
import type { Product } from "./types";

// UTF-8 byte-order mark. Without it Excel opens the CSV as Windows-1252
// and mangles non-ASCII product names (PCNA uses the trademark/registered
// symbols in several names).
const UTF8_BOM = "﻿";

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
  return UTF8_BOM + [header, ...lines].join("\r\n") + "\r\n";
}
