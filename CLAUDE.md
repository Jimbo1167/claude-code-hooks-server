# Agent onboarding

## Which host am I on?

Before doing anything involving deploy, git, or running the server, read `.host-role` at the repo root. Its content determines what this checkout is for:

- `dev` — This is the developer laptop. Edit code here, commit, push. **Do not** try to rebuild or restart the container here; this machine does not run the hooks server.
- `runtime` — This is the home server (`macbook-pro-m1-homeserver`) where the `claude-hooks` Docker container actually runs. Pull and rebuild here, but **do not** author changes here — they'll be lost or drift from the dev checkout.

If `.host-role` is missing, stop and ask the user which host this is, then create the file with the appropriate value. Don't guess from hostname — the two machines have similar names.

Full topology and deploy commands live in `docs/deployment.md`.
