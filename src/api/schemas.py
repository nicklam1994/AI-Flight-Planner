"""
Pydantic schemas for API request/response models.
"""
from pydantic import BaseModel, Field


class LLMConfigSchema(BaseModel):
    """LLM configuration from the frontend."""
    provider: str = "ollama"
    base_url: str = "http://localhost:11434/v1"
    model: str = "qwen3.5:9b-agent"
    api_key: str = "ollama"
    temperature: float = 0.3


class PlanRequest(BaseModel):
    """POST /api/plan request body."""
    input: str = Field(..., min_length=1, max_length=500, description="Natural language routing request")
    k: int = Field(default=5, ge=1, le=20, description="Number of candidate routes")
    llm_config: LLMConfigSchema | None = None
    cycle: str | None = Field(default=None, description="AIRAC cycle (e.g., '2604')")


class ParsedIntentResponse(BaseModel):
    """Parsed routing intent (subset of PlanResponse)."""
    origin: str | None = None
    destination: str | None = None
    airway_type: str | None = None
    avoid_waypoints: list[str] = []
    avoid_airspaces: list[str] = []
    prefer_sid: str | None = None
    prefer_star: str | None = None
    cruise_altitude: int | None = None
    confidence: float = 0.0


class RouteSegmentResponse(BaseModel):
    """A single route segment."""
    from_ident: str
    to_ident: str
    segment_type: str  # "airway", "DCT", "SID", "STAR"
    airway_name: str = ""
    distance_nm: float = 0.0


class RouteCandidateResponse(BaseModel):
    """A candidate route with metadata."""
    index: int
    route_string: str
    total_distance_nm: float
    segments: list[RouteSegmentResponse] = []
    score: float | None = None
    eval_reason: str = ""


class PlanResponse(BaseModel):
    """POST /api/plan response."""
    parsed: ParsedIntentResponse | None = None
    route_string: str = ""
    candidates: list[RouteCandidateResponse] = []
    warnings: list[str] = []
    error: str | None = None


class AirportResult(BaseModel):
    """Airport search result."""
    icao: str | None
    ident: str
    iata: str | None
    name: str
    city: str | None
    lat: float
    lon: float


class AirportSearchResponse(BaseModel):
    """GET /api/airports response."""
    results: list[AirportResult]


class WaypointResult(BaseModel):
    """Waypoint search result."""
    ident: str
    wp_type: str
    lat: float
    lon: float


class WaypointSearchResponse(BaseModel):
    """GET /api/waypoints response."""
    results: list[WaypointResult]


class HealthResponse(BaseModel):
    """GET /api/health response."""
    status: str
    airac_cycle: str | None = None
    airway_nodes: int = 0
    airway_edges: int = 0
    llm_configured: bool = False


class CycleInfo(BaseModel):
    """AIRAC cycle metadata."""
    id: str
    label: str
    valid_from: str = ""
    valid_to: str = ""


class CyclesResponse(BaseModel):
    """GET /api/cycles response."""
    cycles: list[CycleInfo]
    default: str
