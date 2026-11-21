# syntax=docker/dockerfile:1

# ---- fetch the official Ookla Speedtest CLI for the target architecture ----
FROM debian:bookworm-slim AS speedtest
ARG TARGETARCH
ARG SPEEDTEST_VERSION=1.2.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && case "${TARGETARCH:-amd64}" in \
      amd64) ARCH=x86_64 ;; \
      arm64) ARCH=aarch64 ;; \
      arm) ARCH=armhf ;; \
      386) ARCH=i386 ;; \
      *) echo "unsupported arch ${TARGETARCH}" && exit 1 ;; \
    esac \
 && curl -fsSL "https://install.speedtest.net/app/cli/ookla-speedtest-${SPEEDTEST_VERSION}-linux-${ARCH}.tgz" \
    | tar -xz -C /usr/local/bin speedtest \
 && chmod +x /usr/local/bin/speedtest

# ---- install node deps ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    HOME=/data
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data
COPY --from=speedtest /usr/local/bin/speedtest /usr/local/bin/speedtest
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
