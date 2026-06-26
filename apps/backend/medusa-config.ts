import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

const isProd = process.env.NODE_ENV === 'production'

// Fail fast in productie zodat de server nooit met bekende default-secrets start.
// Buiten productie is een dev-fallback toegestaan voor lokaal gemak.
const jwtSecret = process.env.JWT_SECRET || (isProd ? '' : 'dev-jwt-secret')
const cookieSecret = process.env.COOKIE_SECRET || (isProd ? '' : 'dev-cookie-secret')
if (isProd && (!jwtSecret || !cookieSecret)) {
  throw new Error('JWT_SECRET en COOKIE_SECRET moeten gezet zijn in productie.')
}

// ── Redis ─────────────────────────────────────────────────────────────────────
// Eén REDIS_URL voedt cache, event bus, workflow engine én sessies.
// Is REDIS_URL niet gezet, dan vallen alle modules terug op in-memory (veilig:
// de deploy breekt niet voordat de Redis-service bestaat).
const redisUrl = process.env.REDIS_URL

// Managed providers (Upstash e.d.) draaien over TLS via `rediss://`.
// ioredis detecteert dat zelf, maar BullMQ wil `tls: {}` expliciet zien.
const isTls = !!redisUrl && redisUrl.startsWith('rediss://')
const tlsOption = isTls ? { tls: {} } : {}

// BullMQ (event bus + workflow engine) vereist `maxRetriesPerRequest: null` op
// blocking-connecties, anders hangt/faalt de worker bij reconnects.
const bullRedisOptions = { maxRetriesPerRequest: null, ...tlsOption }

const redisModules = redisUrl
  ? [
      {
        // Cache: ontlast Postgres bij herhaalde reads (prijzen, regio's, varianten).
        resolve: '@medusajs/medusa/cache-redis',
        options: {
          redisUrl,
          ttl: 30,
          ...(isTls ? { redisOptions: tlsOption } : {}),
        },
      },
      {
        // Event bus: betrouwbare async events (orders, fulfilment, e-mail-hooks).
        resolve: '@medusajs/medusa/event-bus-redis',
        options: {
          redisUrl,
          ...(isTls ? { redisOptions: tlsOption } : {}),
          // Voorkomt onbeperkte sleutelgroei in Redis (afgeronde jobs opruimen).
          jobOptions: {
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: { age: 86400, count: 1000 },
          },
        },
      },
      {
        // Workflow engine: workflow-state overleeft herstart/deploy.
        resolve: '@medusajs/medusa/workflow-engine-redis',
        options: {
          redis: {
            redisUrl,
            redisOptions: bullRedisOptions,
          },
        },
      },
    ]
  : []

// ── Crypto payment (BTCPay Server) ────────────────────────────────────────────
// Alleen registreren zodra de keys gezet zijn: vóór die tijd boot de backend
// gewoon met enkel de system/manual provider (validateOptions zou anders gooien).
// Provider-key wordt `pp_crypto_btcpay`; configureer de BTCPay-webhook (in de
// BTCPay-UI) naar <backend>/hooks/payment/pp_crypto_btcpay met BTCPAY_WEBHOOK_SECRET.
const cryptoEnabled =
  !!process.env.BTCPAY_URL &&
  !!process.env.BTCPAY_API_KEY &&
  !!process.env.BTCPAY_STORE_ID &&
  !!process.env.BTCPAY_WEBHOOK_SECRET

const cryptoProviderId = 'btcpay'
const storefrontUrl = process.env.STOREFRONT_URL || 'https://gradepurity.com'

// ── Transactionele e-mail (Resend) ────────────────────────────────────────────
// Order­bevestiging / betaling ontvangen / verzonden lopen via de Resend-provider.
// Alleen registreren zodra de keys gezet zijn, anders gooit validateOptions bij
// boot. Zonder keys valt het notification-module terug op de default (log-only),
// zodat de backend blijft draaien.
const resendEnabled = !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM

const notificationModules = resendEnabled
  ? [
      {
        resolve: '@medusajs/medusa/notification',
        options: {
          providers: [
            {
              resolve: './src/modules/resend',
              id: 'resend',
              options: {
                channels: ['email'],
                api_key: process.env.RESEND_API_KEY,
                from: process.env.RESEND_FROM,
                reply_to: process.env.RESEND_REPLY_TO,
              },
            },
          ],
        },
      },
    ]
  : []

const paymentModules = cryptoEnabled
  ? [
      {
        resolve: '@medusajs/medusa/payment',
        options: {
          providers: [
            {
              resolve: './src/modules/btcpay',
              id: cryptoProviderId,
              options: {
                serverUrl: process.env.BTCPAY_URL,
                apiKey: process.env.BTCPAY_API_KEY,
                storeId: process.env.BTCPAY_STORE_ID,
                webhookSecret: process.env.BTCPAY_WEBHOOK_SECRET,
                storefrontUrl,
                successPath:
                  process.env.CRYPTO_SUCCESS_PATH || '/nl/bestelling-ontvangen',
              },
            },
          ],
        },
      },
    ]
  : []

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    // Sessies in Redis -> admin blijft ingelogd na elke deploy/herstart.
    ...(redisUrl
      ? { redisUrl, ...(isTls ? { redisOptions: tlsOption } : {}) }
      : {}),
    // Eén Railway-instance draait API + jobs in hetzelfde proces ("shared").
    // Later te splitsen naar server/worker via env, zonder code-wijziging.
    workerMode:
      (process.env.MEDUSA_WORKER_MODE as 'shared' | 'server' | 'worker') ||
      'shared',
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret,
      cookieSecret,
    },
  },
  modules: [...redisModules, ...paymentModules, ...notificationModules],
})
