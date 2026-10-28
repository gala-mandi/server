import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { FileStorage, PutFileInput, StoredFile } from './file-storage';

const UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';

export interface ImageKitOptions {
  privateKey: string;
  /** Folder in the ImageKit media library, e.g. `/galla-mandi`. */
  folder: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Production store: ImageKit, through its upload REST API (server-side
 * upload with the private key, so no SDK is needed).
 */
export class ImageKitStorage implements FileStorage {
  private readonly logger = new Logger(ImageKitStorage.name);
  private readonly fetch: typeof fetch;

  constructor(private readonly options: ImageKitOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async put({ key, body, contentType }: PutFileInput): Promise<StoredFile> {
    const slash = key.lastIndexOf('/');
    const folder = `${this.options.folder.replace(/\/+$/, '')}/${key.slice(0, Math.max(slash, 0))}`;
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(body)], { type: contentType }),
      key.slice(slash + 1),
    );
    form.append('fileName', key.slice(slash + 1));
    form.append('folder', folder);
    form.append('useUniqueFileName', 'false');

    let response: Response;
    try {
      response = await this.fetch(UPLOAD_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.options.privateKey}:`).toString('base64')}`,
        },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      this.logger.error(`ImageKit upload failed: ${String(error)}`);
      throw unavailable();
    }

    if (!response.ok) {
      // The body has ImageKit's reason; never contains our key.
      this.logger.error(
        `ImageKit upload failed (${response.status}): ${await response.text()}`,
      );
      throw unavailable();
    }
    const { url } = (await response.json()) as { url?: unknown };
    if (typeof url !== 'string') {
      this.logger.error('ImageKit upload returned no url');
      throw unavailable();
    }
    return { url };
  }
}

const unavailable = () =>
  new ServiceUnavailableException(
    'Could not save the logo right now. Please try again.',
  );
