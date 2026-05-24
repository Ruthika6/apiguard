from pydantic import BaseModel
from typing import Optional, Any


class LogEntry(BaseModel):
    timestamp: str
    endpoint: str
    status_code: int
    latency_ms: int
    message: str = ""
    method: str = "GET"
    user_id: Optional[str] = None
    trace_id: Optional[str] = None
    extra: Optional[dict] = None


class AnalysisRequest(BaseModel):
    log_entry: dict
    context: Optional[str] = None


class AlertConfig(BaseModel):
    webhook_url: str
    endpoint: Optional[str] = None
    error_rate_threshold: float = 5.0
    latency_threshold_ms: int = 2000
    channel: str = "#alerts"
