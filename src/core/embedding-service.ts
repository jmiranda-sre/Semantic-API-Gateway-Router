// ─── src/core/embedding-service.ts ───
// Pluggable embedding engine with LRU cache and provider fallback.

import type { GatewayConfig } from '../registry/types.js';
import { LRUCache } from 'lru-cache';
import { fnv1aHash } from '../utils/vector-math.js';
import pino from 'pino';

const logger = pino({ name: 'embedding-service' });

export interface EmbeddingProvider {
  name: string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions: number;
}

// ── OpenAI Provider ──

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  name = 'openai';
  dimensions: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;

  constructor(
    private apiKey: string,
    private model: string,
    dimensions: number,
  ) {
    this.dimensions = dimensions;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getClient(): Promise<any> {
    if (!this.client) {
      const { default: OpenAI } = await import('openai');
      this.client = new OpenAI({ apiKey: this.apiKey, timeout: 10_000 });
    }
    return this.client;
  }

  async embed(text: string): Promise<number[]> {
    const client = await this.getClient();
    const response = await client.embeddings.create({
      model: this.model,
      input: text,
      dimensions: this.dimensions,
    });
    return response.data[0]!.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const client = await this.getClient();
    // Batch limit: 2048 per OpenAI API
    const batches = chunkArray(texts, 2048);
    const allEmbeddings: number[][] = [];

    for (const batch of batches) {
      const response = await client.embeddings.create({
        model: this.model,
        input: batch,
        dimensions: this.dimensions,
      });
      const sorted = response.data.sort((a: { index: number }, b: { index: number }) => a.index - b.index);
      allEmbeddings.push(...sorted.map((d: { embedding: number[] }) => d.embedding));
    }

    return allEmbeddings;
  }
}

// ── Local/Fallback Provider (deterministic hash-based, NOT for production matching) ──

export class LocalFallbackEmbeddingProvider implements EmbeddingProvider {
  name = 'local-fallback';
  dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    logger.warn({ textLength: text.length }, 'local_fallback_embedding_used_degraded_quality');
    return this.hashToVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(t => this.hashToVector(t));
  }

  /** Deterministic pseudo-embedding from text hash. NOT semantically meaningful. */
  private hashToVector(text: string): number[] {
    const vec = new Array(this.dimensions).fill(0);
    const normalized = text.toLowerCase().trim();
    for (let i = 0; i < normalized.length; i++) {
      const charCode = normalized.charCodeAt(i);
      const idx = (charCode + i) % this.dimensions;
      vec[idx]! += Math.sin(charCode * (i + 1)) * 0.1;
    }
    // Normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return norm === 0 ? vec : vec.map(v => v / norm);
  }
}

// ── Embedding Service (cache + fallback orchestration) ──

export class EmbeddingService {
  private provider: EmbeddingProvider;
  private fallback: LocalFallbackEmbeddingProvider;
  private cache: LRUCache<number, number[]>;
  private isHealthy = true;
  private consecutiveFailures = 0;
  private readonly MAX_FAILURES = 3;

  constructor(config: GatewayConfig) {
    this.cache = new LRUCache<number, number[]>({
      max: config.embeddingCacheMax,
      ttl: config.embeddingCacheTTL * 1000,
    });

    if (config.embeddingProvider === 'openai') {
      this.provider = new OpenAIEmbeddingProvider(
        config.openaiApiKey,
        config.embeddingModel,
        config.embeddingDimensions,
      );
    } else {
      this.provider = new LocalFallbackEmbeddingProvider(config.embeddingDimensions);
    }

    this.fallback = new LocalFallbackEmbeddingProvider(config.embeddingDimensions);
  }

  async embed(text: string): Promise<{ vector: number[]; cached: boolean; provider: string }> {
    const key = fnv1aHash(text.trim().toLowerCase());

    // Cache hit
    const cached = this.cache.get(key);
    if (cached) {
      return { vector: cached, cached: true, provider: 'cache' };
    }

    // Provider call with fallback
    try {
      const vector = await this.embedWithTimeout(text);
      this.consecutiveFailures = 0;
      this.isHealthy = true;
      this.cache.set(key, vector);
      return { vector, cached: false, provider: this.provider.name };
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.MAX_FAILURES) {
        this.isHealthy = false;
      }
      logger.error({ err, consecutiveFailures: this.consecutiveFailures }, 'embedding_provider_failed');
      // Fallback
      const fallbackVector = await this.fallback.embed(text);
      this.cache.set(key, fallbackVector);
      return { vector: fallbackVector, cached: false, provider: this.fallback.name };
    }
  }

  async embedBatch(texts: string[]): Promise<Array<{ vector: number[]; cached: boolean; provider: string }>> {
    const results: Array<{ vector: number[]; cached: boolean; provider: string }> = [];
    const uncached: { index: number; text: string }[] = [];

    // Check cache first
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      const key = fnv1aHash(text.trim().toLowerCase());
      const cached = this.cache.get(key);
      if (cached) {
        results[i] = { vector: cached, cached: true, provider: 'cache' };
      } else {
        uncached.push({ index: i, text });
      }
    }

    // Batch embed uncached
    if (uncached.length > 0) {
      try {
        const embeddings = await this.embedBatchWithTimeout(uncached.map(u => u.text));
        for (let j = 0; j < uncached.length; j++) {
          const { index } = uncached[j]!;
          const vector = embeddings[j]!;
          const key = fnv1aHash(uncached[j]!.text.trim().toLowerCase());
          this.cache.set(key, vector);
          results[index] = { vector, cached: false, provider: this.provider.name };
        }
        this.consecutiveFailures = 0;
        this.isHealthy = true;
      } catch (err) {
        this.consecutiveFailures++;
        logger.error({ err }, 'embedding_batch_failed_using_fallback');
        for (const { index, text } of uncached) {
          const fallbackVector = await this.fallback.embed(text);
          const key = fnv1aHash(text.trim().toLowerCase());
          this.cache.set(key, fallbackVector);
          results[index] = { vector: fallbackVector, cached: false, provider: this.fallback.name };
        }
      }
    }

    return results;
  }

  getHealthStatus(): { healthy: boolean; provider: string; consecutiveFailures: number } {
    return {
      healthy: this.isHealthy,
      provider: this.provider.name,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  getCacheStats(): { size: number; max: number; hitRate?: number } {
    return {
      size: this.cache.size,
      max: this.cache.max,
    };
  }

  switchProvider(provider: EmbeddingProvider): void {
    this.provider = provider;
    this.cache.clear();
    this.isHealthy = true;
    this.consecutiveFailures = 0;
    logger.info({ provider: provider.name }, 'embedding_provider_switched');
  }

  private embedWithTimeout(text: string): Promise<number[]> {
    return Promise.race([
      this.provider.embed(text),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new EmbeddingTimeoutError('Embedding request timed out')), 10_000),
      ),
    ]);
  }

  private embedBatchWithTimeout(texts: string[]): Promise<number[][]> {
    return Promise.race([
      this.provider.embedBatch(texts),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new EmbeddingTimeoutError('Batch embedding request timed out')), 30_000),
      ),
    ]);
  }
}

// ── Errors ──

export class EmbeddingTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingTimeoutError';
  }
}

// ── Utility ──

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
