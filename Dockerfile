# syntax=docker/dockerfile:1.6
# ---- Builder stage ----
FROM rust:bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    protobuf-compiler \
    libprotobuf-dev \
    cmake \
    libssl-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
RUN --mount=type=cache,id=${RAILWAY_CACHE_KEY}-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=${RAILWAY_CACHE_KEY}-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=${RAILWAY_CACHE_KEY}-build-target,target=/build/target \
    mkdir src && echo "fn main() {}" > src/main.rs && touch src/lib.rs \
    && cargo build --release \
    && rm -rf src
COPY interface/package.json interface/
RUN --mount=type=cache,id=bun-cache,target=/root/.bun/install/cache \
    cd interface && bun install
COPY interface/ interface/
RUN --mount=type=cache,id=bun-cache,target=/root/.bun/install/cache \
    cd interface && bun run build
COPY build.rs ./
COPY prompts/ prompts/
COPY migrations/ migrations/
COPY src/ src/
RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=build-target,target=/build/target \
    SPACEBOT_SKIP_FRONTEND_BUILD=1 cargo build --release \
    && mv /build/target/release/spacebot /usr/local/bin/spacebot \
    && cargo clean -p spacebot --release --target-dir /build/target
# ---- Slim stage ----
FROM debian:bookworm-slim AS slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libsqlite3-0 \
    curl \
    gh \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/bin/spacebot /usr/local/bin/spacebot
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV SPACEBOT_DIR=/data
ENV SPACEBOT_DEPLOYMENT=docker
EXPOSE 19898 18789
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:19898/api/health || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["spacebot", "start", "--foreground"]
# ---- Full stage ----
FROM slim AS full
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libcups2 \
    libxss1 \
    libxtst6 \
    && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium
ENV CHROME_FLAGS="--no-sandbox --disable-dev-shm-usage --disable-gpu"
