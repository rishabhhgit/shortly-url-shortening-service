import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import Database from 'better-sqlite3'
import helmet from 'helmet'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import pino from 'pino'
import pinoHttp from 'pino-http'
import { cleanEnv, str, num } from 'envalid'
import xss from 'xss'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const env = cleanEnv(process.env, {
  NODE_ENV: str({ choices: ['development', 'production', 'test'], default: 'development' }),
  PORT: num({ default: 3000 }),
  RAZORPAY_KEY_ID: str({ default: '' }),
  RAZORPAY_KEY_SECRET: str({ default: '' }),
  CORS_ORIGIN: str({ default: '*' }),
  RATE_LIMIT_WINDOW_MS: num({ default: 15 * 60 * 1000 }),
  RATE_LIMIT_MAX_REQUESTS: num({ default: 100 }),
  DB_FILE: str({ default: 'data/shortly.db' }),
})

const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: env.NODE_ENV !== 'production' ? { target: 'pino/file', options: { destination: 1 } } : undefined,
})

const ALPHABET = '23456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'
const ALIAS_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/
const RESERVED_CODES = new Set(['api', 'favicon.ico', 'health', 'robots.txt'])
const PAYMENT_PLANS = Object.freeze({
  pro: {
    id: 'pro',
    name: 'Golden Pro',
    description: 'Lifetime access to premium link tools',
    amount: 49900,
    currency: 'INR',
  },
})

function createCode(length = 7) {
  return Array.from({ length }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Enter a URL to shorten.')
  }

  const input = value.trim()
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`

  let parsed
  try {
    parsed = new URL(withProtocol)
  } catch {
    throw new Error('Enter a valid URL, such as example.com/article.')
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('Only HTTP and HTTPS URLs can be shortened.')
  }

  if (parsed.username || parsed.password) {
    throw new Error('URLs containing credentials are not supported.')
  }

  if (parsed.hostname.length > 253) {
    throw new Error('URL hostname is too long.')
  }

  return parsed.href
}

function sanitizeInput(value) {
  if (typeof value !== 'string') return value
  return xss(value, {
    whiteList: {},
    stripIgnoreTag: true,
    stripIgnoreTagBody: ['script', 'style'],
  })
}

function initDatabase(dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  const db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      code TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      clicks INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_clicked_at TEXT,
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      receipt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      payment_id TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_links_expires_at ON links(expires_at);
  `)

  return db
}

function rowToLink(row) {
  return {
    code: row.code,
    url: row.url,
    clicks: row.clicks,
    createdAt: row.created_at,
    lastClickedAt: row.last_clicked_at,
    expiresAt: row.expires_at,
  }
}

function createStore(db) {
  const insertStmt = db.prepare(
    'INSERT INTO links (code, url, clicks, created_at, last_clicked_at, expires_at) VALUES (@code, @url, @clicks, @createdAt, @lastClickedAt, @expiresAt)'
  )
  const findByCodeStmt = db.prepare('SELECT * FROM links WHERE code = ?')
  const findByUrlStmt = db.prepare('SELECT * FROM links WHERE url = ? ORDER BY created_at DESC LIMIT 1')
  const selectAllStmt = db.prepare('SELECT * FROM links ORDER BY created_at DESC LIMIT ?')
  const updateClicksStmt = db.prepare('UPDATE links SET clicks = clicks + 1, last_clicked_at = ? WHERE code = ?')
  const deleteStmt = db.prepare('DELETE FROM links WHERE code = ?')
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM links')
  const searchStmt = db.prepare('SELECT * FROM links WHERE url LIKE ? OR code LIKE ? ORDER BY created_at DESC LIMIT ?')

  return {
    all(limit = 50) {
      return selectAllStmt.all(limit).map(rowToLink)
    },
    find(code) {
      const row = findByCodeStmt.get(code)
      return row ? rowToLink(row) : undefined
    },
    findByUrl(url) {
      const row = findByUrlStmt.get(url)
      return row ? rowToLink(row) : undefined
    },
    search(query, limit = 50) {
      const pattern = `%${query}%`
      return searchStmt.all(pattern, pattern, limit).map(rowToLink)
    },
    count() {
      return countStmt.get().count
    },
    add(link) {
      insertStmt.run({
        code: link.code,
        url: link.url,
        clicks: link.clicks ?? 0,
        createdAt: link.createdAt,
        lastClickedAt: link.lastClickedAt ?? null,
        expiresAt: link.expiresAt ?? null,
      })
      return link
    },
    recordClick(code) {
      const link = findByCodeStmt.get(code)
      if (!link) return null

      if (link.expires_at && new Date(link.expires_at) < new Date()) {
        deleteStmt.run(code)
        return null
      }

      const info = updateClicksStmt.run(new Date().toISOString(), code)
      if (info.changes === 0) return null
      const row = findByCodeStmt.get(code)
      return row ? rowToLink(row) : null
    },
    remove(code) {
      const info = deleteStmt.run(code)
      return info.changes > 0
    },
  }
}

