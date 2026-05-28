"""
Graph-based route search using NetworkX's Yen's K-shortest paths algorithm.

Given origin and destination airports, finds K shortest paths through
the airway graph, with support for altitude filtering and waypoint
avoidance.
"""
import logging
from itertools import islice
import re

import networkx as nx

from src.config import config
from src.db.airport import Airport, find_by_icao
from src.db.graph_builder import WaypointInfo, haversine_nm
from src.route.airport_connector import find_nearest_airway_nodes
from src.route.models import RouteCandidate, RouteSegment

logger = logging.getLogger(__name__)


def find_routes(
    origin_icao: str,
    dest_icao: str,
    G: nx.DiGraph,
    wp_map: dict[int, WaypointInfo],
    k: int | None = None,
    min_alt: int | None = None,
    max_alt: int | None = None,
    avoid_waypoint_ids: list[int] | None = None,
    prefer_sid: str | None = None,
    prefer_star: str | None = None,
) -> list[RouteCandidate]:
    """
    Find K shortest paths between two airports through the airway graph.

    Uses Yen's algorithm (NetworkX's shortest_simple_paths) to produce
    multiple candidate routes, then ranks by total distance.

    Args:
        origin_icao: Origin airport ICAO code (e.g., "VHHH").
        dest_icao: Destination airport ICAO code (e.g., "RJTT").
        G: The airway NetworkX DiGraph.
        wp_map: {waypoint_id: WaypointInfo} lookup table.
        k: Number of candidate routes to return (default from config).
        min_alt: Minimum cruise altitude in feet (filters edges below this).
        max_alt: Maximum cruise altitude in feet (filters edges above this).
        avoid_waypoint_ids: Waypoint IDs to exclude from paths.
        prefer_sid: SID procedure name — used for route string annotation only
                    (Phase 1: no auto waypoint pinning).
        prefer_star: STAR procedure name — used for route string annotation only
                     (Phase 1: no auto waypoint pinning).

    Returns:
        List of RouteCandidate, sorted by distance ascending.
    """
    k = k or config.default_k
    k = min(k, config.max_k)
    avoid_waypoint_ids = avoid_waypoint_ids or []

    # --- 1. Resolve airports ---
    origin = find_by_icao(origin_icao)
    dest = find_by_icao(dest_icao)
    if origin is None:
        raise ValueError(f"Origin airport not found: {origin_icao}")
    if dest is None:
        raise ValueError(f"Destination airport not found: {dest_icao}")

    # --- 2. Find nearest airway nodes for each airport ---
    start_nodes = find_nearest_airway_nodes(origin, wp_map, G=G)
    end_nodes = find_nearest_airway_nodes(dest, wp_map, G=G)

    if not start_nodes:
        raise ValueError(f"No airway nodes found near origin: {origin_icao}")
    if not end_nodes:
        raise ValueError(f"No airway nodes found near destination: {dest_icao}")

    logger.info(
        f"Origin {origin_icao}: {len(start_nodes)} nearby airway nodes "
        f"(nearest: {start_nodes[0][1]:.1f} km)"
    )
    logger.info(
        f"Destination {dest_icao}: {len(end_nodes)} nearby airway nodes "
        f"(nearest: {end_nodes[0][1]:.1f} km)"
    )

    # --- 3. Build search graph with super source/sink → use SID/STAR fixes ---
    search_G = G.copy()
    SUPER_SOURCE = -1
    SUPER_SINK = -2
    search_G.add_node(SUPER_SOURCE)
    search_G.add_node(SUPER_SINK)

    # Load SID exit fixes + STAR initial fixes
    from src.db.sidstar import get_sid_exit_fixes, get_star_initial_fixes

    sid_fixes = get_sid_exit_fixes(origin_icao)
    star_fixes = get_star_initial_fixes(dest_icao)
    dep_fix_map = {f["fix"].upper(): f for f in sid_fixes}
    arr_fix_map = {f["fix"].upper(): f for f in star_fixes}

    # Resolve fix waypoints to graph node IDs
    dep_nodes = _resolve_fix_nodes(sid_fixes, wp_map, search_G)
    arr_nodes = _resolve_fix_nodes(star_fixes, wp_map, search_G)

    # Calculate distances from airport to each fix
    for d in dep_nodes:
        d["dist_nm"] = haversine_nm(origin.lat, origin.lon, d["lat"], d["lon"])
    for a in arr_nodes:
        a["dist_nm"] = haversine_nm(dest.lat, dest.lon, a["lat"], a["lon"])

    # Connect super source → dep_fix nodes (use SID fixes as start)
    dep_used = False
    if dep_nodes:
        for d in dep_nodes:
            search_G.add_edge(SUPER_SOURCE, d["waypoint_id"], distance_nm=d["dist_nm"])
        dep_used = True
        logger.info(f"Using {len(dep_nodes)} SID exit fix nodes as departure")
    else:
        # Fallback to airport connectors
        for wp_id, dist_km in start_nodes:
            search_G.add_edge(SUPER_SOURCE, wp_id, distance_nm=dist_km / 1.852)
        logger.info(f"No SID fixes, using {len(start_nodes)} airport connectors for departure")

    # Connect arr_fix nodes → super sink (use STAR fixes as end)
    arr_used = False
    if arr_nodes:
        for a in arr_nodes:
            search_G.add_edge(a["waypoint_id"], SUPER_SINK, distance_nm=a["dist_nm"])
        arr_used = True
        logger.info(f"Using {len(arr_nodes)} STAR initial fix nodes as arrival")
    else:
        for wp_id, dist_km in end_nodes:
            search_G.add_edge(wp_id, SUPER_SINK, distance_nm=dist_km / 1.852)
        logger.info(f"No STAR fixes, using {len(end_nodes)} airport connectors for arrival")

    # --- 4. Apply airway class weighting ---
    _AIRWAY_CLASS_WEIGHT = {"A": 0, "G": 2, "R": 3, "L": 3, "Q": 4, "Y": 5, "H": 5, "J": 6, "W": 8, "V": 8}
    for _u, _v, d in search_G.edges(data=True):
        if _u == SUPER_SOURCE or _v == SUPER_SINK:
            continue
        airway = d.get("airway_name", "")
        if airway:
            cls = airway[0].upper()
            penalty = _AIRWAY_CLASS_WEIGHT.get(cls, 10)
            d["distance_nm"] = d.get("distance_nm", 0) + penalty

    # Remove avoided waypoints
    for wp_id in avoid_waypoint_ids:
        if wp_id in search_G:
            search_G.remove_node(wp_id)

    # --- 5. Run Yen's K-shortest paths (search more than needed for diversity) ---
    search_k = k * 4
    try:
        paths_iter = islice(
            nx.shortest_simple_paths(search_G, SUPER_SOURCE, SUPER_SINK, weight="distance_nm"),
            search_k,
        )
        raw_paths = list(paths_iter)
    except nx.NetworkXNoPath:
        raise ValueError(
            f"No path found between {origin_icao} and {dest_icao} "
            f"with current filters"
        )

    if not raw_paths:
        raise ValueError(f"No path found between {origin_icao} and {dest_icao}")

    logger.info(f"Found {len(raw_paths)} trunk paths (search_k={search_k})")

    # --- 6. Convert paths + match SID/STAR fixes (first/last node = fix) ---
    dest_icao_code = dest.icao or dest.ident
    candidates: list[RouteCandidate] = []
    SEGMENT_PENALTY_NM = 3.0

    # Build lookup: waypoint_id → fix metadata for dep and arr nodes
    dep_node_map = {d["waypoint_id"]: d for d in dep_nodes}
    arr_node_map = {a["waypoint_id"]: a for a in arr_nodes}

    for idx, path in enumerate(raw_paths):
        clean_path = [n for n in path if n not in (SUPER_SOURCE, SUPER_SINK)]

        if len(clean_path) < 1:
            continue

        first_wp_id = clean_path[0]
        last_wp_id = clean_path[-1]

        dep_info = dep_node_map.get(first_wp_id) if dep_used else None
        arr_info = arr_node_map.get(last_wp_id) if arr_used else None

        dep_fix_ident = dep_info["ident"] if dep_info else None
        arr_fix_ident = arr_info["ident"] if arr_info else None
        dep_sid_name = (dep_info or {}).get("sid_name", "")
        arr_star_name = (arr_info or {}).get("star_name", "")
        dep_dist_nm = (dep_info or {}).get("dist_nm", 0)
        arr_dist_nm = (arr_info or {}).get("dist_nm", 0)

        segments: list[RouteSegment] = []
        total_dist = dep_dist_nm + arr_dist_nm

        # Airport → dep_fix (SID)
        if dep_fix_ident:
            segments.append(RouteSegment(
                from_ident=origin.icao or origin.ident,
                to_ident=dep_fix_ident,
                segment_type="DCT",
                distance_nm=dep_dist_nm,
            ))
        else:
            # Fallback: use airport connector
            wp_info = wp_map.get(first_wp_id)
            if wp_info:
                dist = 0.0
                for nid, d in start_nodes:
                    if nid == first_wp_id:
                        dist = d / 1.852
                        break
                segments.append(RouteSegment(
                    from_ident=origin.icao or origin.ident,
                    to_ident=wp_info.ident,
                    segment_type="DCT", distance_nm=dist,
                ))
                total_dist += dist

        # Middle
        for i in range(len(clean_path) - 1):
            u, v = clean_path[i], clean_path[i + 1]
            edge_data = search_G.get_edge_data(u, v)
            if edge_data is None: continue
            if isinstance(edge_data, dict) and "distance_nm" in edge_data:
                ed = edge_data
            else:
                ed = list(edge_data.values())[0] if isinstance(edge_data, dict) else edge_data
            u_info, v_info = wp_map.get(u), wp_map.get(v)
            if u_info is None or v_info is None: continue
            airway = ed.get("airway_name", "")
            dist = ed.get("distance_nm", 0) or 0
            segments.append(RouteSegment(
                from_ident=u_info.ident, to_ident=v_info.ident,
                segment_type="airway" if airway else "DCT",
                airway_name=airway, distance_nm=dist,
                min_alt=ed.get("min_alt", 0) or 0,
                max_alt=ed.get("max_alt", 99999) or 99999,
            ))
            total_dist += dist

        # arr_fix → airport (STAR)
        if arr_fix_ident:
            segments.append(RouteSegment(
                from_ident=arr_fix_ident,
                to_ident=dest.icao or dest.ident,
                segment_type="DCT",
                distance_nm=arr_dist_nm,
            ))
        else:
            wp_info = wp_map.get(last_wp_id)
            if wp_info:
                dist = 0.0
                for nid, d in end_nodes:
                    if nid == last_wp_id:
                        dist = d / 1.852
                        break
                segments.append(RouteSegment(
                    from_ident=wp_info.ident,
                    to_ident=dest.icao or dest.ident,
                    segment_type="DCT", distance_nm=dist,
                ))
                total_dist += dist

        route_str = build_route_string(
            origin, dest, segments, wp_map,
            prefer_sid=dep_sid_name or "SID",
            prefer_star=arr_star_name or "STAR",
            dep_fix=dep_fix_ident,
            arr_fix=arr_fix_ident,
        )

        score = total_dist + SEGMENT_PENALTY_NM * len(segments)
        candidates.append(RouteCandidate(
            index=idx, route_string=route_str, segments=segments,
            total_distance_nm=round(total_dist, 1), node_path=clean_path, score=score,
        ))

    # Sort by composite score (distance + segment penalty), keep top K
    candidates.sort(key=lambda c: c.score or c.total_distance_nm)
    candidates = candidates[:k]

    # Re-index
    for i, c in enumerate(candidates):
        c.index = i

    return candidates


