#!/usr/bin/env python3
"""
Sample log generator — sends realistic API logs to APIGuard backend
Run: python generate_logs.py --mode spike --count 100
"""

import argparse
import json
import random
import time
import urllib.request
from datetime import datetime

ENDPOINTS = [
    "/api/payments/charge", "/api/auth/login", "/api/users/profile",
    "/api/orders/create", "/api/inventory/stock", "/api/search/products",
    "/api/webhooks/stripe", "/api/auth/refresh", "/api/notifications/send",
    "/api/reports/export", "/api/cache/invalidate", "/api/db/query",
]

ERRORS = [
    ("Connection timeout to upstream service", 500, 5000),
    ("Database connection pool exhausted", 500, 12000),
    ("JWT signature invalid — key rotation?", 401, 90),
    ("Rate limit exceeded", 429, 50),
    ("Service unavailable — circuit breaker open", 503, 100),
    ("Validation error: missing required field", 422, 200),
    ("Redis connection refused", 503, 8800),
    ("SSL certificate verification failed", 500, 300),
]


def make_log(spike=False):
    is_error = random.random() < (0.40 if spike else 0.08)
    is_slow = random.random() < (0.25 if spike else 0.05)
    ep = random.choice(ENDPOINTS)

    if is_error:
        msg, code, lat = random.choice(ERRORS)
        if spike and "payments" in ep:
            msg, code, lat = ERRORS[0]  # force payment timeouts during spike
    else:
        msg, code = "OK", 200
        lat = random.randint(2000, 6000) if is_slow else random.randint(30, 400)

    return {
        "timestamp": datetime.utcnow().isoformat(),
        "endpoint": ep,
        "status_code": code,
        "latency_ms": lat,
        "message": msg,
        "method": "POST" if any(x in ep for x in ["create", "charge", "login", "send"]) else "GET",
        "trace_id": f"trace-{random.randint(100000, 999999)}",
    }


def send_batch(logs, url="http://localhost:8000/logs/ingest"):
    data = json.dumps(logs).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"  ✗ Send failed: {e}")
        return None


def main():
    parser = argparse.ArgumentParser(description="APIGuard log generator")
    parser.add_argument("--mode", choices=["normal", "spike", "silent"], default="normal")
    parser.add_argument("--count", type=int, default=50)
    parser.add_argument("--batch", type=int, default=10)
    parser.add_argument("--url", default="http://localhost:8000")
    args = parser.parse_args()

    print(f"APIGuard Log Generator")
    print(f"Mode: {args.mode} | Count: {args.count} | Target: {args.url}")
    print("─" * 40)

    ingest_url = f"{args.url}/logs/ingest"
    spike = args.mode == "spike"
    sent = 0

    while sent < args.count:
        batch_size = min(args.batch, args.count - sent)
        batch = [make_log(spike=spike) for _ in range(batch_size)]

        # Save to NDJSON for demo
        with open("sample-logs/generated.ndjson", "a") as f:
            for log in batch:
                f.write(json.dumps(log) + "\n")

        result = send_batch(batch, ingest_url)
        sent += batch_size

        errors = sum(1 for l in batch if l["status_code"] >= 400)
        print(f"  Sent {sent}/{args.count} | {errors} errors in batch | {result}")

        time.sleep(0.5)

    print(f"\n✓ Done. {sent} logs sent. Check the dashboard!")


if __name__ == "__main__":
    import os
    os.makedirs("sample-logs", exist_ok=True)
    main()
