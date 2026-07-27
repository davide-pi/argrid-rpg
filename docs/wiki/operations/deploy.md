# Deploy — GitHub Actions → Netlify

- **Purpose:** how the app ships. CI builds and CD deploys to Netlify; nothing is deployed by hand.
- **Applies to:** `main` (preview) and version tags (production).
- **Risk:** medium — pushing to `main` triggers a real (preview) deploy.
- **Last verified:** 2026-07-27
- **Refs:** `.github/workflows/ci.yml`, `.github/workflows/cd.yml`, `GitVersion.yml`

## Mechanism (from the workflow files)

- **CI** (`ci.yml`) runs on **push to `main`**, on **tags `v[0-9]+.[0-9]+.[0-9]+`**, and on **PRs to
  `main`**. Jobs, in order:
  1. **Lint** — `npm run lint`.
  2. **Test** — `npm run test:coverage` (uploads a `coverage/` artifact).
  3. **Build** (needs lint + test) — GitVersion computes the version, `npm version … --no-git-tag-version`
     sets it, `npm run build` runs with `APP_VERSION` in the env (injected into the bundle as the on-map
     **version badge**). Uploads the `dist/` artifact + a `deploy-info.env` (`deploy_type`, `version`).
     `deploy_type` = **production** for a tag, **preview** for `main`, **none** otherwise (e.g. PRs).
- **CD** (`cd.yml`) is triggered by CI's completion (`workflow_run`), only on **success** and **not for
  PRs**. It **reuses CI's artifacts** (no rebuild): downloads `dist/`, reads `deploy_type`, and deploys to
  **Netlify** (`nwtgck/actions-netlify`) — **production** deploy for a tag, otherwise a **preview** deploy.

## Steps

- **Preview deploy:** just push/merge to `main`.
  ```bash
  git push origin main
  ```
- **Production deploy:** push a semver tag.
  ```bash
  git tag v1.2.0
  git push origin v1.2.0
  ```

## Prerequisites (GitHub → repo settings)

**Assumption (verify with the repo owner — not derivable from the code):** the CD job needs these secrets
configured, and the environments `preview` / `production` to exist:

- `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID` (the Netlify project — `argrid-rpg`).
- The default `GITHUB_TOKEN` is used to pull artifacts from the triggering CI run.

## Verify

- Watch the **Actions** tab: CI (lint → test → build) green, then CD → "Deploy to Netlify" green.
- The deploy URL is surfaced on the CD job's environment; check the site loads and the version badge
  matches the built version.

## Rollback / if it fails

- Re-deploy a previous good state (revert the commit on `main`, or re-tag from an earlier commit).
- **History note:** `main` is published — do **not** rewrite it (squash/force-push); go forward with normal
  commits, since a force-push would disrupt CI/CD and any consumers.