# ---------------------------------------------------------------------------
# Helper: resolve SID/STAR fix waypoints to graph nodes
# ---------------------------------------------------------------------------

def _resolve_fix_nodes(
    fixes: list[dict],
    wp_map: dict[int, WaypointInfo],
    G: nx.DiGraph,
) -> list[dict]:
    """Resolve SID/STAR fix waypoint idents to graph node IDs."""
    nodes = []
    for f in fixes:
        fix_ident = f["fix"].upper()
        for wp_id, wp in wp_map.items():
            if wp.ident.upper() == fix_ident and wp_id in G.nodes():
                nodes.append({
                    "waypoint_id": wp_id, "ident": wp.ident,
                    "lat": wp.lat, "lon": wp.lon, "dist_nm": 0,
                    "sid_name": f.get("sid", ""),
                    "star_name": f.get("star", ""),
                    "runway": f.get("runway", ""),
                })
                break
    return nodes


# ---------------------------------------------------------------------------
# Great-circle bias: penalize edges far from the direct great-circle line
# ---------------------------------------------------------------------------

def _apply_great_circle_bias(
    G: nx.DiGraph,
    wp_map: dict[int, WaypointInfo],
    lat1: float, lon1: float,
    lat2: float, lon2: float,
) -> None:
    """
    Add penalty to edge weights based on cross-track deviation from the
    great-circle line between (lat1,lon1) and (lat2,lon2).

    Edges whose midpoint deviates N NM from the great-circle get an
    extra N/5 NM penalty (capped at 200 NM).  This naturally biases
    the search toward the direct route corridor.
    """
    import math

    def _cross_track_nm(lat, lon):
        """Cross-track distance (NM) from point to great-circle line A→B."""
        lat1_r, lon1_r = math.radians(lat1), math.radians(lon1)
        lat2_r, lon2_r = math.radians(lat2), math.radians(lon2)
        lat_r, lon_r = math.radians(lat), math.radians(lon)

        d13 = math.acos(
            math.sin(lat1_r) * math.sin(lat_r) +
            math.cos(lat1_r) * math.cos(lat_r) * math.cos(lon_r - lon1_r)
        )
        if d13 < 1e-10:
            return 0.0

        b13 = math.atan2(
            math.sin(lon_r - lon1_r) * math.cos(lat_r),
            math.cos(lat1_r) * math.sin(lat_r) -
            math.sin(lat1_r) * math.cos(lat_r) * math.cos(lon_r - lon1_r)
        )
        b12 = math.atan2(
            math.sin(lon2_r - lon1_r) * math.cos(lat2_r),
            math.cos(lat1_r) * math.sin(lat2_r) -
            math.sin(lat1_r) * math.cos(lat2_r) * math.cos(lon2_r - lon1_r)
        )

        dxt = math.asin(math.sin(d13) * math.sin(b13 - b12))
        return abs(dxt) * 3440.065  # radians → NM

    for _u, _v, d in G.edges(data=True):
        u_wp = wp_map.get(_u)
        v_wp = wp_map.get(_v)
        if not u_wp or not v_wp:
            continue
        mid_lat = (u_wp.lat + v_wp.lat) / 2
        mid_lon = (u_wp.lon + v_wp.lon) / 2
        deviation = _cross_track_nm(mid_lat, mid_lon)
        penalty = min(deviation / 5, 200)
        if penalty > 0:
            d["distance_nm"] = d.get("distance_nm", 0) + penalty


