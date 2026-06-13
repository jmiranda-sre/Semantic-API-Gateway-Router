// ─── src/core/semantic-router.ts ───
// Core routing engine: semantic matching, confidence thresholds, disambiguation.

import type { RoutingResult, RoutingCandidate, GatewayConfig } from '../registry/types.js';
import type { CatalogManager } from '../registry/catalog-manager.js';
import type { EmbeddingService } from './embedding-service.js';
import pino from 'pino';

const logger = pino({ name: 'semantic-router' });

export interface SemanticRouterMetrics {
  totalQueries: number;
  directMatches: number;
  disambiguations: number;
  noMatches: number;
  avgConfidence: number;
  avgRoutingTimeMs: number;
}

export class SemanticRouter {
  private metrics: SemanticRouterMetrics = {
    totalQueries: 0,
    directMatches: 0,
    disambiguations: 0,
    noMatches: 0,
    avgConfidence: 0,
    avgRoutingTimeMs: 0,
  };
  private totalConfidence = 0;
  private totalRoutingTime = 0;

  constructor(
    private catalog: CatalogManager,
    private embeddingService: EmbeddingService,
    private config: GatewayConfig,
  ) {}

  /**
   * Route a semantic intent to the best-matching service.
   *
   * Flow:
   * 1. Embed the intent
   * 2. Search catalog for nearest services
   * 3. Apply confidence threshold
   * 4. Apply conflict resolution (ambiguous → 300)
   * 5. Return routing result
   */
  async route(intent: string, preferredTags?: string[]): Promise<RoutingResult> {
    const startTime = performance.now();

    try {
      // Step 1: Embed intent
      const { vector, cached, provider } = await this.embeddingService.embed(intent);
      logger.debug({ intent: intent.slice(0, 100), cached, provider }, 'intent_embedded');

      // Step 2: Search catalog (HNSW or brute-force)
      const candidates = await this.catalog.searchNearest(vector, 5);

      // Step 3: Tag preference boosting
      const boosted = preferredTags
        ? this.applyTagBoost(candidates, preferredTags)
        : candidates;

      // Step 4: Confidence threshold
      const topCandidate = boosted[0];
      if (!topCandidate || topCandidate.score === 0) {
        this.recordMetrics(startTime, 0, 'no_match');
        return {
          matched: false,
          selectedService: null,
          confidence: 0,
          candidates: boosted,
          disambiguationRequired: false,
        };
      }

      // Step 5: Conflict resolution (two services too close → 300)
      if (boosted.length >= 2) {
        const top = boosted[0]!;
        const second = boosted[1]!;
        if (top.score < this.config.confidenceThreshold) {
          // Below threshold: check if disambiguation helps
          if (second.score - top.score < this.config.conflictMargin && second.score > 0.5) {
            this.recordMetrics(startTime, top.score, 'disambiguation');
            this.logRoutingTable(intent, boosted);
            return {
              matched: false,
              selectedService: null,
              confidence: top.score,
              candidates: boosted.slice(0, 3),
              disambiguationRequired: true,
            };
          }
        }

        // Both above threshold and too close
        if (
          top.score >= this.config.confidenceThreshold &&
          second.score >= this.config.confidenceThreshold &&
          top.score - second.score < this.config.conflictMargin
        ) {
          this.recordMetrics(startTime, top.score, 'disambiguation');
          this.logRoutingTable(intent, boosted);
          return {
            matched: true,
            selectedService: top.service,
            confidence: top.score,
            candidates: boosted.slice(0, 3),
            disambiguationRequired: true,
          };
        }
      }

      // Step 6: Single strong match
      if (boosted[0]!.score >= this.config.confidenceThreshold) {
        this.recordMetrics(startTime, boosted[0]!.score, 'direct_match');
        this.logRoutingTable(intent, boosted);
        return {
          matched: true,
          selectedService: boosted[0]!.service,
          confidence: boosted[0]!.score,
          candidates: boosted,
          disambiguationRequired: false,
        };
      }

      // Below threshold — no confident match
      this.recordMetrics(startTime, boosted[0]!.score, 'no_match');
      this.logRoutingTable(intent, boosted);
      return {
        matched: false,
        selectedService: null,
        confidence: boosted[0]!.score,
        candidates: boosted,
        disambiguationRequired: false,
      };
    } catch (err) {
      logger.error({ err, intent: intent.slice(0, 100) }, 'routing_error');
      this.recordMetrics(startTime, 0, 'no_match');
      return {
        matched: false,
        selectedService: null,
        confidence: 0,
        candidates: [],
        disambiguationRequired: false,
      };
    }
  }

