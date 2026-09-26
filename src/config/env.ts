import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  CREDENTIALS_PATH: z.string().default('./data/credentials.json'),

  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  ANTHROPIC_OAUTH_TOKEN_URL: z
    .string()
    .url()
    .default('https://console.anthropic.com/v1/oauth/token'),
  CLAUDE_CLIENT_ID: z.string().default('00000000-0000-0000-0000-000000000000'),
  GATEWAY_VERSION: z.string().default('0.1.0'),

  DATABASE_PATH: z.string().default('./data/gateway.db'),

  DEFAULT_MAX_TOKENS: z.coerce.number().int().positive().default(4096),

  ALLOWED_ORIGINS: z.string().default(''),
  ADMIN_TOKEN: z.string().default(''),

  // Answer from an in-process canned upstream instead of calling a
  // provider. Lets the gateway be run with no account and no
  // credentials -- see src/upstream/mockDispatcher.ts.
  MOCK_UPSTREAM: z
    .string()
    .default('')
    .transform((v) => v !== '' && v !== '0' && v.toLowerCase() !== 'false'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function getAllowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
