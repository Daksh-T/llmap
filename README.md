# Locating Legacies Atlas

An editorial map page for the Locating Slavery's Legacies project, powered by the public Omeka API at `locatinglegacies.org`.

## Local development

```bash
bun run dev
```

This uses `vercel dev`, so local development mirrors the Vercel deployment shape:

- `index.html` for the static page
- `public/` for static assets
- `api/legacies.ts` for the serverless data endpoint

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
