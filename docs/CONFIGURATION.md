# CONFIGURATION

This document lists SplitPro environment variables and how they are used. The authoritative list is `.env.example`.

## Required variables

### Database

- `POSTGRES_CONTAINER_NAME`: Docker container name used in compose setups.
- `POSTGRES_USER`: Database user.
- `POSTGRES_PASSWORD`: Database password.
- `POSTGRES_DB`: Database name.
- `POSTGRES_PORT`: Database port.
- `DATABASE_URL`: Full connection string used by the app.

`POSTGRES_USER` may be a regular (non-superuser) role when `pg_cron` is preinstalled. See [docker/README.md](../docker/README.md).

#### External PostgreSQL prerequisites (pg_cron)

If SplitPro connects to an external/managed PostgreSQL instance, make sure your database administrator enables `pg_cron` on the PostgreSQL server before first startup.

1. Set PostgreSQL server settings (same values used in [`docker/prod/compose.yml`](../docker/prod/compose.yml)):

   ```conf
   shared_preload_libraries = 'pg_cron'
   cron.database_name = '<your_splitpro_db>'
   cron.timezone = 'UTC'
   ```

   Restart PostgreSQL after changing these settings.

2. Connect to the SplitPro database as a superuser/admin and install + grant `pg_cron` access:

   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_cron;
   GRANT USAGE ON SCHEMA cron TO <app_user>;
   GRANT SELECT, UPDATE, REFERENCES ON cron.job TO <app_user>;
   GRANT SELECT ON cron.job_run_details TO <app_user>;
   ```

3. Verify setup:

   ```sql
   SHOW shared_preload_libraries;
   SHOW cron.database_name;
   SHOW cron.timezone;
   SELECT extname FROM pg_extension WHERE extname = 'pg_cron';
   ```

SplitPro can then run with a regular (non-superuser) `POSTGRES_USER`. The `UPDATE`
permission on `cron.job` is needed for schedule migration and the row locks used by
startup reconciliation. pg_cron's row-level security scopes jobs to their owner.

If your deployment sits behind a NAT/firewall/proxy that can silently drop idle TCP connections (leaving the pool with dead sockets that hang instead of erroring), add `connect_timeout` and `socket_timeout` (seconds) to `DATABASE_URL` so Prisma gives up on a stale connection instead of hanging indefinitely - e.g. `?connect_timeout=5&socket_timeout=5`. `/api/readyz`'s own query timeout only bounds queries that reach Postgres; it can't help if the socket itself is dead. See [docker/README.md#health-checks](../docker/README.md#health-checks) for `/api/healthz`/`/api/readyz` details and example probe configuration.

### Authentication (NextAuth)

- `NEXTAUTH_SECRET`: Secret used to sign tokens. Generate with `openssl rand -base64 32`.
- `NEXTAUTH_URL`: Canonical app URL (used for callbacks and absolute URLs).
- `NEXTAUTH_URL_INTERNAL`: Optional internal URL for server-side calls when the app cannot reach `NEXTAUTH_URL`.

At least one provider must be configured. SplitPro does not support username/password.

### App behavior

- `DEFAULT_HOMEPAGE`: Sets the landing page route, e.g. `/home` or `/balances`.
- `ENABLE_USER_DISCOVERY`: Default `false`. Show an “Other users” section in the expense participant picker, including hidden friends and users without shared expenses. Excludes yourself and deleted accounts. Enable for private instances where all users may discover each other; this does not add friends to the balance dashboard.
- `ENABLE_SENDING_INVITES`: Enable email invites (requires SMTP config).
- `DISABLE_EMAIL_SIGNUP`: Disable email magic-link signup for new users.
- `DISABLE_EMAIL_LOGIN`: Default `false`. Disable email magic-link/OTP login entirely, even when SMTP is configured (for example only to send invites). Use it when an SSO/OAuth provider must be the only way to sign in: `DISABLE_EMAIL_SIGNUP` alone does not prevent invited users from signing in with a magic link, because inviting someone creates their account.
- `UPLOAD_MAX_FILE_SIZE_MB`: Maximum receipt upload size in MB. Used by both client-side pre-check and server-side upload limit. This is also the max size target for image compression, so increase it if you see bad resolution/quality. Default: `10`.

## Optional variables

### Recurring expenses (pg_cron)

See [Recurring transactions](RECURRING_TRANSACTIONS.md) for configuration and deployment instructions.

### Cache cleanup (pg_cron)

- `CLEAR_CACHE_CRON_RULE`: Cron rule for cache cleanup jobs in database `cron.timezone` (UTC by default).
- `CACHE_RETENTION_INTERVAL`: Postgres interval string that defines how long cached data can remain unused.

For time-zone behavior, see [Recurring transactions](RECURRING_TRANSACTIONS.md).
Standard cron ranges, lists and steps are supported; see the
[pg_cron documentation](https://github.com/citusdata/pg_cron#cron-syntax).

### SMTP (email provider)

Used for magic-link login and invites.

- `FROM_EMAIL`: Sender address.
- `EMAIL_SERVER_HOST`: SMTP host.
- `EMAIL_SERVER_PORT`: SMTP port.
- `EMAIL_SERVER_USER`: SMTP user.
- `EMAIL_SERVER_PASSWORD`: SMTP password.
- `EMAIL_TLS_REJECT_UNAUTHORIZED`: Validates TLS certificates by default. Set it to 0 if you have a relay that needs it (Proton Bridge, Postfix, etc.)

### Bank integrations

#### Plaid (recommended)

- `PLAID_CLIENT_ID`: Plaid client id.
- `PLAID_SECRET`: Plaid secret.
- `PLAID_ENVIRONMENT`: `sandbox`, `development`, or `production`.
- `PLAID_COUNTRY_CODES`: Country codes list (per Plaid docs).
- `PLAID_INTERVAL_IN_DAYS`: Lookback window for fetching transactions (default 30 days).

#### GoCardless (deprecated)

- `GOCARDLESS_COUNTRY`
- `GOCARDLESS_SECRET_ID`
- `GOCARDLESS_SECRET_KEY`
- `GOCARDLESS_INTERVAL_IN_DAYS`

### OAuth providers

#### Shared OAuth settings

- `OAUTH_AUTO_REDIRECT`: Optional flag. When set to `true`, the sign-in page automatically redirects when exactly one OAuth provider is configured and no other authentication providers are enabled. This applies to Google, Authentik, Keycloak, and generic OIDC.

#### Google

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

#### Authentik

- `AUTHENTIK_ID`
- `AUTHENTIK_SECRET`
- `AUTHENTIK_ISSUER`: Must include the application slug, no trailing slash.

#### Authentik invitations

Optional. When SplitPro uses Authentik as its only login method, friend invites can create the
access in Authentik instead of relying on email login. It is enabled when `ENABLE_SENDING_INVITES=true`
and all the variables below are set (SMTP is still required to send the emails). Setting only some
of them is treated as a configuration error: invites fail instead of falling back to the default ones.

- `AUTHENTIK_URL`: Base URL of Authentik, e.g. `https://auth.example.com` (not the issuer URL).
- `AUTHENTIK_TOKEN`: API token of a dedicated service account. It is only used server-side and never logged.
- `AUTHENTIK_GROUP`: Name of the group that grants access to the SplitPro application (exact name, case-sensitive).
- `AUTHENTIK_ENROLLMENT_FLOW_SLUG`: Slug of an enrollment flow with an Invitation stage.
- `AUTHENTIK_APP_SLUG`: Slug of the SplitPro application in Authentik. New users are sent to `/application/launch/<slug>/` after enrolling.
- `AUTHENTIK_INVITE_EXPIRY_DAYS`: Days before an unused invitation expires. Default `7`.

