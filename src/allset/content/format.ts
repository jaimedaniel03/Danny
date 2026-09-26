/** +13125550123 → (312) 555-0123 */
export function formatPhone(e164: string): string {
  const digits = e164.replace(/^\+1/, '');
  if (!/^\d{10}$/.test(digits)) return e164;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}
