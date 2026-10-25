import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const healthSchema = z.object({
  status: z.literal('ok'),
  database: z.literal('up'),
});

export class HealthDto extends createZodDto(healthSchema) {}
