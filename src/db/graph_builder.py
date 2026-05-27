"""
Build NetworkX directed graph from the airway table.

Loads airway segments at application startup and returns a DiGraph
with waypoint_id nodes and edges annotated with airway metadata + distances.

Performance: ~0.3s for 29K edges / 17K nodes (J-type airways).
"""
import logging
import math
from dataclasses import dataclass

import networkx as nx

from src.db.connection import get_db
from src.config import config

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class WaypointInfo:
    """Lightweight waypoint lookup entry."""
    waypoint_id: int
    ident: str
    lat: float
    lon: float
    wp_type: str  # WN, WU, V, N, ...


# ---------------------------------------------------------------------------
# Haversine distance (km)
# ---------------------------------------------------------------------------

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in kilometres."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in nautical miles."""
    return haversine_km(lat1, lon1, lat2, lon2) / 1.852


# ---------------------------------------------------------------------------
# Graph builder
# ---------------------------------------------------------------------------

def build_airway_graph(airway_type: str | None = None) -> tuple[nx.DiGraph, dict[int, WaypointInfo]]:
    """
    Build a NetworkX DiGraph from the airway table.

    Args:
        airway_type: 'J' (high-altitude), 'B' (low-altitude), or None (all).

    Returns:
        (graph, waypoint_map) where waypoint_map is {waypoint_id: WaypointInfo}.
    """
    db = get_db()

    # --- 1. Load waypoint info ---
    logger.info("Loading waypoint lookup table...")
    wp_rows = db.execute(
        "SELECT waypoint_id, ident, lonx, laty, type FROM waypoint"
    ).fetchall()
    wp_map: dict[int, WaypointInfo] = {}
    for r in wp_rows:
        wp_map[r["waypoint_id"]] = WaypointInfo(
            waypoint_id=r["waypoint_id"],
            ident=r["ident"],
            lon=r["lonx"],
            lat=r["laty"],
            wp_type=r["type"],
        )

    # --- 2. Load airway segments ---
    where = "WHERE airway_type = ?" if airway_type else ""
    params = (airway_type,) if airway_type else ()
    sql = f"""SELECT airway_name, airway_type, sequence_no,
                     from_waypoint_id, to_waypoint_id,
                     minimum_altitude, maximum_altitude,
                     direction,
                     from_lonx, from_laty, to_lonx, to_laty
              FROM airway {where}
              ORDER BY airway_name, sequence_no"""

    logger.info(f"Loading airway segments (type={airway_type or 'all'})...")
    segments = db.execute(sql, params).fetchall()
    logger.info(f"Loaded {len(segments)} airway segments")

    # --- 3. Build directed graph ---
    G = nx.DiGraph()
    edges_added = 0
    nodes_added = set()

    for seg in segments:
        from_id = seg["from_waypoint_id"]
        to_id = seg["to_waypoint_id"]

        # Get coordinates for distance calculation
        from_wp = wp_map.get(from_id)
        to_wp = wp_map.get(to_id)
        if from_wp is None or to_wp is None:
            continue

        dist_nm = haversine_nm(from_wp.lat, from_wp.lon, to_wp.lat, to_wp.lon)

        # Add nodes if not already present
        if from_id not in nodes_added:
            G.add_node(from_id)
            nodes_added.add(from_id)
        if to_id not in nodes_added:
            G.add_node(to_id)
            nodes_added.add(to_id)

        # --- Determine direction and add edges ---
        # direction = 'F' → forward only (one-way)
        # direction = 'B' or NULL → bidirectional (current default)
        # direction = 'R' → reverse only (one-way opposite)
        direction = seg["direction"]  # sqlite3.Row: None when column is NULL

        def _add_forward_edge():
            G.add_edge(
                from_id, to_id,
                airway_name=seg["airway_name"],
                airway_type=seg["airway_type"],
                sequence_no=seg["sequence_no"],
                min_alt=seg["minimum_altitude"],
                max_alt=seg["maximum_altitude"],
                distance_nm=dist_nm,
                distance_km=dist_nm * 1.852,
            )

        def _add_reverse_edge():
            G.add_edge(
                to_id, from_id,
                airway_name=seg["airway_name"],
                airway_type=seg["airway_type"],
                sequence_no=seg["sequence_no"] + 1000,  # distinguish from forward
                min_alt=seg["minimum_altitude"],
                max_alt=seg["maximum_altitude"],
                distance_nm=dist_nm,
                distance_km=dist_nm * 1.852,
            )

        if direction == "F":
            _add_forward_edge()
            edges_added += 1
        elif direction == "R":
            _add_reverse_edge()
            edges_added += 1
        else:
            # direction == 'B' or NULL: treat as bidirectional
            _add_forward_edge()
            _add_reverse_edge()
            edges_added += 2

    logger.info(
        f"Graph built: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges "
        f"({edges_added} directional segments processed)"
    )
    return G, wp_map
