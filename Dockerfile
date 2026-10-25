# One image: the website (Next.js, standalone), the API and the scan worker.
# The website listens on the host's PORT; the API only on 127.0.0.1 inside the container.

FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build && cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/

FROM python:3.11-slim
COPY --from=web /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY pyproject.toml README.md ./
COPY core ./core
COPY api ./api
COPY mcp_server ./mcp_server
COPY evals ./evals
COPY data ./data
COPY tests ./tests
RUN pip install --no-cache-dir ".[gee]"
COPY --from=web /web/.next/standalone ./web

ENV DATABASE_PATH=/app/data/app.db
ENV RASTER_DIR=/app/data/rasters
# The scan worker runs as a thread in the API (one process, less memory).
ENV RUN_WORKER_IN_API=true
ENV API_URL=http://127.0.0.1:8000
EXPOSE 10000
CMD ["sh", "-c", "uvicorn api.main:app --host 127.0.0.1 --port 8000 & HOSTNAME=0.0.0.0 PORT=${PORT:-10000} exec node web/server.js"]
