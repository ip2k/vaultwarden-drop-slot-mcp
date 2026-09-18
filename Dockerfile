# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build AS test
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY test ./test
USER node
CMD ["node", "--test", "--test-concurrency=1", "test/*.test.mjs"]

FROM build AS production-deps
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime
WORKDIR /app
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE NOTICE ./
RUN mkdir /state /bw && chown node:node /state /bw
USER node
EXPOSE 8443
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--help"]

# The CLI is a separate executable (GPL-3.0). It is not linked into the npm
# module or included in the default runtime. Preserve its license/source notice.
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS cli-download
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN set -eu; case "$TARGETARCH" in \
    amd64) archive=bw-oss-linux-2026.8.0.zip; checksum=d8bbc213d3dbdb701709386af6ea3bd763482f922ae0b538fdc3fdb88b1b1704 ;; \
    arm64) archive=bw-oss-linux-arm64-2026.8.0.zip; checksum=c635773f3fb4eb29bd23fe7fe468c59c69a9f2b614e543fc598aa592d55deb37 ;; \
    *) exit 1 ;; esac; \
    curl --fail --location --proto '=https' "https://github.com/bitwarden/clients/releases/download/cli-v2026.8.0/$archive" -o /tmp/bw.zip; \
    printf '%s  /tmp/bw.zip\n' "$checksum" | sha256sum -c -; \
    mkdir /bw && unzip /tmp/bw.zip -d /bw && chmod 755 /bw/bw && rm /tmp/bw.zip

FROM runtime AS importer
USER root
COPY --from=cli-download /bw/bw /usr/local/bin/bw
COPY --from=cli-download /etc/ssl/certs /etc/ssl/certs
RUN sha256sum /usr/local/bin/bw > /app/bw.sha256
USER node

FROM importer AS acceptance
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
COPY --from=build /app/node_modules/playwright ./node_modules/playwright
COPY --from=build /app/node_modules/playwright-core ./node_modules/playwright-core
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/* \
    && node node_modules/playwright/cli.js install --with-deps chromium
COPY test ./test
USER node
ENTRYPOINT ["node", "test/acceptance.mjs"]

# The ordinary docker build result is deliberately the unprivileged adapter/inbox.
FROM runtime AS default
