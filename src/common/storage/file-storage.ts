export interface StoredFile {
  /** Public address the browser loads the file from. */
  url: string;
}

export interface PutFileInput {
  /** Path inside the store, e.g. `tenants/<id>/logo-<uuid>.png`. */
  key: string;
  body: Buffer;
  contentType: string;
}

/** Where uploaded files (shop logos) are kept. */
export interface FileStorage {
  put(input: PutFileInput): Promise<StoredFile>;
}

export const FILE_STORAGE = Symbol('FILE_STORAGE');
