# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/skills/package.json packages/skills/package.json
COPY packages/agent-memory-trends/package.json packages/agent-memory-trends/package.json
COPY packages/skillwiki-maintenance/package.json packages/skillwiki-maintenance/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
RUN npm ci
COPY packages/shared ./packages/shared
COPY packages/cli/src ./packages/cli/src
COPY packages/cli/tsconfig.json packages/cli/tsconfig.json
COPY packages/mcp-server ./packages/mcp-server
RUN npm run -w @skillwiki/mcp-server build

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends rclone ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages/mcp-server/package.json ./packages/mcp-server/package.json
COPY --from=build /src/packages/mcp-server/dist ./packages/mcp-server/dist
COPY --from=build /src/packages/shared ./packages/shared
COPY --from=build /src/packages/cli/package.json ./packages/cli/package.json
RUN mkdir -p /opt/skillwiki-mcp/vault /etc/skillwiki-mcp /var/log/skillwiki-mcp \
  && printf '%s\n' '{}' > /etc/skillwiki-mcp/tokens.yaml \
  && printf '%s\n' '# Schema' > /opt/skillwiki-mcp/vault/SCHEMA.md \
  && chown -R node:node /opt/skillwiki-mcp /etc/skillwiki-mcp /var/log/skillwiki-mcp
USER node
ENV SKILLWIKI_MCP_BIND=127.0.0.1 \
    SKILLWIKI_MCP_PORT=8801 \
    SKILLWIKI_MCP_VAULT=/opt/skillwiki-mcp/vault \
    SKILLWIKI_MCP_TOKEN_MAP=/etc/skillwiki-mcp/tokens.yaml
EXPOSE 8801
CMD ["node", "packages/mcp-server/dist/server.js"]
