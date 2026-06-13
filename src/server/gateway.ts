// ─── src/server/gateway.ts ───
// Semantic API Gateway — Fastify server with semantic routing.

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { v4 as uuid } from 'uuid';

import type {
  GatewayConfig,
  APIErrorResponse,
  APISuccessResponse,
  SemanticQuery,
  ServiceRegistration,
  ErrorCode,
} from '../registry/types.js';
import { ServiceRegistrationSchema } from '../registry/types.js';
import { CatalogManager } from '../registry/catalog-manager.js';
import { EmbeddingService } from '../core/embedding-service.js';
import { SemanticRouter } from '../core/semantic-router.js';
import { ProxyHandler } from './proxy-handler.js';
import { verifyJWT, verifyAdminApiKey, AuthError } from './auth-handler.js';
import { logger, createContextLogger } from '../monitoring/logger.js';
import {
  register as metricsRegister,
  routingDuration,
  routingTotal,
  confidenceScore,
  catalogSize,
} from '../monitoring/metrics.js';

// ── Config from Environment ──

function loadConfig(): GatewayConfig {
  return {
    port: parseInt(process.env['APP_PORT'] ?? '3000', 10),
    jwtSecret: process.env['JWT_SECRET'] ?? 'dev-secret-change-me-in-production-min-32',
    jwtIssuer: process.env['JWT_ISSUER'] ?? 'semantic-gateway',
    jwtAudience: process.env['JWT_AUDIENCE'] ?? 'semantic-gateway',
    jwtExpiry: parseInt(process.env['JWT_EXPIRY'] ?? '900', 10),
    adminApiKey: process.env['ADMIN_API_KEY'] ?? 'dev-admin-key-change-me-min-32-chars',
    embeddingProvider: (process.env['EMBEDDING_PROVIDER'] as 'openai' | 'local') ?? 'openai',
    openaiApiKey: process.env['OPENAI_API_KEY'] ?? '',
    embeddingModel: process.env['EMBEDDING_MODEL'] ?? 'text-embedding-3-small',
    embeddingDimensions: parseInt(process.env['EMBEDDING_DIMENSIONS'] ?? '1536', 10),
    embeddingCacheTTL: parseInt(process.env['EMBEDDING_CACHE_TTL'] ?? '3600', 10),
    embeddingCacheMax: parseInt(process.env['EMBEDDING_CACHE_MAX'] ?? '10000', 10),
    hnswM: parseInt(process.env['HNSW_M'] ?? '16', 10),
    hnswEfConstruction: parseInt(process.env['HNSW_EF_CONSTRUCTION'] ?? '200', 10),
    hnswEfSearch: parseInt(process.env['HNSW_EF_SEARCH'] ?? '50', 10),
    confidenceThreshold: parseFloat(process.env['CONFIDENCE_THRESHOLD'] ?? '0.85'),
    conflictMargin: parseFloat(process.env['CONFLICT_MARGIN'] ?? '0.05'),
    routerTimeoutMs: parseInt(process.env['ROUTER_TIMEOUT_MS'] ?? '5000', 10),
    proxyTimeoutMs: parseInt(process.env['PROXY_TIMEOUT_MS'] ?? '30000', 10),
    proxyMaxSockets: parseInt(process.env['PROXY_MAX_SOCKETS'] ?? '100', 10),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    metricsEnabled: process.env['METRICS_ENABLED'] === 'true',
    corsOrigin: process.env['CORS_ORIGIN'] ?? 'http://localhost:3000',
    rateLimitMax: parseInt(process.env['RATE_LIMIT_MAX'] ?? '100', 10),
    rateLimitWindowMs: parseInt(process.env['RATE_LIMIT_WINDOW_MS'] ?? '60000', 10),
    authRateLimitMax: parseInt(process.env['AUTH_RATE_LIMIT_MAX'] ?? '5', 10),
    authRateLimitWindowMs: parseInt(process.env['AUTH_RATE_LIMIT_WINDOW_MS'] ?? '900000', 10),
  };
}

// ── Application ──