  /**
   * Re-index services that don't have embeddings yet.
   */
  async indexUnembeddedServices(): Promise<number> {
    const unembedded = this.catalog.getServicesWithoutEmbeddings();
    if (unembedded.length === 0) return 0;

    const descriptions = unembedded.map(s => s.semanticDescription);
    const results = await this.embeddingService.embedBatch(descriptions);

    let indexed = 0;
    for (let i = 0; i < unembedded.length; i++) {
      const service = unembedded[i]!;
      const { vector } = results[i]!;
      this.catalog.setServiceEmbedding(service.id, vector);
      indexed++;
    }

    // Rebuild HNSW index
    await this.catalog.buildIndex();
    logger.info({ indexedCount: indexed }, 'unembedded_services_indexed');
    return indexed;
  }

  getMetrics(): SemanticRouterMetrics {
    return { ...this.metrics };
  }

  // ── Private ──

  private applyTagBoost(
    candidates: RoutingCandidate[],
    preferredTags: string[],
  ): RoutingCandidate[] {
    return candidates
      .map(c => {
        const tagOverlap = c.service.tags.filter(t =>
          preferredTags.some(pt => pt.toLowerCase() === t.toLowerCase()),
        ).length;
        // Small boost proportional to tag overlap (max +10%)
        const boost = 1 + (tagOverlap / Math.max(c.service.tags.length, 1)) * 0.1;
        return { ...c, score: Math.min(c.score * boost, 1.0) };
      })
      .sort((a, b) => b.score - a.score);
  }

  private recordMetrics(startTime: number, confidence: number, outcome: string): void {
    const elapsed = performance.now() - startTime;
    this.metrics.totalQueries++;
    this.totalConfidence += confidence;
    this.totalRoutingTime += elapsed;
    this.metrics.avgConfidence = this.totalConfidence / this.metrics.totalQueries;
    this.metrics.avgRoutingTimeMs = this.totalRoutingTime / this.metrics.totalQueries;

    if (outcome === 'direct_match') this.metrics.directMatches++;
    else if (outcome === 'disambiguation') this.metrics.disambiguations++;
    else this.metrics.noMatches++;
  }

  /**
   * Visual trace: print candidate ranking table in debug mode.
   */
  private logRoutingTable(intent: string, candidates: RoutingCandidate[]): void {
    if (logger.level !== 'debug' && process.env['APP_ENV'] !== 'development') return;

    const header = '┌────────────────────────────────────┬──────────┬──────────┐\n' +
                   '│ Service                            │ Score    │ Status   │\n' +
                   '├────────────────────────────────────┼──────────┼──────────┤';

    const threshold = this.config.confidenceThreshold;
    const rows = candidates.slice(0, 5).map(c => {
      const status = c.score >= threshold ? '✓ MATCH' : c.score >= threshold - 0.1 ? '⚠ LOW' : '✗ MISS';
      const name = c.service.name.padEnd(34).slice(0, 34);
      const score = c.score.toFixed(6).padEnd(8);
      return `│ ${name} │ ${score} │ ${status.padEnd(8)} │`;
    });

    const footer = '└────────────────────────────────────┴──────────┴──────────┘';

    logger.debug(
      `\nSemantic Routing Table for: "${intent.slice(0, 60)}"\n${header}\n${rows.join('\n')}\n${footer}`,
    );
  }
}
