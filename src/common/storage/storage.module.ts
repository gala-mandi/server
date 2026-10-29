import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { FILE_STORAGE, type FileStorage } from './file-storage';
import { ImageKitStorage } from './imagekit.storage';
import { LocalDiskStorage } from './local-disk.storage';

/** ImageKit when `IMAGEKIT_PRIVATE_KEY` is set, local disk otherwise. */
export function createFileStorage(
  config: ConfigService<Env, true>,
): FileStorage {
  const privateKey = config.get('IMAGEKIT_PRIVATE_KEY', { infer: true });
  if (privateKey) {
    return new ImageKitStorage({
      privateKey,
      folder: config.get('IMAGEKIT_FOLDER', { infer: true }),
    });
  }
  return new LocalDiskStorage(
    config.get('UPLOADS_DIR', { infer: true }),
    config.get('PUBLIC_API_URL', { infer: true }),
  );
}

@Module({
  providers: [
    {
      provide: FILE_STORAGE,
      inject: [ConfigService],
      useFactory: createFileStorage,
    },
  ],
  exports: [FILE_STORAGE],
})
export class StorageModule {}
