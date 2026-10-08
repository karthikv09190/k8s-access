/**
 * Export utilities for K8s resources.
 * Use URL.createObjectURL + temporary <a> for downloads (works in Tauri webview).
 */

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportJSON(filename: string, data: unknown[]): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  triggerDownload(blob, filename);
}

/** Resolve a dot-path accessor like "metadata.name" against an object. */
function getByPath(obj: any, path: string): unknown {
  return path.split(".").reduce((acc, key) => {
    if (acc == null) return "";
    return acc[key];
  }, obj);
}

function toCsvValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return JSON.stringify(value);
  const str = String(value);
  // Escape double quotes and wrap in quotes if the value contains commas, quotes, or newlines
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportCSV(filename: string, data: any[], columns: string[]): void {
  const header = columns.join(",");
  const rows = data.map((item) =>
    columns.map((col) => toCsvValue(getByPath(item, col))).join(",")
  );
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  triggerDownload(blob, filename);
}

/**
 * Returns a markdown table string.
 * rows[0] is the header row; remaining rows are data rows.
 */
export function exportMarkdown(title: string, rows: string[][]): string {
  if (rows.length === 0) return `# ${title}\n\n_No data_\n`;

  const [header, ...dataRows] = rows;
  const separator = header.map(() => "---");

  const formatRow = (cells: string[]) => `| ${cells.join(" | ")} |`;

  const lines = [
    `# ${title}`,
    "",
    formatRow(header),
    formatRow(separator),
    ...dataRows.map(formatRow),
    "",
  ];

  return lines.join("\n");
}
