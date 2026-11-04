import {
  bagsToKg,
  formatWeight,
  InvalidQuantityError,
  kgToBags,
  kgToMaund,
  maundToKg,
  UNIT_LABELS,
} from './units';

describe('kgToMaund()', () => {
  it('1,000 kg with maund = 40 kg → 25 maund', () => {
    expect(kgToMaund('1000', '40')).toEqual({
      maund: '25',
      kg: '0.000',
      totalMaund: '25.000',
    });
  });

  it('1,010 kg → 25 maund 10 kg (25.25 maund)', () => {
    expect(kgToMaund('1010', '40')).toEqual({
      maund: '25',
      kg: '10.000',
      totalMaund: '25.250',
    });
  });

  it('0 kg → 0 maund 0 kg', () => {
    expect(kgToMaund('0', '40')).toEqual({
      maund: '0',
      kg: '0.000',
      totalMaund: '0.000',
    });
  });

  it('less than one maund stays in kg', () => {
    expect(kgToMaund('39.999', '40')).toMatchObject({
      maund: '0',
      kg: '39.999',
    });
  });

  it('decimals: 1010.5 kg → 25 maund 10.5 kg', () => {
    expect(kgToMaund('1010.5', '40')).toEqual({
      maund: '25',
      kg: '10.500',
      totalMaund: '25.263',
    });
  });

  it('no float error: 0.1 + 0.2 style values stay exact', () => {
    // 40.3 / 40 in floats leaves 0.29999999999999716 kg.
    expect(kgToMaund('40.3', '40').kg).toBe('0.300');
    expect(kgToMaund('80.7', '40.1').kg).toBe('0.500');
  });

  it('very large: 999,999,999.999 kg', () => {
    expect(kgToMaund('999999999.999', '40')).toEqual({
      maund: '24999999',
      kg: '39.999',
      totalMaund: '25000000.000',
    });
  });

  it('custom maund_kg 37.324: whole maunds plus the exact rest', () => {
    // 26 × 37.324 = 970.424
    expect(kgToMaund('1000', '37.324')).toEqual({
      maund: '26',
      kg: '29.576',
      totalMaund: '26.792',
    });
  });

  it('rounds the input to 3 decimals (half up) first', () => {
    expect(kgToMaund('10.0005', '40').kg).toBe('10.001');
    expect(kgToMaund('39.9996', '40')).toMatchObject({
      maund: '1',
      kg: '0.000',
    });
  });

  it('accepts surrounding spaces', () => {
    expect(kgToMaund(' 1000 ', ' 40 ').maund).toBe('25');
  });

  it.each(['-1', '-0.001', '', ' ', 'abc', '1e3', '1,000', '10.', '.5', 'NaN'])(
    'refuses kg %p',
    (kg) => {
      expect(() => kgToMaund(kg, '40')).toThrow(InvalidQuantityError);
    },
  );

  it('refuses a number instead of a string (no floats in)', () => {
    expect(() => kgToMaund(1000 as unknown as string, '40')).toThrow(
      InvalidQuantityError,
    );
  });

  it.each(['0', '0.000', '-40', 'x', '0.0001'])('refuses maund_kg %p', (m) => {
    expect(() => kgToMaund('1000', m)).toThrow(/maundKg/);
  });
});

