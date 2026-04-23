# Deployment

Development and runtime live on different machines. This doc records the exact flow so you don't have to re-derive it each time.

## Hosts

| Role | Machine | User | Path |
|------|---------|------|------|
| Development | `Jims-MacBook-Pro.local` (this laptop) | `jim` | `~/projects/claude-code-hooks-server` |
| Runtime | `macbook-pro-m1-homeserver` (Tailscale) | `jamesschindler` | `~/projects/hooks-server` |

The runtime directory is named `hooks-server`, **not** `claude-code-hooks-server` — it's the same git repo (`Jimbo1167/claude-code-hooks-server`) cloned into a differently-named directory.

## Runtime topology

The container is orchestrated by a separate repo on the home server:

- Compose file: `~/projects/mac-home-server/docker-compose.yml`
- Service name: `claude-hooks`
- Container name: `claude-hooks`
- Build context: `/Users/jamesschindler/projects/hooks-server` (referenced absolutely in the compose file)
- Port: `3003:3003`
- Data volume: `claude-hooks_data` → `/app/data` (SQLite lives here; survives rebuilds)

The laptop reaches the server as `http://macbook-pro-m1-homeserver:3003` via Tailscale MagicDNS. That's the URL every hook in `~/.claude/settings.json` points at.

## Deploy a change

1. On the laptop, commit and push:
   ```bash
   git add -A && git commit -m "..." && git push
   ```
2. On the home server, pull and rebuild the container:
   ```bash
   ssh macbook-pro-m1-homeserver '
     cd ~/projects/hooks-server && git pull &&
     cd ~/projects/mac-home-server && docker compose up -d --build claude-hooks
   '
   ```

The build pulls fresh source via the compose build context, so there's no separate image push step. Data in `claude-hooks_data` is untouched.

## Verify

```bash
curl -s http://macbook-pro-m1-homeserver:3003/api/rules | head -c 200
ssh macbook-pro-m1-homeserver 'docker logs --tail 20 claude-hooks'
```

## Local dev (no Docker)

If you want to iterate without the Docker round-trip, you can run the server directly on the laptop:

```bash
npm run dev   # auto-reload on :3003
```

Then temporarily point `~/.claude/settings.json` hooks at `http://localhost:3003` instead of `http://macbook-pro-m1-homeserver:3003`. Remember to switch back — and note the two instances use separate SQLite databases, so event history won't merge.
