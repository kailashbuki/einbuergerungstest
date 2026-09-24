# Deploy target (resolved)

Orchestrator note — these values are confirmed, not placeholders.

- GitHub user: `kailashbuki`
- Repo: `einbuergerungstest` (public, required for Pages on a free account)
- Vite `base`: `/einbuergerungstest/`
- Live URL: `https://kailashbuki.github.io/einbuergerungstest/`

Base path lives in exactly one exported constant: `src/config/paths.ts` (`BASE_PATH`),
consumed by `vite.config.ts` and the router. Do not hardcode it anywhere else.

Firebase remains an unresolved placeholder and still needs the user.
Before Google sign-in works in production, `https://kailashbuki.github.io`
must be added to Firebase Authentication -> Settings -> Authorized domains.
