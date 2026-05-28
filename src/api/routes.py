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
    ProceduresResponse,
    ProcedureSummary,
    ProcedureDetailResponse,
    ProcedureLegResponse,
    ProcedureFilterRequest,
    ProcedureFilterResponse,
    RouteFilterRequest,
    RouteFilterResponse,
    WaypointDetailResponse,
    RouteWaypointsResponse,
    WeatherResponse,
    WeatherStation,
    WeatherMetar,
    WeatherWind,
    WeatherCloud,
    WeatherAirport,
    WeatherTaf,
    TafTrend,
    AirportDetailResponse,
    AirportInfo,
    RunwayInfo,
    ComInfo,
    ProcedureInfo,
    ApproachInfo,
)
from src.db.airport import search as search_airports
from src.db.connection import get_db, reconnect_db, reconnect_s3db
from src.ai.nlp_parser import parse_intent
from src.ai.route_evaluator import evaluate_routes
from src.route.models import ParsedIntent, RouteCandidate
from src.config import config, list_cycles

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

# Session-level cache for the last plan result (used by /api/route/{idx}/waypoints).
# Lives in app memory — resets on restart, not persisted.
_last_plan_candidates: list | None = None


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
                has_sid_star=c.get("has_sid_star", False),
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
        raise HTTPException(status_code=400, detail="Cannot determine origin/destination. Please specify ICAO codes explicitly.")

    # Look up IATA codes from LNM DB
    try:
        from src.db.connection import get_db
        db = get_db()
        row = db.execute("SELECT iata FROM airport WHERE upper(ident)=? OR upper(icao)=?",
                         (intent.origin.upper(), intent.origin.upper())).fetchone()
        if row and row["iata"]:
            intent.origin_iata = row["iata"]
        row = db.execute("SELECT iata FROM airport WHERE upper(ident)=? OR upper(icao)=?",
                         (intent.destination.upper(), intent.destination.upper())).fetchone()
        if row and row["iata"]:
            intent.dest_iata = row["iata"]
    except Exception:
        pass

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
            prefer_sid=intent.prefer_sid,
            prefer_star=intent.prefer_star,
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

    # --- Step 3: Evaluate routes with LLM (if enabled) ---
    user_prefs = _build_user_prefs(intent)
    eval_enabled = getattr(request, 'use_evaluator', True)
    if eval_enabled:
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
    else:
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

    # Cache for /api/route/{idx}/waypoints
    global _last_plan_candidates
    _last_plan_candidates = candidates

    return PlanResponse(
        parsed=_intent_to_response(intent),
        route_string=best.route_string,
        candidates=candidate_responses,
        candidate_index=best_idx or 0,
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
# SID/STAR procedures
# ---------------------------------------------------------------------------

@router.get("/procedures", response_model=ProceduresResponse)
async def get_procedures(airport: str = "", type: str = ""):
    """
    Return SID and STAR procedures for a given airport.

    Query params:
        airport: ICAO airport code (e.g., "VHHH"). Case-insensitive.
        type: "sid", "star", or empty (both).
    """
    if not airport or len(airport) < 4:
        raise HTTPException(status_code=400, detail="Airport ICAO code required (4 characters)")

    from src.db.sidstar import get_procedures as get_procs

    try:
        data = get_procs(airport.upper())
    except Exception as e:
        logger.warning(f"Procedure query failed for {airport}: {e}")
        return ProceduresResponse(icao=airport.upper())

    sids = [ProcedureSummary(name=s["name"], runways=s["runways"]) for s in data["sids"]]
    stars = [ProcedureSummary(name=s["name"], runways=s["runways"]) for s in data["stars"]]

    # Filter by type if specified
    if type.lower() == "sid":
        stars = []
    elif type.lower() == "star":
        sids = []

    return ProceduresResponse(icao=airport.upper(), sids=sids, stars=stars)


@router.get("/procedures/{name}", response_model=ProcedureDetailResponse)
async def get_procedure_detail(airport: str, name: str, type: str = "sid"):
    """
    Return the full leg-by-leg detail of a specific SID or STAR procedure.

    Path params:
        name: Procedure name (e.g., "RAME1C")
    Query params:
        airport: ICAO airport code (e.g., "VHHH")
        type: "sid" or "star"
    """
    if not airport or len(airport) < 4:
        raise HTTPException(status_code=400, detail="Valid airport ICAO code required")

    from src.db.sidstar import get_procedure_legs

    if type.lower() not in ("sid", "star"):
        raise HTTPException(status_code=400, detail="type must be 'sid' or 'star'")
    proc_type = type.upper()
    proc = get_procedure_legs(airport.upper(), name, proc_type)

    if proc is None:
        raise HTTPException(
            status_code=404,
            detail=f"Procedure '{name}' ({proc_type}) not found for {airport.upper()}",
        )

    return ProcedureDetailResponse(
        name=proc.name,
        procedure_type=proc.procedure_type,
        airport_icao=airport.upper(),
        runways=proc.runways,
        legs=[
            ProcedureLegResponse(
                seqno=leg.seqno,
                waypoint_ident=leg.waypoint_identifier,
                path_termination=leg.path_termination,
                lat=leg.waypoint_latitude,
                lon=leg.waypoint_longitude,
                altitude1=leg.altitude1,
                altitude2=leg.altitude2,
                transition=leg.transition_identifier,
            )
            for leg in proc.legs
        ],
    )


# ---------------------------------------------------------------------------
# Step 3: Procedure filter (filter SID/STAR by route waypoint)
# ---------------------------------------------------------------------------

@router.post("/procedures/filter", response_model=ProcedureFilterResponse)
async def filter_procedures_endpoint(body: ProcedureFilterRequest):
    """
    Filter SID/STAR procedures based on the waypoints extracted from a route string.

    Given a route_string like "VHHH SID OCEAN V3 ... SASAN STAR ZSSS",
    extracts OCEAN (SID exit) and SASAN (STAR entry), then queries the
    .s3db for procedures that pass through those waypoints.

    Request body: { route_string, dep_icao, arr_icao }
    """
    from src.route.step3_filter import filter_for_route

    result = filter_for_route(
        route_string=body.route_string,
        dep_icao=body.dep_icao,
        arr_icao=body.arr_icao,
    )

    return ProcedureFilterResponse(
        sids=[ProcedureSummary(name=p["name"], runways=p["runways"]) for p in result["sids"]],
        stars=[ProcedureSummary(name=p["name"], runways=p["runways"]) for p in result["stars"]],
        sid_node=result.get("sid_node"),
        star_node=result.get("star_node"),
    )


# ---------------------------------------------------------------------------
# Step 3: Route filter (v2 — filter SID/STAR by route string waypoint)
# ---------------------------------------------------------------------------

@router.post("/route/filter", response_model=RouteFilterResponse)
async def filter_route_endpoint(body: RouteFilterRequest):
    """
    Filter SID/STAR procedures based on waypoints extracted from a route string.

    Given a route_string like "VHHH DCT OCEAN V3 SIKOU A1 ELATO DCT ZSSS",
    extracts OCEAN (SID exit waypoint) and ELATO (STAR entry waypoint), then
    queries the .s3db for procedures that pass through those waypoints.

    This is the v2 replacement for POST /api/procedures/filter — it uses
    the token-scan extraction that handles route strings without explicit
    SID/STAR markers.
    """
    from src.route.step3_filter import filter_for_route

    result = filter_for_route(
        route_string=body.route_string,
        dep_icao=body.origin,
        arr_icao=body.destination,
    )

    return RouteFilterResponse(
        origin=body.origin.upper(),
        destination=body.destination.upper(),
        route_string=body.route_string,
        sid_filter_node=result.get("sid_node"),
        star_filter_node=result.get("star_node"),
        sids=[ProcedureSummary(name=p["name"], runways=p["runways"]) for p in result["sids"]],
        stars=[ProcedureSummary(name=p["name"], runways=p["runways"]) for p in result["stars"]],
    )


# ---------------------------------------------------------------------------
# Step 4: Route waypoints (v2 — navigation detail)
# ---------------------------------------------------------------------------

@router.get("/route/{candidate_index}/waypoints", response_model=RouteWaypointsResponse)
async def get_route_waypoints(candidate_index: int):
    """
    Return detailed information for all waypoints in a candidate route.

    Uses the last plan result (session cache). Extracts waypoint idents
    from the candidate's segments, then batch-queries the LNM database
    for type, frequency, and coordinates.
    """
    if _last_plan_candidates is None:
        raise HTTPException(status_code=404, detail="No plan result cached — run /api/plan first")

    candidate = None
    for c in _last_plan_candidates:
        if c.index == candidate_index:
            candidate = c
            break

    if candidate is None:
        raise HTTPException(
            status_code=404,
            detail=f"Candidate {candidate_index} not found in last plan result",
        )

    wp_idents: list[str] = []
    seen: set[str] = set()
    for seg in candidate.segments:
        for ident in (seg.from_ident, seg.to_ident):
            if ident and ident not in seen:
                wp_idents.append(ident)
                seen.add(ident)

    from src.db.airport import get_waypoint_details

    details = get_waypoint_details(wp_idents)

    return RouteWaypointsResponse(
        waypoints=[
            WaypointDetailResponse(
                ident=d["ident"],
                type=d["type"],
                type_label=d["type_label"],
                frequency=d["frequency"],
                lat=d["lat"],
                lon=d["lon"],
            )
            for d in details
        ]
    )


# ---------------------------------------------------------------------------
# Airport detail (runways + SID/STAR filtered by fix)
# ---------------------------------------------------------------------------

ILS_CAT_MAP: dict[str, str] = {
    "0": "ILS",      # no perf indicator / unknown
    "1": "CAT I",
    "2": "CAT II",
    "3": "CAT III",
}


@router.get("/airport/{icao}/detail", response_model=AirportDetailResponse)
async def get_airport_detail(icao: str, fix: str | None = None):
    """
    Return detailed airport info, runways with ILS, and optionally
    SID/STAR procedures filtered by a fix waypoint.

    Path params:
        icao: 4-letter ICAO airport code (e.g., "VHHH")
    Query params:
        fix:  Waypoint identifier (e.g., "ENPAR", "DUMAP").
              When provided, returns SIDs and STARs whose leg waypoints
              include this fix. Each ProcedureInfo includes the full
              waypoint sequence and the exit/initial fix.
    """
    if not icao or len(icao) < 4:
        raise HTTPException(status_code=400, detail="Airport ICAO code required (4 characters)")

    icao_upper = icao.upper()
    db = get_db()

    # --- Airport info ---
    apt_row = db.execute(
        "SELECT ident, name, city, country, laty, lonx, altitude, transition_altitude "
        "FROM airport WHERE upper(ident) = ? OR upper(icao) = ?",
        (icao_upper, icao_upper),
    ).fetchone()

    if apt_row is None:
        raise HTTPException(status_code=404, detail=f"Airport '{icao_upper}' not found")

    airport_info = AirportInfo(
        ident=apt_row["ident"],
        name=apt_row["name"] or "",
        city=apt_row["city"],
        country=apt_row["country"],
        lat=apt_row["laty"],
        lon=apt_row["lonx"],
        elevation_ft=apt_row["altitude"],
        transition_altitude=int(apt_row["transition_altitude"])
        if apt_row["transition_altitude"] is not None else None,
    )

    # --- Runways ---
    rwy_rows = db.execute(
        "SELECT re.name, re.heading, re.ils_ident, "
        "r.length, r.width "
        "FROM runway_end re "
        "JOIN runway r ON r.primary_end_id = re.runway_end_id "
        "  OR r.secondary_end_id = re.runway_end_id "
        "JOIN airport a ON a.airport_id = r.airport_id "
        "WHERE upper(a.ident) = ? "
        "ORDER BY re.name",
        (icao_upper,),
    ).fetchall()

    # Query all ILS for this airport in one batch
    ils_rows = db.execute(
        "SELECT ident, type, frequency, dme_range, gs_pitch, loc_heading "
        "FROM ils WHERE loc_airport_ident = ?",
        (icao_upper,),
    ).fetchall()
    ils_map: dict[str, dict] = {r["ident"]: dict(r) for r in ils_rows}

    runways: list[RunwayInfo] = []
    seen: set[str] = set()
    for r in rwy_rows:
        name = r["name"]
        if name in seen:
            continue
        seen.add(name)

        ils = ils_map.get(r["ils_ident"]) if r["ils_ident"] else None
        ils_cat = ILS_CAT_MAP.get(ils["type"], "ILS") if ils else None
        has_dme = (ils["dme_range"] or 0) > 0 if ils else False

        runways.append(RunwayInfo(
            name=name,
            length_ft=r["length"],
            width_ft=r["width"],
            elevation_ft=apt_row["altitude"],
            heading_deg=ils["loc_heading"] if ils else r["heading"],
            glidepath_deg=ils["gs_pitch"] if ils else None,
            ils_frequency=ils["frequency"] if ils else None,
            ils_ident=ils["ident"] if ils else None,
            ils_cat=ils_cat,
            has_dme=has_dme,
            transition_alt_ft=apt_row["transition_altitude"],
        ))

    # --- SID/STAR filtered by fix ---
    sids: list[ProcedureInfo] | None = None
    stars: list[ProcedureInfo] | None = None

    if fix:
        from src.db.connection import get_s3db
        from src.db.sidstar import SID_RT, STAR_RT

        s3db = get_s3db()
        if s3db is not None:
            fix_upper = fix.upper()

            # Query SIDs: all legs for procedures where any leg matches the fix
            sid_rows = s3db.execute(
                "SELECT procedure_identifier, transition_identifier, seqno, waypoint_identifier "
                "FROM tbl_sids "
                "WHERE airport_identifier = ? "
                f"AND route_type {SID_RT} "
                "AND waypoint_identifier IS NOT NULL "
                "AND procedure_identifier IN ("
                "  SELECT DISTINCT procedure_identifier FROM tbl_sids "
                "  WHERE airport_identifier = ? "
                f" AND route_type {SID_RT} "
                "  AND waypoint_identifier = ?"
                ") "
                "ORDER BY procedure_identifier, transition_identifier, seqno",
                (icao_upper, icao_upper, fix_upper),
            ).fetchall()

            # Group SID legs by (procedure_identifier, transition_identifier)
            sid_groups: dict[tuple[str, str], list[str]] = {}
            for r in sid_rows:
                key = (r["procedure_identifier"], r["transition_identifier"] or "")
                sid_groups.setdefault(key, []).append(r["waypoint_identifier"])

            # Pair runway transitions with named transitions
            sid_paired = []
            from collections import defaultdict
            proc_data = defaultdict(lambda: {"runways": [], "named": {}})
            for (proc, trans), wps in sid_groups.items():
                if trans and trans.upper().startswith("RW"):
                    rwy = trans.replace("RW", "")
                    proc_data[proc]["runways"].append((rwy, wps))
                elif trans:
                    proc_data[proc]["named"][trans] = wps
                else:
                    proc_data[proc]["runways"].append(("", wps))
            for proc, data in proc_data.items():
                for rwy, rwy_wps in data["runways"]:
                    rwy_fix = rwy_wps[-1] if rwy_wps else None
                    # Base case: no transition
                    sid_paired.append(ProcedureInfo(name=proc, runway=rwy or None, transition=None,
                        fix_waypoints=rwy_wps, exit_fix=rwy_fix))
                    # Paired: runway + named transition
                    for ntrans, nwps in data["named"].items():
                        nfix = nwps[-1] if nwps else None
                        sid_paired.append(ProcedureInfo(name=proc, runway=rwy or None, transition=ntrans,
                            fix_waypoints=rwy_wps + nwps, exit_fix=nfix))
                if not data["runways"] and data["named"]:
                    for ntrans, nwps in data["named"].items():
                        nfix = nwps[-1] if nwps else None
                        sid_paired.append(ProcedureInfo(name=proc, runway=None, transition=ntrans,
                            fix_waypoints=nwps, exit_fix=nfix))
            sids = sid_paired

            # Query STARs: all legs for procedures where any leg matches the fix
            star_rows = s3db.execute(
                "SELECT procedure_identifier, transition_identifier, seqno, waypoint_identifier "
                "FROM tbl_stars "
                "WHERE airport_identifier = ? "
                f"AND route_type {STAR_RT} "
                "AND waypoint_identifier IS NOT NULL "
                "AND procedure_identifier IN ("
                "  SELECT DISTINCT procedure_identifier FROM tbl_stars "
                "  WHERE airport_identifier = ? "
                f" AND route_type {STAR_RT} "
                "  AND waypoint_identifier = ?"
                ") "
                "ORDER BY procedure_identifier, transition_identifier, seqno",
                (icao_upper, icao_upper, fix_upper),
            ).fetchall()

            # Group STAR legs by (procedure_identifier, transition_identifier)
            star_groups: dict[tuple[str, str], list[str]] = {}
            for r in star_rows:
                key = (r["procedure_identifier"], r["transition_identifier"] or "")
                star_groups.setdefault(key, []).append(r["waypoint_identifier"])

            stars = [
                ProcedureInfo(
                    name=proc,
                    runway=trans or None,
                    fix_waypoints=wps,
                    exit_fix=wps[0] if wps else None,
                )
                for (proc, trans), wps in star_groups.items()
            ]

    # Link approach procedures to STARs
    if stars and fix:
        try:
            apt_id_row = db.execute("SELECT airport_id FROM airport WHERE upper(ident)=? or upper(icao)=?",
                                    (icao_upper, icao_upper)).fetchone()
            if apt_id_row:
                apt_id = apt_id_row["airport_id"]
                # Get all approaches for this airport
                app_rows = db.execute(
                    "SELECT approach_id, arinc_name, runway_name, type, suffix FROM approach WHERE airport_id=? AND runway_name IS NOT NULL",
                    (apt_id,)).fetchall()
                # Build approach lookup by fix
                for app in app_rows:
                    app_name = (app["type"] or "") + (app["suffix"] or "")
                    arinc = app["arinc_name"]
                    rwy = app["runway_name"]
                    # Get transition fixes for this approach
                    trans_rows = db.execute(
                        "SELECT fix_ident FROM transition WHERE approach_id=? AND fix_ident IS NOT NULL",
                        (app["approach_id"],)).fetchall()
                    # Get approach leg waypoints
                    leg_rows = db.execute(
                        "SELECT fix_ident FROM approach_leg WHERE approach_id=? AND fix_ident IS NOT NULL ORDER BY approach_leg_id",
                        (app["approach_id"],)).fetchall()
                    app_wps = {r["fix_ident"].upper() for r in leg_rows}
                    # For each STAR, check if STAR waypoints overlap with approach
                    for s in stars:
                        star_wps = {w.upper() for w in (s.fix_waypoints or [])}
                        if star_wps & app_wps:
                            s.approaches.append(ApproachInfo(
                                name=app_name or "",
                                arinc_name=arinc,
                                transition=(trans_rows[0]["fix_ident"] if trans_rows else None),
                                runway=rwy,
                            ))
        except Exception as e:
            logger.warning(f"Approach linking failed for {icao_upper}: {e}")

    # Query COM frequencies
    com_rows = db.execute(
        "SELECT c.type, c.frequency, c.name FROM com c "
        "JOIN airport a ON c.airport_id = a.airport_id "
        "WHERE upper(a.ident) = ? ORDER BY c.type, c.frequency",
        (icao_upper,),
    ).fetchall()
    coms = [ComInfo(type=r["type"], frequency_khz=r["frequency"], name=r["name"]) for r in com_rows]

    return AirportDetailResponse(
        airport=airport_info,
        runways=runways,
        coms=coms,
        sids=sids,
        stars=stars,
    )


# ---------------------------------------------------------------------------\n# Weather (METAR + TAF from NOAA)
# ---------------------------------------------------------------------------

NOAA_METAR_URL = "https://aviationweather.gov/api/data/metar/"


@router.get("/weather", response_model=WeatherResponse)
async def get_weather(dep: str = "", arr: str = ""):
    """
    Fetch METAR and TAF for departure and arrival airports from NOAA.

    Query params:
        dep: Departure airport ICAO (e.g., "VHHH")
        arr: Arrival airport ICAO (e.g., "ZSSS")

    Returns parsed METAR with Chinese cloud translations, plus raw TAF.
    """
    import httpx
    from src.weather.metar import parse_metar, parse_taf

    result = WeatherResponse()

    icaos = []
    if dep:
        icaos.append(dep.upper())
    if arr:
        icaos.append(arr.upper())

    if not icaos:
        raise HTTPException(status_code=400, detail="At least one of dep/arr required")

    url = f"{NOAA_METAR_URL}?ids={','.join(icaos)}&taf=1"

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url)
            if resp.status_code != 200:
                logger.warning(f"NOAA API returned {resp.status_code}: {resp.text[:200]}")
                raise HTTPException(status_code=502, detail=f"NOAA API returned {resp.status_code}")
            raw_text = resp.text.strip()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="NOAA API timed out")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch weather: {e}")
        raise HTTPException(status_code=502, detail=f"Failed to fetch weather: {e}")

    # NOAA returns METAR lines followed by TAF lines, separated by blank lines.
    # Each airport's report block starts with its own METAR.
    blocks = _split_noaa_response(raw_text, icaos)

    dep_data = _build_weather_station(dep.upper(), blocks.get(dep.upper(), "")) if dep else None
    arr_data = _build_weather_station(arr.upper(), blocks.get(arr.upper(), "")) if arr else None

    return WeatherResponse(departure=dep_data, arrival=arr_data)


