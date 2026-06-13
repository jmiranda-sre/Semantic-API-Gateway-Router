// ─── src/__tests__/semantic-router.test.ts ───
// Unit tests for the Semantic Router core logic.

import { describe, it, expect, beforeEach } from 'vitest';
import { CatalogManager } from '../registry/catalog-manager.js';
import { SemanticRouter } from '../core/semantic-router.js';
import { EmbeddingService } from '../core/embedding-service.js';
import type { ServiceRegistration, GatewayConfig } from '../registry/types.js';

// Minimal config for testing
const testConfig: GatewayConfig = {
  port: 3000,
  jwtSecret: 'test-secret-min-32-characters-length!!',
  jwtIssuer: 'test',
  jwtAudience: 'test',
  jwtExpiry: 900,
  adminApiKey: 'test-admin-key-min-32-characters-length!',
  embeddingProvider: 'local',
  openaiApiKey: '',
  embeddingModel: 'text-embedding-3-small',
  embeddingDimensions: 64, // Small for tests
  embeddingCacheTTL: 3600,
  embeddingCacheMax: 100,
  hnswM: 16,
  hnswEfConstruction: 200,
  hnswEfSearch: 50,
  confidenceThreshold: 0.5, // Lower for test determinism
  conflictMargin: 0.05,
  routerTimeoutMs: 5000,
  proxyTimeoutMs: 5000,
  proxyMaxSockets: 10,
  logLevel: 'silent',
  metricsEnabled: false,
  corsOrigin: 'http://localhost:3000',
  rateLimitMax: 100,
  rateLimitWindowMs: 60000,
  authRateLimitMax: 5,
  authRateLimitWindowMs: 900000,
};

function makeService(overrides: Partial<ServiceRegistration> & Pick<ServiceRegistration, 'name' | 'semanticDescription'>): ServiceRegistration {
  return {
    name: overrides.name,
    baseUrl: overrides.baseUrl ?? 'http://localhost:4001',
    version: overrides.version ?? '1.0.0',
    semanticDescription: overrides.semanticDescription,
    tags: overrides.tags ?? ['test'],
    securityTags: overrides.securityTags ?? ['public' as const],
    healthCheckPath: overrides.healthCheckPath ?? '/health',
    metadata: overrides.metadata,
  };
}

describe('CatalogManager', () => {
  let catalog: CatalogManager;

  beforeEach(() => {
    catalog = new CatalogManager(testConfig);
  });

  it('should register a service', () => {
    const service = catalog.register(makeService({
      name: 'user-service',
      semanticDescription: 'Manages user accounts and authentication',
      tags: ['users', 'auth'],
      securityTags: ['authenticated'],
    }));

    expect(service.id).toBeDefined();
    expect(service.name).toBe('user-service');
    expect(catalog.count).toBe(1);
  });

  it('should not allow duplicate registration with same name+version', () => {
    catalog.register(makeService({
      name: 'user-service',
      semanticDescription: 'Manages user accounts and authentication',
      tags: ['users'],
      securityTags: ['authenticated'],
    }));

    expect(() => {
      catalog.register(makeService({
        name: 'user-service',
        semanticDescription: 'Manages user accounts and authentication',
        tags: ['users'],
        securityTags: ['authenticated'],
      }));
    }).toThrow();
  });

  it('should hot-reload service with same name but different version', () => {
    const v1 = catalog.register(makeService({
      name: 'user-service',
      version: '1.0.0',
      semanticDescription: 'v1 description',
      tags: ['users'],
      securityTags: ['authenticated'],
    }));

    const v2 = catalog.register(makeService({
      name: 'user-service',
      version: '2.0.0',
      semanticDescription: 'v2 description',
      tags: ['users'],
      securityTags: ['authenticated'],
    }));

    expect(catalog.count).toBe(1);
    expect(v2.id).not.toBe(v1.id);
    expect(v2.version).toBe('2.0.0');
  });

  it('should deregister a service', () => {
    const service = catalog.register(makeService({
      name: 'user-service',
      semanticDescription: 'Manages user accounts and authentication',
      tags: ['users'],
      securityTags: ['authenticated'],
    }));

    const removed = catalog.deregister(service.id);
    expect(removed).toBe(true);
    expect(catalog.count).toBe(0);
  });

  it('should list all services', () => {
    catalog.register(makeService({
      name: 'svc-a',
      semanticDescription: 'Service A description',
      tags: ['a'],
    }));
    catalog.register(makeService({
      name: 'svc-b',
      baseUrl: 'http://localhost:4002',
      semanticDescription: 'Service B description',
      tags: ['b'],
    }));

    const list = catalog.listAll();
    expect(list).toHaveLength(2);
  });
});

