FROM python:3.11-slim

WORKDIR /app
COPY pyproject.toml README.md ./
COPY core ./core
COPY api ./api
COPY mcp_server ./mcp_server
COPY evals ./evals
COPY data ./data
COPY tests ./tests

RUN pip install --no-cache-dir ".[gee]"

ENV DATABASE_PATH=/app/data/app.db
ENV RASTER_DIR=/app/data/rasters
EXPOSE 8000
# The scan worker runs beside the API (restarted if it ever exits; interrupted scans are requeued),
# and the API listens on the host's PORT (Render sets it) or 8000.
CMD ["sh", "-c", "(while true; do python -m api.worker; sleep 5; done) & exec uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
