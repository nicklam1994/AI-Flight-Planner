"""
Graph-based route search using NetworkX's Yen's K-shortest paths algorithm.

Given origin and destination airports, finds K shortest paths through
the airway graph, with support for altitude filtering and waypoint
avoidance.
"""
import logging
from itertools import islice

import networkx as nx

from src.config import config
from src.db.airport import Airport, find_by_icao
from src.db.graph_builder import WaypointInfo
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

    # --- 3. Build search graph with super source/sink ---
    # Clone the graph so we can add virtual edges without mutating the original.
    search_G = G.copy()

    SUPER_SOURCE = -1
    SUPER_SINK = -2

    search_G.add_node(SUPER_SOURCE)
    search_G.add_node(SUPER_SINK)

    start_ids = set()
    end_ids = set()

    for wp_id, dist_km in start_nodes:
        search_G.add_edge(SUPER_SOURCE, wp_id, distance_nm=dist_km / 1.852)
        start_ids.add(wp_id)
    for wp_id, dist_km in end_nodes:
        search_G.add_edge(wp_id, SUPER_SINK, distance_nm=dist_km / 1.852)
        end_ids.add(wp_id)

    # --- 4. Apply filters ---
    # Remove edges that don't meet altitude constraints
    if min_alt is not None or max_alt is not None:
        edges_to_remove = []
        for u, v, d in search_G.edges(data=True):
            if u == SUPER_SOURCE or v == SUPER_SINK:
                continue
            e_min = d.get("min_alt", 0) or 0
            e_max = d.get("max_alt", 99999) or 99999
            if min_alt is not None and e_max < min_alt:
                edges_to_remove.append((u, v))
            if max_alt is not None and e_min > max_alt:
                edges_to_remove.append((u, v))
        search_G.remove_edges_from(edges_to_remove)
        if edges_to_remove:
            logger.info(f"Removed {len(edges_to_remove)} edges due to altitude filter")

    # Remove avoided waypoints
    for wp_id in avoid_waypoint_ids:
        if wp_id in search_G:
            search_G.remove_node(wp_id)

    # --- 5. Run Yen's K-shortest paths ---
    try:
        paths_iter = islice(
            nx.shortest_simple_paths(search_G, SUPER_SOURCE, SUPER_SINK, weight="distance_nm"),
            k,
        )
        raw_paths = list(paths_iter)
    except nx.NetworkXNoPath:
        raise ValueError(
            f"No path found between {origin_icao} and {dest_icao} "
            f"with current filters"
        )

    if not raw_paths:
        raise ValueError(f"No path found between {origin_icao} and {dest_icao}")

    logger.info(f"Found {len(raw_paths)} paths")

    # --- 6. Convert paths to RouteCandidates ---
    candidates: list[RouteCandidate] = []

    for idx, path in enumerate(raw_paths):
        # Remove super source/sink
        clean_path = [n for n in path if n not in (SUPER_SOURCE, SUPER_SINK)]

        # Build segments by walking the path edges
        segments: list[RouteSegment] = []
        total_dist = 0.0

        # First: airport → first waypoint
        if len(clean_path) >= 1:
            first_wp = clean_path[0]
            wp_info = wp_map.get(first_wp)
            if wp_info:
                dist = 0.0
                for nid, d in start_nodes:
                    if nid == first_wp:
                        dist = d / 1.852
                        break
                segments.append(RouteSegment(
                    from_ident=origin.icao or origin.ident,
                    to_ident=wp_info.ident,
                    segment_type="DCT",
                    distance_nm=dist,
                ))
                total_dist += dist

        # Middle: waypoint → waypoint via airway or DCT
        for i in range(len(clean_path) - 1):
            u = clean_path[i]
            v = clean_path[i + 1]
            edge_data = search_G.get_edge_data(u, v)
            if edge_data is None:
                continue

            # If multiple edges exist, take the first
            if isinstance(edge_data, dict) and "distance_nm" in edge_data:
                ed = edge_data
            else:
                ed = list(edge_data.values())[0] if isinstance(edge_data, dict) else edge_data

            u_info = wp_map.get(u)
            v_info = wp_map.get(v)
            if u_info is None or v_info is None:
                continue

            airway = ed.get("airway_name", "")
            dist = ed.get("distance_nm", 0.0)

            segments.append(RouteSegment(
                from_ident=u_info.ident,
                to_ident=v_info.ident,
                segment_type="airway" if airway else "DCT",
                airway_name=airway,
                distance_nm=dist,
                min_alt=ed.get("min_alt", 0) or 0,
                max_alt=ed.get("max_alt", 99999) or 99999,
            ))
            total_dist += dist

        # Last: last waypoint → airport
        if len(clean_path) >= 1:
            last_wp = clean_path[-1]
            wp_info = wp_map.get(last_wp)
            if wp_info:
                dist = 0.0
                for nid, d in end_nodes:
                    if nid == last_wp:
                        dist = d / 1.852
                        break
                segments.append(RouteSegment(
                    from_ident=wp_info.ident,
                    to_ident=dest.icao or dest.ident,
                    segment_type="DCT",
                    distance_nm=dist,
                ))
                total_dist += dist

        # Build route string
        route_str = build_route_string(origin, dest, segments, wp_map, prefer_sid, prefer_star)

        candidates.append(RouteCandidate(
            index=idx,
            route_string=route_str,
            segments=segments,
            total_distance_nm=round(total_dist, 1),
            node_path=clean_path,
        ))

    # --- 7. Auto-match SID/STAR from .s3db ---
    # When the user didn't explicitly specify a SID/STAR, try to match one
    # from the .s3db using the route's first/last enroute waypoints.
    _auto_match_sid_star(candidates, origin_icao, dest_icao, origin, dest,
                          wp_map, prefer_sid, prefer_star)

    # Sort by total distance
    candidates.sort(key=lambda c: c.total_distance_nm)

    # Re-index
    for i, c in enumerate(candidates):
        c.index = i

    return candidates


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
) -> str:
    """
    Build an ATS route string from a list of segments.

    Format: ICAO_ORIGIN SID_NAME? WP1 AWY1 WP2 AWY2 ... DCT STAR_NAME? ICAO_DEST

    Compresses consecutive segments on the same airway into
    "START_WP AWY_NAME END_WP".  Deduplicates waypoints when the
    end of one segment equals the start of the next — both for
    airway→airway and DCT→airway transitions.
    """
    parts: list[str] = [origin.icao or origin.ident]
    last_ident: str = parts[0]  # Track last waypoint/airport to dedup
    dest_icao = dest.icao or dest.ident

    # If SID is specified, insert it after the origin airport
    if prefer_sid:
        parts.append(prefer_sid)
        last_ident = prefer_sid

    # Compress consecutive same-airway segments
    i = 0
    while i < len(segments):
        seg = segments[i]

        if seg.segment_type in ("SID", "STAR"):
            proc_name = seg.airway_name or seg.segment_type
            if proc_name != last_ident:
                parts.append(proc_name)
                last_ident = proc_name
            i += 1
            continue

        if seg.segment_type == "DCT":
            # Skip DCT→airport — destination ICAO is always appended at the end
            if seg.to_ident.upper() == dest_icao.upper():
                i += 1
                continue

            # When SID is already in the route string, don't emit "DCT" for the
            # airport→first-waypoint segment — the SID subsumes the departure leg.
            # Still output the waypoint so it appears as the first enroute fix
            # (the next airway block will dedup it if it starts at the same point).
            if prefer_sid and seg.from_ident.upper() == (origin.icao or origin.ident).upper():
                if seg.to_ident != last_ident:
                    parts.append(seg.to_ident)
                    last_ident = seg.to_ident
                i += 1
                continue

            # Compress consecutive DCT segments: only output the final destination.
            final_to = seg.to_ident
            j = i + 1
            while j < len(segments):
                next_seg = segments[j]
                if (
                    next_seg.segment_type == "DCT"
                    and next_seg.to_ident.upper() != dest_icao.upper()
                ):
                    final_to = next_seg.to_ident
                    j += 1
                else:
                    break

            # Only output DCT + waypoint if not already at this waypoint
            if final_to != last_ident:
                parts.append("DCT")
                parts.append(final_to)
                last_ident = final_to
            i = j
            continue

        # Airway segment: group consecutive same-airway segments
        airway_name = seg.airway_name
        start_wp = seg.from_ident
        end_wp = seg.to_ident

        j = i + 1
        while j < len(segments):
            next_seg = segments[j]
            if next_seg.segment_type == "airway" and next_seg.airway_name == airway_name:
                end_wp = next_seg.to_ident
                j += 1
            else:
                break

        # Dedup: if start_wp == last_ident (from previous DCT or airway),
        # skip it — only output airway_name + end_wp
        if start_wp != last_ident:
            parts.append(start_wp)
        parts.append(airway_name)
        parts.append(end_wp)
        last_ident = end_wp
        i = j

    # Add STAR name before destination if specified
    if prefer_star:
        if last_ident != prefer_star:
            parts.append(prefer_star)
            last_ident = prefer_star
    if last_ident != dest_icao:
        parts.append(dest_icao)

    return " ".join(parts)
