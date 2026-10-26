import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { App } from 'supertest/types';
import type { Env } from '../src/config/env.schema';
import { createTestApp } from './create-app';

describe('Rate limit (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 429 after THROTTLE_LIMIT requests', async () => {
    const limit = app
      .get<ConfigService<Env, true>>(ConfigService)
      .get('THROTTLE_LIMIT', { infer: true });
    const server = app.getHttpServer();

    for (let i = 0; i < limit; i++) {
      await request(server).get('/health').expect(200);
    }
    const res = await request(server).get('/health').expect(429);

    expect(res.body).toEqual({
      statusCode: 429,
      message: 'Too many requests, please try again later',
    });
  }, 30_000);
});
