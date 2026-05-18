# ---- Build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.migrations.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/
RUN npm run build

# ---- Production stage ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-migrations/migrations ./migrations
COPY lexicons/ ./lexicons/

EXPOSE 3001
USER node
CMD ["node", "dist/index.js"]
