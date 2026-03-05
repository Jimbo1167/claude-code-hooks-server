FROM node:22-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:22-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ ./dist/
COPY public/ ./public/

EXPOSE 3003

CMD ["node", "dist/index.js"]
