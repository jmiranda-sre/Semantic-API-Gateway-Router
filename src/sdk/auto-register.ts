// ─── src/sdk/auto-register.ts ───
// SDK Example: How a microservice self-registers with the Semantic Gateway on startup.
//
// Usage: import { registerWithGateway } from './auto-register.js';
//        await registerWithGateway({ name: 'user-service', ... });

import type { ServiceRegistration } from '../registry/types.js';

export interface GatewayRegistrationConfig extends ServiceRegistration {
  gatewayUrl: string;
  adminApiKey: string;
  retryAttempts?: number;
  retryDelayMs?: number;
}

interface RegistrationResult {
  id: string;
  name: string;
  status: string;
  embeddingGenerated: boolean;
}

/**
 * Register a microservice with the Semantic API Gateway.
 * Includes retry logic and graceful error handling.
 */
export async function registerWithGateway(
  config: GatewayRegistrationConfig,
): Promise<RegistrationResult> {
  const {
    gatewayUrl,
    adminApiKey,
    retryAttempts = 3,
    retryDelayMs = 2000,
    ...registration
  } = config;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    try {
      const url = `${gatewayUrl}/api/v1/admin/register`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-API-Key': adminApiKey,
        },
        body: JSON.stringify(registration),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Registration failed (${response.status}): ${body}`);
      }

      const result = await response.json() as { data: RegistrationResult };
      console.log(`[auto-register] Service '${registration.name}' registered (id: ${result.data.id})`);
      return result.data;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[auto-register] Attempt ${attempt}/${retryAttempts} failed: ${lastError.message}`,
      );

      if (attempt < retryAttempts) {
        await sleep(retryDelayMs * attempt); // Exponential backoff
      }
    }
  }

  throw new Error(
    `Failed to register '${registration.name}' after ${retryAttempts} attempts. Last error: ${lastError?.message}`,
  );
}

/**
 * Deregister a microservice from the gateway (e.g., on shutdown).
 */
export async function deregisterFromGateway(
  gatewayUrl: string,
  adminApiKey: string,
  serviceId: string,
): Promise<void> {
  const url = `${gatewayUrl}/api/v1/admin/services/${serviceId}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: { 'X-Admin-API-Key': adminApiKey },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Deregistration failed (${response.status})`);
  }

  console.log(`[auto-register] Service deregistered (id: ${serviceId})`);
}

/**
 * Example: Express service that auto-registers on startup.
 */
export function exampleExpressSetup(): string {
  return `
// ── In your microservice's index.ts ──
import express from 'express';
import { registerWithGateway, deregisterFromGateway } from 'semantic-gateway-sdk';

const app = express();
const PORT = process.env.SERVICE_PORT ?? 4001;

let serviceId: string | null = null;

async function bootstrap() {
  // 1. Start your service
  app.listen(PORT, async () => {
    console.log(\`User service listening on port \${PORT}\`);

    // 2. Self-register with Semantic Gateway
    try {
      const result = await registerWithGateway({
        gatewayUrl: process.env.GATEWAY_URL ?? 'http://localhost:3000',
        adminApiKey: process.env.ADMIN_API_KEY!,
        name: 'user-service',
        baseUrl: \`http://localhost:\${PORT}\`,
        version: '1.0.0',
        semanticDescription: 'Manages user accounts, profiles, authentication, and authorization. Handles user CRUD, password resets, email verification, and role-based access control.',
        tags: ['users', 'auth', 'accounts', 'profiles', 'password'],
        securityTags: ['authenticated'],
        healthCheckPath: '/health',
      });
      serviceId = result.id;
    } catch (err) {
      console.error('Gateway registration failed:', err);
    }
  });
}

// 3. Deregister on shutdown
process.on('SIGTERM', async () => {
  if (serviceId) {
    await deregisterFromGateway(
      process.env.GATEWAY_URL!,
      process.env.ADMIN_API_KEY!,
      serviceId,
    );
  }
  process.exit(0);
});

bootstrap();
`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
