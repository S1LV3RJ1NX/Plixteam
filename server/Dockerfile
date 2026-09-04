FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY signaling.py .

ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "uvicorn signaling:app --host 0.0.0.0 --port ${PORT}"]
