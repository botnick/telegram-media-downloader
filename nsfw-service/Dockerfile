FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
# CPU-only torch first: the default PyPI wheel on x86_64 bundles several GB
# of CUDA libraries that this CPU image never uses. requirements.txt then
# finds torch already satisfied.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt

COPY main.py .

ENV TGDL_NSFW_HOST=0.0.0.0
ENV TGDL_NSFW_PORT=8012

EXPOSE 8012

# The model downloads on first start, so give it time before counting failures.
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('TGDL_NSFW_PORT', '8012'), timeout=4)"

CMD ["python", "main.py"]
