# wiki/ — experience-derived knowledge

Knowledge we **learned** building, testing and operating argrid-rpg — **not derivable from the code**.
Source of truth is human experience and runtime behaviour, so it can't be verified by grepping source.
Maintained by the `wiki-keeper` agent (proactive drafts, **user approves**). Written in **English**.

**This file is the index.** When you add/rename/remove an entry, update the matching table below so the
map always says *where a thing lives* and *where a new thing goes*.

## Where things go (folder scopes)

| Folder | Put here | Template |
|---|---|---|
| [`issues/`](issues/) | A **known issue**: symptom → how it was investigated → root cause → resolution → status. | [`issues/_template.md`](issues/_template.md) |
| [`operations/`](operations/) | A **procedure** to run: test on a phone, verify detection headless, deploy, etc. | [`operations/_template.md`](operations/_template.md) |
| [`knowledge-base/`](knowledge-base/) | A **fundamental**: how to run/build, the OpenCV-boot constraints, environments, glossary. | [`knowledge-base/_template.md`](knowledge-base/_template.md) |

Conventions for every entry:
- One file per issue / procedure / topic. Kebab-case filename. Keep it lean, link out — don't duplicate.
- **Every command / query / script goes in a fenced code block tagged with its language** (```bash, ```js,
  ```powershell, …).
- Cross-link the relevant `../technical/` doc (read-only) instead of re-explaining architecture.
- Mark anything not confirmed as an explicit assumption. State `Last verified: <date>` where it matters.

## Index — issues

| Entry | Status | What |
|---|---|---|
| [OpenCV.js hangs when driven from Node](issues/opencv-hangs-in-node.md) | resolved | Can't run `detectGrid` in Node — verify detection in a headless browser instead |

## Index — operations

| Entry | What it does |
|---|---|
| [Verify detection & the tactical UI in a headless browser](operations/verify-detection-headless.md) | Drive `detectGrid` + the UI via the `window.__argrid` DEV hook (inject a synthetic grid, simulate taps) |
| [Test on a phone (ngrok)](operations/test-on-a-phone.md) | Reach the dev/preview server from a phone over HTTPS so the camera works |
| [Deploy — GitHub Actions → Netlify](operations/deploy.md) | Push to `main` → preview deploy; push a `vX.Y.Z` tag → production deploy |

## Index — knowledge-base

| Entry | Topic |
|---|---|
| [Project setup — run, build, test, lint](knowledge-base/project-setup.md) | The stack and the npm scripts; camera/service-worker notes |
| [OpenCV boot constraints](knowledge-base/opencv-boot.md) | Why `opencv-boot.js` is a classic script with a synchronous ready callback — don't "modernize" it |
