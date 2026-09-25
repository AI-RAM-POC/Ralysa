# syntax=docker/dockerfile:1
# Control-plane image (F-002-T14; design §8.5, SEC-F002-13 c, SEC-F002-29, AR-12).
#
#   docker build -f deploy/docker/control-plane.Dockerfile -t ralysa/control-plane .
#   node tooling/repo-scripts/src/secret-scan-cli.ts image --dockerfile deploy/docker/control-plane.Dockerfile
#
# - Multi-stage: the build stage installs and builds from the lockfile; the runtime stage gets only
#   the output of `pnpm deploy --prod`, so devDependencies (the dev stack, the mock IdP and its
#   oidc-provider engine, compilers, test tools) never reach it. The image scan asserts that.
# - No ARG or ENV carries a secret, and none ever may: the image is scanned with its
#   `docker image inspect` config and history. If a build ever needs a credential, pass it with
#   BuildKit `RUN --mount=type=secret`, never ARG or ENV (SEC-F002-29).
# - The build context is the repository root, filtered by /.dockerignore (no .env, no
#   deploy/docker/dev/, no keys, no .git).
# - The runtime runs as the unprivileged `node` user (uid 1000), with the application files owned
#   by root and read-only to it. Config (identifiers and vault paths only, §3.8) is mounted at run
#   time: `serve --config /etc/ralysa/control-plane.yaml`.
# - Base images are pinned by digest: node 24.21.0 on Alpine, the same index as the dev stack's
#   mock-idp service (checked 2026-09-25, implementation-notes T09).

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
ENV CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
WORKDIR /repo
COPY . .
# Before any pnpm command, as in CI (ci/pre-install-gate-first): pnpm installs configDependencies
# and loads pnpmfiles, and `pnpm install` runs lifecycle scripts. Plain node, no packages.
RUN node tooling/repo-scripts/src/pre-install-gate.ts
# pnpm from Corepack, which verifies the sha512 in package.json#packageManager.
RUN corepack enable && pnpm --version
# The control plane and its workspace dependencies (build tooling included), from the lockfile.
RUN pnpm install --frozen-lockfile --filter "@ralysa/control-plane..."
RUN pnpm --filter "@ralysa/control-plane..." run build
# Production dependencies only; workspace packages are copied in (their `files`: dist only).
RUN pnpm --filter @ralysa/control-plane deploy --prod /out

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
# The runtime needs node only: drop the package managers the base image ships.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /out /app
USER 1000:1000
EXPOSE 4100
ENTRYPOINT ["node", "dist/main.js"]
CMD ["serve", "--config", "/etc/ralysa/control-plane.yaml"]
