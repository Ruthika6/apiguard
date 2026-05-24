"""
APIGuard — AI-powered API Failure Detection & Debugging Agent
Backend: FastAPI + Anthropic Claude
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import asyncio
import json
import random
import time
from datetime import datetime, timedelta
from typing import Optional
from collections import defaultdict

from analyzer import LogAnalyzer
from models import LogEntry, AnalysisRequest, AlertConfig

app = FastAPI(
    title="APIGuard — API Failure Detection Agent",
    description="AI-powered real-time API monitoring, anomaly detection, and debugging",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

analyzer = LogAnalyzer()

# In-memory log buffer (use Redis/Kafka in production)
log_buffer: list[dict] = []
connected_clients: list[WebSocket] = []


@app.get("/")
async def root():
    return {
        "service": "APIGuard",
        "status": "running",
        "endpoints": [
            "/logs/ingest",
            "/logs/analyze",
            "/logs/groups",
            "/metrics/summary",
            "/ws/stream",
            "/alert/test",
        ]
    }


@app.post("/logs/ingest")
async def ingest_logs(entries: list[LogEntry]):
    """Ingest a batch of API log entries"""
    for entry in entries:
        log = entry.dict()
        log["ingested_at"] = datetime.utcnow().isoformat()
        log_buffer.append(log)

    # Trim buffer to last 10k entries
    if len(log_buffer) > 10000:
        log_buffer[:] = log_buffer[-10000:]

    # Broadcast to WebSocket clients
    await broadcast_update({"type": "logs_ingested", "count": len(entries)})

    return {"ingested": len(entries), "buffer_size": len(log_buffer)}


@app.post("/logs/upload")
async def upload_log_file(file: UploadFile = File(...)):
    """Upload a log file (JSON, NDJSON, or CSV format)"""
    content = await file.read()
    lines = content.decode().strip().split("\n")
    parsed = []

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            parsed.append(entry)
            log_buffer.append(entry)
        except json.JSONDecodeError:
            # Try parsing as CSV/plain text
            parts = line.split(",")
            if len(parts) >= 4:
                parsed.append({
                    "timestamp": parts[0].strip(),
                    "endpoint": parts[1].strip(),
                    "status_code": int(parts[2].strip()),
                    "latency_ms": int(parts[3].strip()),
                    "message": parts[4].strip() if len(parts) > 4 else "",
                })

    return {"parsed": len(parsed), "filename": file.filename}


@app.get("/logs/analyze")
async def analyze_logs(
    endpoint: Optional[str] = None,
    time_window_minutes: int = 60,
    min_error_rate: float = 0.05
):
    """Trigger AI analysis on recent logs"""
    cutoff = datetime.utcnow() - timedelta(minutes=time_window_minutes)

    relevant = [
        l for l in log_buffer
        if endpoint is None or endpoint in l.get("endpoint", "")
    ]

    if not relevant:
        # Generate sample logs for demo
        relevant = _generate_sample_logs(50)

    result = await analyzer.analyze_batch(relevant, min_error_rate)
    return result


@app.get("/logs/groups")
async def get_failure_groups(time_window_minutes: int = 60):
    """Get AI-clustered failure groups"""
    relevant = log_buffer[-500:] if log_buffer else _generate_sample_logs(50)
    groups = analyzer.group_failures(relevant)
    return {"groups": groups, "total_analyzed": len(relevant)}


@app.get("/metrics/summary")
async def get_metrics_summary():
    """Get real-time metrics snapshot"""
    logs = log_buffer[-1000:] if log_buffer else _generate_sample_logs(100)

    total = len(logs)
    errors = [l for l in logs if l.get("status_code", 200) >= 500]
    warnings = [l for l in logs if 400 <= l.get("status_code", 200) < 500]
    latencies = [l.get("latency_ms", 0) for l in logs if l.get("latency_ms")]

    latencies.sort()
    p95 = latencies[int(len(latencies) * 0.95)] if latencies else 0
    p99 = latencies[int(len(latencies) * 0.99)] if latencies else 0

    endpoint_counts = defaultdict(int)
    endpoint_errors = defaultdict(int)
    for l in logs:
        ep = l.get("endpoint", "unknown")
        endpoint_counts[ep] += 1
        if l.get("status_code", 200) >= 400:
            endpoint_errors[ep] += 1

    top_failing = sorted(
        endpoint_errors.items(), key=lambda x: x[1], reverse=True
    )[:5]

    return {
        "total_requests": total,
        "error_count": len(errors),
        "warning_count": len(warnings),
        "error_rate": round(len(errors) / max(total, 1) * 100, 2),
        "p95_latency_ms": p95,
        "p99_latency_ms": p99,
        "avg_latency_ms": round(sum(latencies) / max(len(latencies), 1)),
        "affected_endpoints": len(endpoint_errors),
        "total_endpoints": len(endpoint_counts),
        "top_failing_endpoints": [
            {"endpoint": ep, "errors": cnt} for ep, cnt in top_failing
        ],
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.post("/analyze/entry")
async def analyze_single_entry(request: AnalysisRequest):
    """AI analysis of a single log entry"""
    result = await analyzer.analyze_single(request.log_entry, request.context)
    return result


@app.post("/alert/test")
async def test_alert(config: AlertConfig):
    """Send a test alert to configured webhook"""
    message = {
        "text": f"🚨 *APIGuard Test Alert*\nEndpoint: `{config.endpoint}`\nError rate threshold: {config.error_rate_threshold}%\nThis is a test notification.",
        "username": "APIGuard Bot",
        "icon_emoji": ":shield:",
    }
    # In production, POST to config.webhook_url
    return {"sent": True, "message": message, "webhook": config.webhook_url}


@app.websocket("/ws/stream")
async def websocket_stream(websocket: WebSocket):
    """Real-time log streaming via WebSocket"""
    await websocket.accept()
    connected_clients.append(websocket)
    try:
        while True:
            # Send a heartbeat with latest metrics every 5s
            metrics = await get_metrics_summary()
            await websocket.send_json({
                "type": "metrics_update",
                "data": metrics,
                "timestamp": datetime.utcnow().isoformat(),
            })
            await asyncio.sleep(5)
    except WebSocketDisconnect:
        connected_clients.remove(websocket)


async def broadcast_update(payload: dict):
    """Broadcast update to all connected WebSocket clients"""
    dead = []
    for client in connected_clients:
        try:
            await client.send_json(payload)
        except Exception:
            dead.append(client)
    for d in dead:
        connected_clients.remove(d)


def _generate_sample_logs(n: int = 50) -> list[dict]:
    """Generate realistic sample logs for demo"""
    endpoints = [
        "/api/payments/charge", "/api/auth/login", "/api/users/profile",
        "/api/orders/create", "/api/inventory/stock", "/api/search/products",
        "/api/webhooks/stripe", "/api/auth/refresh", "/api/notifications/send",
    ]
    error_codes = [500, 502, 503, 504, 429, 401, 422, 404]
    error_msgs = [
        "Connection timeout to upstream service",
        "Database connection pool exhausted",
        "JWT signature invalid",
        "Rate limit exceeded",
        "Service unavailable — circuit breaker open",
        "Validation error: missing required field",
        "Redis cache miss — cold start spike",
        "SSL certificate verification failed",
    ]
    logs = []
    base_time = datetime.utcnow()
    for i in range(n):
        is_error = random.random() < 0.15
        is_slow = random.random() < 0.10
        ep = random.choice(endpoints)
        code = random.choice(error_codes) if is_error else 200
        latency = random.randint(2000, 8000) if is_slow else random.randint(30, 400)
        logs.append({
            "timestamp": (base_time - timedelta(seconds=i * 12)).isoformat(),
            "endpoint": ep,
            "status_code": code,
            "latency_ms": latency,
            "message": random.choice(error_msgs) if is_error else "OK",
            "method": "POST" if "create" in ep or "charge" in ep else "GET",
        })
    return logs


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
