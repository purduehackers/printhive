FROM docker.io/oven/bun:1.4.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile
COPY . .
RUN bun run check && bun test tests && bun run build

FROM docker.io/oven/bun:1.4.3 AS runtime
WORKDIR /app
USER root
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321 DATA_DIR=/data
COPY package.json bun.lock ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile --production && mkdir /data
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY scripts/migrate.ts scripts/operator.ts scripts/cleanup.ts scripts/preflight.ts ./scripts/
COPY src/lib ./src/lib
EXPOSE 4321
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD bun -e 'const r = await fetch("http://127.0.0.1:4321/api/health"); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "run", "start"]
