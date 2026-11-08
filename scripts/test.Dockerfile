# A locked Node 24 baseline; image identity is also recorded in TESTING.md.
FROM node:24-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0
WORKDIR /opt/session-link
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=node:node . .
RUN node scripts/prepare-host-fixtures.mjs /opt/host-sdk && chown -R node:node /opt/host-sdk
ENV DSH_CHAT_RC1_CLIENT=/opt/host-sdk/chat-rc1/package/lib/client.js \
    DSH_CHAT_CLIENT=/opt/host-sdk/chat-rc5/package/lib/client.js \
    DSH_CHAT_FLOW_CLIENT=/opt/host-sdk/chat-rc5/scroll-patched.js \
    DSH_CLIENT_CONVERSATION=/opt/host-sdk/conversation/package/lib/client.js
USER node
# `--read-only --network=none --tmpfs /tmp:...` is required at runtime.
# All writes (pack/build/fixtures/npm cache) go to the disposable tmpfs.
CMD ["sh", "-eu", "-c", "mkdir -p /tmp/home /tmp/work; cp -a /opt/session-link/. /tmp/work/; cd /tmp/work; export HOME=/tmp/home npm_config_cache=/tmp/npm-cache; npm test; npm run build; npm run check:public -- --pack"]
