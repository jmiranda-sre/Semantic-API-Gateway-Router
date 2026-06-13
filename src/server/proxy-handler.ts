// ─── src/server/proxy-handler.ts ───
// Transparent proxy with context propagation and error handling.

import http from 'node:http';
import httpProxy from 'http-proxy';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { RegisteredService, AuthenticatedRequest } from '../registry/types.js';
import { logger, createContextLogger } from '../monitoring/logger.js';
import { proxyDuration, proxyErrors, activeConnections } from '../monitoring/metrics.js';

export interface ProxyConfig {
  timeout: number;
  maxSockets: number;
}

interface ProxyDependencies {
  config: ProxyConfig;
}

export class ProxyHandler {
  private proxy: httpProxy;
  private config: ProxyConfig;

  constructor(deps: ProxyDependencies) {
    this.config = deps.config;

    this.proxy = httpProxy.createProxyServer({
      timeout: this.config.timeout,
      agent: new http.Agent({
        maxSockets: this.config.maxSockets,
        keepAlive: true,
        keepAliveMsecs: 30_000,
      }),
      proxyTimeout: this.config.timeout,
      changeOrigin: true,
      followRedirects: false,
      selfHandleResponse: false,
    });

    // Error handling
    this.proxy.on('error', (err, _req, res) => {
      logger.error({ err: err.message }, 'proxy_error');
      if (res && 'headersSent' in res && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            code: 'PROXY_UPSTREAM_ERROR',
            message: 'Upstream service unavailable',
            request_id: (res as ProxyResExt).requestId ?? 'unknown',
          },
        }));
      }
    });

    this.proxy.on('proxyReq', (proxyReq, req, _res, _options) => {
      // Propagate security context headers
      const ctx = (req as ReqExt).routingContext;
      if (ctx?.auth) {
        proxyReq.setHeader('X-User-Id', ctx.auth.userId);
        proxyReq.setHeader('X-User-Permissions', ctx.auth.permissions.join(','));
        proxyReq.setHeader('X-Request-Id', ctx.correlationId);
        proxyReq.setHeader('X-Gateway-Source', 'semantic-gateway');
        proxyReq.setHeader('X-Matched-Service', ctx.matchedService?.name ?? 'unknown');
        proxyReq.setHeader('X-Semantic-Confidence', ctx.confidence?.toFixed(6) ?? '0');
      }
    });
  }

  /**
   * Proxy the request to the matched service.
   */
  async proxyRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    service: RegisteredService,
    auth: AuthenticatedRequest,
    correlationId: string,
    confidence: number,
  ): Promise<void> {
    const start = performance.now();
    activeConnections.inc();

    const ctxLog = createContextLogger(correlationId, auth.userId);

    // Attach context for proxyReq event
    (request.raw as ReqExt).routingContext = {
      auth,
      correlationId,
      matchedService: service,
      confidence,
    };

    try {
      await new Promise<void>((resolve, reject) => {
        this.proxy.web(request.raw, reply.raw, {
          target: service.baseUrl,
          timeout: this.config.timeout,
        }, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      const elapsed = (performance.now() - start) / 1000;
      const statusCode = reply.statusCode;

      proxyDuration.observe(
        { service: service.name, status_code: String(statusCode) },
        elapsed,
      );

      ctxLog.info({
        service: service.name,
        target: service.baseUrl,
        statusCode,
        durationMs: Math.round(elapsed * 1000),
        confidence,
      }, 'request_proxied');
    } catch (err) {
      const elapsed = (performance.now() - start) / 1000;
      const errorMessage = err instanceof Error ? err.message : 'Unknown proxy error';

      proxyErrors.inc({ service: service.name, error_type: 'upstream_error' });
      proxyDuration.observe(
        { service: service.name, status_code: '502' },
        elapsed,
      );

      ctxLog.error({
        service: service.name,
        err: errorMessage,
        durationMs: Math.round(elapsed * 1000),
      }, 'proxy_failed');

      if (!reply.raw.headersSent) {
        reply.code(502).send({
          error: {
            code: 'PROXY_UPSTREAM_ERROR',
            message: `Upstream service '${service.name}' unavailable`,
            request_id: correlationId,
          },
        });
      }
    } finally {
      activeConnections.dec();
    }
  }

  close(): void {
    this.proxy.close();
  }
}

// ── Type Augmentation ──

interface ReqExt {
  routingContext?: {
    auth: AuthenticatedRequest;
    correlationId: string;
    matchedService: RegisteredService | null;
    confidence: number;
  };
}

interface ProxyResExt {
  requestId?: string;
}
