# Royalty Claims Portal

This project is a small full-stack MVP for a royalty claims management system.

## Features

- Role-based login for admin, reviewer, and claimant users
- Claim dashboard with summary analytics and filtering
- Claim detail view with supporting document access
- Claim submission with file upload support
- Approve/reject review workflow
- SQLite-backed persistence and JWT-authenticated API

## Local run

```bash
cd "C:\Users\Huybbie\Documents\Royalties claim"
npm install
npm start
```

Then open: <http://localhost:3001>

## Local no-Docker run (recommended)

This project is designed to run directly on your machine without Docker. It uses the existing Node + SQLite setup and is the simplest option for development and local production testing.

```bash
copy .env.example .env
npm install
npm run start:local
```

Then open:

- Admin portal: http://localhost:3001
- Artist portal: http://localhost:8000

## Local PostgreSQL run (no Docker)

If you want to move away from SQLite without using Docker, create a Postgres environment file:

```bash
copy .env.postgres.example .env
```

Then make sure a local PostgreSQL server is running, and update the connection string if needed:

```bash
DB_CLIENT=postgres
DATABASE_URL=postgres://postgres:postgres@localhost:5432/royalties_claim
```

The app will use Postgres instead of SQLite when `DB_CLIENT=postgres` or `DATABASE_URL` is present.

## Vercel deployment

This project can be deployed to Vercel without Docker. For production, use Postgres rather than SQLite because Vercel serverless environments do not support the native SQLite driver reliably.

1. Set your Vercel environment variables:
   - `DATABASE_URL`
   - `JWT_SECRET`
   - `NODE_ENV=production`
   - `ALLOWED_ORIGINS=https://your-project.vercel.app`
2. Run:

```bash
npm install
npm run vercel:deploy
```

The project includes a Vercel configuration in [vercel.json](vercel.json) and a serverless entry in [api/index.js](api/index.js).

## Docker run (optional)

Docker is optional and not required for this project. If you still want a containerized setup on a machine with Docker installed:

```bash
cp .env.docker.example .env.docker
npm run docker:up
```

This starts the app on port 3001 and the artist portal on port 8000, alongside a local PostgreSQL container for deployment-style testing.

## Staging and production environments

Use the environment examples as a starting point:

```bash
cp .env.staging.example .env.staging
cp .env.production.example .env.production
```

The project is already prepared for environment-specific settings such as:

- separate JWT secrets
- distinct app URLs
- managed database connections
- object storage bucket names
- upload and file-size limits

## Database and storage migration path

The current local prototype uses SQLite for development. The app is now configured so you can move the same workflow to a managed Postgres deployment by setting `DATABASE_URL` in a production environment and replacing local storage with cloud-backed uploads.

Recommended production stack:

- Postgres for transactional data
- object storage (S3-compatible bucket) for claim files
- reverse proxy / load balancer for HTTPS and traffic routing
- set `ALLOWED_ORIGINS` for the live admin and artist domains

## CI / deployment pipeline

The repository includes a GitHub Actions workflow at [.github/workflows/ci.yml](.github/workflows/ci.yml) that runs tests and validates the server files on every push or pull request.

## Monitoring and operations

Before public hosting, add:

- uptime checks for the admin and artist portals
- alerting on failed logins, claim review delays, and API 5xx responses
- structured logs for authentication, claim creation, and upload errors
- daily backup checks for Postgres and object storage

## Demo accounts

- Admin: <admin@royaltyhub.com> / admin123
- Reviewer: <reviewer@royaltyhub.com> / reviewer123
- Claimant: <artist@royaltyhub.com> / artist123

## Environment setup

Create a local environment file based on the sample values:

```bash
copy .env.example .env
```

Example values:

- PORT=3001
- JWT_SECRET=replace-with-a-strong-secret
- NODE_ENV=development

## Production notes

- Run with a real secret in production instead of the default JWT value.
- Place the app behind a reverse proxy or hosting service that supports Node.js.
- Store uploads on a persistent volume and adjust file-size limits as needed.
- Ensure the database file and upload directory are writable in the deployed environment.

## Project idea

This prototype demonstrates a royalty claim workflow for a music rights or royalty management system, with artists, submission status tracking, review actions, and a dashboard for operational oversight.
