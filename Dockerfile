FROM python:3.11-slim

WORKDIR /app
COPY pyproject.toml README.md ./
COPY core ./core
COPY api ./api
COPY mcp_server ./mcp_server
COPY evals ./evals
COPY data ./data
COPY tests ./tests

RUN pip install --no-cache-dir .

ENV DATABASE_PATH=/app/data/app.db
ENV RASTER_DIR=/app/data/rasters
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
