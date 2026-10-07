FROM node:22.19.0-bookworm-slim
ARG BB_FORK_COMMIT=local-test
LABEL org.opencontainers.image.revision=$BB_FORK_COMMIT
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates curl sqlite3 procps && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY . .
ENV CI=true NODE_OPTIONS=--max-old-space-size=3072
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=bb-app --concurrency=2 --output-logs=errors-only
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production BB_DATA_DIR=/data BB_SERVER_BIND_HOST=0.0.0.0 BB_SERVER_PORT=38886 BB_HOST_DAEMON_PORT=38887
USER node
EXPOSE 38886
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=6 CMD node -e 'fetch("http://127.0.0.1:38886/health").then(async r=>{if(!r.ok||!(await r.json()).ok)process.exit(1)}).catch(()=>process.exit(1))'
CMD ["node", "packages/bb-app/dist/bb-app.js", "start"]
