FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY src ./src
COPY test ./test
COPY tsconfig.json ./

RUN npm ci
RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/src ./dist/src

ENV NODE_ENV=production
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=8080
ENV MCP_PATH=/mcp
ENV VAULT_ROOT=/data/vault
ENV DEFAULT_WRITE_DIR=98-Inbox

EXPOSE 8080

USER node

CMD ["node", "dist/src/server.js"]
