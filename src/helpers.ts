export function stringOr(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

export function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number" && isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return fallback;
}

export function booleanOr(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}
