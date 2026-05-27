"""
Route data models — type definitions for route candidates, segments, and requests.
"""
from dataclasses import dataclass, field


@dataclass
class RouteSegment:
    """A single segment of a route (airway edge, DCT, SID, or STAR)."""
    from_ident: str       # waypoint ident or airport ICAO
    to_ident: str         # waypoint ident or airport ICAO
    segment_type: str     # "airway", "DCT", "SID", "STAR"
    airway_name: str = ""  # airway name (e.g., "A461"), empty for DCT
    distance_nm: float = 0.0
    min_alt: int = 0
    max_alt: int = 99999


@dataclass
class RouteCandidate:
    """A candidate route from origin to destination."""
    index: int                    # 0-based ranking position
    route_string: str             # ATS route string (e.g., "VHHH DCT ELATO A1 ...")
    segments: list[RouteSegment] = field(default_factory=list)
    total_distance_nm: float = 0.0
    node_path: list[int] = field(default_factory=list)  # waypoint_id sequence
    score: float | None = None     # AI evaluation score (1-10)
    eval_reason: str = ""          # AI evaluation rationale


@dataclass
class PlanRequest:
    """Request body for POST /api/plan."""
    input: str                     # natural language input
    k: int = 5                     # number of candidate routes
    llm_config: dict | None = None  # optional LLM overrides


@dataclass
class LLMConfig:
    """LLM connection settings (from frontend or env)."""
    provider: str = "ollama"
    base_url: str = "http://localhost:11434/v1"
    model: str = "qwen3.5:9b-agent"
    api_key: str = "ollama"
    temperature: float = 0.3


@dataclass
class ParsedIntent:
    """Structured output from NLP parsing."""
    origin: str | None = None          # ICAO code
    destination: str | None = None     # ICAO code
    airway_type: str | None = None     # "J", "B", or None
    avoid_waypoints: list[str] = field(default_factory=list)
    avoid_airspaces: list[str] = field(default_factory=list)
    prefer_sid: str | None = None
    prefer_star: str | None = None
    cruise_altitude: int | None = None
    confidence: float = 0.0


@dataclass
class PlanResponse:
    """Response body for POST /api/plan."""
    parsed: ParsedIntent | None = None
    route_string: str = ""           # best route in ATS format
    candidates: list[RouteCandidate] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    error: str | None = None