def _split_noaa_response(raw: str, icaos: list[str]) -> dict[str, str]:
    """
    Split NOAA multi-station response into per-ICAO blocks.

    NOAA returns:
        METAR VHHH ...
        TAF VHHH ...

        METAR ZSSS ...
        TAF ZSSS ...

    Returns dict mapping ICAO → combined block text.
    """
    result: dict[str, str] = {}
    current_icao = None
    current_lines: list[str] = []

    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            # Blank line = block separator
            if current_icao:
                result[current_icao] = "\n".join(current_lines)
            current_icao = None
            current_lines = []
            continue

        # Detect ICAO from METAR or TAF prefix
        for icao in icaos:
            if (stripped.upper().startswith(f"METAR {icao}") or
                stripped.upper().startswith(f"TAF {icao}")):
                if current_icao != icao:
                    # Save previous block
                    if current_icao:
                        result[current_icao] = "\n".join(current_lines)
                    current_icao = icao
                    current_lines = []
                break

        current_lines.append(stripped)

    # Save last block
    if current_icao:
        result[current_icao] = "\n".join(current_lines)

    return result


def _build_weather_station(icao: str, block: str) -> WeatherStation | None:
    """Parse a NOAA block for one airport into a WeatherStation model."""
    from src.weather.metar import parse_metar, parse_taf

    if not block:
        return None

    lines = block.splitlines()
    metar_line = ""
    taf_lines: list[str] = []

    for line in lines:
        if line.upper().startswith("METAR"):
            metar_line = line
        else:
            # TAF first line or continuation (TEMPO, BECMG, FM, PROB)
            taf_lines.append(line)

    # Parse METAR
    metar_data = parse_metar(metar_line) if metar_line else None

    # Parse TAF — join all lines (first line has TAF prefix, continuations don't)
    taf_raw_text = "\n".join(taf_lines).strip() if taf_lines else None
    taf_data = parse_taf(taf_raw_text) if taf_raw_text else None

    # Build updated time string: "Updated: 2026-05-28 01:30 UTC"
    updated = None
    updated_iso = None
    if metar_data and metar_data.get("time"):
        updated = f"Updated: {metar_data['time']}"
    if metar_data and metar_data.get("time_iso"):
        updated_iso = metar_data["time_iso"]

    airport_info = WeatherAirport()
    if metar_data:
        ap = metar_data.get("airport", {})
        airport_info = WeatherAirport(
            ident=ap.get("ident", icao),
            name=ap.get("name", ""),
            city=ap.get("city", ""),
            country=ap.get("country", ""),
            elevation_m=ap.get("elevation_m"),
            lat=ap.get("lat"),
            lon=ap.get("lon"),
        )

    metar_model = None
    if metar_data:
        wind_data = metar_data.get("wind", {})
        metar_model = WeatherMetar(
            raw=metar_line,
            icao=metar_data.get("icao", icao),
            airport=airport_info,
            time=metar_data.get("time"),
            wind=WeatherWind(
                dir=wind_data.get("dir"),
                speed_kts=wind_data.get("speed_kts"),
                gust_kts=wind_data.get("gust_kts"),
                dir_compass=wind_data.get("dir_compass"),
                dir_cn=wind_data.get("dir_cn"),
                arrow=wind_data.get("arrow"),
            ),
            wind_text=metar_data.get("wind_text", ""),
            temp_c=metar_data.get("temp_c"),
            dewpt_c=metar_data.get("dewpt_c"),
            visibility_m=metar_data.get("visibility_m"),
            visibility_str=metar_data.get("visibility_str", ""),
            visibility_qualifier=metar_data.get("visibility_qualifier", ""),
            pressure_hpa=metar_data.get("pressure_hpa"),
            pressure_inhg=metar_data.get("pressure_inhg"),
            clouds=[
                WeatherCloud(
                    cover=c.get("cover", ""),
                    cover_cn=c.get("cover_cn", ""),
                    height_ft=c.get("height_ft"),
                    emoji=c.get("emoji", ""),
                    cloud_type=c.get("cloud_type"),
                    cloud_type_cn=c.get("cloud_type_cn"),
                    is_dangerous=c.get("is_dangerous", False),
                )
                for c in metar_data.get("clouds", [])
            ],
            weather=metar_data.get("weather", []),
            flight_rules=metar_data.get("flight_rules", ""),
            elevation_m=metar_data.get("elevation_m"),
        )

    # Build TAF model
    taf_model = None
    if taf_data:
        taf_model = WeatherTaf(
            raw=taf_data.get("raw", taf_raw_text or ""),
            icao=icao,
            time_from=taf_data.get("time_from"),
            time_to=taf_data.get("time_to"),
            wind=WeatherWind(**taf_data["wind"]) if taf_data.get("wind") else WeatherWind(),
            wind_text=taf_data.get("wind_text", ""),
            visibility_m=taf_data.get("visibility_m"),
            visibility_str=taf_data.get("visibility_str", ""),
            clouds=[WeatherCloud(**c) for c in taf_data.get("clouds", [])],
            weather=taf_data.get("weather", []),
            max_temp_c=taf_data.get("max_temp_c"),
            min_temp_c=taf_data.get("min_temp_c"),
            max_temp_time=taf_data.get("max_temp_time"),
            min_temp_time=taf_data.get("min_temp_time"),
            trends=[
                TafTrend(
                    kind=t.get("kind", "TEMPO"),
                    time_from=t.get("time_from"),
                    time_to=t.get("time_to"),
                    wind=WeatherWind(**t["wind"]) if t.get("wind") else WeatherWind(),
                    wind_text=t.get("wind_text", ""),
                    visibility_m=t.get("visibility_m"),
                    visibility_str=t.get("visibility_str", ""),
                    clouds=[WeatherCloud(**c) for c in t.get("clouds", [])],
                    weather=t.get("weather", []),
                    raw=t.get("raw", ""),
                )
                for t in taf_data.get("trends", [])
            ],
        )

    return WeatherStation(
        icao=icao,
        airport=airport_info,
        metar=metar_model,
        metar_raw=metar_line or None,
        taf_raw=taf_raw_text,
        taf=taf_model,
        updated=updated,
        updated_iso=updated_iso,
    )


