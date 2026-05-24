import { useState, useEffect, useRef, useCallback } from "react";

const ANTHROPIC_KEY = import.meta.env.VITE_ANTHROPIC_KEY || "";

// ─── Sample Data ────────────────────────────────────────────────────────────
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
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", marginBottom: 4 }}>Slack alert</div>
          <div style={{ fontSize: 12, fontFamily: "var(--font-mono)", padding: "8px 10px", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)" }}>
            {result.alert_message}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
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
      setAiResult({ severity: "info", root_cause: "Could not connect to Claude API. Check your API key.", likely_causes: ["Invalid API key", "Network error", "Rate limit"], fix_steps: ["Verify ANTHROPIC_KEY is correct", "Check network connectivity", "Check Anthropic dashboard for rate limits"] });
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
      for (const line of lines) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      if (parsed.length) setLogs((prev) => [...parsed, ...prev]);
    };
    reader.readAsText(file);
  };

  const injectAnomaly = () => {
    const extras = [
      { timestamp: new Date().toTimeString().slice(0, 8), endpoint: "/api/payments/charge", status_code: 500, latency_ms: 6100, message: "Stripe rate limit exceeded — too many requests", method: "POST" },
      { timestamp: new Date().toTimeString().slice(0, 8), endpoint: "/api/db/query", status_code: 500, latency_ms: 12000, message: "Connection pool exhausted — all 20 connections in use", method: "GET" },
    ];
    setLogs((prev) => [extras[Math.floor(Math.random() * extras.length)], ...prev]);
  };

  return (
    <div style={{ padding: "1rem 0", fontFamily: "var(--font-mono, monospace)", minHeight: 700 }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } } @keyframes blink { 0%,100%{opacity:1}50%{opacity:.3} }`}</style>

      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingBottom: "1rem", borderBottom: "0.5px solid var(--color-border-tertiary)", marginBottom: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 500, letterSpacing: "0.04em" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#E24B4A", display: "inline-block", animation: "blink 1.4s infinite" }} />
          APIGUARD — failure detection agent
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Badge type="error">{groups.filter((g) => g.status_code >= 500).length} critical</Badge>
          <Badge type="warn">{groups.filter((g) => g.status_code >= 400 && g.status_code < 500).length} warnings</Badge>
          <button onClick={injectAnomaly} style={{ fontSize: 11, padding: "4px 10px", borderRadius: "var(--border-radius-md)", border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontFamily: "var(--font-mono)" }}>inject anomaly</button>
          <button onClick={() => fileRef.current.click()} style={{ fontSize: 11, padding: "4px 10px", borderRadius: "var(--border-radius-md)", border: "0.5px solid var(--color-border-info)", background: "var(--color-background-info)", color: "var(--color-text-info)", cursor: "pointer", fontFamily: "var(--font-mono)" }}>upload logs</button>
          <input ref={fileRef} type="file" accept=".json,.ndjson,.log" style={{ display: "none" }} onChange={handleFileUpload} />
        </div>
      </div>

      {/* Metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: "1rem" }}>
        <MetricCard label="total requests" value={metrics.total.toLocaleString()} sub="in buffer" />
        <MetricCard label="error rate" value={`${metrics.errorRate}%`} sub="↑ above baseline" subColor="var(--color-text-danger)" />
        <MetricCard label="p95 latency" value={`${metrics.p95}ms`} sub={metrics.p95 > 1200 ? "↑ above SLA" : "within SLA"} subColor={metrics.p95 > 1200 ? "var(--color-text-warning)" : "var(--color-text-success)"} />
        <MetricCard label="affected endpoints" value={metrics.affectedEndpoints} sub={`of ${new Set(logs.map((l) => l.endpoint)).size} total`} />
      </div>

      {/* Panels */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: "1rem" }}>
        {/* Log stream */}
        <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", letterSpacing: "0.04em", textTransform: "uppercase" }}>live log stream</span>
            <Badge type="error">LIVE</Badge>
          </div>
          <div style={{ maxHeight: 260, overflowY: "auto" }}>
            {logs.map((log, i) => {
              const sev = severity(log);
              const isSelected = selectedLog === i;
              return (
                <div key={i} onClick={() => { setSelectedLog(i); handleAnalyze(log, "entry"); }} style={{ padding: "7px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", gap: 8, fontSize: 12, cursor: "pointer", background: isSelected ? "var(--color-background-info)" : "transparent", alignItems: "flex-start" }}>
                  <SevDot sev={sev} />
                  <span style={{ color: "var(--color-text-tertiary)", minWidth: 50, fontSize: 11, marginTop: 1 }}>{log.timestamp}</span>
                  <span style={{ color: "var(--color-text-secondary)", minWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{log.endpoint}</span>
                  <span style={{ color: "var(--color-text-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{log.status_code} · {log.message?.substring(0, 35)}{log.message?.length > 35 ? "…" : ""}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Failure groups */}
        <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", letterSpacing: "0.04em", textTransform: "uppercase" }}>failure groups</span>
            <Badge type="info">AI clustered</Badge>
          </div>
          <div style={{ padding: "10px 14px" }}>
            {groups.slice(0, 5).map((g, i) => {
              const sev = g.status_code >= 500 ? "error" : "warn";
              const pct = Math.min(100, (g.entries.length / Math.max(logs.length * 0.15, 1)) * 100);
              return (
                <div key={i} style={{ paddingBottom: 10, marginBottom: 10, borderBottom: i < groups.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 18, fontWeight: 500, minWidth: 28, fontFamily: "var(--font-mono)", color: sev === "error" ? "#E24B4A" : "#EF9F27" }}>{g.entries.length}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-primary)" }}>{g.endpoint}</div>
                      <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>HTTP {g.status_code}</div>
                    </div>
                    <Badge type={sev}>{sev}</Badge>
                  </div>
                  <div style={{ height: 5, background: "var(--color-background-secondary)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: sev === "error" ? "#E24B4A" : "#EF9F27", borderRadius: 3, transition: "width 0.6s" }} />
                  </div>
                </div>
              );
            })}
            {groups.length === 0 && <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", padding: "8px 0" }}>No failure groups detected — system healthy</div>}
          </div>
        </div>
      </div>

      {/* AI Panel */}
      <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", marginBottom: "1rem", overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
            ✦ AI debugging analysis
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {aiLoading && <Badge type="warn">analyzing…</Badge>}
            {aiResult && !aiLoading && <Badge type="ok">ready</Badge>}
            <button onClick={() => handleAnalyze(null, "all")} style={{ fontSize: 11, padding: "4px 10px", borderRadius: "var(--border-radius-md)", border: "0.5px solid var(--color-border-info)", background: "var(--color-background-info)", color: "var(--color-text-info)", cursor: "pointer", fontFamily: "var(--font-mono)" }}>
              analyze all ↗
            </button>
          </div>
        </div>
        <div style={{ padding: 14 }}>
          <AIResult result={aiResult} loading={aiLoading} />
        </div>
      </div>

      {/* Status bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)", paddingTop: 8, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
        <span>monitoring active</span>
        <span>·</span>
        <span>{elapsed}s since load</span>
        <span>·</span>
        <span>{logs.length} log entries in buffer</span>
        <span style={{ marginLeft: "auto" }}>powered by claude sonnet-4</span>
      </div>
    </div>
  );
}

