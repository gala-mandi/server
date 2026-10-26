/** Phone numbers are stored as local digits, e.g. `03001234567`. */
export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  // +92 300 1234567 → 03001234567
  if (digits.startsWith('92') && digits.length === 12)
    return `0${digits.slice(2)}`;
  return digits;
}

export type Identifier =
  { kind: 'email'; value: string } | { kind: 'phone'; value: string };

/** Login accepts a phone number or an email address. */
export function parseIdentifier(input: string): Identifier {
  const value = input.trim();
  if (value.includes('@')) return { kind: 'email', value: value.toLowerCase() };
  return { kind: 'phone', value: normalizePhone(value) };
}
