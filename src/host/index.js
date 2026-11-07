/**
 * Package entry. Only this module imports a Host value: the public
 * `createUserMessage` builder. Everything else is injected so tests can run
 * against a mock Host without private package internals.
 */

import { SessionLinkService, createSessionLinkPlugin, normalizeConfig, resolveStateRoot } from './plugin.js'

let hostBuilder

/**
 * Load the only Host value import lazily. This keeps every source module
 * importable in tests without a production Harness install, while a real
 * profile still must provide the exact peer package at apply time.
 * @returns {Promise<(input: Record<string, any>) => Record<string, any>>}
 */
async function createUserMessageBuilder() {
  if (hostBuilder !== undefined) return hostBuilder
  let module
  try {
    module = await import('@deepseek-ai/dsh-llm')
  } catch (error) {
    throw new Error(
      '@wangmo/dsh-session-link: @deepseek-ai/dsh-llm must be resolvable from this package (peer 0.2.1-rc.5 || 0.2.2-rc.1)',
      { cause: error },
    )
  }
  if (typeof module.createUserMessage !== 'function') {
    throw new Error('@wangmo/dsh-session-link: @deepseek-ai/dsh-llm does not export createUserMessage')
  }
  hostBuilder = module.createUserMessage
  return hostBuilder
}

export const name = 'session-link'

/**
 * Public Host services this plugin requires. The loader activates the plugin
 * only after all of them exist; a Host without the authenticated exact Fetch
 * API is rejected in open() instead of falling back to an unauthenticated
 * raw webServer route.
 */
export const inject = [
  'sessions',
  'agents',
  'sessionController',
  'workspaceRegistry',
  'sessionQuery',
  'connection',
  'tools',
  'systemPrompt',
]

/**
 * @param {Record<string, any>} ctx
 * @param {Record<string, unknown>|undefined} config
 * @returns {Promise<SessionLinkService>}
 */
export async function apply(ctx, config) {
  const createUserMessage = await createUserMessageBuilder()
  // Cordis accepts only void or an effect disposer from apply; the service is
  // registered through ctx.provide and tied to the plugin's lifecycle effect.
  await createSessionLinkPlugin(ctx, config, { createUserMessage })
}

export { SessionLinkService, createSessionLinkPlugin, normalizeConfig, resolveStateRoot }
export { Ledger } from '../core/ledger.js'
export { rollbackPreflight, validateV1State, v3ToV2Preflight } from '../core/migration.js'
export { v04DowngradePreflight } from '../core/downgrade.js'
export { SessionLinkEngine } from '../core/engine.js'
export { HostAdapter } from './adapter.js'
export { createToolDefinitions } from './tools.js'
export { CONNECTION_PATH, createConnectionHandler, dispatchRpc, registerConnectionRoute } from './connection.js'
export { PROMPT_SECTION_NAME, SESSION_LINK_GUIDANCE } from './prompt.js'
