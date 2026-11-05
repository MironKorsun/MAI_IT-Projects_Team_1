# syntax=docker/dockerfile:1
# Образ ВП ТС ЕГЭ (ТЗ СЧ NFR-31): контейнер OCI, Linux x86-64, конфигурация — переменными окружения,
# секретов в образе нет (мастер-ключ КИМ и пароли передаются при запуске).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY tsconfig.base.json ./
COPY shared shared
COPY kim kim
COPY api api
COPY server server
COPY web web
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/dist server/dist
COPY server/migrations server/migrations
COPY --from=build /app/web/dist web/dist
COPY kim kim
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
