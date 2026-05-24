"""
AI-powered log analysis using Claude (Anthropic)
Groups failures, detects anomalies, generates debugging recommendations
"""

import anthropic
import json
from collections import defaultdict, Counter
from typing import Optional
import re


class LogAnalyzer:
    def __init__(self):
        self.client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env
        self.model = "claude-sonnet-4-20250514"

    # ─── Single Entry Analysis ─────────────────────────────────────────────────

    async def analyze_single(self, log_entry: dict, context: Optional[str] = None) -> dict:
        """Deep analysis of one log entry with debugging steps"""
        prompt = f"""You are a senior API reliability engineer. Analyze this log entry and return ONLY a JSON object (no markdown, no explanation):

Log Entry:
{json.dumps(log_entry, indent=2)}

{f'Additional context: {context}' if context else ''}

Return this exact JSON structure:
{{
  "severity": "critical|warning|info",
  "likely_causes": ["cause1", "cause2", "cause3"],
  "root_cause": "one sentence summary of what went wrong",
  "impact": "who and what is affected",
  "fix_steps": [
    "step 1 — concrete action",
    "step 2 — concrete action",
    "step 3 — concrete action",
    "step 4 — concrete action"
  ],
  "prevention": "one sentence on how to prevent recurrence",
  "alert_message": "Slack-style alert under 40 words starting with an emoji",
  "related_patterns": ["pattern1", "pattern2"],
  "estimated_fix_time": "e.g. 15 minutes | 2 hours | requires deploy"
}}"""

        message = self.client.messages.create(
            model=self.model,
            max_tokens=1000,
            messages=[{"role": "user", "content": prompt}]
        )

        raw = message.content[0].text.strip()
        raw = re.sub(r'```json|```', '', raw).strip()

        try:
            return {"status": "ok", "analysis": json.loads(raw), "entry": log_entry}
        except json.JSONDecodeError:
            return {"status": "error", "raw": raw, "entry": log_entry}

    # ─── Batch Analysis ────────────────────────────────────────────────────────

    async def analyze_batch(self, logs: list[dict], min_error_rate: float = 0.05) -> dict:
        """Analyze a batch of logs — detect anomalies, group failures, explain causes"""
        stats = self._compute_stats(logs)

        if stats["error_rate"] < min_error_rate and stats["latency_spike"] is False:
            return {
                "status": "healthy",
                "message": "No significant anomalies detected",
                "stats": stats,
                "groups": [],
                "analysis": None,
            }

        groups = self.group_failures(logs)
        groups_summary = "\n".join([
            f"- {g['count']}x {g['pattern']}: {g['description']}"
            for g in groups[:5]
        ])

        prompt = f"""You are a senior SRE. Analyze these API failure patterns and return ONLY a JSON object:

Stats:
- Total requests: {stats['total']}
- Error rate: {stats['error_rate']:.1%}
- p95 latency: {stats['p95_latency_ms']}ms
- p99 latency: {stats['p99_latency_ms']}ms
- Affected endpoints: {stats['affected_endpoints']}

Failure groups:
{groups_summary}

Top errors: {json.dumps(stats['top_errors'], indent=2)}

Return this exact JSON:
{{
  "overall_severity": "critical|degraded|warning|healthy",
  "summary": "2-3 sentence executive summary of what is happening",
  "root_cause": "the single most likely root cause",
  "likely_causes": ["cause1", "cause2", "cause3"],
  "immediate_actions": [
    "action 1 — do RIGHT NOW",
    "action 2",
    "action 3"
  ],
  "investigation_steps": [
    "check 1",
    "check 2",
    "check 3",
    "check 4"
  ],
  "alert_message": "Slack alert starting with emoji, under 50 words, mention top failing endpoint and error rate",
  "runbook_url_suggestion": "e.g. wiki/payment-gateway-runbook",
  "estimated_impact": "e.g. 6% of users seeing errors, payment flow degraded",
  "fix_eta": "e.g. 30 minutes if cache restart | 2 hours if DB migration needed"
}}"""

        message = self.client.messages.create(
            model=self.model,
            max_tokens=1200,
            messages=[{"role": "user", "content": prompt}]
        )

        raw = message.content[0].text.strip()
        raw = re.sub(r'```json|```', '', raw).strip()

        try:
            analysis = json.loads(raw)
        except json.JSONDecodeError:
            analysis = {"error": "parse_failed", "raw": raw}

        return {
            "status": "anomalies_detected",
            "stats": stats,
            "groups": groups,
            "analysis": analysis,
        }

    # ─── Failure Grouping ──────────────────────────────────────────────────────

    def group_failures(self, logs: list[dict]) -> list[dict]:
        """Cluster similar failures by endpoint + status code + message pattern"""
        error_logs = [l for l in logs if l.get("status_code", 200) >= 400]

        buckets = defaultdict(list)
        for l in error_logs:
            ep = l.get("endpoint", "unknown")
            code = l.get("status_code", 0)
            msg = l.get("message", "")

            # Normalize message to a pattern (strip UUIDs, IDs, timestamps)
            pattern = re.sub(r'\b[0-9a-f-]{8,}\b', '<id>', msg.lower())
            pattern = re.sub(r'\d{4}-\d{2}-\d{2}', '<date>', pattern)
            pattern = re.sub(r'\d+ms', '<latency>', pattern)

            key = f"{ep}|{code}|{pattern[:60]}"
            buckets[key].append(l)

        groups = []
        for key, entries in sorted(buckets.items(), key=lambda x: -len(x[1])):
            ep, code, pattern = key.split("|", 2)
            latencies = [e.get("latency_ms", 0) for e in entries if e.get("latency_ms")]
            avg_latency = sum(latencies) // max(len(latencies), 1)

            severity = "critical" if int(code) >= 500 else "warning" if int(code) >= 400 else "info"
            if avg_latency > 3000:
                severity = "critical"

            groups.append({
                "pattern": f"{ep} → {code}",
                "description": pattern.strip(),
                "count": len(entries),
                "endpoint": ep,
                "status_code": int(code),
                "avg_latency_ms": avg_latency,
                "severity": severity,
                "first_seen": entries[-1].get("timestamp", ""),
                "last_seen": entries[0].get("timestamp", ""),
                "sample": entries[0],
            })

        return groups[:10]

    # ─── Stats Helper ──────────────────────────────────────────────────────────

    def _compute_stats(self, logs: list[dict]) -> dict:
        total = len(logs)
        if total == 0:
            return {"total": 0, "error_rate": 0, "p95_latency_ms": 0, "p99_latency_ms": 0,
                    "affected_endpoints": 0, "top_errors": [], "latency_spike": False}

        errors = [l for l in logs if l.get("status_code", 200) >= 500]
        client_errors = [l for l in logs if 400 <= l.get("status_code", 200) < 500]
        latencies = sorted([l.get("latency_ms", 0) for l in logs if l.get("latency_ms")])

        p95 = latencies[int(len(latencies) * 0.95)] if latencies else 0
        p99 = latencies[int(len(latencies) * 0.99)] if latencies else 0
        avg = sum(latencies) // max(len(latencies), 1)

        endpoint_errors = Counter(l.get("endpoint") for l in errors if l.get("endpoint"))
        error_messages = Counter(l.get("message", "")[:60] for l in errors)

        return {
            "total": total,
            "error_count": len(errors),
            "client_error_count": len(client_errors),
            "error_rate": len(errors) / total,
            "p95_latency_ms": p95,
            "p99_latency_ms": p99,
            "avg_latency_ms": avg,
            "latency_spike": p95 > 2000,
            "affected_endpoints": len(endpoint_errors),
            "top_errors": [
                {"endpoint": ep, "count": cnt}
                for ep, cnt in endpoint_errors.most_common(5)
            ],
            "top_messages": [
                {"message": msg, "count": cnt}
                for msg, cnt in error_messages.most_common(3)
            ],
        }

    # ─── Anomaly Detection ─────────────────────────────────────────────────────

    def detect_anomalies(self, logs: list[dict], baseline_error_rate: float = 0.02) -> list[dict]:
        """Rule-based anomaly detection (runs locally, no AI call needed)"""
        anomalies = []
        stats = self._compute_stats(logs)

        if stats["error_rate"] > baseline_error_rate * 3:
            anomalies.append({
                "type": "error_rate_spike",
                "severity": "critical" if stats["error_rate"] > 0.1 else "warning",
                "description": f"Error rate {stats['error_rate']:.1%} — {stats['error_rate']/baseline_error_rate:.1f}x above baseline",
                "metric": stats["error_rate"],
                "threshold": baseline_error_rate * 3,
            })

        if stats["p95_latency_ms"] > 2000:
            anomalies.append({
                "type": "latency_spike",
                "severity": "critical" if stats["p95_latency_ms"] > 5000 else "warning",
                "description": f"p95 latency is {stats['p95_latency_ms']}ms — likely DB or upstream issue",
                "metric": stats["p95_latency_ms"],
                "threshold": 2000,
            })

        for ep_stat in stats["top_errors"]:
            ep_logs = [l for l in logs if l.get("endpoint") == ep_stat["endpoint"]]
            ep_error_rate = ep_stat["count"] / max(len(ep_logs), 1)
            if ep_error_rate > 0.5:
                anomalies.append({
                    "type": "endpoint_degraded",
                    "severity": "critical",
                    "description": f"{ep_stat['endpoint']} has {ep_error_rate:.0%} error rate — endpoint is failing",
                    "endpoint": ep_stat["endpoint"],
                    "error_rate": ep_error_rate,
                })

        return anomalies
