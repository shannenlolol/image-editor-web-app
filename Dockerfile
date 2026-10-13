FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    U2NET_HOME=/models \
    NUMBA_CACHE_DIR=/tmp/numba

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download the u2netp background-removal model at build time,
# so the container never needs to fetch it at runtime. The download is saved
# readable by root only, so open it up for the unprivileged user below.
RUN python -c "from rembg import new_session; new_session('u2netp')" \
 && chmod -R a+rX /models

COPY app.py .
COPY templates ./templates
COPY static ./static

RUN useradd --create-home --uid 1000 appuser
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4)"

# One worker, because the rate limiter and the 2-removal cap live in memory.
# Four threads, so the page and health check still answer while two removals run.
# --max-requests restarts the worker now and then, which stops onnxruntime's
# memory from slowly growing; jitter avoids a predictable restart.
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "1", "--threads", "4", "--timeout", "120", \
     "--max-requests", "200", "--max-requests-jitter", "50", "app:app"]
