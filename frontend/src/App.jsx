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

function SevDot({ sev }) {
  const colors = { error: "#E24B4A", warn: "#EF9F27", ok: "#639922" };
  return (
    <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: colors[sev] || "#888", flexShrink: 0, marginTop: 5 }} />
  );
}

function Badge({ children, type = "info" }) {
  const styles = {
    error: { background: "#3d1a1a", color: "#E24B4A" },
    warn: { background: "#3d2e0a", color: "#EF9F27" },
    ok: { background: "#1a2e1a", color: "#639922" },
    info: { background: "#1a2a3d", color: "#378ADD" },
  };
  return (
    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, fontFamily: "monospace", ...styles[type] }}>
      {children}
    </span>
  );
}

function MetricCard({ label, value, sub, subColor = "#888" }) {
  return (
    <div style={{ background: "#1a1a1a", borderRadius: 8, padding: "12px 14px", border: "1px solid #333" }}>
      <div style={{ fontSize: 11, color: "#888", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, fontFamily: "monospace", color: "#fff" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, marginTop: 2, color: subColor }}>{sub}</div>}
    </div>
  );
}

function AIResult({ result, loading }) {
  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#888" }}>
        <div style={{ width: 14, height: 14, border: "1.5px solid #333", borderTopColor: "#378ADD", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
        AI is analyzing the failure pattern...
      </div>
    );
  }
  if (!result) {
    return <div style={{ fontSize: 13, color: "#555" }}>Select a log entry or click "analyze all" to get AI-powered debugging recommendations</div>;
  }

  const sevColor = result.severity === "critical" ? "#E24B4A" : result.severity === "warning" ? "#EF9F27" : "#378ADD";
  const sevType = result.severity === "critical" ? "error" : result.severity === "warning" ? "warn" : "info";

  return (
    <div style={{ fontSize: 13, lineHeight: 1.7 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <Badge type={sevType}>{(result.severity || "info").toUpperCase()}</Badge>
        {result.estimated_fix_time && <span style={{ fontSize: 11, color: "#888" }}>Fix ETA: {result.estimated_fix_time}</span>}
      </div>
      {result.root_cause && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", color: "#888", marginBottom: 4 }}>Root cause</div>
          <div style={{ padding: 8, background: "#1a1a1a", borderRadius: 4, borderLeft: `3px solid ${sevColor}`, color: "#ccc" }}>{result.root_cause}</div>
        </div>
      )}
      {result.likely_causes?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", color: "#888", marginBottom: 4 }}>Likely causes</div>
          <div>
            {result.likely_causes.map((c, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, padding: "3px 8px", borderRadius: 4, margin: "0 4px 4px 0", background: "#1a1a1a", color: "#ccc", fontFamily: "monospace", border: "1px solid #333" }}>▸ {c}</span>
            ))}
          </div>
        </div>
      )}
      {(result.fix_steps || result.immediate_actions)?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", color: "#888", marginBottom: 4 }}>Debugging steps</div>
          {(result.fix_steps || result.immediate_actions).map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6, fontSize: 12, color: "#ccc" }}>
              <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#1a2a3d", color: "#378ADD", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 500, flexShrink: 0, marginTop: 1 }}>{i + 1}</div>
              <div>{s}</div>
            </div>
          ))}
        </div>
      )}
      {result.alert_message && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", color: "#888", marginBottom: 4 }}>Slack alert</div>
          <div style={{ fontSize: 12, fontFamily: "monospace", padding: "8px 10px", background: "#1a1a1a", borderRadius: 4, color: "#ccc", border: "1px solid #333" }}>{result.alert_message}</div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [logs, setLogs] = useState(SAMPLE_LOGS);
  const [selectedLog, setSelectedLog] = useState(null);
  const [aiResult, setAiResult] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const fileRef = useRef();

  const metrics = computeMetrics(logs);
  const groups = groupFailures(logs);

  useEffect(() => {
    const iv = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const handleAnalyze = useCallback(async (log, mode = "entry") => {
    setAiLoading(true);
    setAiResult(null);
    try {
      let prompt;
      if (mode === "entry") {
        prompt = `You are a senior SRE. Analyze this API log entry and return ONLY valid JSON (no markdown):
${JSON.stringify(log, null, 2)}
Return: {"severity":"critical|warning|info","likely_causes":["...","...","..."],"root_cause":"one sentence","fix_steps":["step1","step2","step3","step4"],"alert_message":"emoji + under 40 words","estimated_fix_time":"e.g. 15 minutes"}`;
      } else {
        const summary = groups.map((g) => `${g.entries.length}x ${g.endpoint} → ${g.status_code}`).join("\n");
        prompt = `You are a senior SRE. Analyze these API failure patterns and return ONLY valid JSON:
Metrics: error_rate=${metrics.errorRate}%, p95=${metrics.p95}ms, affected_endpoints=${metrics.affectedEndpoints}
Failure groups:\n${summary}
Return: {"severity":"critical|degraded|warning","root_cause":"sentence","likely_causes":["...","...","..."],"immediate_actions":["action1","action2","action3"],"alert_message":"emoji + under 50 words","estimated_fix_time":"e.g. 30 minutes"}`;
      }
      const result = await askClaude(prompt);
      setAiResult(result);
    } catch (e) {
      setAiResult({ severity: "info", root_cause: "Could not connect to Claude API. Check your API key.", likely_causes: ["Invalid API key", "Network error", "Rate limit"], fix_steps: ["Verify ANTHROPIC_KEY is correct", "Check network connectivity", "Check Anthropic dashboard"] });
    }
    setAiLoading(false);
  }, [logs, groups, metrics]);

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const lines = ev.target.result.split("\n").filter(Boolean);
      const parsed = [];
      for (const line of lines) { try { parsed.push(JSON.parse(line)); } catch {} }
      if (parsed.length) setLogs((prev) => [...parsed, ...prev]);
    };
    reader.readAsText(file);
  };

  const injectAnomaly = () => {
    const extras = [
      { timestamp: new Date().toTimeString().slice(0, 8), endpoint: "/api/payments/charge", status_code: 500, latency_ms: 6100, message: "Stripe rate limit exceeded", method: "POST" },
      { timestamp: new Date().toTimeString().slice(0, 8), endpoint: "/api/db/query", status_code: 500, latency_ms: 12000, message: "Connection pool exhausted", method: "GET" },
    ];
    setLogs((prev) => [extras[Math.floor(Math.random() * extras.length)], ...prev]);
  };

  return (
    <div style={{ padding: "1rem", fontFamily: "monospace", minHeight: "100vh", background: "#0d0d0d", color: "#ccc" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } } @keyframes blink { 0%,100%{opacity:1}50%{opacity:.3} }`}</style>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingBottom: "1rem", borderBottom: "1px solid #222", marginBottom: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, font

