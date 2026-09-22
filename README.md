# React + Hono Template for Cloudflare Workers

A full-stack template built with React, Hono, Vite, Better Auth, and shadcn/ui. The same platform-neutral Hono app runs on Cloudflare Workers or a regular Node server, while small platform adapters handle runtime-specific dependencies such as D1 vs Postgres, Workers Assets vs Node static serving, and environment variables.

## Features

| Feature | Description |
| --- | --- |
| Same-origin full stack | One origin serves the React SPA and Hono API, so no CORS setup is needed |
| Authentication | Better Auth email/password flow with shared runtime config |
| Shared DTOs | Zod schemas and inferred TypeScript DTOs live in `src/shared/dto` |
| Database adapters | Cloudflare D1 for Workers, Postgres for Node |
| UI foundation | shadcn/ui, Tailwind CSS v4, Geist font, Radix UI, Lucide icons |
| Dual deployment | Cloudflare Workers deployment and Node/Docker deployment scripts |

## Tech Stack

- Frontend: React 19, Vite 8, React Router 7, Tailwind CSS 4, shadcn/ui, SWR
- Backend: Hono 4
- Auth: Better Auth
- Database: Cloudflare D1 on Workers, Postgres on Node
- Shared contracts: Zod DTO schemas under `src/shared/dto`
- Runtime: Cloudflare Workers with `nodejs_compat`, or Node 24+

## Project Structure

```txt
src/
  client/
    app/                 React route components
    components/          App and shadcn/ui components
    hooks/               Client hooks
    lib/                 Client-only helpers
  server/
    entry.cloudflare.ts  Cloudflare Worker entrypoint
    entry.node.ts        Node server entrypoint
    index.ts             Platform-neutral Hono app and API routes
    me.ts                Auth-protected /api/me sub-app
    env.ts               App runtime types
    lib/                 Server-only auth, storage, and data helpers
    platforms/           Runtime factories for Cloudflare and Node
  shared/
    dto/                 Zod schemas and DTO types used by client and server
migrations/
  d1/                    Wrangler SQL migrations for Cloudflare D1
  kysely/postgres/       Kysely TypeScript migrations for Node/Postgres
better-auth.config.ts    Better Auth CLI schema-generation config
kysely.config.ts         Postgres Kysely CLI migration config
wrangler.jsonc           Worker, assets, and D1 configuration
```

## Quick Start

Install dependencies:

```bash
npm install
```

Create local environment files from `.env.example`:

```bash
cp .env.example .dev.vars
cp .env.example .env
```

Use `.dev.vars` for Cloudflare local development and `.env` for Node, Docker, and Postgres migration commands. At minimum, set:

```ini
BETTER_AUTH_SECRET=your-32-plus-character-random-secret
BETTER_AUTH_URL=http://localhost:8787
BETTER_AUTH_ALLOWED_HOSTS=""
```

Generate a secret with:

```bash
openssl rand -base64 32
```

Create a D1 database and update `wrangler.jsonc`:

```bash
npx wrangler d1 create cf-react-hono-template
```

Set the returned `database_id` in `wrangler.jsonc`.

Apply the D1 migrations:

```bash
npm run db:migrate:d1:local
```

The initial D1 migration includes the Better Auth tables.

Start local development:

```bash
npm run dev
```

Open the URL printed by Vite/Wrangler. With the default Cloudflare dev setup this is usually `http://localhost:8787`.

## Routes

- `/` - public landing page
- `/sign-up` - create an account
- `/sign-in` - sign in
- `/dashboard` - protected dashboard
- `/messages` - protected page that calls `/api/messages`

## API

- `GET /api/health` - health check
- `GET /api/messages` - example response validated with `@shared/dto/messages`
- `GET /api/me` - current authenticated user, or 401
- `GET|POST /api/auth/*` - Better Auth endpoints

## Shared DTO Pattern

Shared request and response contracts belong in `src/shared/dto`. Each file should export:

- Zod schemas for runtime validation.
- `z.infer` DTO types for client and server TypeScript use.

For example, `src/shared/dto/messages.ts` defines the `/api/messages` response schema. The server parses the response before returning it, and the client parses the JSON after fetching it. This keeps API contracts visible without duplicating types.

## Database Migrations

This template intentionally keeps D1 and Postgres migrations separate.

- D1 migrations live in `migrations/d1` as plain SQL files and are applied by Wrangler.
- Postgres migrations live in `migrations/kysely/postgres` as Kysely TypeScript files and are applied by `kysely-ctl`.

