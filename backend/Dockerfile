# ---------- build & run no mesmo stage ----------
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# 1) Instala dependências (inclui TS para compilar)
COPY package*.json ./
RUN npm install && npm cache clean --force

# 2) Copia configs e código
COPY tsconfig*.json ./
COPY src ./src

# 3) Compila TS -> dist
RUN npm run build

# 4) Remove devDependencies e lixos de build
RUN npm prune --omit=dev \
 && rm -rf src tsconfig*.json

# 5) wget pro healthcheck do docker-compose
RUN apk add --no-cache wget

EXPOSE 8080
CMD ["node", "dist/server.js"]

