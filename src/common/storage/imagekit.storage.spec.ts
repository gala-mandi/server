import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { ImageKitStorage } from './imagekit.storage';
import { LocalDiskStorage } from './local-disk.storage';
import { createFileStorage } from './storage.module';

const UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';
const KEY = 'private_test_key';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

interface Call {
  url: string;
  init: RequestInit;
}

/** A fake `fetch` that records its calls and answers with `respond()`. */
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = jest.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: url instanceof Request ? url.url : url.toString(),
      init: init ?? {},
    });
    return Promise.resolve(respond());
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const put = (storage: ImageKitStorage, key = 'tenants/abc/logo-1.png') =>
  storage.put({ key, body: PNG, contentType: 'image/png' });

describe('ImageKitStorage', () => {
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => logError.mockRestore());

  it('POSTs the file to the ImageKit upload API and returns its url', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ url: 'https://ik.imagekit.io/demo/tenants/abc/logo-1.png' }),
    );
    const storage = new ImageKitStorage({
      privateKey: KEY,
      folder: '/galla-mandi',
      fetch,
    });

    await expect(put(storage)).resolves.toEqual({
      url: 'https://ik.imagekit.io/demo/tenants/abc/logo-1.png',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(UPLOAD_URL);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('authenticates with Basic auth of the private key and an empty password', async () => {
    const { fetch, calls } = fakeFetch(() => json({ url: 'https://x/y.png' }));
    await put(new ImageKitStorage({ privateKey: KEY, folder: '/g', fetch }));

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`,
    );
  });

  it('sends the file, its name and the folder from the key', async () => {
    const { fetch, calls } = fakeFetch(() => json({ url: 'https://x/y.png' }));
    await put(
      new ImageKitStorage({ privateKey: KEY, folder: '/galla-mandi/', fetch }),
    );

    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('fileName')).toBe('logo-1.png');
    expect(form.get('folder')).toBe('/galla-mandi/tenants/abc');
    expect(form.get('useUniqueFileName')).toBe('false');

    const file = form.get('file') as File;
    expect(file.name).toBe('logo-1.png');
    expect(file.type).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
  });

  it('a key without a folder goes to the root folder', async () => {
    const { fetch, calls } = fakeFetch(() => json({ url: 'https://x/y.png' }));
    await put(
      new ImageKitStorage({ privateKey: KEY, folder: '/galla-mandi', fetch }),
      'logo.png',
    );

    const form = calls[0].init.body as FormData;
    expect(form.get('fileName')).toBe('logo.png');
    expect(form.get('folder')).toBe('/galla-mandi/');
  });

  it.each([400, 401, 403, 500, 503])(
    'a %i answer → 503 with a retry message, never the key',
    async (status) => {
      const { fetch } = fakeFetch(() =>
        json({ message: 'Your account cannot be authenticated.' }, status),
      );
      const result = put(
        new ImageKitStorage({ privateKey: KEY, folder: '/g', fetch }),
      );

      await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(result).rejects.toThrow(
        'Could not save the logo right now. Please try again.',
      );
      expect(String(logError.mock.calls)).not.toContain(KEY);
    },
  );

  it('a network error or timeout → 503', async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });

    await expect(
      put(new ImageKitStorage({ privateKey: KEY, folder: '/g', fetch })),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('a success answer without a url → 503', async () => {
    const { fetch } = fakeFetch(() => json({ fileId: 'abc' }));

    await expect(
      put(new ImageKitStorage({ privateKey: KEY, folder: '/g', fetch })),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('createFileStorage()', () => {
  const config = (env: Partial<Env>) =>
    ({
      get: (key: keyof Env) => env[key],
    }) as unknown as ConfigService<Env, true>;

  it('uses ImageKit when IMAGEKIT_PRIVATE_KEY is set', () => {
    expect(
      createFileStorage(
        config({ IMAGEKIT_PRIVATE_KEY: KEY, IMAGEKIT_FOLDER: '/galla-mandi' }),
      ),
    ).toBeInstanceOf(ImageKitStorage);
  });

  it('uses the local disk otherwise', () => {
    expect(
      createFileStorage(
        config({
          UPLOADS_DIR: 'uploads',
          PUBLIC_API_URL: 'http://localhost:4000',
        }),
      ),
    ).toBeInstanceOf(LocalDiskStorage);
  });
});