def _auto_match_sid_star(
    candidates: list[RouteCandidate],
    origin_icao: str,
    dest_icao: str,
    origin: Airport,
    dest: Airport,
    wp_map: dict[int, WaypointInfo],
    prefer_sid: str | None,
    prefer_star: str | None,
) -> None:
    """
    Auto-detect SID/STAR procedures from .s3db and inject into route strings.

    For each candidate, extracts the first enroute waypoint (SID exit) and
    last enroute waypoint (STAR entry), queries the PMDG .s3db for matching
    procedures, picks the first match, and rebuilds the route string with
    those procedure names.

    Only runs when prefer_sid/prefer_star are not already explicitly set.
    Gracefully degrades (no-op) if the .s3db is unavailable.
    """
    # If both are already explicitly set, nothing to do
    if prefer_sid and prefer_star:
        return

    # Only attempt auto-match for the top candidates (first 3)
    # to avoid excessive .s3db queries
    for candidate in candidates[:3]:
        try:
            from src.route.step3_filter import filter_for_route

            result = filter_for_route(
                route_string=candidate.route_string,
                dep_icao=origin_icao,
                arr_icao=dest_icao,
            )

            matched_sid = prefer_sid
            matched_star = prefer_star

            if not matched_sid and result.get("sids"):
                matched_sid = result["sids"][0]["name"]
            if not matched_star and result.get("stars"):
                matched_star = result["stars"][0]["name"]

            # Rebuild route string with matched procedures if any found
            if matched_sid != prefer_sid or matched_star != prefer_star:
                candidate.route_string = build_route_string(
                    origin, dest, candidate.segments, wp_map,
                    prefer_sid=matched_sid,
                    prefer_star=matched_star,
                )
                logger.debug(
                    f"Candidate {candidate.index}: auto-matched "
                    f"SID={matched_sid}, STAR={matched_star}"
                )
        except Exception as e:
            logger.debug(f"SID/STAR auto-match skipped for candidate "
                         f"{candidate.index}: {e}")
            continue  # Try next candidate — one failure doesn't mean all fail


