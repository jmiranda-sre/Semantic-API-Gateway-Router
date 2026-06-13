// ─── src/registry/types.ts ───
// Canonical type definitions for the Service Registry.

import { z } from 'zod';

// ── Service Registration ──

export const ServiceRegistrationSchema = z.object({
  name: z.string().min(2).max(128),
  baseUrl: z.string().url(),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  semanticDescription: z.string().min(10).max(2048),
  tags: z.array(z.string().min(1).max(64)).min(1).max(20),
  securityTags: z.array(z.enum(['public', 'authenticated', 'admin', 'internal'])).min(1),
  healthCheckPath: z.string().default('/health'),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ServiceRegistration = z.infer<typeof ServiceRegistrationSchema>;

export interface RegisteredService extends ServiceRegistration {
  id: string;
  embedding: number[] | null;
  registeredAt: number;
  updatedAt: number;
}

// ── Semantic Query ──

export const SemanticQuerySchema = z.object({
  intent: z.string().min(1).max(4096),
  context: z.record(z.string(), z.unknown()).optional(),
  preferredTags: z.array(z.string()).optional(),
});

export type SemanticQuery = z.infer<typeof SemanticQuerySchema>;

// ── Routing Result ──

export interface RoutingCandidate {
  service: RegisteredService;
  score: number;
}

export interface RoutingResult {
  matched: boolean;
  selectedService: RegisteredService | null;
  confidence: number;
  candidates: RoutingCandidate[];
  disambiguationRequired: boolean;
}

// ── Error Codes ──

export const ErrorCode = {
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',
  AUTH_RATE_LIMITED: 'AUTH_RATE_LIMITED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  ROUTER_NO_MATCH: 'ROUTER_NO_MATCH',
  ROUTER_DISAMBIGUATION: 'ROUTER_DISAMBIGUATION',
  ROUTER_TIMEOUT: 'ROUTER_TIMEOUT',
  EMBEDDING_PROVIDER_ERROR: 'EMBEDDING_PROVIDER_ERROR',
  EMBEDDING_TIMEOUT: 'EMBEDDING_TIMEOUT',
  CATALOG_SERVICE_NOT_FOUND: 'CATALOG_SERVICE_NOT_FOUND',
  CATALOG_SERVICE_EXISTS: 'CATALOG_SERVICE_EXISTS',
  PROXY_UPSTREAM_ERROR: 'PROXY_UPSTREAM_ERROR',
  PROXY_TIMEOUT: 'PROXY_TIMEOUT',
  SYSTEM_INTERNAL_ERROR: 'SYSTEM_INTERNAL_ERROR',
  SYSTEM_EXTERNAL_ERROR: 'SYSTEM_EXTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ── API Response Envelope ──

export interface ErrorDetail {
  field?: string;
  message: string;
}

export interface APIErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details: ErrorDetail[];
    request_id: string;
    documentation_url?: string;
  };
}

export interface APISuccessResponse<T> {
  data: T;
}

// ── Config ──

export interface GatewayConfig {
  port: number;
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  jwtExpiry: number;
  adminApiKey: string;
  embeddingProvider: 'openai' | 'local';
  openaiApiKey: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingCacheTTL: number;
  embeddingCacheMax: number;
  hnswM: number;
  hnswEfConstruction: number;
  hnswEfSearch: number;
  confidenceThreshold: number;
  conflictMargin: number;
  routerTimeoutMs: number;
  proxyTimeoutMs: number;
  proxyMaxSockets: number;
  logLevel: string;
  metricsEnabled: boolean;
  corsOrigin: string;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  authRateLimitMax: number;
  authRateLimitWindowMs: number;
}

// ── JWT Payload ──

export interface JWTPayload {
  sub: string;
  permissions: string[];
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

// ── Authenticated Request ──

export interface AuthenticatedRequest {
  userId: string;
  permissions: string[];
}