export async function buildGateway(config?: GatewayConfig) {
  const cfg = config ?? loadConfig();

  const app = Fastify({
    logger: false, // We use pino directly
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'correlation_id',
    genReqId: () => uuid(),
    trustProxy: true,
    bodyLimit: 1_048_576, // 1MB
  });

  // ── Core Services ──
  const catalog = new CatalogManager(cfg);
  const embeddingService = new EmbeddingService(cfg);
  const router = new SemanticRouter(catalog, embeddingService, cfg);
  const proxy = new ProxyHandler({ config: { timeout: cfg.proxyTimeoutMs, maxSockets: cfg.proxyMaxSockets } });
  const verifyToken = verifyJWT({
    jwtSecret: cfg.jwtSecret,
    jwtIssuer: cfg.jwtIssuer,
    jwtAudience: cfg.jwtAudience,
    adminApiKey: cfg.adminApiKey,
  });
  const verifyAdmin = verifyAdminApiKey({
    jwtSecret: cfg.jwtSecret,
    jwtIssuer: cfg.jwtIssuer,
    jwtAudience: cfg.jwtAudience,
    adminApiKey: cfg.adminApiKey,
  });

  // ── Plugins ──

  await app.register(cors, {
    origin: cfg.corsOrigin.split(','),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Admin-API-Key'],
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  });

  await app.register(rateLimit, {
    max: cfg.rateLimitMax,
    timeWindow: cfg.rateLimitWindowMs,
    keyGenerator: (req) => req.ip,
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
  });

  // ── Global Error Handler ──

  app.setErrorHandler((err, request, reply) => {
    const correlationId = request.id;
    const ctxLog = createContextLogger(correlationId);

    if (err instanceof AuthError) {
      const statusCode = err.code === 'AUTH_FORBIDDEN' ? 403 : 401;
      void reply.code(statusCode);
      return reply.send({
        error: {
          code: err.code as ErrorCode,
          message: err.message,
          details: [],
          request_id: correlationId,
        },
      } satisfies APIErrorResponse);
    }

    const errAny = err as Record<string, unknown>;
    if (errAny['statusCode'] === 429) {
      return reply.code(429).send({
        error: {
          code: 'AUTH_RATE_LIMITED' as ErrorCode,
          message: 'Too many requests. Retry after the window resets.',
          details: [],
          request_id: correlationId,
        },
      } satisfies APIErrorResponse);
    }

    // Validation errors from Fastify schema
    if (errAny['validation']) {
      const validation = errAny['validation'] as Array<{
        instancePath?: string;
        params?: Record<string, unknown>;
        message?: string;
      }>;
      void reply.code(400);
      return reply.send({
        error: {
          code: 'VALIDATION_ERROR' as ErrorCode,
          message: 'Invalid request body',
          details: validation.map(v => ({
            field: v.instancePath ?? (v.params?.['missingProperty'] as string | undefined) ?? 'unknown',
            message: v.message ?? 'Validation failed',
          })),
          request_id: correlationId,
        },
      } satisfies APIErrorResponse);
    }

    // Unexpected errors — log full, return generic
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : undefined;
    ctxLog.error({ err: errMsg, stack: errStack }, 'unhandled_error');
    return reply.code(500).send({
      error: {
        code: 'SYSTEM_INTERNAL_ERROR' as ErrorCode,
        message: 'An unexpected error occurred',
        details: [],
        request_id: correlationId,
      },
    } satisfies APIErrorResponse);
  });

  // ── Correlation ID + Auth Context Middleware ──

  app.addHook('onRequest', async (request, _reply) => {
    const correlationId = request.id;
    request.headers['x-request-id'] = correlationId;
    (request as any).correlationId = correlationId;
  });

  // ── Health Check ──

  app.get('/health', async () => {
    const embeddingHealth = embeddingService.getHealthStatus();
    const routerMetrics = router.getMetrics();

    const checks: Record<string, { status: string; latency_ms?: number; detail?: string }> = {
      catalog: { status: catalog.count > 0 ? 'healthy' : 'degraded', latency_ms: 0 },
      embedding: {
        status: embeddingHealth.healthy ? 'healthy' : 'degraded',
        detail: embeddingHealth.healthy ? undefined : `${embeddingHealth.consecutiveFailures} consecutive failures`,
      },
      vector_index: {
        status: catalog.count > 0 ? 'healthy' : 'degraded',
      },
    };

    const overallStatus = Object.values(checks).every(c => c.status === 'healthy')
      ? 'healthy'
      : Object.values(checks).some(c => c.status === 'unhealthy')
        ? 'unhealthy'
        : 'degraded';

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: process.env['APP_VERSION'] ?? '1.0.0',
      uptime_seconds: Math.floor(process.uptime()),
      checks,
      metrics: {
        total_queries: routerMetrics.totalQueries,
        direct_matches: routerMetrics.directMatches,
        avg_confidence: routerMetrics.avgConfidence.toFixed(4),
        avg_routing_time_ms: routerMetrics.avgRoutingTimeMs.toFixed(2),
      },
    };
  });

  // ── Metrics (Prometheus) ──

  app.get('/metrics', async (_req, reply) => {
    catalogSize.set(catalog.count);
    const metrics = await metricsRegister.metrics();
    void reply.type('text/plain; version=0.0.4');
    return reply.send(metrics);
  });

  // ── Semantic Route (Main Entry) ──

  app.post<{ Body: SemanticQuery }>('/api/v1/route', {
    schema: {
      body: {
        type: 'object',
        required: ['intent'],
        properties: {
          intent: { type: 'string', minLength: 1, maxLength: 4096 },
          context: { type: 'object' },
          preferredTags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const correlationId = request.id;
    const ctxLog = createContextLogger(correlationId);

    // Auth
    const auth = await verifyToken(request);

    const { intent, preferredTags } = request.body;
    ctxLog.info({ intent: intent.slice(0, 100), userId: auth.userId }, 'semantic_route_request');

    // Route
    const startTime = performance.now();
    const result = await router.route(intent, preferredTags);
    const elapsed = (performance.now() - startTime) / 1000;

    routingDuration.observe({ outcome: result.matched ? 'matched' : 'unmatched' }, elapsed);
    routingTotal.inc({ outcome: result.disambiguationRequired ? 'disambiguation' : result.matched ? 'matched' : 'unmatched', provider: 'unknown' });
    confidenceScore.observe(result.confidence);

    // No match
    if (!result.matched && !result.disambiguationRequired) {
      return reply.code(404).send({
        error: {
          code: 'ROUTER_NO_MATCH' as ErrorCode,
          message: 'No service matched the provided intent with sufficient confidence',
          details: [{ message: `Highest confidence: ${result.confidence.toFixed(4)} (threshold: ${cfg.confidenceThreshold})` }],
          request_id: correlationId,
        },
      } satisfies APIErrorResponse);
    }

    // Disambiguation required — 300 Multiple Choices
    if (result.disambiguationRequired) {
      return reply.code(300).send({
        data: {
          message: 'Multiple services match the intent. Please select one.',
          candidates: result.candidates.map(c => ({
            service_id: c.service.id,
            name: c.service.name,
            description: c.service.semanticDescription.slice(0, 200),
            confidence: c.score,
          })),
          confidence: result.confidence,
        },
      });
    }

    // Direct match — proxy
    const service = result.selectedService!;

    ctxLog.info({
      service: service.name,
      confidence: result.confidence,
      durationMs: Math.round(elapsed * 1000),
    }, 'semantic_route_matched');

    // Add routing metadata to response headers
    void reply.header('X-Matched-Service', service.name);
    void reply.header('X-Semantic-Confidence', result.confidence.toFixed(6));
    void reply.header('X-Request-ID', correlationId);

    // Proxy to upstream service
    await proxy.proxyRequest(request, reply, service, auth, correlationId, result.confidence);
  });

  // ── Resolve Disambiguation ──

  app.post<{ Body: { serviceId: string; intent: string } }>('/api/v1/route/resolve', {
    schema: {
      body: {
        type: 'object',
        required: ['serviceId', 'intent'],
        properties: {
          serviceId: { type: 'string' },
          intent: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const correlationId = request.id;
    const auth = await verifyToken(request);
    const { serviceId } = request.body;

    const service = catalog.getById(serviceId);
    if (!service) {
      return reply.code(404).send({
        error: {
          code: 'CATALOG_SERVICE_NOT_FOUND' as ErrorCode,
          message: `Service '${serviceId}' not found`,
          details: [],
          request_id: correlationId,
        },
      } satisfies APIErrorResponse);
    }

    void reply.header('X-Matched-Service', service.name);
    void reply.header('X-Request-ID', correlationId);

    await proxy.proxyRequest(request, reply, service, auth, correlationId, 1.0);
  });

  // ── Admin: Register Service ──

  app.post<{ Body: ServiceRegistration }>('/api/v1/admin/register', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'baseUrl', 'version', 'semanticDescription', 'tags', 'securityTags'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 128 },
          baseUrl: { type: 'string', format: 'uri' },
          version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+' },
          semanticDescription: { type: 'string', minLength: 10, maxLength: 2048 },
          tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
          securityTags: { type: 'array', items: { type: 'string', enum: ['public', 'authenticated', 'admin', 'internal'] }, minItems: 1 },
          healthCheckPath: { type: 'string', default: '/health' },
          metadata: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    verifyAdmin(request);

    const parsed = ServiceRegistrationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR' as ErrorCode,
          message: 'Invalid service registration',
          details: parsed.error.issues.map(i => ({
            field: i.path.join('.'),
            message: i.message,
          })),
          request_id: request.id,
        },
      } satisfies APIErrorResponse);
    }

    const service = catalog.register(parsed.data);

    // Auto-embed the new service
    try {
      const { vector } = await embeddingService.embed(service.semanticDescription);
      catalog.setServiceEmbedding(service.id, vector);
      await catalog.buildIndex();
    } catch (err) {
      logger.warn({ err, serviceId: service.id }, 'auto_embed_failed_for_new_service');
    }

    return reply.code(201).send({
      data: {
        id: service.id,
        name: service.name,
        version: service.version,
        status: 'registered',
        embeddingGenerated: service.embedding !== null,
      },
    } satisfies APISuccessResponse<unknown>);
  });

  // ── Admin: Deregister Service ──

  app.delete<{
    Params: { serviceId: string };
  }>('/api/v1/admin/services/:serviceId', async (request, reply) => {
    verifyAdmin(request);

    const removed = catalog.deregister(request.params.serviceId);
    if (!removed) {
      return reply.code(404).send({
        error: {
          code: 'CATALOG_SERVICE_NOT_FOUND' as ErrorCode,
          message: `Service '${request.params.serviceId}' not found`,
          details: [],
          request_id: request.id,
        },
      } satisfies APIErrorResponse);
    }

    await catalog.buildIndex();
    return reply.code(200).send({
      data: { id: request.params.serviceId, status: 'deregistered' },
    } satisfies APISuccessResponse<unknown>);
  });

  // ── Admin: Update Service ──

  app.patch<{
    Params: { serviceId: string };
    Body: Partial<ServiceRegistration>;
  }>('/api/v1/admin/services/:serviceId', async (request, reply) => {
    verifyAdmin(request);

    try {
      const updated = catalog.update(request.params.serviceId, request.body);

      // Re-embed if description changed
      if (request.body.semanticDescription) {
        try {
          const { vector } = await embeddingService.embed(updated.semanticDescription);
          catalog.setServiceEmbedding(updated.id, vector);
          await catalog.buildIndex();
        } catch (err) {
          logger.warn({ err }, 're_embed_failed_on_update');
        }
      }

      return reply.send({
        data: {
          id: updated.id,
          name: updated.name,
          version: updated.version,
          updatedAt: new Date(updated.updatedAt).toISOString(),
        },
      } satisfies APISuccessResponse<unknown>);
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        return reply.code(404).send({
          error: {
            code: 'CATALOG_SERVICE_NOT_FOUND' as ErrorCode,
            message: err.message,
            details: [],
            request_id: request.id,
          },
        } satisfies APIErrorResponse);
      }
      throw err;
    }
  });

  // ── Admin: List Services ──

  app.get('/api/v1/admin/services', async (request, _reply) => {
    verifyAdmin(request);

    const services = catalog.listAll();
    return {
      data: services.map(s => ({
        id: s.id,
        name: s.name,
        baseUrl: s.baseUrl,
        version: s.version,
        tags: s.tags,
        securityTags: s.securityTags,
        hasEmbedding: s.embedding !== null,
        registeredAt: new Date(s.registeredAt).toISOString(),
      })),
    };
  });

  // ── Admin: Re-index all services ──

  app.post('/api/v1/admin/reindex', async (request, reply) => {
    verifyAdmin(request);

    const indexed = await router.indexUnembeddedServices();
    return reply.send({
      data: {
        services_indexed: indexed,
        total_services: catalog.count,
      },
    } satisfies APISuccessResponse<unknown>);
  });

  // ── Graceful Shutdown ──

  app.addHook('onClose', () => {
    proxy.close();
    logger.info('gateway_shutdown_complete');
  });

  return { app, catalog, embeddingService, router, proxy };
}

// ── Entry Point ──

if (process.argv[1]?.endsWith('gateway.ts') || process.argv[1]?.endsWith('gateway.js')) {
  (async () => {
    const config = loadConfig();
    const { app } = await buildGateway(config);

    try {
      await app.listen({ port: config.port, host: '0.0.0.0' });
      logger.info({ port: config.port, env: process.env['APP_ENV'] ?? 'development' }, 'semantic_gateway_started');
    } catch (err) {
      logger.fatal({ err }, 'gateway_start_failed');
      process.exit(1);
    }

    // Graceful shutdown handlers
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'shutdown_signal_received');
      await app.close();
      process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  })();
}
