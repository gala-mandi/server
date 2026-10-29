import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import express from 'express';
import helmet from 'helmet';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import type { Env } from './config/env.schema';

/** Shared by main.ts and the e2e tests, so tests run the real app setup. */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const allowedOrigins = config.get('CORS_ORIGINS', { infer: true });

  app.use(helmet());
  app.enableCors({
    // Requests without an Origin (curl, server-to-server) are allowed;
    // browsers from other origins get no CORS headers and are blocked.
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => callback(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
    exposedHeaders: ['Retry-After', 'X-RateLimit-Remaining'],
  });
  app.enableShutdownHooks();

  // Logos saved on local disk (no ImageKit key). Other origins (the web
  // panel) may show them as images; nothing else is served from here.
  if (!config.get('IMAGEKIT_PRIVATE_KEY', { infer: true })) {
    app.use(
      '/uploads',
      express.static(config.get('UPLOADS_DIR', { infer: true }), {
        dotfiles: 'deny',
        index: false,
        redirect: false,
        setHeaders: (res) => {
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
  }

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Galla Mandi API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, cleanupOpenApiDoc(document));
}
