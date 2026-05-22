FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

ENV TGDL_NSFW_HOST=0.0.0.0
ENV TGDL_NSFW_PORT=8012

EXPOSE 8012

CMD ["python", "main.py"]
