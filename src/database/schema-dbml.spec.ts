import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Parser } from '@dbml/core';
import { is, SQL } from 'drizzle-orm';
import {
  getTableConfig,
  isPgEnum,
  PgDialect,
  PgTable,
} from 'drizzle-orm/pg-core';
import * as schema from './schema';

/**
 * The database design (`docs/database/schema.dbml`, synced from the master
 * copy in `gala-mandi/.github`) and the Drizzle schema must describe the same
 * database. This compares them table by table: names, columns, SQL types,
 * NOT NULL, defaults, primary keys, unique columns, indexes, foreign keys
 * (and whether each relation is optional), check constraints and enums.
 *
 * Run alone with `npm run db:check-dbml`. When it fails, the DBML change
 * comes first (a PR to gala-mandi/.github), then the Drizzle change and its
 * migration; the diff printed by Jest shows which side differs.
 */

const DBML_PATH = join(__dirname, '../../docs/database/schema.dbml');

/**
 * Platform tables: no NOT NULL tenant_id and no Row-Level Security. Every
 * other table is a shop's business table.
 */
const PLATFORM_TABLES = [
  'plans',
  'tenants',
  'users',
  'refresh_tokens',
  'otp_codes',
  'auth_logs',
  'audit_logs',
];

interface ColumnModel {
  type: string;
  notNull: boolean;
  unique: boolean;
  default: string | null;
}

interface IndexModel {
  columns: string[];
  unique: boolean;
  method: string;
}

interface TableModel {
  columns: Record<string, ColumnModel>;
  primaryKey: string[];
  indexes: Record<string, IndexModel>;
  /** `column -> table.column`, with ` (optional)` when the column may be NULL. */
  foreignKeys: string[];
  checks: Record<string, string>;
}

interface SchemaModel {
  tables: Record<string, TableModel>;
  enums: Record<string, string[]>;
}

/** The same SQL type, however it is spelled (`timestamptz`, `int`, `numeric(14, 2)`…). */
const TYPE_ALIASES: Record<string, string> = {
  timestamptz: 'timestamp with time zone',
  int: 'integer',
  int4: 'integer',
  int8: 'bigint',
  bool: 'boolean',
};

function normalizeType(type: string): string {
  const lower = type.trim().toLowerCase();
  return (TYPE_ALIASES[lower] ?? lower).replace(/\s+/g, '');
}

