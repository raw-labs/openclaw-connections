# Official Node 24.19.0 bookworm image; immutable multi-platform digest.
FROM node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b

ARG CONNECTIONS_BUILD_UID
ARG CONNECTIONS_BUILD_GID
RUN groupadd --non-unique --gid "${CONNECTIONS_BUILD_GID}" connections-builder \
    && useradd --non-unique --uid "${CONNECTIONS_BUILD_UID}" \
      --gid "${CONNECTIONS_BUILD_GID}" --create-home connections-builder
ENV HOME=/home/connections-builder
USER connections-builder
