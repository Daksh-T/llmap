# Locating Legacies Atlas

An editorial map page for the Locating Slavery's Legacies project, powered by the public Omeka API at `locatinglegacies.org`.

## Local development

```bash
bun run dev
```

This uses the local Bun server in `dev.ts`, which mirrors the Vercel routing shape without invoking `vercel dev` recursively:

- `index.html` for the static page
- `public/` for static assets
- `api/legacies.ts` for the serverless data endpoint

If you specifically want to boot the Vercel CLI locally, use:

```bash
bun run dev:vercel
```

## Deployment

The project is structured for Vercel:

- `vercel.json` enables the Bun runtime
- `/api/legacies` fetches and normalizes live memorial data
- the function returns cache headers for Vercel's CDN

Deploy commands:

```bash
bun run deploy
bun run deploy:prod
```
