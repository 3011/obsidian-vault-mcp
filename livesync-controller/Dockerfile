ARG LIVESYNC_CLI_IMAGE=obsidian-livesync-cli:latest
FROM ${LIVESYNC_CLI_IMAGE}

COPY controller.mjs /usr/local/bin/livesync-controller
RUN printf '#!/bin/sh\nexec node /app/dist/index.cjs "$@"\n' > /usr/local/bin/livesync-cli \
  && chmod +x /usr/local/bin/livesync-controller /usr/local/bin/livesync-cli

ENTRYPOINT ["node", "/usr/local/bin/livesync-controller"]
