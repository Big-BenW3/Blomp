# Blomp: build rules

Blomp is a PWA that has Kane CLI test a developer's live site, then opens a fix PR and has Kane re-check it.
Spec: the PRD and build plan linked from the README.

- Stack: Next.js App Router, TypeScript, Tailwind, Auth.js v5 (GitHub), Neon + Drizzle, Vitest.
- Kane CLI never runs on Vercel or in the dev sandbox; it runs in `.github/workflows/kane-scan.yml`.
- The verdict (pass, fail, unknown) comes only from Kane's exit code and `run_end` event. Models never decide it.
- UNKNOWN (Kane exit 2 or 3) is never counted as a pass in a score.
- Validate every external input with zod: model output, webhook bodies, runner posts.
- No secrets in the repo. Variables are listed in `.env.example`.
- Small commits. Run `npm run lint && npm run typecheck && npm test` before pushing.
- Never edit `kane/` check files from inside a fix task; the check must not be weakened by the thing it checks.
