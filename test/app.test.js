import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { createApp } from '../script.js'

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'shortly-test-'))
const paymentSecret = 'test_razorpay_secret'
const { app, db } = createApp({
  dbFile: path.join(temporaryDirectory, 'test.db'),
  razorpayKeyId: 'rzp_test_public_key',
  razorpayKeySecret: paymentSecret,
  createPaymentOrder: async (plan) => ({
    id: 'order_test_123',
    amount: plan.amount,
    currency: plan.currency,
  }),
})
let server
let baseUrl

before(async () => {
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve())
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  db.close()
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
})

test('serves the web app', async () => {
  const response = await fetch(baseUrl)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /Big links deserve/)
})

test('returns health check', async () => {
  const response = await fetch(`${baseUrl}/api/health`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.status, 'healthy')
  assert.equal(body.database, 'connected')
  assert.ok(body.timestamp)
  assert.ok(typeof body.uptime === 'number')
})

test('returns robots.txt', async () => {
  const response = await fetch(`${baseUrl}/robots.txt`)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /User-agent/)
})

test('creates, lists, redirects, counts, and deletes a short link', async () => {
  const createdResponse = await fetch(`${baseUrl}/api/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'example.com/a?b=1', customAlias: 'example-link' }),
  })
  assert.equal(createdResponse.status, 201)
  const created = await createdResponse.json()
  assert.equal(created.url, 'https://example.com/a?b=1')
  assert.equal(created.code, 'example-link')

  const redirectResponse = await fetch(created.shortUrl, { redirect: 'manual' })
  assert.equal(redirectResponse.status, 302)
  assert.equal(redirectResponse.headers.get('location'), created.url)

  const linksResponse = await fetch(`${baseUrl}/api/links`)
  const linksBody = await linksResponse.json()
  assert.ok(Array.isArray(linksBody.links))
  assert.ok(linksBody.pagination)
  assert.equal(linksBody.links.length, 1)
  assert.equal(linksBody.links[0].clicks, 1)
  assert.equal(linksBody.pagination.total, 1)

  const deleteResponse = await fetch(`${baseUrl}/api/links/example-link`, { method: 'DELETE' })
  assert.equal(deleteResponse.status, 204)

  const afterDelete = await (await fetch(`${baseUrl}/api/links`)).json()
  assert.equal(afterDelete.links.length, 0)
})

test('rejects invalid URLs and duplicate aliases', async () => {
  const invalidResponse = await fetch(`${baseUrl}/api/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'ftp://example.com/file' }),
  })
  assert.equal(invalidResponse.status, 400)

  const firstResponse = await fetch(`${baseUrl}/api/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com', customAlias: 'same-name' }),
  })
  assert.equal(firstResponse.status, 201)

  const duplicateResponse = await fetch(`${baseUrl}/api/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://openai.com', customAlias: 'same-name' }),
  })
  assert.equal(duplicateResponse.status, 409)

  await fetch(`${baseUrl}/api/links/same-name`, { method: 'DELETE' })
})

test('supports search query parameter', async () => {
  await fetch(`${baseUrl}/api/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/search-test', customAlias: 'search-test' }),
  })

  const searchResponse = await fetch(`${baseUrl}/api/links?search=search-test`)
  const searchBody = await searchResponse.json()
  assert.ok(searchBody.links.length >= 1)
  assert.ok(searchBody.links.some((l) => l.code === 'search-test'))

  const noMatchResponse = await fetch(`${baseUrl}/api/links?search=zzz-no-match-zzz`)
  const noMatchBody = await noMatchResponse.json()
  assert.equal(noMatchBody.links.length, 0)

  await fetch(`${baseUrl}/api/links/search-test`, { method: 'DELETE' })
})

test('supports pagination parameters', async () => {
  const response = await fetch(`${baseUrl}/api/links?page=1&limit=1`)
  const body = await response.json()
  assert.ok(body.pagination)
  assert.equal(body.pagination.page, 1)
  assert.equal(body.pagination.limit, 1)
  assert.ok(typeof body.pagination.total === 'number')
  assert.ok(typeof body.pagination.totalPages === 'number')
})

test('creates and cryptographically verifies a Razorpay order', async () => {
  const configResponse = await fetch(`${baseUrl}/api/payments/config`)
  const config = await configResponse.json()
  assert.equal(config.enabled, true)
  assert.equal(config.keyId, 'rzp_test_public_key')
  assert.equal(config.plans[0].amount, 49900)

  const orderResponse = await fetch(`${baseUrl}/api/payments/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId: 'pro' }),
  })
  assert.equal(orderResponse.status, 201)
  const order = await orderResponse.json()
  assert.equal(order.orderId, 'order_test_123')
  assert.equal(order.currency, 'INR')

  const paymentId = 'pay_test_456'
  const signature = crypto
    .createHmac('sha256', paymentSecret)
    .update(`${order.orderId}|${paymentId}`)
    .digest('hex')
  const verifyResponse = await fetch(`${baseUrl}/api/payments/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      razorpay_order_id: order.orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    }),
  })
  assert.equal(verifyResponse.status, 200)
  assert.equal((await verifyResponse.json()).verified, true)
})

test('rejects invalid plans and forged payment signatures', async () => {
  const invalidPlanResponse = await fetch(`${baseUrl}/api/payments/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId: 'not-a-plan' }),
  })
  assert.equal(invalidPlanResponse.status, 400)

  const forgedResponse = await fetch(`${baseUrl}/api/payments/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      razorpay_order_id: 'order_test_123',
      razorpay_payment_id: 'pay_forged',
      razorpay_signature: '0'.repeat(64),
    }),
  })
  assert.equal(forgedResponse.status, 400)
})

test('returns security headers', async () => {
  const response = await fetch(`${baseUrl}/`)
  assert.ok(response.headers.get('x-content-type-options'))
  assert.ok(response.headers.get('x-frame-options'))
})

test('returns 404 for unknown API routes', async () => {
  const response = await fetch(`${baseUrl}/api/nonexistent`)
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.ok(body.error)
})

test('rejects non-JSON request bodies', async () => {
  const response = await fetch(`${baseUrl}/api/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json',
  })
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.ok(body.error.includes('JSON'))
})