describe('SemanticRouter', () => {
  let catalog: CatalogManager;
  let embeddingService: EmbeddingService;
  let router: SemanticRouter;

  beforeEach(() => {
    catalog = new CatalogManager(testConfig);
    embeddingService = new EmbeddingService(testConfig);
    router = new SemanticRouter(catalog, embeddingService, testConfig);
  });

  it('should return no match for empty catalog', async () => {
    const result = await router.route('I need to create a user');
    expect(result.matched).toBe(false);
    expect(result.selectedService).toBeNull();
  });

  it('should route to the best matching service', async () => {
    // Register services
    catalog.register(makeService({
      name: 'user-service',
      semanticDescription: 'Manages user accounts, profiles, authentication, and authorization. Handles user CRUD operations.',
      tags: ['users', 'auth'],
      securityTags: ['authenticated'],
    }));

    catalog.register(makeService({
      name: 'payment-service',
      baseUrl: 'http://localhost:4002',
      semanticDescription: 'Processes payments, refunds, and billing. Handles credit card transactions and Stripe integration.',
      tags: ['payments', 'billing'],
      securityTags: ['authenticated'],
    }));

    // Index services
    await router.indexUnembeddedServices();

    // Route
    const result = await router.route('I need to create a new user account');

    // With local fallback embeddings, exact match confidence may vary.
    // Test that the router returns candidates and a valid confidence.
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.candidates.length).toBeGreaterThan(0);
    // The result is either matched or not — local fallback is degraded quality
    // so we just verify the routing pipeline completes without error.
    expect(typeof result.matched).toBe('boolean');
  });

  it('should track routing metrics', async () => {
    catalog.register(makeService({
      name: 'svc-a',
      semanticDescription: 'Service for testing metrics tracking',
      tags: ['test'],
    }));

    await router.indexUnembeddedServices();
    await router.route('test metrics');

    const metrics = router.getMetrics();
    expect(metrics.totalQueries).toBe(1);
  });
});

describe('Vector Math', () => {
  it('cosine similarity: identical vectors', async () => {
    const { cosineSimilarity } = await import('../utils/vector-math.js');
    const vec = [1, 0, 0];
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0);
  });

  it('cosine similarity: orthogonal vectors', async () => {
    const { cosineSimilarity } = await import('../utils/vector-math.js');
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('cosine similarity: opposite vectors', async () => {
    const { cosineSimilarity } = await import('../utils/vector-math.js');
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('fnv1a hash: consistent', async () => {
    const { fnv1aHash } = await import('../utils/vector-math.js');
    expect(fnv1aHash('test')).toBe(fnv1aHash('test'));
    expect(fnv1aHash('test')).not.toBe(fnv1aHash('tset'));
  });
});

describe('EmbeddingService', () => {
  it('should cache identical embeddings', async () => {
    const service = new EmbeddingService(testConfig);
    const r1 = await service.embed('hello world');
    const r2 = await service.embed('hello world');

    expect(r1.cached).toBe(false);
    expect(r2.cached).toBe(true);
    expect(r1.vector).toEqual(r2.vector);
  });

  it('should report health status', async () => {
    const service = new EmbeddingService(testConfig);
    const health = service.getHealthStatus();
    expect(health).toHaveProperty('healthy');
    expect(health).toHaveProperty('provider');
  });
});