/** SQL text without quotes, table prefixes or extra spaces. */
function normalizeSql(text: string): string {
  return text
    .replace(/"[a-z0-9_]+"\./g, '')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const dialect = new PgDialect();

function sqlText(value: SQL): string {
  return normalizeSql(dialect.sqlToQuery(value).sql);
}

// ───────────────────────── Drizzle side ─────────────────────────

function drizzleDefault(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (is(value, SQL)) return sqlText(value);
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function drizzleModel(): SchemaModel {
  const model: SchemaModel = { tables: {}, enums: {} };

  for (const value of Object.values(schema) as unknown[]) {
    if (isPgEnum(value)) {
      model.enums[value.enumName] = [...value.enumValues];
      continue;
    }
    if (!is(value, PgTable)) continue;

    const config = getTableConfig(value);
    const table: TableModel = {
      columns: {},
      primaryKey: [],
      indexes: {},
      foreignKeys: [],
      checks: {},
    };

    for (const column of config.columns) {
      table.columns[column.name] = {
        type: normalizeType(column.getSQLType()),
        notNull: column.notNull,
        unique: column.isUnique,
        default: drizzleDefault(column.default),
      };
      if (column.primary) table.primaryKey.push(column.name);
    }
    for (const pk of config.primaryKeys) {
      table.primaryKey.push(...pk.columns.map((c) => c.name));
    }

    // Partial indexes (`.where()`) can't be written in DBML; only the
    // columns are compared.
    for (const index of config.indexes) {
      const { name, columns, unique, method } = index.config;
      table.indexes[name ?? '(unnamed)'] = {
        columns: columns.map((c) =>
          is(c, SQL) ? sqlText(c) : ((c as { name?: string }).name ?? '?'),
        ),
        unique,
        method: method ?? 'btree',
      };
    }
    for (const constraint of config.uniqueConstraints) {
      table.indexes[constraint.getName() ?? '(unnamed)'] = {
        columns: constraint.columns.map((c) => c.name),
        unique: true,
        method: 'btree',
      };
    }

    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      const foreignTable = getTableConfig(ref.foreignTable).name;
      ref.columns.forEach((column, i) => {
        const optional = column.notNull ? '' : ' (optional)';
        table.foreignKeys.push(
          `${column.name} -> ${foreignTable}.${ref.foreignColumns[i].name}${optional}`,
        );
      });
    }
    table.foreignKeys.sort();

    for (const check of config.checks) {
      table.checks[check.name] = sqlText(check.value);
    }

    model.tables[config.name] = table;
  }
  return model;
}

// ───────────────────────── DBML side ─────────────────────────

/** The parts of the @dbml/core model this check reads (its own types are `any`). */
interface DbmlDefault {
  type: string;
  value: string | number | boolean;
}
interface DbmlIndexColumn {
  // 'column' or 'expression'
  type: string;
  value: string;
}
interface DbmlEndpoint {
  tableName: string;
  fieldNames: string[];
  relation: string;
}

function parseDbml(source: string) {
  const parser = new Parser();
  const database = parser.parse(source, 'dbmlv2');
  const warnings = parser.DBMLCompiler.parse
    .warnings()
    .map((w) => JSON.stringify(w));
  return { database, warnings };
}

function dbmlModel(source: string): SchemaModel {
  const { database } = parseDbml(source);
  const model: SchemaModel = { tables: {}, enums: {} };

  for (const dbSchema of database.schemas) {
    for (const dbEnum of dbSchema.enums) {
      model.enums[dbEnum.name] = dbEnum.values.map((v) => v.name);
    }

    for (const dbTable of dbSchema.tables) {
      const table: TableModel = {
        columns: {},
        primaryKey: [],
        indexes: {},
        foreignKeys: [],
        checks: {},
      };
      for (const field of dbTable.fields) {
        const type = field.type as { type_name: string };
        const dbDefault = field.dbdefault as DbmlDefault | undefined;
        table.columns[field.name] = {
          type: normalizeType(type.type_name),
          notNull: Boolean(field.not_null) || Boolean(field.pk),
          unique: Boolean(field.unique),
          default:
            dbDefault === undefined
              ? null
              : dbDefault.type === 'expression'
                ? normalizeSql(String(dbDefault.value))
                : String(dbDefault.value),
        };
        if (field.pk) table.primaryKey.push(field.name);
      }
      for (const index of dbTable.indexes) {
        const columns = (index.columns as DbmlIndexColumn[]).map((c) =>
          c.type === 'column' ? c.value : normalizeSql(c.value),
        );
        if (index.pk) {
          table.primaryKey.push(...columns);
          continue;
        }
        table.indexes[index.name ?? '(unnamed)'] = {
          columns,
          unique: Boolean(index.unique),
          method: (index.type as string | undefined) ?? 'btree',
        };
      }
      for (const check of dbTable.checks) {
        table.checks[check.name] = normalizeSql(check.expression);
      }
      model.tables[dbTable.name] = table;
    }

    // A relation belongs to the table holding the foreign key: the "many"
    // side, or for one-to-one (`-`) the column that declares the ref.
    for (const ref of dbSchema.refs) {
      const [a, b] = ref.endpoints as unknown as DbmlEndpoint[];
      const [child, parent] =
        a.relation === '*' && b.relation !== '*' ? [a, b] : [b, a];
      const optional = parent.relation === '0..1' ? ' (optional)' : '';
      const childTable = model.tables[child.tableName];
      child.fieldNames.forEach((column, i) => {
        childTable.foreignKeys.push(
          `${column} -> ${parent.tableName}.${parent.fieldNames[i]}${optional}`,
        );
      });
    }
  }
  for (const table of Object.values(model.tables)) table.foreignKeys.sort();
  return model;
}

// ───────────────────────── Tests ─────────────────────────

describe('docs/database/schema.dbml ↔ Drizzle schema', () => {
  const source = readFileSync(DBML_PATH, 'utf8');
  const drizzle = drizzleModel();
  const dbml = dbmlModel(source);
  const allTables = [
    ...new Set([...Object.keys(drizzle.tables), ...Object.keys(dbml.tables)]),
  ].sort();

  it('parses with no errors and no warnings', () => {
    expect(parseDbml(source).warnings).toEqual([]);
  });

  it('has the same tables (same count)', () => {
    expect(Object.keys(dbml.tables).sort()).toEqual(
      Object.keys(drizzle.tables).sort(),
    );
  });

  it('has the same enums', () => {
    expect(dbml.enums).toEqual(drizzle.enums);
  });

  it.each(allTables)('table %s matches', (name) => {
    expect(dbml.tables[name]).toEqual(drizzle.tables[name]);
  });

  it.each(allTables.filter((t) => !PLATFORM_TABLES.includes(t)))(
    'business table %s has a NOT NULL tenant_id and Row-Level Security',
    (name) => {
      const table = Object.values(schema).find(
        (v: unknown) => is(v, PgTable) && getTableConfig(v).name === name,
      ) as PgTable;
      const config = getTableConfig(table);
      const tenantId = config.columns.find((c) => c.name === 'tenant_id');
      expect(tenantId?.notNull).toBe(true);
      expect(config.policies.map((p) => p.name)).toContain('tenant_isolation');
    },
  );

  it.each(PLATFORM_TABLES)('platform table %s has no RLS policy', (name) => {
    expect(drizzle.tables[name]).toBeDefined();
    const table = Object.values(schema).find(
      (v: unknown) => is(v, PgTable) && getTableConfig(v).name === name,
    ) as PgTable;
    expect(getTableConfig(table).policies).toEqual([]);
  });
});