describe('maundToKg()', () => {
  it('25 maund → 1000 kg', () => {
    expect(maundToKg('25', '40')).toBe('1000.000');
  });

  it('25 maund 10 kg → 1010 kg', () => {
    expect(maundToKg('25', '40', '10')).toBe('1010.000');
  });

  it('decimal maunds: 25.25 → 1010 kg', () => {
    expect(maundToKg('25.25', '40')).toBe('1010.000');
  });

  it('custom maund_kg: 26 maund 29.576 kg of 37.324 → 1000 kg', () => {
    expect(maundToKg('26', '37.324', '29.576')).toBe('1000.000');
  });

  it('0 → 0', () => {
    expect(maundToKg('0', '40')).toBe('0.000');
  });

  it('very large', () => {
    expect(maundToKg('24999999', '40', '39.999')).toBe('999999999.999');
  });

  it('rounds the result to 3 decimals', () => {
    // 1/3 maund-ish: 0.3333 × 37.324 = 12.4400892
    expect(maundToKg('0.3333', '37.324')).toBe('12.440');
  });

  it.each(['0', '1', '39.999', '1010.5', '123456.789', '999999999.999'])(
    'round trip: %s kg → maund + kg → the same kg',
    (kg) => {
      const { maund, kg: rest } = kgToMaund(kg, '37.324');
      expect(maundToKg(maund, '37.324', rest)).toBe(
        Number.isInteger(Number(kg))
          ? `${kg}.000`
          : kg.padEnd(kg.indexOf('.') + 4, '0'),
      );
    },
  );

  it.each([
    ['-1', '40', '0'],
    ['1', '0', '0'],
    ['1', '40', '-5'],
    ['one', '40', '0'],
  ])('refuses maund %p, maund_kg %p, kg %p', (mn, m, kg) => {
    expect(() => maundToKg(mn, m, kg)).toThrow(InvalidQuantityError);
  });
});

describe('kgToBags() / bagsToKg()', () => {
  it('1005 kg in 100 kg bags → 10 bags 5 kg', () => {
    expect(kgToBags('1005', '100')).toEqual({
      bags: '10',
      kg: '5.000',
      totalBags: '10.050',
    });
  });

  it('decimal bag weight: 50.5 kg bags', () => {
    expect(kgToBags('1010', '50.5')).toEqual({
      bags: '20',
      kg: '0.000',
      totalBags: '20.000',
    });
  });

  it('0 kg → 0 bags', () => {
    expect(kgToBags('0', '100')).toEqual({
      bags: '0',
      kg: '0.000',
      totalBags: '0.000',
    });
  });

  it('12 bags of 100 kg → 1200 kg; half a bag counts', () => {
    expect(bagsToKg('12', '100')).toBe('1200.000');
    expect(bagsToKg('12.5', '100')).toBe('1250.000');
    expect(bagsToKg('0', '100')).toBe('0.000');
  });

  it('very large', () => {
    expect(bagsToKg('9999999', '99999.999')).toBe('999999890000.001');
    expect(kgToBags('999999999.999', '99999.999').bags).toBe('10000');
  });

  it.each(['0', '-1', '', 'abc'])('refuses bag weight %p', (w) => {
    expect(() => kgToBags('100', w)).toThrow(/bagWeightKg/);
    expect(() => bagsToKg('1', w)).toThrow(/bagWeightKg/);
  });

  it('refuses negative bags or kg', () => {
    expect(() => bagsToKg('-1', '100')).toThrow(/bags/);
    expect(() => kgToBags('-1', '100')).toThrow(/kg/);
  });
});

describe('formatWeight()', () => {
  it.each([
    ['1000', '40', '25 mn'],
    ['1010', '40', '25 mn 10 kg'],
    ['1010.5', '40', '25 mn 10.5 kg'],
    ['0', '40', '0 kg'],
    ['0.000', '40', '0 kg'],
    ['10', '40', '10 kg'],
    ['39.999', '40', '39.999 kg'],
    ['40', '40', '1 mn'],
    ['1000', '37.324', '26 mn 29.576 kg'],
    ['999999999.999', '40', '24999999 mn 39.999 kg'],
  ])('%s kg (maund %s) → %p', (kg, maundKg, text) => {
    expect(formatWeight(kg, maundKg)).toBe(text);
  });

  it('labels come from one place and can be swapped (Urdu later)', () => {
    expect(UNIT_LABELS).toEqual({ maund: 'mn', kg: 'kg', bag: 'bag' });
    expect(
      formatWeight('1010', '40', { maund: 'من', kg: 'کلو', bag: 'بوری' }),
    ).toBe('25 من 10 کلو');
  });

  it('refuses bad input like the converters', () => {
    expect(() => formatWeight('-5', '40')).toThrow(InvalidQuantityError);
    expect(() => formatWeight('5', '0')).toThrow(InvalidQuantityError);
  });

  it('the error names the field', () => {
    try {
      formatWeight('abc', '40');
      fail('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect((error as InvalidQuantityError).field).toBe('kg');
    }
  });
});
