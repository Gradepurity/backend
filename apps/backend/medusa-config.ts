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

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret,
      cookieSecret,
    }
  }
})
