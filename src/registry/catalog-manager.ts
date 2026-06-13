// ─── src/registry/catalog-manager.ts ───
// Dynamic service catalog with hot-reload and HNSW indexing.

import { v4 as uuid } from 'uuid';
import type {
  RegisteredService,
  ServiceRegistration,
  RoutingCandidate,
  GatewayConfig,
} from './types.js';
import pino from 'pino';

const logger = pino({ name: 'catalog-manager' });

export class CatalogManager {
  private services = new Map<string, RegisteredService>();
  private nameIndex = new Map<string, string>(); // name → id
  private idList: string[] = [];
  private indexBuilt = false;
  private hnswIndex: InstanceType<typeof import('hnswlib-node').HierarchicalNSW> | null = null;
  private config: GatewayConfig;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  // ── Registration ──

  register(registration: ServiceRegistration): RegisteredService {
    const existingId = this.nameIndex.get(registration.name);
    if (existingId) {
      const existing = this.services.get(existingId);
      if (existing && existing.version === registration.version) {
        throw new CatalogError(
          'CATALOG_SERVICE_EXISTS',
          `Service '${registration.name}' v${registration.version} already registered`,
        );
      }
      // Hot-reload: replace existing
      this.deregister(existingId);
    }

    const id = uuid();
    const now = Date.now();
    const service: RegisteredService = {
      id,
      ...registration,
      embedding: null,
      registeredAt: now,
      updatedAt: now,
    };

    this.services.set(id, service);
    this.nameIndex.set(registration.name, id);
    this.indexBuilt = false;

    logger.info({ serviceId: id, name: registration.name, version: registration.version }, 'service_registered');
    return service;
  }

  deregister(serviceId: string): boolean {
    const service = this.services.get(serviceId);
    if (!service) return false;

    this.services.delete(serviceId);
    this.nameIndex.delete(service.name);
    this.indexBuilt = false;

    logger.info({ serviceId, name: service.name }, 'service_deregistered');
    return true;
  }

  update(serviceId: string, patch: Partial<ServiceRegistration>): RegisteredService {
    const existing = this.services.get(serviceId);
    if (!existing) {
      throw new CatalogError('CATALOG_SERVICE_NOT_FOUND', `Service '${serviceId}' not found`);
    }

    // If name changed, update index
    if (patch.name && patch.name !== existing.name) {
      this.nameIndex.delete(existing.name);
      this.nameIndex.set(patch.name, serviceId);
    }

    const updated: RegisteredService = {
      ...existing,
      ...patch,
      embedding: patch.semanticDescription !== undefined ? null : existing.embedding,
      updatedAt: Date.now(),
    };
    this.services.set(serviceId, updated);

    if (patch.semanticDescription !== undefined) {
      this.indexBuilt = false;
    }

    logger.info({ serviceId, name: updated.name }, 'service_updated');
    return updated;
  }

  // ── Queries ──

  getById(serviceId: string): RegisteredService | undefined {
    return this.services.get(serviceId);
  }

  getByName(name: string): RegisteredService | undefined {
    const id = this.nameIndex.get(name);
    if (!id) return undefined;
    return this.services.get(id);
  }

  listAll(): RegisteredService[] {
    return [...this.services.values()];
  }

  get count(): number {
    return this.services.size;
  }

  // ── HNSW Index ──

  async buildIndex(): Promise<void> {
    if (this.indexBuilt) return;
    if (this.services.size === 0) return;

    const serviceList = [...this.services.values()].filter(s => s.embedding !== null);
    if (serviceList.length === 0) {
      logger.warn('no_services_with_embeddings_skip_index');
      return;
    }

    const dim = this.config.embeddingDimensions;
    const maxElements = serviceList.length * 2; // room for growth

    try {
      const hnswlib = await import('hnswlib-node');
      const index = new hnswlib.HierarchicalNSW('cosine', dim);

      index.initIndex(maxElements, this.config.hnswM, this.config.hnswEfConstruction, 42);
      
      this.idList = [];

      let label = 0;
      for (const service of serviceList) {
        if (service.embedding) {
          index.addPoint(service.embedding, label, false);
          this.idList.push(service.id);
          label++;
        }
      }

      index.setEf(this.config.hnswEfSearch);
      this.hnswIndex = index;
      this.indexBuilt = true;

      logger.info({ serviceCount: label, dimensions: dim }, 'hnsw_index_built');
    } catch (err) {
      logger.error({ err }, 'hnsw_index_build_failed_falling_back_to_brute_force');
      this.hnswIndex = null;
      this.indexBuilt = false;
    }
  }

  async searchNearest(queryEmbedding: number[], k: number = 5): Promise<RoutingCandidate[]> {
    // Ensure index is built
    await this.buildIndex();

    const candidates: RoutingCandidate[] = [];

    // Strategy 1: HNSW index (sub-millisecond)
    if (this.hnswIndex && this.indexBuilt && this.idList.length > 0) {
      try {
        const result = this.hnswIndex.searchKnn(queryEmbedding, Math.min(k, this.idList.length));
        for (let i = 0; i < result.neighbors.length; i++) {
          const label = result.neighbors[i] as number;
          const distance = result.distances[i] as number;
          const serviceId = this.idList[label]!;
          if (!serviceId) continue;
          const service = this.services.get(serviceId);
          if (service) {
            candidates.push({ service, score: 1 - distance }); // cosine similarity from distance
          }
        }
        return candidates;
      } catch (err) {
        logger.warn({ err }, 'hnsw_search_failed_fallback_brute_force');
      }
    }

    // Strategy 2: Brute-force cosine similarity (fallback)
    for (const service of this.services.values()) {
      if (!service.embedding) continue;
      const score = cosineSimilarity(queryEmbedding, service.embedding);
      candidates.push({ service, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, k);
  }

  // ── Embedding Management ──

  setServiceEmbedding(serviceId: string, embedding: number[]): void {
    const service = this.services.get(serviceId);
    if (!service) {
      throw new CatalogError('CATALOG_SERVICE_NOT_FOUND', `Service '${serviceId}' not found`);
    }
    service.embedding = embedding;
    service.updatedAt = Date.now();
    this.indexBuilt = false;
  }

  getServicesWithoutEmbeddings(): RegisteredService[] {
    return [...this.services.values()].filter(s => s.embedding === null);
  }
}

// ── Utility ──

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Catalog Error ──

export class CatalogError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}