When someone is invited by email, SplitPro looks the address up in Authentik:

| Authentik state                   | What SplitPro does                                               |
| --------------------------------- | ---------------------------------------------------------------- |
| User exists, not in the group     | Adds the user to `AUTHENTIK_GROUP` and emails a link to SplitPro |
| User exists, already in the group | Emails a link to SplitPro                                        |
| No user with that email           | Creates a single-use invitation and emails the enrollment link   |

In every case the placeholder SplitPro user is created as usual and is linked on the first Authentik
login through the email address. If Authentik is unreachable or returns an error, the person is not
invited and the UI shows an error. Combine this with `DISABLE_EMAIL_LOGIN=true` so that the SMTP
configuration does not enable magic-link login.

Invitations are created as `splitpro-<random>` (visible in _Directory → Invitations_) with these
custom attributes (`fixed_data`):

```yaml
email: friend@example.com
groups_to_add:
  - SplitPro
```

The enrollment flow must use them:

- The Invitation stage must have "Continue flow without invitation" disabled.
- A Prompt stage with a field whose key is `email` is pre-filled with the invited address (make it read-only if users must not change it).
- `groups_to_add` must be applied by your flow (for example with the expression policy or User Write stage configuration you already use for manual invitations).
- End the flow with a User Login stage, so that the `next` redirect opens SplitPro directly.

