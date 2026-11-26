FROM node:24-slim

WORKDIR /app

COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/gateway/package.json ./apps/gateway/

RUN npm install --workspaces --include-workspace-root=false --workspace=@sandrobina/shared --workspace=@sandrobina/gateway --ignore-scripts

COPY packages/shared ./packages/shared
COPY apps/gateway ./apps/gateway

RUN npm run build --workspace=@sandrobina/shared && npm run build --workspace=@sandrobina/gateway

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data
EXPOSE 8787

CMD ["node", "apps/gateway/dist/index.js"]
