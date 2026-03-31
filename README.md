# CMS Bridge

CMS Bridge is a self-hosted Airtable-to-Webflow CMS sync service with a small dashboard and API for managing connections, mappings, and manual or scheduled syncs.

## Requirements

- Node.js 20+
- npm
- PostgreSQL, including hosted options such as Supabase
- An Airtable personal access token with the required base permissions
- A Webflow API token with access to the target site and collection

## Local setup

1. Install dependencies:

```bash
npm ci
```

2. Start the app:

```bash
npm run dev
```

3. Open `http://0.0.0.0:3456`. On first run, CMS Bridge automatically redirects to onboarding so you can enter your database URL, dashboard password, session secret, and provider API keys from the UI.

4. If you prefer managing config manually instead of using onboarding, you can still seed a local env file yourself:

```bash
cp .env.example .env
```

The app listens on `http://0.0.0.0:3456` by default and exposes a health endpoint at `/api/health`.

In local or writable self-hosted environments, the setup screen can write database, dashboard, and provider credentials into your `.env` file. On managed hosts such as Vercel or Render, the same screen gives you a copyable env block for platform-level configuration.

## Environment variables

Required:

- `AIRTABLE_API_KEY`
- `WEBFLOW_API_TOKEN`
- `DATABASE_URL` or `POSTGRES_URL`
- `APP_PASSWORD`
- `APP_SESSION_SECRET`

Optional:

- `APP_AUTOMATION_TOKEN`
- `PORT`
- `HOST`
- `LOG_LEVEL`
- `PGSSLMODE`
- `PG_POOL_SIZE`

Notes:

- `DATABASE_URL` is the simplest option and works well with Supabase, Render Postgres, Neon, and self-hosted Postgres.
- `APP_PASSWORD` is the shared dashboard login password.
- `APP_SESSION_SECRET` signs the session cookie and should be a long random value.
- `APP_AUTOMATION_TOKEN` should be different from the dashboard password if you enable Airtable-triggered syncs.
- For Supabase and most hosted Postgres providers, set `PGSSLMODE=require`.
- In production-like environments, if `APP_PASSWORD` or `APP_SESSION_SECRET` is missing, the app fails closed and blocks access to everything except `/api/health`.

## Deployment

### Supabase Postgres

If you want to use Supabase for the project database, create a Supabase project first and use its Postgres connection string as `DATABASE_URL`.

Recommended setup:

1. Create a new Supabase project.
2. Open Supabase project settings and copy the Postgres connection string from the database settings page.
3. Set that value as `DATABASE_URL`.
4. Set `PGSSLMODE=require`.
5. Keep `PG_POOL_SIZE=3` unless you know you need a different pool size.

Notes:

- CMS Bridge only needs PostgreSQL connectivity from Supabase. It does not require Supabase Auth, Storage, or Edge Functions.
- The onboarding screen can hold the Supabase connection string for local development. For hosted deployments, use the generated env block and paste it into your deployment platform.

### Vercel

This repo includes `vercel.json` and `api/[...route].js` for Vercel deployment.

Recommended setup:

- Framework preset: `Other`
- Install command: `npm ci`
- Build command: `npm run build`
- Output directory: leave empty

Recommended env vars on Vercel:

- `DATABASE_URL`
  Use your Supabase or other Postgres connection string.
- `PGSSLMODE`
  Set this to `require` for Supabase and most hosted Postgres providers.
- `AIRTABLE_API_KEY`
- `WEBFLOW_API_TOKEN`
- `APP_PASSWORD`
- `APP_SESSION_SECRET`
- `APP_AUTOMATION_TOKEN`
  Optional.

Recommended Vercel flow with Supabase:

1. Create the Supabase project and copy its Postgres connection string.
2. Create the Vercel project from this repository.
3. Add `DATABASE_URL` with the Supabase connection string.
4. Add `PGSSLMODE=require`.
5. Add `AIRTABLE_API_KEY`, `WEBFLOW_API_TOKEN`, `APP_PASSWORD`, and `APP_SESSION_SECRET`.
6. Deploy, then open the app and finish any remaining onboarding from `/setup`.

The dashboard and API are served through the same function so the auth gate protects both.

Vercel Hobby caveat:

- Manual and on-demand syncs work.
- The in-process scheduler is not used on Vercel, so cron-based scheduled syncs are not supported there.

### Render

This repo includes `render.yaml` for a managed Postgres database plus a Node web service.

Provide these secrets in Render:

- `AIRTABLE_API_KEY`
- `WEBFLOW_API_TOKEN`
- `APP_PASSWORD`
- `APP_SESSION_SECRET`

Optional:

- `APP_AUTOMATION_TOKEN`
- `PGSSLMODE`
- `PG_POOL_SIZE`
- `LOG_LEVEL`

`DATABASE_URL` is sourced from the managed Render PostgreSQL instance in the template.

## Airtable automation

If you want Airtable Automations to trigger record-level Airtable-to-Webflow syncs, configure `APP_AUTOMATION_TOKEN` in your deployment and use a separate value from the dashboard password.

Use this pattern in Airtable Automations:

```js
const CONNECTION_ID = "your-connection-id";
const CMS_BRIDGE_URL = "https://your-public-deployment.example.com";
const CMS_BRIDGE_AUTOMATION_TOKEN = "your-automation-token";

const { recordId } = input.config();
if (!recordId) {
  throw new Error("recordId is missing. Map the Airtable trigger record ID into the script input.");
}

const response = await fetch(`${CMS_BRIDGE_URL}/api/sync/${CONNECTION_ID}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-CMS-Bridge-Automation-Token": CMS_BRIDGE_AUTOMATION_TOKEN,
  },
  body: JSON.stringify({
    direction: "airtable_to_webflow",
    recordIds: [recordId],
  }),
});

const body = await response.text();

if (!response.ok) {
  throw new Error(`Sync failed (HTTP ${response.status}): ${body}`);
}

console.log(body);
```

Automation-token rules:

- only `POST /api/sync/:connectionId` accepts the token
- only `direction: "airtable_to_webflow"` is allowed
- `recordIds` must be present and non-empty
- `force` and `dryRun` are rejected for automation-token requests

## Secret hygiene

This repository is intended to be safe to publish, but you still need to keep your own runtime values out of git.

- Never commit `.env`, `.vercel/`, or runtime database files such as `data/*.db*`.
- Run the local secret scan before pushing:

```bash
npm run check:secrets
```

- GitHub Actions also runs the same scan on pushes to `main` and on pull requests.

## Publishing this as a fresh public repo

If you are publishing from a private working repo, create the public GitHub repo from a clean snapshot of the current tree rather than pushing existing history. If any real credential was ever exposed outside ignored local files, rotate it before publication.