# ---------------------------------------------------------------------------
# AIRAC Cycle switching
# ---------------------------------------------------------------------------

from pydantic import BaseModel as PydanticBaseModel

class CycleSwitchRequest(PydanticBaseModel):
    cycle: str


# ---------------------------------------------------------------------------
# LLM proxy — fetch model list from configured LLM API (bypass CORS)
# ---------------------------------------------------------------------------

class LlmProxyRequest(PydanticBaseModel):
    base_url: str
    api_key: str = ""


@router.post("/llm/models")
async def proxy_fetch_models(body: LlmProxyRequest):
    """
    Proxy for fetching LLM model list from the configured API endpoint.
    Bypasses browser CORS by routing through the backend.
    """
    import httpx

    base = body.base_url.rstrip("/")
    api_key = body.api_key

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    # Try Ollama /api/tags
    root_url = base.replace("/v1", "")
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{root_url}/api/tags", headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("models"):
                    models = [m["name"] for m in data["models"]]
                    return {"models": sorted(models), "source": "ollama"}
    except Exception:
        pass

    # Try OpenAI-compatible /v1/models
    models_url = f"{base}/models" if base.endswith("/v1") else f"{base}/v1/models"
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(models_url, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                raw = []
                if isinstance(data, list):
                    raw = [m.get("id", "") for m in data if isinstance(m, dict)]
                elif isinstance(data, dict) and "data" in data:
                    raw = [m["id"] for m in data["data"] if m.get("id")]
                return {"models": sorted(raw), "source": "openai"}
    except Exception:
        pass

    return {"models": [], "source": None}


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

    # Reconnect s3db so subsequent SID/STAR queries use the new cycle's database.
    # Even if no .s3db exists for the new cycle (returns None), get_s3db()
    # will detect the mismatch on next call and handle it gracefully.
    reconnect_s3db(cycle_id)

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
        cruise_altitude_min=intent.cruise_altitude_min,
        cruise_altitude_max=intent.cruise_altitude_max,
        confidence=intent.confidence,
        context=intent.context,
        origin_iata=intent.origin_iata,
        dest_iata=intent.dest_iata,
        use_sids=intent.use_sids,
        use_stars=intent.use_stars,
        rnav_capable=intent.rnav_capable,
        aircraft_type=intent.aircraft_type,
        fuel_unit=intent.fuel_unit,
    )


def _build_user_prefs(intent: ParsedIntent) -> str:
    """Build a user preferences string for the evaluator prompt."""
    parts = []
    if intent.prefer_sid:
        parts.append(f"Use SID: {intent.prefer_sid}")
    if intent.prefer_star:
        parts.append(f"Use STAR: {intent.prefer_star}")
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
