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
        route_str = build_route_string(origin, dest, segments, wp_map)

        candidates.append(RouteCandidate(
            index=idx,
            route_string=route_str,
            segments=segments,
            total_distance_nm=round(total_dist, 1),
            node_path=clean_path,
        ))

    # Sort by total distance
    candidates.sort(key=lambda c: c.total_distance_nm)

    # Re-index
    for i, c in enumerate(candidates):
        c.index = i

    return candidates


def build_route_string(
    origin: Airport,
    dest: Airport,
    segments: list[RouteSegment],
    wp_map: dict[int, WaypointInfo],
) -> str:
    """
    Build an ATS route string from a list of segments.

    Format: ICAO_ORIGIN SID_NAME? WP1 AWY1 WP2 AWY2 ... DCT ICAO_DEST

    Compresses consecutive segments on the same airway into
    "START_WP AWY_NAME END_WP".
    """
    parts = [origin.icao or origin.ident]

    # Compress consecutive same-airway segments
    i = 0
    while i < len(segments):
        seg = segments[i]

        if seg.segment_type in ("SID", "STAR"):
            parts.append(seg.airway_name or seg.segment_type)
            i += 1
            continue

        if seg.segment_type == "DCT":
            parts.append("DCT")
            parts.append(seg.to_ident)
            i += 1
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

        parts.append(start_wp)
        parts.append(airway_name)
        parts.append(end_wp)
        i = j

    # Add destination if not already the last element
    dest_icao = dest.icao or dest.ident
    if parts[-1] != dest_icao:
        parts.append(dest_icao)

    return " ".join(parts)