The split is deliberate. D1 is reached through a Cloudflare Worker binding, the D1 REST API, or Wrangler. Kysely can query D1 from inside a Worker when given `env.DB`, but it cannot directly connect to a remote D1 database from a normal Node migration process in the same way it connects to Postgres. Keeping D1 migrations in Wrangler-compatible SQL avoids exposing a migration HTTP endpoint and keeps Cloudflare deployments aligned with the native D1 tooling.

When a schema change affects both runtimes, add two migrations with matching version numbers and names:

```txt
migrations/
  d1/
    0002_add_widgets.sql
  kysely/
    postgres/
      0002_add_widgets.ts
```

Use D1 migrations for Cloudflare:

```bash
npm run db:migrate:d1:local
npm run db:migrate:d1:remote
```

Use Kysely CLI migrations for Postgres:

```bash
npm run db:migrate:postgres:latest
npm run db:migrate:postgres:status
```

`npm run auth:generate` uses `npx auth@latest` to generate a temporary Better Auth schema SQL file. Treat it as a helper for refreshing or comparing the Better Auth baseline; committed database migrations remain the source of truth.

## Deployment Targets

### Cloudflare Workers

```bash
npm run build:cf
npm run deploy:cf
```

Cloudflare uses:

- `src/server/entry.cloudflare.ts`
- `vite.config.ts`
- `wrangler.jsonc`

Workers Assets serve the SPA with `not_found_handling: "single-page-application"`. Requests matching `/api/*` run through the Worker first.

Production Worker secrets:

```txt
BETTER_AUTH_SECRET
BETTER_AUTH_URL
BETTER_AUTH_ALLOWED_HOSTS
```

### Node

```bash
npm run build:node
npm run start:node
```

Node emits:

```txt
dist/node/entry.node.js
dist/client/
```

Node runtime variables:

```txt
DATABASE_URL
BETTER_AUTH_SECRET
BETTER_AUTH_URL
BETTER_AUTH_ALLOWED_HOSTS
PORT
```

`PORT` is optional and defaults to `3000`.

Docker:

```bash
npm run docker:build
npm run docker:run
```

Before starting the Node target against a fresh Postgres database, run:

```bash
npm run db:migrate:postgres:latest
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Local Cloudflare/Vite development |
| `npm run build` | Default Cloudflare build |
| `npm run build:cf` | Type-check and build for Cloudflare Workers |
| `npm run build:node` | Build client and Node server output |
| `npm run start:node` | Run the built Node server |
| `npm run deploy:cf` | Build and deploy to Cloudflare Workers |
| `npm run auth:generate` | Generate temporary Better Auth schema SQL with `npx auth@latest` |
| `npm run db:migrate:d1:local` | Apply D1 SQL migrations to local Wrangler D1 |
| `npm run db:migrate:d1:remote` | Apply D1 SQL migrations to remote Cloudflare D1 |
| `npm run db:migrate:postgres:latest` | Apply all pending Postgres Kysely migrations |
| `npm run db:migrate:postgres:up` | Apply one pending Postgres Kysely migration |
| `npm run db:migrate:postgres:down` | Roll back one Postgres Kysely migration |
| `npm run db:migrate:postgres:status` | List Postgres Kysely migration status |
| `npm run cf-typegen` | Generate Worker binding types |
| `npm run check` | Type-check, build, and run a Wrangler dry-run deploy |
| `npm run lint` | Run ESLint |

## Extending

- Add shared DTOs under `src/shared/dto` when client and server both need a contract.
- Add API sub-apps under `src/server` and mount them from `src/server/index.ts`.
- Add D1 migrations under `migrations/d1` and matching Postgres migrations under `migrations/kysely/postgres` when a schema change affects both targets.
- Extend auth in `src/server/lib/auth.ts` and keep `better-auth.config.ts` using the same shared options.

### Object Storage

`AppRuntime` includes a `blob` field backed by `UnsupportedObjectStorage` by default. This is an intentional extension point for projects that need file uploads or generated assets.

- On Cloudflare, replace it with an R2-backed implementation in `src/server/platforms/cloudflare.ts`.
- On Node, replace it with an S3-compatible implementation in `src/server/platforms/node.ts`.
- If a project does not need object storage, the `blob` field and `src/server/lib/blob.ts` can be removed.

### Renaming The Template

The template keeps names explicit instead of hiding them behind a generator. After cloning, replace `cf-react-hono-template` in:

- `package.json` package name and Docker image scripts.
- `wrangler.jsonc` Worker name and D1 database name.
- `README.md` examples.
- `index.html` page title.

Then create a new D1 database with the chosen name and set the returned `database_id` in `wrangler.jsonc`.

## License

This project is licensed under the Mozilla Public License 2.0. See [LICENSE](LICENSE).
