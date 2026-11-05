import Decimal from 'decimal.js';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isCalendarDate } from '../../common/time/karachi-date';

/** A rate is per maund or per kg. */
export const RATE_UNITS = ['maund', 'kg'] as const;
export type RateUnit = (typeof RATE_UNITS)[number];

/** Most commodities one save may carry. */
export const MAX_RATES_PER_SAVE = 500;

const rateDate = z
  .string()
  .trim()
  .refine(isCalendarDate, 'Enter a date as YYYY-MM-DD');

// numeric(14,2): up to 12 digits before the point. Strings, never floats.
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const MONEY_MESSAGE = 'Enter a rate in rupees (up to 2 decimals)';

const money = z.string().trim().regex(MONEY, MONEY_MESSAGE);

export const rateInputSchema = z
  .object({
    commodityId: z.uuid('Choose a commodity'),
    minRate: money,
    maxRate: money,
    // Optional: null, missing or "" mean "not set".
    avgRate: z
      .string()
      .trim()
      .nullish()
      .transform((v) => v || null)
      .refine((v) => v === null || MONEY.test(v), MONEY_MESSAGE),
    rateUnit: z.enum(RATE_UNITS, 'Choose maund or kg').default('maund'),
  })
  .strict()
  .refine(
    // Only when both are well-formed; otherwise their own message shows.
    (r) =>
      !MONEY.test(r.minRate) ||
      !MONEY.test(r.maxRate) ||
      new Decimal(r.minRate).lte(r.maxRate),
    { message: 'Max rate must be at least the min rate', path: ['maxRate'] },
  );

export const saveRatesSchema = z
  .object({
    rates: z
      .array(rateInputSchema)
      .min(1, 'Enter at least one rate')
      .max(
        MAX_RATES_PER_SAVE,
        `Save at most ${MAX_RATES_PER_SAVE} rates at once`,
      ),
  })
  .strict()
  .superRefine(({ rates }, ctx) => {
    // One row per commodity and day: the same commodity twice is a mistake.
    const seen = new Set<string>();
    rates.forEach((rate, i) => {
      if (seen.has(rate.commodityId)) {
        ctx.addIssue({
          code: 'custom',
          message: 'This commodity is already in the list',
          path: ['rates', i, 'commodityId'],
        });
      }
      seen.add(rate.commodityId);
    });
  });

export const rateDateParamSchema = z.object({ date: rateDate });

export const listRatesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    commodity: z.uuid('Choose a commodity').optional(),
    from: rateDate.optional(),
    to: rateDate.optional(),
    sort: z.enum(['rateDate', '-rateDate']).default('-rateDate'),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: '"to" must be on or after "from"',
    path: ['to'],
  });

export type RateInput = z.infer<typeof rateInputSchema>;
export type SaveRatesInput = z.infer<typeof saveRatesSchema>;
export type ListRatesQuery = z.infer<typeof listRatesQuerySchema>;

export const rateSchema = z.object({
  id: z.uuid(),
  commodityId: z.uuid(),
  /** Asia/Karachi date, e.g. "2026-11-06". */
  rateDate: z.iso.date(),
  /** Rupees as strings, e.g. "4200.00". */
  minRate: z.string(),
  maxRate: z.string(),
  avgRate: z.string().nullable(),
  rateUnit: z.enum(RATE_UNITS),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Rate = z.infer<typeof rateSchema>;

const dayRatesSchema = z.object({
  date: z.iso.date(),
  data: z.array(rateSchema),
});

export type DayRates = z.infer<typeof dayRatesSchema>;

export class SaveRatesDto extends createZodDto(saveRatesSchema) {}
export class RateDateParamDto extends createZodDto(rateDateParamSchema) {}
export class ListRatesQueryDto extends createZodDto(listRatesQuerySchema) {}
export class DayRatesDto extends createZodDto(dayRatesSchema) {}
export class TodayRatesDto extends createZodDto(
  dayRatesSchema.extend({
    /** Yesterday's rates: the starting point for today's entry. */
    yesterday: dayRatesSchema,
  }),
) {}
export class RateListDto extends createZodDto(
  z.object({
    data: z.array(rateSchema),
    meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }),
  }),
) {}