function createPaymentStore(db) {
  const insertStmt = db.prepare(
    `INSERT INTO payments (id, plan_id, amount, currency, receipt, status, created_at)
     VALUES (@id, @planId, @amount, @currency, @receipt, @status, @createdAt)`
  )
  const findByIdStmt = db.prepare('SELECT * FROM payments WHERE id = ?')
  const markPaidStmt = db.prepare(
    'UPDATE payments SET status = ?, payment_id = ?, paid_at = ? WHERE id = ?'
  )

  return {
    add(order) {
      insertStmt.run({
        id: order.id,
        planId: order.planId,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt,
        status: order.status,
        createdAt: order.createdAt,
      })
      return order
    },
    find(id) {
      const row = findByIdStmt.get(id)
      if (!row) return undefined
      return {
        id: row.id,
        planId: row.plan_id,
        amount: row.amount,
        currency: row.currency,
        receipt: row.receipt,
        status: row.status,
        paymentId: row.payment_id,
        paidAt: row.paid_at,
        createdAt: row.created_at,
      }
    },
    markPaid(id, paymentId) {
      const paidAt = new Date().toISOString()
      const info = markPaidStmt.run('paid', paymentId, paidAt, id)
      if (info.changes === 0) return null
      return {
        id,
        status: 'paid',
        paymentId,
        paidAt,
      }
    },
  }
}

async function createRazorpayOrder(plan, receipt, keyId, keySecret) {
  const authorization = Buffer.from(`${keyId}:${keySecret}`).toString('base64')
  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authorization}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: plan.amount,
      currency: plan.currency,
      receipt,
      notes: { planId: plan.id },
    }),
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(data.error?.description || 'Razorpay could not create an order.')
  }

  return data
}

function validPaymentSignature(orderId, paymentId, signature, secret) {
  if (typeof signature !== 'string' || !/^[a-f\d]{64}$/i.test(signature)) return false
  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))
}

function publicLink(link, baseUrl) {
  return {
    ...link,
    shortUrl: `${baseUrl}/${link.code}`,
  }
}

