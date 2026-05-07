FROM python:3.11-slim

# ffmpeg is required for audio conversion
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cache directory — mount a persistent volume here on Render
ENV CACHE_DIR=/data/cache
RUN mkdir -p /data/cache

EXPOSE 8000

CMD ["gunicorn", "server:app", "--bind", "0.0.0.0:8000", "--workers", "1", "--timeout", "600", "--keep-alive", "5"]
