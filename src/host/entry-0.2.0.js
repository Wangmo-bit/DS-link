/** Exact-version physical entry: do not reuse an older index.js callback during rc.5 HMR. */
import { createSessionLinkPlugin } from './plugin.js'
export { inject } from './index.js'
export const name = 'session-link'
let builder
export async function apply(ctx, config) {
  if (builder === undefined) {
    const sdk = await import('@deepseek-ai/dsh-llm')
    if (typeof sdk.createUserMessage !== 'function') throw new Error('dsh-session-link: Host createUserMessage is unavailable')
    builder = sdk.createUserMessage
  }
  await createSessionLinkPlugin(ctx, config, { createUserMessage: builder })
}
