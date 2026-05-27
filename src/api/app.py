"""
FastAPI application entry point for AI Flight Planner.

Loads the airway graph at startup and exposes REST API endpoints
for natural language flight route planning.
"""
import logging
from contextlib import asynccontextmanager

import networkx as nx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from src.config import config
from src.db.graph_builder import WaypointInfo

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level globals — populated at startup
# ---------------------------------------------------------------------------

# The airway graph (NetworkX DiGraph), loaded once at startup.
airway_graph: nx.DiGraph | None = None

# Waypoint lookup table: {waypoint_id: WaypointInfo}
waypoint_map: dict[int, WaypointInfo] = {}

# Graph statistics for /api/health
graph_stats: dict = {"nodes": 0, "edges": 0}

# Track which cycle the current graph was built from
_current_cycle: str | None = None


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: load airway graph into memory. Shutdown: cleanup."""
    logger.info("Loading airway graph at startup...")
    await _load_graph()

    yield

    logger.info("Shutting down...")
    global airway_graph, waypoint_map, _current_cycle
    airway_graph = None
    waypoint_map.clear()
    _current_cycle = None


# ---------------------------------------------------------------------------
# Graph loading (also called to switch cycles at runtime)
# ---------------------------------------------------------------------------

async def _load_graph(cycle: str | None = None):
    """Load the airway graph, optionally for a specific AIRAC cycle."""
    global airway_graph, waypoint_map, graph_stats, _current_cycle

    # Resolve DB path and reconnect if needed
    from src.config import resolve_db_path
    from src.db.connection import reconnect_db
    from src.db.graph_builder import build_airway_graph

    db_path = resolve_db_path(cycle)
    logger.info(f"Using database: {db_path}")

    # Reconnect if the DB path has changed
    reconnect_db(db_path)

    try:
        airway_graph, waypoint_map = build_airway_graph(airway_type=None)
        graph_stats = {
            "nodes": airway_graph.number_of_nodes(),
            "edges": airway_graph.number_of_edges(),
        }
        _current_cycle = cycle
        logger.info(
            f"Airway graph loaded: {graph_stats['nodes']} nodes, "
            f"{graph_stats['edges']} edges (cycle={cycle or 'default'})"
        )
    except Exception as e:
        logger.error(f"Failed to load airway graph: {e}")


# ---------------------------------------------------------------------------
# App creation
# ---------------------------------------------------------------------------

app = FastAPI(
    title="AI Flight Planner",
    description="Natural language flight route planning powered by LLM + real Navigraph data",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — allow frontend (localhost:8000) and any local dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routes
from src.api.routes import router  # noqa: E402 (must be after app creation)

app.include_router(router)

# Static files (frontend SPA) — served at /
try:
    app.mount("/", StaticFiles(directory="static", html=True), name="static")
except RuntimeError:
    logger.warning("Static files directory not found — frontend will not be served")
