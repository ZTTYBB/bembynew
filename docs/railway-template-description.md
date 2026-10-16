# Deploy and Host Bemby on Railway

Bemby is a self-hosted automation tool for managing daily Telegram bot check-ins and Emby video watch sessions. It includes a web admin portal supporting multiple accounts, a built-in task scheduler, real-time logs, AI-assisted button recognition, and Telegram notifications.

## About Hosting Bemby

Hosting Bemby involves running a persistent Node.js/Express server that maintains active Telegram MTProto connections and a background task scheduler. All data is stored in a SQLite database, so a persistent volume is required to survive restarts. A single container serves the backend API, the Vue 3 web portal, and the scheduler together. Railway provisions the container directly from the official Docker Hub image and exposes it on port 3000. You supply an admin username, password, and a JWT secret at deploy time — everything else is handled automatically.

## Common Use Cases

- Automate daily Telegram bot check-ins across multiple accounts on a randomised schedule
- Simulate Emby media server watch sessions to maintain active membership status
- Run multi-step custom Telegram bot workflows with AI-assisted captcha and button recognition

## Dependencies for Bemby Hosting

- A Telegram API ID and API Hash from [my.telegram.org/apps](https://my.telegram.org/apps) — required to add Telegram accounts for check-in tasks
- An Emby server URL and account credentials — required for Emby watch tasks

### Deployment Dependencies

- Container image: [ghcr.io/zttybb/bembynew](https://github.com/ZTTYBB/bembynew/pkgs/container/bembynew)
- Source code: [github.com/ZTTYBB/bembynew](https://github.com/ZTTYBB/bembynew)
- Telegram API credentials: [my.telegram.org/apps](https://my.telegram.org/apps)

### Implementation Details

Three environment variables must be set at deploy time:

```
ADMIN_USERNAME   # Web portal login username
ADMIN_PASSWORD   # Web portal login password
JWT_SECRET       # Random secret for session tokens — generate with: openssl rand -hex 32
BEMBY_DATA_KEY   # Separate random key for encrypting Telegram credentials at rest
```

A persistent volume must be mounted at `/app/data` to retain the SQLite database across restarts.

## Why Deploy Bemby on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Bemby on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
