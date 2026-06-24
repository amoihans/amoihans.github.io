# Base stage for building the static files
FROM node:lts AS base
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# Runtime stage for serving the application
FROM nginx:mainline-alpine-slim AS runtime
COPY --from=base /app/dist /usr/share/nginx/html
# 自定义 nginx 配置：开启 gzip、加 COOP/COEP（Godot Web 必需）、配置缓存策略
COPY nginx.conf /etc/nginx/nginx.conf
EXPOSE 80
