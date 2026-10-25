import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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
