FROM rust:1.88-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --locked --release

FROM debian:bookworm-slim
RUN groupadd --system --gid 10001 blackterminal \
    && useradd --system --uid 10001 --gid blackterminal --home /var/lib/black-terminal-relay --shell /usr/sbin/nologin blackterminal \
    && install -d -m 0700 -o blackterminal -g blackterminal /var/lib/black-terminal-relay
COPY --from=build /build/target/release/black-terminal-relay /usr/local/bin/black-terminal-relay
USER 10001:10001
EXPOSE 4001/tcp 8080/tcp
VOLUME ["/var/lib/black-terminal-relay"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/usr/local/bin/black-terminal-relay", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/black-terminal-relay"]
