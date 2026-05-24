# 🛡️ APIGuard — AI-Powered API Failure Detection & Debugging Agent

> **Hackathon Project** — Real-time API monitoring, anomaly detection, and AI-powered debugging powered by Claude (Anthropic)

![Python](https://img.shields.io/badge/Python-3.11+-blue) ![FastAPI](https://img.shields.io/badge/FastAPI-0.115-green) ![React](https://img.shields.io/badge/React-18-61dafb) ![Claude](https://img.shields.io/badge/Claude-Sonnet--4-orange)

---

## 🚀 The Problem

Engineering teams struggle to detect **silent API failures**, latency spikes, and integration issues *before* users complain. Traditional monitoring tells you *what* broke — not *why* or *how to fix it*.

## 💡 The Solution

APIGuard is an AI agent that:

1. **Ingests** API logs in real-time (REST, file upload, or WebSocket)
2. **Detects anomalies** — error rate spikes, latency outliers, silent failures
3. **Groups recurring failures** by endpoint + pattern (no duplicates in your inbox)
4. **Explains root causes** using Claude AI — not just "500 error" but *why*
5. **Generates debugging steps** — concrete, actionable, ordered by priority
6. **Alerts developers** with Slack-ready messages and runbook suggestions

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                   APIGuard System                    │
│                                                      │
│  Log Sources          Backend           AI Engine    │
│  ──────────          ─────────         ──────────    │
│  REST ingest    →    FastAPI     →    Claude Sonnet  │
│  File upload    →    Analyzer   →    Root cause      │
│  WebSocket      →    Grouper    →    Fix steps       │
│  Log generator  →    Metrics    →    Slack alerts    │
│                       ↓                              │
│                  React Dashboard                     │
│                  (live stream)                       │
└─────────────────────────────────────────────────────┘
```

---

## ⚡ Quick Start

### 1. Clone & Setup

```bash
git clone https://github.com/yourusername/apiguard
cd apiguard
```

### 2. Backend

```bash
cd backend
pip install -r requirements.txt

# Set your Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-your-key-here

# Start the server
python main.py
# → http://localhost:8000
```

### 3. Frontend

```bash
cd frontend
cp .env.example .env
# Edit .env and set VITE_ANTHROPIC_KEY=sk-ant-your-key-here

npm install
npm run dev
# → http://localhost:5173
```

### 4. Generate Demo Logs

```bash
# Normal traffic
python generate_logs.py --mode normal --count 100

# Simulate an incident (high error rate)
python generate_logs.py --mode spike --count 50

# Or upload sample-logs/demo-logs.ndjson from the UI
```

---

## 🎯 Key Features

### Real-Time Log Stream
- Live WebSocket feed of incoming API requests
- Color-coded severity (red = 5xx, amber = 4xx/slow, green = OK)
- Click any entry for instant AI analysis

### AI-Powered Anomaly Detection
- **Error rate spikes** — detected when 3x above baseline
- **Latency outliers** — p95 and p99 tracking with SLA thresholds
- **Silent failures** — 200 OK responses with suspicious latency patterns
- **Endpoint degradation** — per-endpoint error rate tracking

### Intelligent Failure Grouping
- Clusters similar failures by endpoint + status + message pattern
- Strips UUIDs, timestamps, and IDs to find true duplicates
- Ranked by frequency so you fix the biggest problem first

### Claude AI Debugging
Each failure gets:
- **Root cause** — one clear sentence
- **Likely causes** — 3 specific hypotheses
- **Debugging steps** — 4 actionable steps in order
- **Slack alert** — copy-paste ready team notification
- **Fix ETA** — realistic time estimate

### REST API
```
POST /logs/ingest          # Batch log ingestion
POST /logs/upload          # File upload (NDJSON, JSON, CSV)
GET  /logs/analyze         # AI analysis of recent logs
GET  /logs/groups          # Failure clustering
GET  /metrics/summary      # Real-time metrics snapshot
POST /analyze/entry        # Analyze single log entry
WS   /ws/stream            # Live metrics WebSocket
POST /alert/test           # Test Slack webhook
```

---

## 📊 Demo Scenarios

### Scenario 1: Payment Gateway Outage
```bash
python generate_logs.py --mode spike --count 30
# Then click "analyze all" in the dashboard
# Claude identifies: Stripe rate limit + timeout cascade
```

### Scenario 2: Upload Real Logs
```bash
# Upload sample-logs/demo-logs.ndjson from the dashboard
# Demonstrates: 4 distinct failure groups, AI clustering
```

### Scenario 3: API Demo
```bash
curl -X POST http://localhost:8000/logs/ingest \
  -H "Content-Type: application/json" \
  -d '[{"timestamp":"2024-01-15T14:32:01Z","endpoint":"/api/payments","status_code":500,"latency_ms":5200,"message":"Stripe timeout"}]'

curl http://localhost:8000/logs/analyze
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| AI Engine | Anthropic Claude Sonnet 4 |
| Backend | FastAPI (Python 3.11+) |
| Frontend | React 18 + Vite |
| Real-time | WebSockets |
| Deployment | Uvicorn ASGI |

---

## 🔮 Future Roadmap

- [ ] Kafka/Redis integration for production log ingestion
- [ ] Prometheus metrics export
- [ ] Auto-generated runbooks stored in Confluence
- [ ] PagerDuty / OpsGenie alert routing
- [ ] Historical trend analysis and forecasting
- [ ] Multi-tenant support for SaaS teams

---

## 👥 Team

Built for [AI Hackathon for Builders] · May 2026

---

