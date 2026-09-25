# docker

Dockerfiles and compose files.

- `dev/compose.yaml`: the local dev and CI stack (Postgres, OpenBao dev server), F-002. See `docs/engineering/repo-conventions.md` ("The dev stack") and `tooling/dev-stack/README.md`.
- `control-plane.Dockerfile`: the control-plane image (F-002-T14). Multi-stage, `pnpm deploy --prod` (no devDependencies, so no dev stack or mock IdP), third-party test folders removed, non-root (`USER 1000:1000`), no secret in any `ARG` or `ENV`. Build from the repository root, whose `.dockerignore` keeps `.env` files, `deploy/docker/dev/`, keys and `.git` out of the context:

  ```sh
  docker build -f deploy/docker/control-plane.Dockerfile -t ralysa/control-plane .
  node tooling/repo-scripts/src/secret-scan-cli.ts image --dockerfile deploy/docker/control-plane.Dockerfile --exact-values deploy/docker/dev/.env
  ```

  The image runs `serve --config /etc/ralysa/control-plane.yaml`; mount the config there (identifiers and vault paths only, design §3.8), or pass another entry point (`migrate --config …`, `sealer --config …`). The CI `integration` job builds and scans it on every run.
