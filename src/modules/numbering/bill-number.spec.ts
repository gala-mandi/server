import { financialYear, formatBillNumber, shopDate } from './bill-number';

describe('bill numbers', () => {
  describe('formatBillNumber', () => {
    it('pads the number to six digits', () => {
      expect(formatBillNumber('PUR', '2026-27', 123)).toBe(
        'PUR-2026-27-000123',
      );
      expect(formatBillNumber('AK', '2026-27', 1)).toBe('AK-2026-27-000001');
    });

    it('keeps numbers longer than six digits whole', () => {
      expect(formatBillNumber('SAL', '2026-27', 1234567)).toBe(
        'SAL-2026-27-1234567',
      );
    });

    it.each([0, -1, 1.5, Number.NaN])('refuses %p', (n) => {
      expect(() => formatBillNumber('PUR', '2026-27', n)).toThrow(RangeError);
    });
  });

  describe('financialYear', () => {
    it('defaults to a year starting on 1 July', () => {
      expect(financialYear('2026-07-01', null)).toBe('2026-27');
      expect(financialYear('2027-06-30', null)).toBe('2026-27');
      expect(financialYear('2026-06-30', null)).toBe('2025-26');
    });

    it("uses the month and day of the shop's financial_year_start", () => {
      expect(financialYear('2026-03-31', '2020-04-01')).toBe('2025-26');
      expect(financialYear('2026-04-01', '2020-04-01')).toBe('2026-27');
    });

    it('labels a calendar financial year by its single year', () => {
      expect(financialYear('2026-12-31', '2026-01-01')).toBe('2026');
      expect(financialYear('2027-01-01', '2026-01-01')).toBe('2027');
    });

    it('wraps the short end year across a century', () => {
      expect(financialYear('2099-08-01', null)).toBe('2099-00');
    });
  });

  describe('shopDate', () => {
    it('uses the Asia/Karachi calendar day (UTC+5)', () => {
      expect(shopDate(new Date('2026-06-30T18:59:59Z'))).toBe('2026-06-30');
      expect(shopDate(new Date('2026-06-30T19:00:00Z'))).toBe('2026-07-01');
    });
  });
});
