import { ilike, or, type SQL } from 'drizzle-orm';
import { traders } from '../../database/schema';

/** `%`, `_` and `\` typed by the user match themselves, not any text. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Traders whose name, or phone (3+ digits typed), contains `text`. */
export function traderSearch(text: string): SQL {
  const name = ilike(traders.name, likePattern(text));
  const digits = text.replace(/\D/g, '');
  // Phones are stored as digits; "0300-123" finds 0300123….
  return digits.length >= 3
    ? or(name, ilike(traders.phone, likePattern(digits)))!
    : name;
}
