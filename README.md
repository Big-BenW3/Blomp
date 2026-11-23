# Blomp

CI is green. Is your signup? Blomp has [Kane CLI](https://github.com/LambdaTest/kane-cli) open your live site in a real
browser, proves which user flows work, opens a pull request for the ones that don't, and has Kane re-check the fix on the
PR's preview before it is marked verified.

Built for the KaneCLI Online Hackathon by TestMu AI.

> Full README, architecture diagram and judge guide arrive in Phase 8.

## Run locally

```bash
npm install
cp .env.example .env.local   # fill in the values
npm run db:migrate
npm run dev
```
