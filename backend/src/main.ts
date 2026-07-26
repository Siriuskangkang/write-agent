import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:8002',
    credentials: true,
    exposedHeaders: ['X-Workflow-Job-Id', 'X-Request-Id'],
  });

  const config = new DocumentBuilder()
    .setTitle('Writing Agent API')
    .setVersion('1.0.0')
    .addCookieAuth('wa_access_token')
    .addTag('Auth')
    .addTag('Projects')
    .addTag('Files')
    .addTag('Chunks')
    .addTag('Retrieval')
    .addTag('Directory')
    .addTag('Outline')
    .addTag('Content')
    .addTag('Citations')
    .addTag('Sessions')
    .addTag('Export')
    .addTag('Settings')
    .addTag('Workflows')
    .addTag('Health')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3002;
  await app.listen(port);
  console.log(`Backend running on http://localhost:${port}`);
  console.log(`Swagger docs at http://localhost:${port}/api/docs`);
}
bootstrap();
