# Builds the console image: kernel API (Fastify) serving the built UI at /,
# same origin, no CORS. Two build stages produce ui/dist and kernel/dist;
# the runtime stage installs only the kernel's own runtime dependencies
# (not router/runner/agent/ui devDependencies -- vite, playwright, vitest --
# which would otherwise get pulled in through the npm workspaces hoist).
#
# Build for a specific platform explicitly, since a build on Apple Silicon
# defaults to arm64 while Fargate here is deployed as X86_64:
#   docker buildx build --platform linux/amd64 -t styx-console:latest --load .

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY kernel/package.json kernel/package.json
COPY ui/package.json ui/package.json
COPY router/package.json router/package.json
COPY runner/package.json runner/package.json
COPY agent/package.json agent/package.json
RUN npm ci

FROM deps AS build-ui
COPY ui ui
RUN npm run build --workspace=ui

FROM deps AS build-kernel
COPY kernel kernel
RUN npm run build --workspace=kernel

FROM node:20-slim AS runtime
WORKDIR /app
# Standalone kernel-only manifest: keeps the runtime `npm install` to
# fastify/@fastify/static/pg/@aws-sdk-bedrock only, none of the other
# workspaces' devDependencies.
COPY kernel/package.json ./package.json
RUN npm pkg delete devDependencies scripts && npm install --omit=dev

COPY --from=build-kernel /app/kernel/dist ./kernel/dist
COPY --from=build-ui /app/ui/dist ./ui/dist

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "kernel/dist/api/start.js"]
