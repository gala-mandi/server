import { normalizePhone, parseIdentifier } from './identifier';

describe('identifier', () => {
  it.each([
    ['03001234567', '03001234567'],
    ['0300-1234567', '03001234567'],
    ['0300 123 4567', '03001234567'],
    ['+92 300 1234567', '03001234567'],
    ['923001234567', '03001234567'],
  ])('normalizes phone %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('treats input with @ as a lower-cased email', () => {
    expect(parseIdentifier('  Owner@Shop.PK ')).toEqual({
      kind: 'email',
      value: 'owner@shop.pk',
    });
  });

  it('treats anything else as a phone', () => {
    expect(parseIdentifier('0300 1234567')).toEqual({
      kind: 'phone',
      value: '03001234567',
    });
  });
});
