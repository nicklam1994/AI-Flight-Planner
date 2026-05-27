"""
SQLite connection manager for both Navigraph (.sqlite) and PMDG (.s3db) databases.

- LNM (Little Navmap): airway/waypoint/airport data for graph search
- PMDG (s3db): SID/STAR procedure data for departure/arrival routing

Both use readonly singletons with performance PRAGMAs.
"""
import logging
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from src.config import config

logger = logging.getLogger(__name__)

# Module-level singletons (read-only, safe to share).
_conn: sqlite3.Connection | None = None       # LNM airway database
_s3db_conn: sqlite3.Connection | None = None   # PMDG SID/STAR database


# ---------------------------------------------------------------------------
# LNM (Little Navmap) connection - airway/waypoint/airport data
# ---------------------------------------------------------------------------

def get_db() -> sqlite3.Connection:
    """
    Return the singleton read-only LNM SQLite connection.

    Creates the connection on the first call, applying performance
    PRAGMAs for the ~280 MB Navigraph database.

    Uses resolve_db_path() to determine the database path, which checks:
      1. Explicit DB_PATH env var (if set and the file exists)
      2. data/cycles/{cycle}/little_navmap_navigraph.sqlite
    """
    global _conn
    if _conn is not None:
        return _conn

    from src.config import resolve_db_path
    db_path = resolve_db_path(config.current_cycle)
    if not Path(db_path).exists():
        raise FileNotFoundError(f"Database not found: {db_path}")

    uri = f"file:{db_path}?mode=ro"
    logger.info(f"Opening database: {db_path}")

    _conn = sqlite3.connect(uri, uri=True)
    _conn.row_factory = sqlite3.Row
    # Skip WAL - readonly databases cannot change journal mode.
    # The DB is already optimized by LNM at creation time.
    try:
        _conn.execute("PRAGMA cache_size=-200000")  # 200 MB
    except sqlite3.OperationalError:
        pass
    try:
        _conn.execute("PRAGMA mmap_size=300000000")  # 300 MB
    except sqlite3.OperationalError:
        pass
    _conn.execute("PRAGMA query_only=ON")
    try:
        _conn.execute("PRAGMA temp_store=MEMORY")
    except sqlite3.OperationalError:
        pass
    try:
        _conn.enable_load_extension(True)
    except AttributeError:
        pass

    logger.info("LNM database connection established (200MB cache, 300MB mmap)")
    return _conn


@contextmanager
def get_cursor():
    """Context manager yielding a cursor from the LNM connection."""
    db = get_db()
    cur = db.cursor()
    try:
        yield cur
    finally:
        cur.close()


def reconnect_db(db_path: str | None = None) -> sqlite3.Connection:
    """
    Close the existing LNM singleton connection and open a new one.

    Use this when switching AIRAC cycles at runtime.

    Args:
        db_path: New database path. If None, uses config.db_path.
    """
    global _conn
    if _conn is not None:
        logger.info("Closing existing LNM DB connection")
        try:
            _conn.close()
        except Exception:
            pass
        _conn = None

    if db_path:
        import src.config as cfg
        cfg.config.db_path = db_path

    return get_db()


# ---------------------------------------------------------------------------
# PMDG (s3db) connection - SID/STAR procedure data
# ---------------------------------------------------------------------------

def _resolve_s3db_path(cycle: str | None = None) -> str | None:
    """
    Resolve the .s3db file path for a given AIRAC cycle.

    Checks in order:
      1. SID_STAR_DB_PATH env var (explicit override)
      2. data/cycles/{cycle}/e_dfd_PMDG.s3db (cycle-aware path)

    Returns None if no .s3db can be resolved.
    """
    # 1. Explicit env var override
    env_path = os.getenv("SID_STAR_DB_PATH")
    if env_path and Path(env_path).exists():
        return env_path

    # 2. Cycle-aware path
    cycle = cycle or config.current_cycle
    db_path = Path(config.cycles_dir) / cycle / "e_dfd_PMDG.s3db"
    if db_path.exists():
        return str(db_path)

    return None


def get_s3db(cycle: str | None = None) -> sqlite3.Connection | None:
    """
    Return the singleton read-only PMDG .s3db connection for SID/STAR queries.

    The PMDG database (e_dfd_PMDG.s3db) is a separate SQLite file in the same
    cycle directory as the LNM database. It contains ARINC 424 procedure data
    in tbl_sids and tbl_stars tables.

    Returns None if no .s3db file exists for the current cycle - callers must
    handle this gracefully (e.g. return empty lists instead of crashing).

    Args:
        cycle: AIRAC cycle (e.g., '2605'). Defaults to config.current_cycle.

    Returns:
        Read-only sqlite3 connection to the PMDG database, or None if unavailable.
    """
    global _s3db_conn

    # If a different cycle is requested, close and reopen
    if cycle is not None and cycle != config.current_cycle:
        if _s3db_conn is not None:
            try:
                _s3db_conn.close()
            except Exception:
                pass
            _s3db_conn = None

    if _s3db_conn is not None:
        return _s3db_conn

    s3db_path = _resolve_s3db_path(cycle)
    if s3db_path is None:
        logger.debug("No .s3db available - SID/STAR queries will return empty")
        return None

    uri = f"file:{s3db_path}?mode=ro"
    logger.info(f"Opening PMDG database: {s3db_path}")

    _s3db_conn = sqlite3.connect(uri, uri=True)
    _s3db_conn.row_factory = sqlite3.Row
    _s3db_conn.execute("PRAGMA query_only=ON")
    try:
        _s3db_conn.execute("PRAGMA cache_size=-50000")  # 50 MB
    except sqlite3.OperationalError:
        pass

    logger.info("PMDG database connection established")
    return _s3db_conn


def reconnect_s3db(cycle: str | None = None) -> sqlite3.Connection | None:
    """
    Close and reopen the s3db connection, optionally for a new cycle.

    Args:
        cycle: AIRAC cycle identifier. If None, uses config.current_cycle.

    Returns:
        The new connection, or None if no .s3db is available.
    """
    global _s3db_conn
    if _s3db_conn is not None:
        logger.info("Closing existing PMDG DB connection")
        try:
            _s3db_conn.close()
        except Exception:
            pass
        _s3db_conn = None

    return get_s3db(cycle)


@contextmanager
def get_s3db_cursor(cycle: str | None = None):
    """Context manager yielding a cursor from the PMDG s3db connection."""
    db = get_s3db(cycle)
    if db is None:
        raise FileNotFoundError("PMDG .s3db database not available")
    cur = db.cursor()
    try:
        yield cur
    finally:
        cur.close()
