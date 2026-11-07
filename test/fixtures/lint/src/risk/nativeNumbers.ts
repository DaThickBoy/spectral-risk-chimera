// Seeded violations: native number parsing and arithmetic helpers in a financial module.
export function nativeNumbers(text: string, count: number): number {
  const a = parseFloat(text);
  const b = Number(text);
  const c = +text;
  const e = Math.max(count, 1);
  const f = Number.parseFloat(text);
  return a + b + c + e + f;
}