export function createApp(options = {}) {
  const app = express()
  const dbFile = options.dbFile ?? path.join(__dirname, env.DB_FILE)
  const razorpayKeyId = options.razorpayKeyId ?? env.RAZORPAY_KEY_ID
  const razorpayKeySecret = options.razorpayKeySecret ?? env.RAZORPAY_KEY_SECRET
  const db = initDatabase(dbFile)
  const store = createStore(db)
  const paymentStore = createPaymentStore(db)
  const orderCreator = options.createPaymentOrder
    ?? ((plan, receipt) => createRazorpayOrder(plan, receipt, razorpayKeyId, razorpayKeySecret))

  app.disable('x-powered-by')
  app.set('trust proxy', 1)

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://checkout.razorpay.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https://api.razorpay.com'],
        frameSrc: ["'self'", 'https://api.razorpay.com'],
      },
    },
    crossOriginEmbedderPolicy: false,
  }))

  app.use(cors({
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN,
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type'],
    maxAge: 86400,
  }))

  const generalLimiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
  })

  const createLinkLimiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many links created. Please try again later.' },
  })

  const paymentLimiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many payment attempts. Please try again later.' },
  })

  app.use(generalLimiter)

  const loggerMiddleware = pinoHttp({
    logger,
    genReqId: (req) => crypto.randomUUID(),
    customLogLevel: (req, res, err) => {
      if (res.statusCode >= 400 || err) return 'error'
      return 'info'
    },
    customSuccessMessage: (req, res) => {
      return `${req.method} ${req.url} ${res.statusCode}`
    },
    customErrorMessage: (req, res, err) => {
      return `${req.method} ${req.url} ${res.statusCode} - ${err.message}`
    },
  })

  if (env.NODE_ENV !== 'test') {
    app.use(loggerMiddleware)
  }

  app.use(express.json({ limit: '16kb' }))
  app.use(express.static(path.join(__dirname, 'public')))

  app.get('/api/health', (req, res) => {
    try {
      db.prepare('SELECT 1').get()
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: 'connected',
      })
    } catch (error) {
      logger.error({ err: error }, 'Health check failed')
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        database: 'disconnected',
      })
    }
  })

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /api/\nAllow: /\n')
  })

  app.get('/api/links', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`
    const { search, page = '1', limit = '50' } = req.query
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50))

    let links
    if (search && typeof search === 'string' && search.trim().length > 0) {
      const sanitizedSearch = sanitizeInput(search.trim())
      links = store.search(sanitizedSearch, limitNum)
    } else {
      links = store.all(limitNum)
    }

    const total = store.count()
    res.json({
      links: links.map((link) => publicLink(link, baseUrl)),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    })
  })

  app.post('/api/links', createLinkLimiter, (req, res) => {
    try {
      const url = normalizeUrl(req.body?.url)
      const requestedAlias = req.body?.customAlias?.trim()
      let code

      if (requestedAlias) {
        const sanitizedAlias = sanitizeInput(requestedAlias)
        if (!ALIAS_PATTERN.test(sanitizedAlias)) {
          return res.status(400).json({
            error: 'Custom aliases must be 3-32 characters using letters, numbers, hyphens, or underscores.',
          })
        }
        if (RESERVED_CODES.has(sanitizedAlias.toLowerCase()) || store.find(sanitizedAlias)) {
          return res.status(409).json({ error: 'That custom alias is already in use.' })
        }
        code = sanitizedAlias
      } else {
        do {
          code = createCode()
        } while (store.find(code))
      }

      let expiresAt = null
      if (req.body?.expiresIn) {
        const expiresInDays = parseInt(req.body.expiresIn, 10)
        if (expiresInDays > 0 && expiresInDays <= 365) {
          const expiryDate = new Date()
          expiryDate.setDate(expiryDate.getDate() + expiresInDays)
          expiresAt = expiryDate.toISOString()
        }
      }

      const link = store.add({
        code,
        url,
        clicks: 0,
        createdAt: new Date().toISOString(),
        lastClickedAt: null,
        expiresAt,
      })

      logger.info({ code, url: url.substring(0, 50) }, 'Link created')
      const baseUrl = `${req.protocol}://${req.get('host')}`
      return res.status(201).json(publicLink(link, baseUrl))
    } catch (error) {
      logger.error({ err: error }, 'Failed to create link')
      return res.status(400).json({ error: error.message })
    }
  })

  app.delete('/api/links/:code', (req, res) => {
    const code = sanitizeInput(req.params.code)
    if (!store.remove(code)) {
      return res.status(404).json({ error: 'Short link not found.' })
    }
    logger.info({ code }, 'Link deleted')
    return res.status(204).end()
  })

  app.get('/api/payments/config', (req, res) => {
    res.json({
      enabled: Boolean(razorpayKeyId && razorpayKeySecret),
      keyId: razorpayKeyId || null,
      plans: Object.values(PAYMENT_PLANS).map(({ id, name, description, amount, currency }) => ({
        id,
        name,
        description,
        amount,
        currency,
      })),
    })
  })

  app.post('/api/payments/order', paymentLimiter, async (req, res) => {
    const planId = req.body?.planId
    if (typeof planId !== 'string' || !PAYMENT_PLANS[planId]) {
      return res.status(400).json({ error: 'Choose a valid payment plan.' })
    }
    const plan = PAYMENT_PLANS[planId]

    if (!razorpayKeyId || !razorpayKeySecret) {
      return res.status(503).json({ error: 'Payments are not configured yet.' })
    }

    try {
      const receipt = `shortly_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
      const razorpayOrder = await orderCreator(plan, receipt)
      if (!razorpayOrder?.id) throw new Error('Razorpay returned an invalid order.')

      paymentStore.add({
        id: razorpayOrder.id,
        planId: plan.id,
        amount: plan.amount,
        currency: plan.currency,
        receipt,
        status: 'created',
        createdAt: new Date().toISOString(),
      })

      logger.info({ orderId: razorpayOrder.id, planId: plan.id }, 'Payment order created')
      return res.status(201).json({
        keyId: razorpayKeyId,
        orderId: razorpayOrder.id,
        amount: plan.amount,
        currency: plan.currency,
        name: plan.name,
        description: plan.description,
      })
    } catch (error) {
      logger.error({ err: error }, 'Failed to create payment order')
      return res.status(502).json({ error: error.message || 'Could not start checkout.' })
    }
  })

  app.post('/api/payments/verify', paymentLimiter, (req, res) => {
    const orderId = req.body?.razorpay_order_id
    const paymentId = req.body?.razorpay_payment_id
    const signature = req.body?.razorpay_signature
    const order = typeof orderId === 'string' ? paymentStore.find(orderId) : null

    if (!order || typeof paymentId !== 'string' || !razorpayKeySecret) {
      return res.status(400).json({ error: 'Payment details are invalid.' })
    }
    if (!validPaymentSignature(orderId, paymentId, signature, razorpayKeySecret)) {
      logger.warn({ orderId, paymentId }, 'Invalid payment signature')
      return res.status(400).json({ error: 'Payment verification failed.' })
    }

    paymentStore.markPaid(orderId, paymentId)
    logger.info({ orderId, paymentId }, 'Payment verified')
    return res.json({
      verified: true,
      planId: order.planId,
      message: 'Payment verified successfully.',
    })
  })

  app.get('/:code', (req, res, next) => {
    const code = sanitizeInput(req.params.code)
    if (RESERVED_CODES.has(code)) return next()

    const link = store.find(code)
    if (!link) return next()

    if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
      store.remove(code)
      return next()
    }

    store.recordClick(link.code)
    return res.redirect(302, link.url)
  })

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found.' })
  })

  app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'))
  })

  app.use((error, req, res, next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      return res.status(400).json({ error: 'The request body is not valid JSON.' })
    }
    logger.error({ err: error }, 'Unhandled error')
    return res.status(500).json({ error: 'Something went wrong.' })
  })

  return { app, db, store, paymentStore }
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMainModule) {
  const { app, db } = createApp()

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, `Shortly is running at http://localhost:${env.PORT}`)
  })

  const gracefulShutdown = (signal) => {
    logger.info({ signal }, 'Received shutdown signal, closing server...')
    server.close(() => {
      logger.info('Server closed')
      db.close()
      logger.info('Database connection closed')
      process.exit(0)
    })

    setTimeout(() => {
      logger.error('Shutdown timed out, forcing exit')
      process.exit(1)
    }, 10000)
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))

  process.on('unhandledRejection', (reason, promise) => {
    logger.error({ err: reason }, 'Unhandled rejection')
  })

  process.on('uncaughtException', (error) => {
    logger.error({ err: error }, 'Uncaught exception')
    process.exit(1)
  })
}
