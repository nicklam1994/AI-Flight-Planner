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
    candidate_index: int = 0  # Index of best candidate for /api/route/{index}/waypoints
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
    has_sid_star: bool = False


class CyclesResponse(BaseModel):
    """GET /api/cycles response."""
    cycles: list[CycleInfo]
    default: str


# ---------------------------------------------------------------------------
# Procedures (SID/STAR)
# ---------------------------------------------------------------------------

class ProcedureSummary(BaseModel):
    """A SID or STAR procedure summary (name + runways)."""
    name: str
    runways: list[str] = []


class ProceduresResponse(BaseModel):
    """GET /api/procedures response."""
    icao: str
    sids: list[ProcedureSummary] = []
    stars: list[ProcedureSummary] = []


class ProcedureLegResponse(BaseModel):
    """A single leg within a SID/STAR procedure."""
    seqno: int
    waypoint_ident: str | None = None
    path_termination: str = ""
    lat: float | None = None
    lon: float | None = None
    altitude1: int | None = None
    altitude2: int | None = None
    transition: str | None = None


class ProcedureDetailResponse(BaseModel):
    """GET /api/procedures/{name} response."""
    name: str
    procedure_type: str  # "SID" or "STAR"
    airport_icao: str
    runways: list[str] = []
    legs: list[ProcedureLegResponse] = []


# ---------------------------------------------------------------------------
# Step 3: Procedure filter (filter SID/STAR by route waypoint)
# ---------------------------------------------------------------------------

class ProcedureFilterRequest(BaseModel):
    """POST /api/procedures/filter request."""
    route_string: str
    dep_icao: str
    arr_icao: str


class ProcedureFilterResponse(BaseModel):
    """POST /api/procedures/filter response."""
    sids: list[ProcedureSummary] = []
    stars: list[ProcedureSummary] = []
    sid_node: str | None = None
    star_node: str | None = None


# ---------------------------------------------------------------------------
# Weather
# ---------------------------------------------------------------------------

class WeatherWind(BaseModel):
    dir: float | None = None
    speed_kts: float | None = None
    gust_kts: float | None = None
    dir_compass: str | None = None
    dir_cn: str | None = None
    arrow: str | None = None


class WeatherCloud(BaseModel):
    cover: str = ""
    cover_cn: str = ""
    height_ft: float | None = None
    emoji: str = ""
    cloud_type: str | None = None     # "CB" or "TCU"
    cloud_type_cn: str | None = None
    is_dangerous: bool = False

class WeatherAirport(BaseModel):
    ident: str = ""
    name: str = ""
    city: str = ""
    country: str = ""
    elevation_m: float | None = None
    lat: float | None = None
    lon: float | None = None


class WeatherMetar(BaseModel):
    raw: str = ""
    icao: str = ""
    airport: WeatherAirport = Field(default_factory=WeatherAirport)
    time: str | None = None
    wind: WeatherWind = Field(default_factory=WeatherWind)
    wind_text: str = ""
    temp_c: float | None = None
    dewpt_c: float | None = None
    visibility_m: float | None = None
    visibility_str: str = ""
    visibility_qualifier: str = ""
    pressure_hpa: float | None = None
    pressure_inhg: float | None = None
    clouds: list[WeatherCloud] = Field(default_factory=list)
    weather: list[str] = Field(default_factory=list)
    flight_rules: str = ""
    elevation_m: float | None = None


class WeatherStation(BaseModel):
    icao: str = ""
    airport: WeatherAirport = Field(default_factory=WeatherAirport)
    metar: WeatherMetar | None = None
    metar_raw: str | None = None       # raw METAR text
    taf_raw: str | None = None         # raw TAF text
    taf: "WeatherTaf | None" = None    # parsed TAF fields
    updated: str | None = None         # "Updated: 2026-05-28 01:30 UTC"
    updated_iso: str | None = None     # ISO 8601 timestamp


class WeatherTaf(BaseModel):
    """Parsed TAF fields with trend lines."""
    raw: str = ""
    icao: str = ""
    time_from: str | None = None       # "2026-05-28 00:00 UTC"
    time_to: str | None = None
    wind: WeatherWind = Field(default_factory=WeatherWind)
    wind_text: str = ""
    visibility_m: float | None = None
    visibility_str: str = ""
    clouds: list[WeatherCloud] = Field(default_factory=list)
    weather: list[str] = Field(default_factory=list)
    max_temp_c: float | None = None
    min_temp_c: float | None = None
    max_temp_time: str | None = None    # e.g., "28日06Z"
    min_temp_time: str | None = None
    trends: list["TafTrend"] = Field(default_factory=list)


class TafTrend(BaseModel):
    """A TAF trend line (TEMPO, BECMG, PROB)."""
    kind: str = ""                     # "TEMPO", "BECMG", "PROB30", etc.
    time_from: str | None = None       # e.g., "28日14Z"
    time_to: str | None = None
    wind: WeatherWind = Field(default_factory=WeatherWind)
    wind_text: str = ""
    visibility_m: float | None = None
    visibility_str: str = ""
    clouds: list[WeatherCloud] = Field(default_factory=list)
    weather: list[str] = Field(default_factory=list)
    raw: str = ""                      # original trend text


class WeatherResponse(BaseModel):
    """GET /api/weather response."""
    departure: WeatherStation | None = None
    arrival: WeatherStation | None = None


# ---------------------------------------------------------------------------
# Route filter (v2 Step 3 — filter SID/STAR by route waypoint)
# ---------------------------------------------------------------------------

class RouteFilterRequest(BaseModel):
    """POST /api/route/filter request."""
    origin: str = Field(..., min_length=4, max_length=4)
    destination: str = Field(..., min_length=4, max_length=4)
    route_string: str = Field(..., min_length=1)


class RouteFilterResponse(BaseModel):
    """POST /api/route/filter response."""
    origin: str
    destination: str
    route_string: str
    sid_filter_node: str | None = None
    star_filter_node: str | None = None
    sids: list[ProcedureSummary] = []
    stars: list[ProcedureSummary] = []


# ---------------------------------------------------------------------------
# Route waypoints (v2 Step 4 — navigation details)
# ---------------------------------------------------------------------------

class WaypointDetailResponse(BaseModel):
    """A single waypoint with full detail."""
    ident: str
    type: str
    type_label: str
    frequency: int | None = None  # kHz * 100 (e.g., 11230 = 112.30 MHz)
    lat: float
    lon: float


class RouteWaypointsResponse(BaseModel):
    """GET /api/route/{candidate_index}/waypoints response."""
    waypoints: list[WaypointDetailResponse] = []
