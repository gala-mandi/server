import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { FileStorage, PutFileInput, StoredFile } from './file-storage';

/**
 * Development store: files go to a folder on disk and are served by the API
 * at `/uploads` (see `configureApp`). Used when no ImageKit key is set.
 */
export class LocalDiskStorage implements FileStorage {
  private readonly root: string;

  constructor(
    root: string,
    private readonly publicBaseUrl: string,
  ) {
    this.root = resolve(root);
  }

  async put({ key, body }: PutFileInput): Promise<StoredFile> {
    const path = resolve(this.root, key);
    // Keys are built by the server, but never write outside the folder.
    if (!path.startsWith(this.root + sep)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return {
      url: `${this.publicBaseUrl.replace(/\/+$/, '')}/uploads/${key}`,
    };
  }
}