def build_route_string(
    origin: Airport,
    dest: Airport,
    segments: list[RouteSegment],
    wp_map: dict[int, WaypointInfo],
    prefer_sid: str | None = None,
    prefer_star: str | None = None,
    dep_fix: str | None = None,
    arr_fix: str | None = None,
) -> str:
    """
    Build an ATS route string.

    Format: ICAO_ORIGIN SID dep_fix AWY1 WP1 ... arr_fix STAR ICAO_DEST
    """
    parts: list[str] = [origin.icao or origin.ident]
    last_ident: str = parts[0]
    dest_icao = dest.icao or dest.ident

    # Determine first/last enroute waypoints
    first_enroute = None
    last_enroute = None
    for seg in segments:
        if seg.segment_type == "DCT" and (seg.to_ident or "").upper() != dest_icao.upper():
            if first_enroute is None:
                first_enroute = seg.to_ident
        if (seg.to_ident or "").upper() != dest_icao.upper():
            last_enroute = seg.to_ident

    # --- SID output ---
    effective_dep = dep_fix or first_enroute
    if prefer_sid and effective_dep:
        parts.append("SID")
        parts.append(effective_dep)
        last_ident = effective_dep
    elif prefer_sid:
        parts.append("SID")
        parts.append(prefer_sid)
        last_ident = prefer_sid

    # --- Enroute compression ---
    i = 0
    while i < len(segments):
        seg = segments[i]

        if seg.segment_type in ("SID", "STAR"):
            i += 1
            continue

        if seg.segment_type == "DCT":
            to_up = (seg.to_ident or "").upper()
            if to_up == dest_icao.upper():
                i += 1
                continue
            if prefer_sid and (seg.from_ident or "").upper() == (origin.icao or origin.ident).upper():
                i += 1
                continue
            if prefer_star and to_up == dest_icao.upper():
                i += 1
                continue

            final_to = seg.to_ident
            j = i + 1
            while j < len(segments):
                ns = segments[j]
                if ns.segment_type == "DCT" and (ns.to_ident or "").upper() != dest_icao.upper():
                    final_to = ns.to_ident
                    j += 1
                else:
                    break
            if final_to != last_ident:
                parts.append("DCT")
                parts.append(final_to)
                last_ident = final_to
            i = j
            continue

        # Airway compression
        airway_name = seg.airway_name
        start_wp = seg.from_ident
        end_wp = seg.to_ident
        j = i + 1
        while j < len(segments):
            ns = segments[j]
            if ns.segment_type == "airway" and ns.airway_name == airway_name:
                end_wp = ns.to_ident
                j += 1
            else:
                break
        if (start_wp or "") != last_ident:
            parts.append(start_wp or "")
        parts.append(airway_name)
        parts.append(end_wp or "")
        last_ident = end_wp or ""
        i = j

    # --- STAR output ---
    effective_arr = arr_fix or last_enroute
    if prefer_star and effective_arr:
        if (effective_arr or "") != last_ident:
            parts.append(effective_arr or "")
        parts.append("STAR")
        last_ident = "STAR"
    elif prefer_star:
        parts.append(prefer_star or "")
        parts.append("STAR")

    if last_ident != dest_icao:
        parts.append(dest_icao)

    return " ".join(parts)
