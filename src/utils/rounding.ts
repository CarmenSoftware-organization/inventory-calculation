export function round(value: number, precision: number = 4): number {
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}
