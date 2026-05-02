# Deploying with Docker Compose

## 1. Create your `.env`

`docker-compose.yml` requires `SESSION_SECRET` to be set externally. The
easiest way is to run the included setup script — it writes a `.env` with
a freshly generated 64-character random secret, and refuses to overwrite
an existing `.env`:

**Linux / macOS / WSL:**
```bash
bash scripts/setup-env.sh
```

**Windows PowerShell:**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-env.ps1
```

If you'd rather do it by hand, copy the template and fill in a real secret:

```bash
cp .env.example .env
# Then edit .env and replace SESSION_SECRET with a long random value, e.g.:
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
