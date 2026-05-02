# Deploying with Docker Compose

## 1. (Optional) Provide your own `SESSION_SECRET`

You can skip this step. By default the container's entrypoint generates a
cryptographically strong 64-character `SESSION_SECRET` on first boot and
persists it inside the `app-state` Docker volume
(`/app/state/session_secret`), so it survives restarts and rebuilds.

If you'd rather manage the secret yourself (e.g. to share it across
multiple replicas or store it in a secrets manager), create a `.env` file
next to `docker-compose.yml`:

**Using the helper scripts:**

```bash
bash scripts/setup-env.sh                                          # Linux / macOS / WSL
powershell -ExecutionPolicy Bypass -File scripts\setup-env.ps1     # Windows
```

**Or by hand:**

```bash
cp .env.example .env
# Then edit .env and replace SESSION_SECRET with a long random value:
#   SESSION_SECRET=$(openssl rand -hex 32)
```

Docker Compose automatically loads `.env` from the directory you run
`docker compose` in, so no extra flags are needed.

## 2. Build and start

```bash
docker compose up -d --build
```

The app listens on:

- `http://<host>/` — plain HTTP (used until you import a TLS certificate)
- `https://<host>/` — once a cert has been imported via
  **Settings → HTTPS Management** in the web UI

## 3. First login

Default seed admin (change the password immediately in **Settings → Users**):

- username: `admin`
- password: `admin`

## Troubleshooting

**`required variable SESSION_SECRET is missing a value`**
You did not create a `.env` file (or it lives in a different directory than
the one you ran `docker compose` from). Run `cp .env.example .env`, edit it,
and re-run `docker compose up -d`.

**`SESSION_SECRET must be at least 32 characters`**
The value in `.env` is too short or matches a known placeholder
(`change-me`, `dev-secret-change-me`, etc). Replace it with the output of
`openssl rand -hex 32`.