Minimum permissions for the service account (create a service account, a role with these
permissions, a group with that role containing the service account, then an API token for it):

- `Can add Invitation` (global): create invitations.
- `Can view User` (global): look users up by email.
- `Can view Group` (global): find the group by name. Listing groups needs the global permission; an object permission on the group is not enough.
- `Can add user to group`: assign it as an **object permission on the SplitPro group only** (_Directory → Groups → SplitPro → Permissions_), not globally, so the service account can only add people to that group.
- Optional: `Can view Flow`. Without it, invitations are not bound to the enrollment flow and are valid for any flow with an Invitation stage.

#### Keycloak

- `KEYCLOAK_ID`
- `KEYCLOAK_SECRET`
- `KEYCLOAK_ISSUER`: Must include the realm, e.g. `https://keycloak/realms/My_Realm`.

#### Generic OIDC

- `OIDC_NAME`: Lowercase provider name (used for IDs and icons).
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET`
- `OIDC_WELL_KNOWN_URL`: OpenID well-known discovery URL.
- `OIDC_ALLOW_DANGEROUS_EMAIL_LINKING`: Optional flag to allow email-based account linking.

### Web push notifications

Push notifications are disabled until VAPID keys are configured. Without them, the in-app notification toggle has no effect.

To enable push notifications:

1. Generate a VAPID keypair, either with `npx web-push generate-vapid-keys --json` or the online tool at https://vapidkeys.com
2. Set these env vars in `.env`:
   - `WEB_PUSH_PUBLIC_KEY` — generated public key
   - `WEB_PUSH_PRIVATE_KEY` — generated private key
   - `WEB_PUSH_EMAIL` — contact email as a bare address (e.g. `you@example.com`); the app prepends `mailto:` automatically
3. Redeploy or restart your container.
4. If you previously toggled notifications off in the PWA or system settings, re-enable them after redeploying.

### Feedback email

- `FEEDBACK_EMAIL`

### Currency conversions

- `CURRENCY_RATE_PROVIDER`: `frankfurter`, `openexchangerates`, or `nbp`.
- `OPEN_EXCHANGE_RATES_APP_ID`: Required if using Open Exchange Rates.

## Minimal examples

### Email-only auth

```bash
DATABASE_URL="postgresql://postgres:strong-password@localhost:5432/splitpro"
NEXTAUTH_SECRET="<generated>"
NEXTAUTH_URL="https://splitpro.example.com"
FROM_EMAIL="SplitPro <no-reply@example.com>"
EMAIL_SERVER_HOST="smtp.example.com"
EMAIL_SERVER_PORT="587"
EMAIL_SERVER_USER="smtp-user"
EMAIL_SERVER_PASSWORD="smtp-password"
```

### Google OAuth

```bash
DATABASE_URL="postgresql://postgres:strong-password@localhost:5432/splitpro"
NEXTAUTH_SECRET="<generated>"
NEXTAUTH_URL="https://splitpro.example.com"
GOOGLE_CLIENT_ID="<client-id>"
GOOGLE_CLIENT_SECRET="<client-secret>"
```

### OIDC (Keycloak)

```bash
DATABASE_URL="postgresql://postgres:strong-password@localhost:5432/splitpro"
NEXTAUTH_SECRET="<generated>"
NEXTAUTH_URL="https://splitpro.example.com"
OIDC_NAME="keycloak"
OIDC_CLIENT_ID="<client-id>"
OIDC_CLIENT_SECRET="<client-secret>"
OIDC_WELL_KNOWN_URL="https://keycloak.example.com/realms/My_Realm/.well-known/openid-configuration"
```

## Security notes

- Rotate `NEXTAUTH_SECRET` if it is ever exposed.
- Prefer `_FILE` suffix env vars when deploying with Docker secrets (supported for all values).
- in order to lock down your instance, you should configure either your OAuth/ OIDC provider to only allow trusted users, or disable email signups and invites with `DISABLE_EMAIL_SIGNUP=true`.
