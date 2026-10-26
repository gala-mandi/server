import type { Request, Response } from 'express';
import { StripTenantIdMiddleware } from './strip-tenant-id.middleware';

function run(body: unknown): { body: unknown; next: jest.Mock } {
  const req = { body } as Request;
  const next = jest.fn();
  new StripTenantIdMiddleware().use(req, {} as Response, next);
  return { body: req.body, next };
}

describe('StripTenantIdMiddleware', () => {
  it('removes tenant_id and tenantId at the top level', () => {
    const { body, next } = run({
      name: 'Ali Traders',
      tenant_id: 'shop-b',
      tenantId: 'shop-b',
    });
    expect(body).toEqual({ name: 'Ali Traders' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('removes them from nested objects', () => {
    const { body } = run({
      trader: { name: 'Ali', tenant_id: 'shop-b', address: { tenantId: 'x' } },
    });
    expect(body).toEqual({ trader: { name: 'Ali', address: {} } });
  });

  it('removes them from objects inside arrays', () => {
    const { body } = run({
      items: [
        { commodityId: 'c1', tenant_id: 'shop-b' },
        { commodityId: 'c2', tenantId: 'shop-b' },
      ],
    });
    expect(body).toEqual({
      items: [{ commodityId: 'c1' }, { commodityId: 'c2' }],
    });
  });

  it('handles a body that is an array', () => {
    const { body } = run([{ tenant_id: 'shop-b', name: 'A' }, 'text', 3]);
    expect(body).toEqual([{ name: 'A' }, 'text', 3]);
  });

  it('keeps every other key and value unchanged', () => {
    const input = {
      name: 'Ali',
      tenant: 'kept',
      tenant_name: 'kept',
      amount: '1500.00',
      active: false,
      note: null,
      tags: ['a', 'b'],
    };
    const { body } = run({ ...input, tenant_id: 'shop-b' });
    expect(body).toEqual(input);
  });

  it('leaves string and missing bodies alone and calls next', () => {
    const text = run('tenant_id=shop-b');
    expect(text.body).toBe('tenant_id=shop-b');
    expect(text.next).toHaveBeenCalledTimes(1);

    const empty = run(undefined);
    expect(empty.body).toBeUndefined();
    expect(empty.next).toHaveBeenCalledTimes(1);
  });
});
