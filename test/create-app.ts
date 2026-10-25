import { INestApplication, type Type } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

export interface TestAppOptions {
  imports?: Type[];
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

export async function createTestApp(
  options: TestAppOptions = {},
): Promise<INestApplication<App>> {
  const builder = Test.createTestingModule({
    imports: [AppModule, ...(options.imports ?? [])],
  });
  const moduleRef = await (options.override?.(builder) ?? builder).compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return app;
}
