/**
 * Authenticated owner control-plane API.
 *
 * The route is registered through `ctx.connection.fetch`, so rc.5 applies its
 * Host/Origin fence and owner-only principal gate before this handler runs.
 * No cookie parsing, invocation object, or raw webServer route is used.
 */

import { fail, errorPayload } from '../core/errors.js'
import { assertAllowedKeys, assertPlainObject, requiredString } from '../core/validation.js'

export const CONNECTION_PATH = '/api/session-link/api'
export const CONNECTION_METHODS = Object.freeze(['POST'])
const MAX_BODY_BYTES = 1024 * 1024

/**
 * @param {Record<string, any>} service
 * @returns {(request: Request) => Promise<Response>}
 */
export function createConnectionHandler(service) {
  return async (request) => {
    if (request.method !== 'POST') return envelope(null, 405, 'method_not_allowed', 'POST only')
    const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      return envelope(null, 415, 'unsupported_media_type', 'content-type must be application/json')
    }
    let text
    try {
      text = await request.text()
    } catch {
      return envelope(null, 400, 'bad_request', 'request body could not be read')
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
      return envelope(null, 413, 'payload_too_large', 'request body is too large')
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return envelope(null, 400, 'bad_request', 'body is not JSON')
    }
    try {
      const value = await dispatchRpc(service, body)
      return jsonResponse({ ok: true, value })
    } catch (error) {
      return jsonResponse({ ok: false, error: errorPayload(error) })
    }
  }
}

/**
 * @param {Record<string, any>} service
 * @param {unknown} body
 * @returns {Promise<unknown>}
 */
export async function dispatchRpc(service, body) {
  const object = assertPlainObject(body, 'request body', 'bad_request')
  assertAllowedKeys(object, ['action', 'payload'], 'request body', 'bad_request')
  const action = requiredString(object.action, 'action', { max: 64, code: 'bad_request' })
  const payload = object.payload === undefined ? {} : assertPlainObject(object.payload, 'payload', 'bad_request')
  if (action === 'snapshot') return service.engine.snapshot(payload)
  if (action === 'settings') return service.engine.updateSettings(payload)
  if (action === 'control') return service.engine.ownerControl(payload)
  // Owner-only bounded card lookup: the rc.5 Host/Origin fence and owner
  // principal gate run before this handler; the engine then returns only
  // minimal fields for messages that participate in the requested session.
  if (action === 'card_lookup') return service.engine.cardLookup(payload)
  throw fail('invalid_argument', `unknown action ${action}`)
}

/**
 * Register the exact fetch route on the shared authenticated channel.
 * @param {Record<string, any>} ctx
 * @param {(request: Request) => Promise<Response>} handler
 * @returns {Promise<() => Promise<void>>}
 */
export async function registerConnectionRoute(ctx, handler) {
  const fetch = ctx.connection?.fetch
  if (fetch === undefined || typeof fetch.register !== 'function') {
    throw fail(
      'unsupported_host',
      'target Host does not expose the authenticated exact Fetch API; refusing to mount an insecure control plane',
    )
  }
  return fetch.register({
    path: CONNECTION_PATH,
    methods: [...CONNECTION_METHODS],
    requestBody: 'buffered',
    fetch: handler,
  })
}

/**
 * @param {unknown} value
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {Response}
 */
function envelope(value, status, code, message) {
  return jsonResponse(status >= 400 ? { ok: false, error: { code, message } } : { ok: true, value }, status)
}

/** @param {unknown} body @param {number} [status] @returns {Response} */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
