import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDiskStorage } from './local-disk.storage';

describe('LocalDiskStorage', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'galla-mandi-storage-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it('writes the file under the root, creating folders', async () => {
    const storage = new LocalDiskStorage(root, 'http://localhost:4000');

    await storage.put({
      key: 'tenants/abc/logo-1.png',
      body,
      contentType: 'image/png',
    });

    expect(await readFile(join(root, 'tenants', 'abc', 'logo-1.png'))).toEqual(
      body,
    );
  });

  it('returns the public url under /uploads', async () => {
    const storage = new LocalDiskStorage(root, 'http://localhost:4000');

    await expect(
      storage.put({ key: 'tenants/abc/logo-1.png', body, contentType: 'x' }),
    ).resolves.toEqual({
      url: 'http://localhost:4000/uploads/tenants/abc/logo-1.png',
    });
  });

  it('does not double the slash when the base url ends with one', async () => {
    const storage = new LocalDiskStorage(root, 'https://api.example.com//');

    const { url } = await storage.put({
      key: 'a.png',
      body,
      contentType: 'image/png',
    });

    expect(url).toBe('https://api.example.com/uploads/a.png');
  });

  it('normalises a root path with .. segments', async () => {
    const storage = new LocalDiskStorage(
      join(root, 'nested', '..', 'files'),
      'http://localhost:4000',
    );

    await storage.put({ key: 'x/y.png', body, contentType: 'image/png' });

    expect(existsSync(join(root, 'files', 'x', 'y.png'))).toBe(true);
  });

  it.each([
    '../outside.png',
    'tenants/../../outside.png',
    '/etc/passwd-copy',
    '',
    '.',
  ])('refuses key %p that escapes the root', async (key) => {
    const storage = new LocalDiskStorage(
      join(root, 'uploads'),
      'http://localhost:4000',
    );

    await expect(
      storage.put({ key, body, contentType: 'image/png' }),
    ).rejects.toThrow('Invalid storage key');
    expect(existsSync(join(root, 'outside.png'))).toBe(false);
  });

  it('refuses a sibling folder whose name starts like the root', async () => {
    const storage = new LocalDiskStorage(
      join(root, 'uploads'),
      'http://localhost:4000',
    );

    await expect(
      storage.put({
        key: '../uploads-evil/x.png',
        body,
        contentType: 'image/png',
      }),
    ).rejects.toThrow('Invalid storage key');
    expect(existsSync(join(root, 'uploads-evil'))).toBe(false);
  });
});
