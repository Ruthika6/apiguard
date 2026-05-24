import { useState, useEffect, useRef, useCallback } from "react";

const ANTHROPIC_KEY = import.meta.env.VITE_ANTHROPIC_KEY || "";
const SAMPLE_LOGS = [
  { timestamp: "14:32:01", endpoint: "/api/payments/charge", status_code: 500, latency_ms: 3241, message: "Connection timeout to Stripe gateway", method: "POST" },
  { timestamp: "14:32:03", endpoint: "/api/auth/login", status_code: 401, latency_ms: 89, message: "JWT signature invalid — possible key rotation", method: "POST" },
  { timestamp: "14:32:05", endpoint: "/api/users/profile", status_code: 200, latency_ms: 142, message: "OK", method: "GET" },
  { timestamp: "14:32:08", endpoint: "/api/payments/charge", status_code: 503, latency_ms: 5001, message: "Service unavailable — upstream timeout", method: "POST" },
  { timestamp: "14:32:11", endpoint: "/api/inventory/stock", status_code: 200, latency_ms: 891, message: "OK (slow — unoptimized query?)", method: "GET" },
  { timestamp: "14:32:14", endpoint: "/api/auth/refresh", status_code: 401, latency_ms: 44, message: "Token expired — refresh rejected", method: "POST" },
  { timestamp: "14:32:17", endpoint: "/api/payments/charge", status_code: 500, latency_ms: 4892, message: "Connection timeout to Stripe gateway", method: "POST" },
  { timestamp: "14:32:20", endpoint: "/api/orders/create", status_code: 422, latency_ms: 210, message: "Validation failed: missing `sku` field", method: "POST" },
  { timestamp: "14:32:22", endpoint: "/api/webhooks/stripe", status_code: 200, latency_ms: 55, message: "OK", method: "POST" },
  { timestamp: "14:32:25", endpoint: "/api/search/products", status_code: 200, latency_ms: 1901, message: "OK (latency spike — Elasticsearch lag?)", method: "GET" },
  { timestamp: "14:32:29", endpoint: "/api/cache/invalidate", status_code: 503, latency_ms: 8800, message: "Redis connection refused", method: "DELETE" },
  { timestamp: "14:32:33", endpoint: "/api/auth/login", status_code: 200, latency_ms: 98, message: "OK", method: "POST" },
];

// ─── Claude API Call ─────────────────────────────────────────────────────────
async function askClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  const text = data.content.map((c) => c.text || "").join("");
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function severity(log) {
  if (log.status_code >= 500) return "error";
  if (log.status_code >= 400 || log.latency_ms > 2000) return "warn";
  return "ok";
}

function groupFailures(logs) {
  const map = {};
  for (const l of logs) {
    if (l.status_code < 400 && l.latency_ms < 1500) continue;
    const key = `${l.endpoint}|${l.status_code}`;
    if (!map[key]) map[key] = { endpoint: l.endpoint, status_code: l.status_code, entries: [] };
    map[key].entries.push(l);
  }
  return Object.values(map).sort((a, b) => b.entries.length - a.entries.length);
}

function computeMetrics(logs) {
  const total = logs.length;
  const errors = logs.filter((l) => l.status_code >= 500);
  const latencies = logs.map((l) => l.latency_ms).sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const endpoints = new Set(logs.filter((l) => l.status_code >= 400).map((l) => l.endpoint));
  return {
    total,
    errorRate: ((errors.length / Math.max(total, 1)) * 100).toFixed(1),
    p95,
    affectedEndpoints: endpoints.size,
  };
}

// ─── Components ──────────────────────────────────────────────────────────────
function SevDot({ sev }) {
  const colors = { error: "#E24B4A", warn: "#EF9F27", ok: "#639922" };
  return (
    <span style={{
      display: "inline-block", width: 7, height: 7, borderRadius: "50%",
      background: colors[sev] || "#888", flexShrink: 0, marginTop: 5,
    }} />
  );
}

function Badge({ children, type = "info" }) {
  const styles = {
    error: { background: "var(--color-background-danger)", color: "var(--color-text-danger)" },
    warn: { background: "var(--color-background-warning)", color: "var(--color-text-warning)" },
    ok: { background: "var(--color-background-success)", color: "var(--color-text-success)" },
    info: { background: "var(--color-background-info)", color: "var(--color-text-info)" },
  };
  return (
    <span style={{
      fontSize: 11, padding: "2px 8px", borderRadius: "var(--border-radius-md)",
      fontFamily: "var(--font-mono)", ...styles[type],
    }}>
      {children}
    </span>
  );
}

function MetricCard({ label, value, sub, subColor = "var(--color-text-secondary)" }) {
  return (
    <div style={{
      background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)",
      padding: "12px 14px",
    }}>
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 500, fontFamily: "var(--font-mono)", color: "var(--color-text-primary)" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, marginTop: 2, color: subColor }}>{sub}</div>}
    </div>
  );
}

function AIResult({ result, loading }) {
  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--color-text-secondary)" }}>
        <div style={{ width: 14, height: 14, border: "1.5px solid var(--color-border-secondary)", borderTopColor: "#378ADD", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
        AI is analyzing the failure pattern…
      </div>
    );
  }
  if (!result) {
    return (
      <div style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
        Select a log entry or click "analyze all" to get AI-powered debugging recommendations
      </div>
    );
  }

  const sevColor = result.severity === "critical" ? "#E24B4A" : result.severity === "warning" ? "#EF9F27" : "#378ADD";
  const sevType = result.severity === "critical" ? "error" : result.severity === "warning" ? "warn" : "info";

  return (
    <div style={{ fontSize: 13, lineHeight: 1.7 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <Badge type={sevType}>{(result.severity || "info").toUpperCase()}</Badge>
        {result.estimated_fix_time && (
          <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
            Fix ETA: {result.estimated_fix_time}
          </span>
        )}
      </div>

      {result.root_cause && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", marginBottom: 4 }}>Root cause</div>
          <div style={{ padding: 8, background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", borderLeft: `3px solid ${sevColor}` }}>
            {result.root_cause}
          </div>
        </div>
      )}

      {result.likely_causes?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", marginBottom: 4 }}>Likely causes</div>
          <div>
            {result.likely_causes.map((c, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, padding: "3px 8px", borderRadius: "var(--border-radius-md)", margin: "0 4px 4px 0", background: "var(--color-background-secondary)", color: "var(--color-text-primary)", fontFamily: "var(--font-mono)" }}>
                ▸ {c}
              </span>
            ))}
          </div>
        </div>
      )}

      {(result.fix_steps || result.immediate_actions)?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", marginBottom: 4 }}>Debugging steps</div>
          {(result.fix_steps || result.immediate_actions).map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6, fontSize: 12 }}>
              <div style={{ width: 18, height: 18, borderRadius: "50%", background: "var(--color-background-info)", color: "var(--color-text-info)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 500, flexShrink: 0, marginTop: 1 }}>
                {i + 1}
              </div>
              <div>{s}</div>
            </div>
          ))}
        </div>
      )}

      {result.alert_message && (
        <div style={{ ma

