# Web

Next.js frontend. Requests to `/api/*` are proxied to the FastAPI service (`API_URL`, default `http://127.0.0.1:8000`).

```bash
npm install
npm run dev     # http://localhost:3000
npm run lint
npm run build
```

`predev` and `prebuild` copy MapLibre's worker into `public/`, because MapLibre 6 can't find it once Next bundles the library. The copy is git-ignored.
