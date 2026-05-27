"""
REST API routes — all endpoints for the AI Flight Planner.
"""
import logging

from fastapi import APIRouter, HTTPException

from src.api.schemas import (
    PlanRequest,
    PlanResponse,
    ParsedIntentResponse,
    RouteCandidateResponse,
    RouteSegmentResponse,
    AirportSearchResponse,
    AirportResult,
    WaypointSearchResponse,
    WaypointResult,
    HealthResponse,
    CycleInfo,
    CyclesResponse,
)
from src.db.airport import search as search_airports
from src.db.connection import get_db, reconnect_db
from src.ai.nlp_parser import parse_intent
from src.ai.route_evaluator import evaluate_routes
from src.route.models import ParsedIntent, RouteCandidate
from src.config import config, list_cycles

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@router.get("/health", response_model=HealthResponse)
async def health():
    """Return service health and DB metadata."""
    try:
        db = get_db()
        airac = db.execute("SELECT value FROM metadata WHERE name='airac_cycle'").fetchone()
        airac_cycle = airac["value"] if airac else None
    except Exception:
        airac_cycle = None

    # Graph stats are set by the app startup event
    from src.api.app import graph_stats
    return HealthResponse(
        status="ok",
        airac_cycle=airac_cycle,
        airway_nodes=graph_stats.get("nodes", 0),
        airway_edges=graph_stats.get("edges", 0),
        llm_configured=True,  # always available (frontend provides config)
    )


# ---------------------------------------------------------------------------
# AIRAC cycles
# ---------------------------------------------------------------------------

@router.get("/cycles", response_model=CyclesResponse)
async def get_cycles():
    """Return available AIRAC cycles with metadata and default cycle ID."""
    cycles = list_cycles()
    return CyclesResponse(
        cycles=[
            CycleInfo(
                id=c["id"],
                label=c["label"],
                valid_from=c.get("valid_from", ""),
                valid_to=c.get("valid_to", ""),
            )
            for c in cycles
        ],
        default=config.default_cycle,
    )


# ---------------------------------------------------------------------------
# Core: plan route
# ---------------------------------------------------------------------------

