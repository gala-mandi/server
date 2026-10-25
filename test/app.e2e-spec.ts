import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './create-app';

describe('App (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 when the database is up', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(res.body).toEqual({ status: 'ok', database: 'up' });
  });

  it('unknown route returns a clean JSON 404', async () => {
    const res = await request(app.getHttpServer())
      .get('/does-not-exist')
      .expect(404)
      .expect('Content-Type', /json/);

    expect(res.body).toEqual({
      statusCode: 404,
      message: 'Cannot GET /does-not-exist',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/at .+\.(ts|js):\d+/);
  });

  it('serves the OpenAPI document behind /docs', async () => {
    const res = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);

    expect(res.body).toHaveProperty(['paths', '/health']);
  });

  it('sets secure headers (helmet)', async () => {
    const res = await request(app.getHttpServer()).get('/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  describe('CORS', () => {
    const allowed = (process.env.CORS_ORIGINS ?? '').split(',')[0].trim();

    it('allows a listed origin', async () => {
      const res = await request(app.getHttpServer())
        .options('/health')
        .set('Origin', allowed)
        .set('Access-Control-Request-Method', 'GET');

      expect(res.headers['access-control-allow-origin']).toBe(allowed);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('rejects an origin that is not listed', async () => {
      const res = await request(app.getHttpServer())
        .options('/health')
        .set('Origin', 'https://evil.example.com')
        .set('Access-Control-Request-Method', 'GET');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
