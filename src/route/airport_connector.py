"""
Airport-to-airway connector: finds the nearest airway waypoint nodes
for a given airport, enabling route graph search between airports.

Only returns waypoints that exist in the airway graph (not all nav points
like localizers or NDBs that aren't on airways).
"""
import logging
import math
from operator import itemgetter

import networkx as nx

from src.db.airport import Airport
from src.db.graph_builder import WaypointInfo
from src.config import config

logger = logging.getLogger(__name__)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometres."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def find_nearest_airway_nodes(
    airport: Airport,
    wp_map: dict[int, WaypointInfo],
    G: nx.DiGraph | None = None,
    top_n: int | None = None,
    radius_km: float | None = None,
) -> list[tuple[int, float]]:
    """
    Find the nearest N airway waypoints for an airport within a radius.

    Only returns waypoints that are nodes in the airway graph (G), so
    we skip local approach fixes like localizers and NDBs that aren't
    on airways.

    Args:
        airport: The airport to connect from/to.
        wp_map: {waypoint_id: WaypointInfo} lookup table.
        G: The airway graph — only nodes in this graph are considered.
        top_n: Number of nearest nodes to return (default from config).
        radius_km: Search radius in km (default from config).

    Returns:
        List of (waypoint_id, distance_km) sorted by distance ascending.
    """
    top_n = top_n or config.airport_connector_top_n
    radius_km = radius_km or config.airport_connector_radius_km

    candidates: list[tuple[int, float]] = []

    # If graph is provided, only check nodes that are in the graph.
    # Otherwise check all waypoints (used for debugging).
    node_ids = set(G.nodes()) if G is not None else wp_map.keys()

    for wp_id in node_ids:
        wp = wp_map.get(wp_id)
        if wp is None:
            continue
        d = haversine_km(airport.lat, airport.lon, wp.lat, wp.lon)
        if d <= radius_km:
            candidates.append((wp_id, d))

    # Sort by distance, take top N
    candidates.sort(key=itemgetter(1))
    return candidates[:top_n]