@router.post("/plan", response_model=PlanResponse, responses={
    400: {"description": "Invalid input"},
    503: {"description": "LLM unavailable"},
})
async def plan_route(request: PlanRequest):
    """
    Plan a flight route from natural language input.

    Pipeline:
      1. NLP Parser: natural language → structured params (LLM or fallback)
      2. Graph Search: K-shortest paths through the airway network
      3. Route Evaluator: LLM ranks candidates by quality
      4. Return best route + all candidates
    """
    llm_cfg = request.llm_config.model_dump() if request.llm_config else None

    # --- Cycle switching: reload graph if cycle changed ---
    from src.api.app import airway_graph, waypoint_map, _current_cycle as _cur, _load_graph
    if request.cycle and request.cycle != _cur:
        logger.info(f"Cycle change requested: {_cur} → {request.cycle}. Reloading graph...")
        await _load_graph(request.cycle)
        # Re-import globals after reload
        from src.api.app import airway_graph as g2, waypoint_map as w2
        airway_graph, waypoint_map = g2, w2

    if airway_graph is None:
        raise HTTPException(status_code=503, detail="Airway graph not initialized. Try again shortly.")

    # --- Step 1: Parse intent ---
    try:
        intent = await parse_intent(request.input, llm_cfg)
    except Exception as e:
        logger.error(f"NLP parsing failed: {e}")
        raise HTTPException(status_code=400, detail=f"Cannot parse input: {e}")

    if not intent.origin or not intent.destination:
        raise HTTPException(
            status_code=400,
            detail="Could not determine origin and/or destination airport. Please specify ICAO codes (e.g., VHHH, RJTT)."
        )

    # --- Step 2: Find routes ---
    from src.route.graph_search import find_routes

    # Resolve avoid_waypoints to IDs
    avoid_ids = []
    if intent.avoid_waypoints:
        for wp_ident in intent.avoid_waypoints:
            for wp_id, wp_info in waypoint_map.items():
                if wp_info.ident.upper() == wp_ident.upper():
                    avoid_ids.append(wp_id)
                    break

    try:
        candidates = find_routes(
            intent.origin,
            intent.destination,
            airway_graph,
            waypoint_map,
            k=request.k,
            avoid_waypoint_ids=avoid_ids,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Route search failed: {e}")
        raise HTTPException(status_code=500, detail=f"Route search error: {e}")

    if not candidates:
        return PlanResponse(
            parsed=_intent_to_response(intent),
            error="No routes found between specified airports.",
        )

    # --- Step 3: Evaluate routes with LLM ---
    user_prefs = _build_user_prefs(intent)
    try:
        best_idx, rankings = await evaluate_routes(
            intent.origin,
            intent.destination,
            candidates,
            user_preferences=user_prefs,
            llm_config=llm_cfg,
        )
    except Exception as e:
        logger.warning(f"Route evaluation failed (using distance order): {e}")
        best_idx = 0
        rankings = []

    # --- Step 4: Build response ---
    # Put best route first
    if 0 <= best_idx < len(candidates):
        best = candidates[best_idx]
    else:
        best = candidates[0]

    candidate_responses = [
        RouteCandidateResponse(
            index=c.index,
            route_string=c.route_string,
            total_distance_nm=c.total_distance_nm,
            segments=[
                RouteSegmentResponse(
                    from_ident=s.from_ident,
                    to_ident=s.to_ident,
                    segment_type=s.segment_type,
                    airway_name=s.airway_name,
                    distance_nm=s.distance_nm,
                )
                for s in c.segments
            ],
            score=c.score,
            eval_reason=c.eval_reason,
        )
        for c in candidates
    ]

    warnings = []
    if intent.confidence < 0.5:
        warnings.append("Low confidence in parsing — results may not match your intent")
    if not rankings:
        warnings.append("Route evaluation unavailable — routes sorted by distance only")

    return PlanResponse(
        parsed=_intent_to_response(intent),
        route_string=best.route_string,
        candidates=candidate_responses,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Airport autocomplete
# ---------------------------------------------------------------------------

@router.get("/airports", response_model=AirportSearchResponse)
async def search_airport_endpoint(q: str = "", limit: int = 10):
    """Search airports by ICAO, IATA, name, or city."""
    if not q or len(q) < 1:
        return AirportSearchResponse(results=[])

    results = search_airports(q, limit=limit)
    return AirportSearchResponse(
        results=[
            AirportResult(
                icao=r.icao,
                ident=r.ident,
                iata=r.iata,
                name=r.name,
                city=r.city,
                lat=r.lat,
                lon=r.lon,
            )
            for r in results
        ]
    )


# ---------------------------------------------------------------------------
# Waypoint autocomplete
# ---------------------------------------------------------------------------

@router.get("/waypoints", response_model=WaypointSearchResponse)
async def search_waypoint_endpoint(q: str = "", limit: int = 10):
    """Search waypoints by ident prefix."""
    if not q or len(q) < 1:
        return WaypointSearchResponse(results=[])

    db = get_db()
    rows = db.execute(
        "SELECT ident, type, laty, lonx FROM waypoint WHERE upper(ident) LIKE ? LIMIT ?",
        (f"{q.upper()}%", limit),
    ).fetchall()

    return WaypointSearchResponse(
        results=[
            WaypointResult(ident=r["ident"], wp_type=r["type"], lat=r["laty"], lon=r["lonx"])
            for r in rows
        ]
    )


# ---------------------------------------------------------------------------
# AIRAC Cycle switching
# ---------------------------------------------------------------------------

from pydantic import BaseModel as PydanticBaseModel

class CycleSwitchRequest(PydanticBaseModel):
    cycle: str


@router.post("/cycle", response_model=HealthResponse)
async def set_cycle(body: CycleSwitchRequest):
    """
    Switch to a different AIRAC cycle and reload the airway graph.

    Request body: { "cycle": "2604" }
    """
    from src.api.app import _load_graph, graph_stats

    cycle_id = body.cycle

    try:
        await _load_graph(cycle_id)
        stats = graph_stats
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to switch cycle: {e}")
        raise HTTPException(status_code=500, detail=f"Cycle switch failed: {e}")

    # Read the actual AIRAC cycle from the DB metadata
    try:
        db = get_db()
        airac = db.execute(
            "SELECT value FROM metadata WHERE name='airac_cycle'"
        ).fetchone()
        airac_cycle = airac["value"] if airac else cycle_id
    except Exception:
        airac_cycle = cycle_id

    config.current_cycle = cycle_id

    return HealthResponse(
        status="ok",
        airac_cycle=airac_cycle,
        airway_nodes=stats["nodes"],
        airway_edges=stats["edges"],
        llm_configured=True,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _intent_to_response(intent: ParsedIntent) -> ParsedIntentResponse:
    """Convert internal ParsedIntent to API response model."""
    return ParsedIntentResponse(
        origin=intent.origin,
        destination=intent.destination,
        airway_type=intent.airway_type,
        avoid_waypoints=intent.avoid_waypoints,
        avoid_airspaces=intent.avoid_airspaces,
        prefer_sid=intent.prefer_sid,
        prefer_star=intent.prefer_star,
        cruise_altitude=intent.cruise_altitude,
        confidence=intent.confidence,
    )


def _build_user_prefs(intent: ParsedIntent) -> str:
    """Build a user preferences string for the evaluator prompt."""
    parts = []
    if intent.airway_type:
        type_name = {"J": "high-altitude jet airways", "B": "low-altitude", "V": "Victor airways"}.get(
            intent.airway_type, intent.airway_type
        )
        parts.append(f"Prefer {type_name}")
    if intent.cruise_altitude:
        parts.append(f"Cruise altitude: FL{intent.cruise_altitude // 100}")
    if intent.avoid_waypoints:
        parts.append(f"Avoid waypoints: {', '.join(intent.avoid_waypoints)}")
    if intent.avoid_airspaces:
        parts.append(f"Avoid airspaces: {', '.join(intent.avoid_airspaces)}")
    return "; ".join(parts) if parts else ""
