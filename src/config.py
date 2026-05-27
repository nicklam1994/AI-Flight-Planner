"""
Central configuration for AI Flight Planner.
Loads settings from environment variables with sensible defaults.
"""
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

# Project root (one level above src/)
PROJECT_ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Config:
    """Application-wide configuration, loaded from environment variables."""

    # --- Database ---
    # Default: use the cycles directory with the latest AIRAC cycle.
    # Override with DB_PATH env var (absolute path to a .sqlite file).
    # When using cycle mode, the path is resolved as data/cycles/{cycle}/little_navmap_navigraph.sqlite
    cycles_dir: str = field(
        default_factory=lambda: str(PROJECT_ROOT / "data" / "cycles")
    )
    default_cycle: str = os.getenv("DB_CYCLE", "2604")
    # Runtime-mutable current cycle — initialized to default, updated via POST /api/cycle
    current_cycle: str = field(init=False)

    db_path: str = field(
        default_factory=lambda: os.getenv(
            "DB_PATH",
            str(Path.home() / "workspace/AI Flight Planner/lnm_2604/little_navmap_navigraph.sqlite"),
        )
    )

    # --- LLM defaults (can be overridden per-request from the frontend) ---
    llm_provider: str = os.getenv("LLM_PROVIDER", "ollama")
    llm_base_url: str = os.getenv("LLM_BASE_URL", "http://localhost:11434/v1")
    llm_model: str = os.getenv("LLM_MODEL", "gemma4:e4b")
    llm_api_key: str = os.getenv("LLM_API_KEY", "ollama")
    llm_temperature: float = float(os.getenv("LLM_TEMPERATURE", "0.3"))
    llm_max_tokens: int = int(os.getenv("LLM_MAX_TOKENS", "2000"))
    llm_timeout: float = float(os.getenv("LLM_TIMEOUT", "30.0"))

    # --- Server ---
    host: str = os.getenv("HOST", "0.0.0.0")
    port: int = int(os.getenv("PORT", "8000"))

    # --- CORS ---
    cors_origins: list[str] = field(
        default_factory=lambda: os.getenv("CORS_ORIGINS", "*").split(",")
    )

    # --- Route search ---
    default_k: int = int(os.getenv("DEFAULT_K", "5"))  # K-shortest paths
    max_k: int = int(os.getenv("MAX_K", "20"))
    airport_connector_radius_km: float = float(
        os.getenv("AIRPORT_CONNECTOR_RADIUS_KM", "300.0")
    )
    airport_connector_top_n: int = int(os.getenv("AIRPORT_CONNECTOR_TOP_N", "10"))

    def __post_init__(self):
        """Initialize current_cycle from default_cycle."""
        object.__setattr__(self, "current_cycle", self.default_cycle)


# ---------------------------------------------------------------------------
# Cycle helpers
# ---------------------------------------------------------------------------

def resolve_db_path(cycle: str | None = None) -> str:
    """
    Resolve the database path for a given AIRAC cycle.

    If DB_PATH is explicitly set in the environment (not the default),
    always use it directly — this is for direct DB access mode.
    Otherwise, resolve from data/cycles/{cycle}/little_navmap_navigraph.sqlite.

    Args:
        cycle: AIRAC cycle identifier (e.g., "2604"). Defaults to config.default_cycle.

    Returns:
        Absolute path to the SQLite database.
    """
    # If DB_PATH was explicitly set by the user, use it directly
    explicit_db = os.getenv("DB_PATH")
    if explicit_db and Path(explicit_db).exists():
        return explicit_db

    cycle = cycle or config.default_cycle
    db_path = Path(config.cycles_dir) / cycle / "little_navmap_navigraph.sqlite"

    if db_path.exists():
        return str(db_path)

    raise FileNotFoundError(
        f"No database found for cycle {cycle} at {db_path}. "
        f"Available cycles: {list_cycle_ids()}"
    )


def list_cycles() -> list[dict]:
    """
    List all available AIRAC cycles with metadata.

    Returns a list of dicts with keys: id, label, db_path, valid_from, valid_to.
    Sorted newest-first.
    """
    cycles_dir = Path(config.cycles_dir)
    if not cycles_dir.exists():
        return []

    result = []
    for entry in sorted(cycles_dir.iterdir(), reverse=True):
        if not entry.is_dir() or entry.name.startswith("."):
            continue

        sqlite_file = entry / "little_navmap_navigraph.sqlite"
        if not sqlite_file.exists():
            continue

        # Read cycle metadata from cycle_info.txt or cycle.json
        cycle_info = _read_cycle_meta(entry)
        cycle_info["id"] = entry.name
        cycle_info["db_path"] = str(sqlite_file)

        result.append(cycle_info)

    return result


def list_cycle_ids() -> list[str]:
    """Return just the cycle IDs available."""
    return [c["id"] for c in list_cycles()]


def _read_cycle_meta(cycle_dir: Path) -> dict:
    """
    Read cycle metadata from cycle_info.txt.

    Returns dict with: label, valid_from, valid_to.
    """
    label = cycle_dir.name
    valid_from = ""
    valid_to = ""

    info_file = cycle_dir / "cycle_info.txt"
    if info_file.exists():
        text = info_file.read_text(encoding="utf-8", errors="replace")
        # Parse "Valid (from/to): 19/FEB/2026 - 19/MAR/2026"
        match = re.search(r"Valid\s*\(from/to\)\s*:\s*(\d{1,2}/\w{3}/\d{4})\s*-\s*(\d{1,2}/\w{3}/\d{4})", text)
        if match:
            valid_from = match.group(1)
            valid_to = match.group(2)
        # Parse "AIRAC cycle    : 2602"
        cycle_match = re.search(r"AIRAC\s*cycle\s*:\s*(\d+)", text)
        if cycle_match:
            label = f"{cycle_match.group(1)} ({valid_from} – {valid_to})" if valid_from else cycle_match.group(1)

    # Also check cycle.json
    json_file = cycle_dir / "cycle.json"
    if json_file.exists():
        try:
            data = json.loads(json_file.read_text())
            if "cycle" in data and not valid_from:
                label = data["cycle"]
        except (json.JSONDecodeError, KeyError):
            pass

    return {"label": label, "valid_from": valid_from, "valid_to": valid_to}


# Singleton instance — loaded once at import time.
config = Config()
