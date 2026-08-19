# anti-DDoSia — zero-dependency Node app
FROM node:24-alpine

# Small init so the container handles signals cleanly (graceful stop).
RUN apk add --no-cache tini wget

WORKDIR /app

# No third-party deps, but copy the manifest first for layer caching / metadata.
COPY package.json ./

# Application code.
COPY server.js ./
COPY public ./public

# Runtime state (GeoIP cache + history) lives here; mount a volume to persist it.
RUN mkdir -p /app/data && chown -R node:node /app

ENV NODE_ENV=production \
    PORT=3000

USER node
EXPOSE 3000

# Container healthcheck hits the app's own health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health | grep -q '"ok":true' || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
