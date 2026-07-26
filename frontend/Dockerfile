FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . ./
RUN npm run build

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8002
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/.next ./.next

CMD ["npm", "run", "start"]
