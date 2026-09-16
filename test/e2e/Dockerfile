# A machine that has never seen dbrex.
#
# Deliberately not a workspace image: nothing from the repository is baked in,
# no dependencies are pre-installed. The verification script copies the source
# in and installs it the way a new user would, so a missing dependency or a
# build step that only works on a warm tree fails here.
FROM node:20-bookworm-slim

# `code` is not installed. This image verifies the daemon and the CLI, which is
# the whole of dbrex except the editor front-end; pulling Electron in would
# quadruple the image for one more assertion.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Not root. A daemon that only works as root is a bug this would otherwise hide,
# and the socket directory is created at mode 0700 for a real user id.
RUN useradd --create-home --shell /bin/bash dbrex \
 && mkdir -p /opt/dbrex \
 && chown dbrex:dbrex /opt/dbrex

COPY --chown=dbrex:dbrex --chmod=755 verify.sh /opt/dbrex/verify.sh
COPY --chown=dbrex:dbrex connections.json /opt/dbrex/connections.json

USER dbrex
WORKDIR /home/dbrex
