# FastAPI SaaS Starter

A production-oriented FastAPI backend that ships the parts every SaaS product needs on day one: authentication, subscription billing, and an admin back office. It runs fully async on PostgreSQL, Redis, and Celery, and is ready to sit behind a dashboard or an API-first client.

<p>
  <img alt="Python" src="https://img.shields.io/badge/Python-3.12+-3776AB?logo=python&logoColor=white">
  <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-0.121-009688?logo=fastapi&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white">
  <img alt="Celery" src="https://img.shields.io/badge/Celery-5.5-37814A?logo=celery&logoColor=white">
  <img alt="Stripe" src="https://img.shields.io/badge/Stripe-14.0-635BFF?logo=stripe&logoColor=white">
</p>

---

## Contents

- [Highlights](#highlights)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Running the Stack](#running-the-stack)
- [Docker](#docker)
- [API Reference](#api-reference)
- [Testing](#testing)
- [Continuous Integration](#continuous-integration)
- [Production Checklist](#production-checklist)
- [Further Documentation](#further-documentation)

---

## Highlights

### Authentication
- Email/password registration and login with Argon2 hashing.
- Email verification, password reset, and authenticated password change.
- Passwordless OTP login codes delivered by email (single-use, 15-minute expiry).
- Social login for Google and GitHub with OAuth state validation and account auto-provisioning.
- JWT access tokens plus refresh-token rotation, database-backed JTI tracking, and httpOnly cookies.
- Account deactivation endpoint.

### Billing
- Plan management: create, read, update, and soft-delete with Stripe product/price synchronisation.
- Stripe Checkout for new subscriptions and plan upgrades.
- Cancel-at-period-end with access-window enforcement.
- Webhook handling for checkout completion, invoice success/failure, and subscription deletion.
- Payment records written on successful invoices, with subscription notification emails queued through Celery.

### Admin Back Office
- Dashboard statistics endpoint aggregating users, subscriptions, and payments.
- User administration: filtered listings, detail views, and per-user transaction and subscription history.
- Privileged mutations — activate/deactivate, grant/revoke admin role, manual verification — gated by an `admin_required` dependency.
- Audit trail (`admin_audit_logs`) recording the acting admin, target, action, and before/after JSON snapshots.
- Billing oversight across all accounts: transactions and subscriptions, individually or paginated.

### AI Assistant
- Natural-language admin queries through an OpenAI-compatible client (Groq by default).
- Tool-calling loop exposing schema introspection (`get_view_columns`) and guarded query execution (`execute_sql`).
- SQL guard rails: `SELECT`/`WITH` statements only, a blocked DDL/DML keyword set, comment stripping, and enum literal normalisation.
- Three execution modes — `count`, `preview`, and `csv` — where CSV results are written to `storage/exports` and returned as a download link instead of inline rows.

### Platform
- Structured request logging with per-request timing and status-aware log levels.
- Rate limiting via slowapi, backed by Redis.
- Consistent validation error responses through a custom exception handler.
- Alembic migrations, Docker Compose orchestration, and a PR-gated CI pipeline.

---

## Architecture

The codebase is organised by **domain module** rather than by technical layer. Each of `auth`, `billing`, and `admin` owns its own router, schemas, service, repository, models, dependencies, and configuration.

```
Request → Router → Dependencies (auth, DI) → Service (business rules) → Repository (data access) → Database
                                                   │
                                                   ├── Stripe gateway (billing)
                                                   ├── FastAPI-Mail (transactional email)
                                                   └── Celery (background jobs)
```

- **Routers** stay thin: parse input, delegate, return schemas.
- **Services** hold business rules and orchestrate side effects.
- **Repositories** encapsulate all SQLAlchemy access.
- **Settings** are split into focused `BaseSettings` classes under `src/settings/`, composed into a single `Settings` object in `src/config.py`.
- Async SQLAlchemy 2.0 + asyncpg serves the API; a sync engine (`SYNC_DATABASE_URL`) backs Celery tasks.

---

## Project Structure

```text
.
├── .github/workflows/          # CI pipeline
├── alembic/                    # Migration environment and versions
├── requirements/               # Runtime and development pins
├── src/
│   ├── admin/                  # Back office, audit log, AI assistant
│   │   ├── ai_repo.py          # Schema introspection and SQL execution
│   │   ├── ai_settings.py      # AI client factory
│   │   ├── ai_utils.py         # SQL sanitisation and CSV export
│   │   ├── ai_vars.py          # Tool definitions and system prompt
│   │   ├── models.py           # AdminAuditLog
│   │   ├── repository.py
│   │   ├── router.py
│   │   ├── schemas.py
│   │   └── services.py
│   ├── auth/                   # Registration, login, OAuth, OTP, tokens
│   ├── billing/                # Plans, subscriptions, payments, Stripe
│   ├── common/                 # Shared enums
│   ├── settings/               # App, database, mail, redis, celery, stripe
│   ├── auth_bearer.py          # Bearer scheme and admin_required guard
│   ├── celery_app.py           # Worker and beat applications
│   ├── config.py               # Composed settings object
│   ├── database.py             # Async/sync engines and session factories
│   ├── hashing.py              # Argon2 helpers
│   ├── jwt.py                  # Token encode/decode
│   ├── logging.py              # Loguru configuration
│   ├── main.py                 # Application, middleware, router wiring
│   ├── paginate.py             # Shared pagination helper
│   └── rate_limiter.py         # slowapi limiter
├── templates/email/            # Jinja email templates
├── tests/                      # Pytest suites for auth and billing
├── Dockerfile
├── docker-compose.yml
├── alembic.ini
└── pytest.ini
```

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | Python 3.12+ |
| Web framework | FastAPI, Starlette, Uvicorn |
| Validation | Pydantic v2, pydantic-settings |
| Database | PostgreSQL 16, SQLAlchemy 2.0 (async), asyncpg, psycopg, Alembic |
| Auth | python-jose (JWT), passlib with Argon2 |
| Payments | Stripe Python SDK |
| Background jobs | Celery 5.5 (worker and beat), Redis |
| Email | FastAPI-Mail, aiosmtplib, Jinja2 templates |
| AI | OpenAI SDK against an OpenAI-compatible endpoint (Groq) |
| Observability | Loguru, slowapi rate limiting |
| Testing | pytest, pytest-asyncio, httpx ASGI transport |

---

## Getting Started

### Prerequisites

| Requirement | Notes |
| --- | --- |
| Python 3.12+ | Required by the dependency pins |
| PostgreSQL | Three databases: application, Celery (sync URL), and tests |
| Redis 7+ | Rate limiting and Celery broker/backend |
| Stripe account | Publishable key, secret key, webhook signing secret |
| SMTP credentials | Transactional email delivery |
| Google and GitHub OAuth apps | Social login |
| Groq API key | AI admin assistant, or another OpenAI-compatible provider |
| Docker (optional) | Local orchestration via Compose |

### Installation

1. **Create and activate a virtual environment**

   ```bash
   python -m venv .venv
   source .venv/bin/activate        # Linux / macOS
   .\.venv\Scripts\activate         # Windows
   ```

2. **Install dependencies**

   ```bash
   pip install -r requirements/requirements.txt
   ```

   Development-only pins live in `requirements/devlopment.txt`.

3. **Configure the environment**

   ```bash
   cp .env.example .env
   ```

   Fill in every value described in [Configuration](#configuration).

4. **Create the databases** referenced by `DATABASE_URL`, `SYNC_DATABASE_URL`, and `TEST_DATABASE_URL`.

5. **Apply migrations**

   ```bash
   alembic upgrade head
   ```

---

## Configuration

All settings are loaded from `.env` through `src/config.py`. Every variable below is required unless a default is listed.

### Application

| Variable | Description | Default |
| --- | --- | --- |
| `APP_NAME` | Display name used in emails and logs | `FastAPI Auth System` |
| `APP_ENV` | Environment label (`development`, `test`, `production`) | `development` |
| `APP_DEBUG` | Enables debug behaviour | `True` |
| `APP_URL` | Public base URL used to build email and OAuth links | — |

### Database

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Async DSN, e.g. `postgresql+asyncpg://user:pass@host:5432/db` |
| `SYNC_DATABASE_URL` | Sync DSN used by Celery tasks, e.g. `postgresql+psycopg://user:pass@host:5432/db` |
| `TEST_DATABASE_URL` | Dedicated database for the test suite |

> `SYNC_DATABASE_URL` is required by `src/settings/database.py` but is not present in `.env.example` — add it manually.

### JWT

| Variable | Description | Default |
| --- | --- | --- |
| `ALGORITHM` | Signing algorithm | `HS256` |
| `ACCESS_SECRET_KEY` | Access token secret | — |
| `ACCESS_TOKEN_EXPIRE` | Access token lifetime in seconds | `900` |
| `REFRESH_SECRET_KEY` | Refresh token secret | — |
| `REFRESH_TOKEN_EXPIRE` | Refresh token lifetime in seconds | `2592000` |
| `VALIDATION_SECRET_KEY` | Secret for verification and reset tokens | — |
| `VALIDATION_TOKEN_EXPIRE` | Validation token lifetime in seconds | `900` |

Generate secrets with `python -c "import secrets; print(secrets.token_urlsafe(64))"` and use a distinct value for each.

### Mail

| Variable | Description |
| --- | --- |
| `SMTP_HOST`, `SMTP_PORT` | SMTP server and port |
| `SMTP_USER`, `SMTP_PASSWORD` | SMTP credentials |

### OAuth

| Provider | Variables |
| --- | --- |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `GOOGLE_USERINFO_URL` |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI`, `GITHUB_AUTHORIZE_URL`, `GITHUB_TOKEN_URL`, `GITHUB_USER_API`, `GITHUB_EMAILS` |

Redirect URIs must match the callback routes: `/auth/social/callback/google` and `/auth/social/callback/github`.

### Infrastructure

| Variable | Description |
| --- | --- |
| `REDIS_URL` | Redis connection URL used by the rate limiter |
| `CELERY_WORKER_URL` | Celery broker URL |
| `CELERY_BEAT_URL` | Celery result/beat backend URL |

### Stripe

| Variable | Description |
| --- | --- |
| `STRIPE_PUBLIC_KEY` | Publishable key |
| `STRIPE_SECRET_KEY` | Secret key |
| `STRIPE_WEBHOOK_SECRET` | Signing secret used to verify webhook payloads |

### AI Assistant

| Variable | Description | Default |
| --- | --- | --- |
| `AI_PROVIDER` | Provider identifier; currently `groq` | `groq` |
| `GROQ_API_KEY` | API key for the provider | — |
| `GROQ_BASE_URL` | OpenAI-compatible base URL | — |
| `AI_MODEL` | Model identifier | `openai/gpt-oss-120b` |

---

## Running the Stack

Start PostgreSQL and Redis, then run each process in its own shell.

**API**

```bash
uvicorn src.main:app --reload
```

Interactive documentation is served at `http://localhost:8000/docs`.

**Celery worker**

```bash
celery -A src.celery_app.celery_app worker --loglevel=info
```

**Celery beat**

```bash
celery -A src.celery_app.beat_app beat --loglevel=info
```

Point `SMTP_*` at a sandbox such as Mailtrap or MailHog during development so verification, reset, OTP, and subscription emails are captured rather than delivered.

To exercise Stripe webhooks locally:

```bash
stripe listen --forward-to localhost:8000/billing/stripe/webhook
```

---

## Docker

```bash
docker-compose up --build
```

| Service | Description | Port |
| --- | --- | --- |
| `api` | FastAPI application | `8000` |
| `db` | PostgreSQL 16 | `5432` |
| `redis` | Redis 7 broker and rate-limit store | `6379` |
| `pgadmin` | Database UI | `5050` |
| `celery` | Background worker | — |
| `celery_beat` | Periodic task scheduler | — |

Compose reads configuration from `.env`. Once the containers are healthy, apply migrations with `docker-compose exec api alembic upgrade head`.

---

## API Reference

### Authentication

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/register` | Create an account and send a verification email |
| `POST` | `/login` | Authenticate and issue access and refresh tokens |
| `POST` | `/refresh-token` | Rotate the refresh token and mint a new access token |
| `GET` | `/verify` | Confirm an email address from a token link |
| `POST` | `/request/verify` | Re-send the verification email |
| `POST` | `/forget-password` | Send a password reset link |
| `POST` | `/new-password` | Set a new password using a reset token |
| `POST` | `/change-password` | Change the password of the current user |
| `POST` | `/request/login-code` | Email a single-use OTP login code |
| `POST` | `/login/code` | Exchange an OTP code for a session |
| `GET` | `/google/login` | Begin the Google OAuth flow |
| `GET` | `/auth/social/callback/google` | Google OAuth callback |
| `GET` | `/github/login` | Begin the GitHub OAuth flow |
| `GET` | `/auth/social/callback/github` | GitHub OAuth callback |
| `POST` | `/deactivate` | Deactivate the current account |

### Billing

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/billing/plans` | List available plans |
| `POST` | `/billing/plans` | Create a plan and sync it to Stripe |
| `GET` | `/billing/plans/{plan_id}` | Retrieve a plan |
| `PATCH` | `/billing/plans/{plan_id}` | Update a plan |
| `DELETE` | `/billing/plans/{plan_id}` | Soft-delete a plan |
| `GET` | `/billing/subscriptions/me` | Current user's subscription |
| `POST` | `/billing/subscriptions/subscribe` | Create a Stripe Checkout session |
| `POST` | `/billing/subscriptions/upgrade` | Upgrade to a higher tier |
| `POST` | `/billing/subscriptions/cancel` | Cancel at period end |
| `GET` | `/billing/payments/me` | Current user's payment history |
| `POST` | `/billing/stripe/webhook` | Signed Stripe webhook receiver |

### Administration

Mutating admin routes require the admin role and are recorded in the audit log.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/dashboard/stats` | Aggregate platform statistics |
| `GET` | `/users` | List users with filtering and pagination |
| `GET` | `/users/{user_id}` | User detail |
| `GET` | `/users/{user_id}/transactions` | Payments for a user |
| `GET` | `/users/{user_id}/subscriptions` | Subscriptions for a user |
| `PATCH` | `/users/{user_id}/status` | Activate or deactivate a user |
| `PATCH` | `/users/{user_id}/role` | Grant or revoke admin rights |
| `PATCH` | `/users/{user_id}/verify` | Manually verify a user |
| `GET` | `/billing/transactions` | All payments, paginated |
| `GET` | `/billing/transactions/{payment_id}` | Payment detail |
| `GET` | `/billing/subscriptions` | All subscriptions, paginated |
| `GET` | `/billing/subscriptions/{sub_id}` | Subscription detail |
| `POST` | `/ai/chat` | Natural-language query over admin data |

---

## Testing

1. Point `TEST_DATABASE_URL` at a dedicated database — the suite creates and drops its own schema.
2. Run the suite:

   ```bash
   pytest
   ```

   Target a module or a single test with `pytest tests/billing` or `pytest tests/auth/api_test.py::test_login`.

Fixtures create the schema per session, disable the rate limiter, and drive the app through an httpx ASGI client. `pytest.ini` sets `asyncio_mode = auto`, so async tests need no decorator. Mock Stripe and email transports in new tests so no external calls are made.

---

## Continuous Integration

`.github/workflows/ci.yml` runs on every non-draft pull request into `main`. It provisions a PostgreSQL service container, installs the pinned requirements on Python 3.12, generates a `.env` from `.env.example`, and executes the test suite. Concurrent runs on the same ref are cancelled automatically.

---

## Production Checklist

- Set `APP_DEBUG=False` and `APP_ENV=production`.
- Replace the development CORS origins in `src/main.py` with your real front-end origins.
- Set `secure=True` on the refresh-token cookie in the auth router and serve exclusively over HTTPS.
- Terminate TLS at a reverse proxy such as Nginx or Caddy in front of Uvicorn or Gunicorn workers.
- Rotate every JWT secret and use distinct values per environment.
- Expose the Stripe webhook URL publicly and verify signatures with `STRIPE_WEBHOOK_SECRET`.
- Supervise the worker and beat processes with systemd, supervisor, or a container orchestrator.
- Run `alembic upgrade head` as part of deployment rather than at application start-up.
- Ship logs to a central collector and tune the slowapi limits for expected traffic.
- Back the `storage/exports` directory with durable storage, or redirect AI CSV exports to object storage.

---

## Further Documentation

| Document | Contents |
| --- | --- |
| [features.md](features.md) | Detailed feature breakdown |
| [docs.md](docs.md) | Endpoint and flow documentation |
| [example.md](example.md) | Request and response examples |
