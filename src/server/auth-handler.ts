// ─── src/server/auth-handler.ts ───
// JWT verification middleware — hardened security, fail-closed.

import { FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import type { JWTPayload, AuthenticatedRequest } from '../registry/types.js';
import { logger } from '../monitoring/logger.js';

export interface AuthConfig {
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  adminApiKey: string;
}

/**
 * Verify JWT token from Authorization header.
 * Sets request.user with decoded payload.
 * Fail-closed: any verification error → 401.
 */
export function verifyJWT(config: AuthConfig) {
  return async (request: FastifyRequest): Promise<AuthenticatedRequest> => {
    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthError('AUTH_TOKEN_INVALID', 'Missing or malformed Authorization header');
    }

    const token = authHeader.slice(7);

    try {
      const decoded = jwt.verify(token, config.jwtSecret, {
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
        algorithms: ['HS256'],
      }) as JWTPayload;

      return {
        userId: decoded.sub,
        permissions: decoded.permissions ?? [],
      };
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new AuthError('AUTH_TOKEN_EXPIRED', 'Access token expired');
      }
      if (err instanceof jwt.JsonWebTokenError) {
        throw new AuthError('AUTH_TOKEN_INVALID', 'Invalid token');
      }
      throw new AuthError('AUTH_TOKEN_INVALID', 'Token verification failed');
    }
  };
}

/**
 * Verify admin API key from X-Admin-API-Key header.
 * Used for administrative endpoints (service registration, etc.)
 */
export function verifyAdminApiKey(config: AuthConfig) {
  return (request: FastifyRequest): void => {
    const apiKey = request.headers['x-admin-api-key'];
    if (!apiKey) {
      throw new AuthError('AUTH_TOKEN_INVALID', 'Missing X-Admin-API-Key header');
    }

    // Constant-time comparison to prevent timing attacks
    if (!constantTimeEquals(apiKey as string, config.adminApiKey)) {
      logger.warn({ ip: request.ip }, 'admin_api_key_invalid_attempt');
      throw new AuthError('AUTH_FORBIDDEN', 'Invalid admin API key');
    }
  };
}

/**
 * Check if user has required permission.
 */
export function requirePermission(permission: string) {
  return (user: AuthenticatedRequest): void => {
    if (!user.permissions.includes(permission) && !user.permissions.includes('admin')) {
      throw new AuthError('AUTH_FORBIDDEN', `Missing permission: ${permission}`);
    }
  };
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ── Auth Error ──

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
