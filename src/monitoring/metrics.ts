// ─── src/monitoring/metrics.ts ───
// Prometheus metrics for the Semantic API Gateway.

import client from 'prom-client';

const register = new client.Registry();

// ── Default metrics (CPU, memory, GC) ──
client.collectDefaultMetrics({ register, prefix: 'sgw_' });

// ── Custom Metrics ──

export const routingDuration = new client.Histogram({
  name: 'sgw_routing_duration_seconds',
  help: 'Time spent on semantic routing',
  labelNames: ['outcome'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

export const routingTotal = new client.Counter({
  name: 'sgw_routing_total',
  help: 'Total number of routing requests',
  labelNames: ['outcome', 'provider'] as const,
  registers: [register],
});

export const embeddingDuration = new client.Histogram({
  name: 'sgw_embedding_duration_seconds',
  help: 'Time spent generating embeddings',
  labelNames: ['provider', 'cached'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

export const embeddingCacheHits = new client.Counter({
  name: 'sgw_embedding_cache_hits_total',
  help: 'Number of embedding cache hits',
  registers: [register],
});

export const proxyDuration = new client.Histogram({
  name: 'sgw_proxy_duration_seconds',
  help: 'Time spent proxying requests to upstream',
  labelNames: ['service', 'status_code'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const proxyErrors = new client.Counter({
  name: 'sgw_proxy_errors_total',
  help: 'Number of proxy errors',
  labelNames: ['service', 'error_type'] as const,
  registers: [register],
});

export const activeConnections = new client.Gauge({
  name: 'sgw_active_connections',
  help: 'Number of active proxy connections',
  registers: [register],
});

export const catalogSize = new client.Gauge({
  name: 'sgw_catalog_services_count',
  help: 'Number of registered services',
  registers: [register],
});

export const confidenceScore = new client.Histogram({
  name: 'sgw_confidence_score',
  help: 'Distribution of confidence scores',
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0],
  registers: [register],
});

export { register };
