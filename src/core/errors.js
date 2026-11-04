/**
 * Stable, model- and UI-facing failures. Messages never contain message
 * bodies, paths, or credentials: only identities, codes, and bounded counts.
 */

export class SessionLinkError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message bounded human description
   * @param {Record<string, unknown>} [details] bounded structured detail
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'SessionLinkError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {SessionLinkError}
 */
export function fail(code, message, details) {
  return new SessionLinkError(code, message, details)
}

/**
 * @param {unknown} error
 * @returns {{ code: string, message: string, details?: Record<string, unknown> }}
 */
export function errorPayload(error) {
  if (error instanceof SessionLinkError) {
    const payload = { code: error.code, message: error.message }
    if (error.details !== undefined) payload.details = error.details
    return payload
  }
  return { code: 'internal', message: 'internal session-link failure' }
}

/**
 * @param {unknown} error
 * @returns {string} stable code for logs without exposing content
 */
export function errorCode(error) {
  if (error instanceof SessionLinkError) return error.code
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return 'internal'
}
