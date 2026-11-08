# syntax=docker/dockerfile:1
FROM rust:1-bookworm AS builder
WORKDIR /src
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
COPY server/migrations ./migrations
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/target cargo build --locked --release -j 2 && cp /src/target/release/may-server /usr/local/bin/may-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl sqlite3 && rm -rf /var/lib/apt/lists/* && useradd -u 10001 -m may && mkdir -p /app/data && chown may:may /app/data
WORKDIR /app
COPY --from=builder /usr/local/bin/may-server /usr/local/bin/may-server
USER may
ENV BIND_ADDRESS=0.0.0.0:8080 DATABASE_URL=sqlite:///app/data/may.db UPLOAD_DIR=/app/data/uploads
EXPOSE 8080
CMD ["may-server"]
