<img src="assets/icon.svg" width="64" height="64" alt="">

# SSM — Shit Show Manager

One page instead of forty tabs. Pulls your open Azure DevOps PRs and their Jira tickets, groups PRs by ticket (key from the PR title, then branch), and sorts each ticket into a stage:

| Stage | Rule (per PR; a ticket sits at its least-advanced PR) |
|---|---|
| PR raised | nothing from CodeRabbit yet |
| CodeRabbit rate limited | CodeRabbit's latest comment is its "Review limit reached" notice — shows when the window opens |
| CodeRabbit fed back | open CodeRabbit threads, or a −5/−10 vote |
| CodeRabbit approved | CodeRabbit voted ≥ 5 |
| CodeRabbit + QA approved | …and the QA reviewer (`QA_REVIEWER_MATCH`) voted ≥ 5 |

Plus **In progress, no PR** (Jira JQL). Only PRs you authored are shown.

**Group by** (toggle, kept in the URL as `?by=kind`): **Stage** (above) or **Ship / Show / Ask** — the first word of the PR title (`SHIP: …`, `SHOW …`, `[ASK] …`; mixed-case needs a colon or brackets so "Show totals…" isn't misread). Unprefixed PRs land in **No prefix**. Whichever dimension isn't the heading shows as a badge on the card.

Per PR: policy checks (builds, comment resolution, merge strategy…) with one-click **requeue**, **Ask CodeRabbit to review** (posts `@coderabbitai review` as a closed thread so it never blocks comment policies), draft/publish. Per ticket: Jira status, any transition, and a **→ IN PR** quick-move when the ticket lags behind its PR.

## Run

```sh
npm install
cp .env.example .env   # fill BETTER_AUTH_SECRET, ALLOWED_EMAILS, JIRA_EMAIL, JIRA_API_TOKEN
npm run dev            # http://localhost:3000
```

- **ADO auth**: set `ADO_PAT`, or leave it empty to borrow your `az login` (it finds the tenant your ADO identity lives in).
- **Email**: without `RESEND_API_KEY`, magic links and codes print to the server console.
- **Auth**: Better Auth + SQLite (`node:sqlite`, auto-migrated). Magic link, email code, email/password, passkeys (add one in Settings). Only `ALLOWED_EMAILS` can sign up or sign in — enforced before any email is sent, at user creation, and on every server call.

## Scripts

`npm run dev` · `npm run build && npm start` · `npm test` · `npm run typecheck` · `npm run check`
