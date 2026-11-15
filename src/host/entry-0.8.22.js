/** Exact-version physical entry; service/state identity stays unversioned. */
import { createSessionLinkPlugin } from './plugin.js'
export * from './index.js'
export const name = 'session-link'
let builder
export async function apply(ctx, config) {
  if (builder === undefined) {
    const sdk = await import('@deepseek-ai/dsh-llm')
    if (typeof sdk.createUserMessage !== 'function') throw new Error('@wangmo-bit/ds-link: Host createUserMessage is unavailable')
    builder = sdk.createUserMessage
  }
  await createSessionLinkPlugin(ctx, config, { createUserMessage: builder })
}
