FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . ./
RUN npm run build

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/evaluation/rag/fixtures ./evaluation/rag/fixtures
RUN mkdir -p /app/evaluation/rag/artifacts

CMD ["node", "dist/main.js"]
