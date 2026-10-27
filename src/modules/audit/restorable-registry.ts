import { Injectable } from '@nestjs/common';
import type { TenantTable } from '../../database/tenant-table';

/**
 * Business tables whose soft-deleted rows an owner may restore through
 * `POST /records/:entity/:id/restore`. Each module registers its table
 * (e.g. `registry.register('traders', traders)` in `onModuleInit`).
 */
@Injectable()
export class RestorableRegistry {
  private readonly tables = new Map<string, TenantTable>();

  register(entity: string, table: TenantTable): void {
    this.tables.set(entity, table);
  }

  get(entity: string): TenantTable | undefined {
    return this.tables.get(entity);
  }
}
