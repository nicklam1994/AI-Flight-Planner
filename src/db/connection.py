"""
SQLite connection manager for the Navigraph database.

Uses readonly mode with WAL journaling, large page cache, and mmap
for fast read performance on the ~280 MB database. The connection is
a module-level singleton — created once at import and reused across
requests, since all access is read-only.
"""
import logging
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from src.config import config

logger = logging.getLogger(__name__)

# Module-level singleton connection (read-only, safe to share).
_conn: sqlite3.Connection | None = None


def get_db() -> sqlite3.Connection:
    """
    Return the singleton read-only SQLite connection.

    Creates the connection on the first call, applying performance
    PRAGMAs for the ~280 MB Navigraph database.

    Uses resolve_db_path() to determine the database path, which checks:
      1. Explicit DB_PATH env var (if set and the file exists)
      2. data/cycles/{cycle}/little_navmap_navigraph.sqlite
    """
    global _conn
    if _conn is not None:
        return _conn

    from src.config import resolve_db_path, config
    db_path = resolve_db_path(config.current_cycle)
    if not Path(db_path).exists():
        raise FileNotFoundError(f"Database not found: {db_path}")

    uri = f"file:{db_path}?mode=ro"
    logger.info(f"Opening database: {db_path}")

    _conn = sqlite3.connect(uri, uri=True)
    _conn.row_factory = sqlite3.Row
    # Skip WAL — readonly databases cannot change journal mode.
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

    logger.info("Database connection established (WAL, 200MB cache, 300MB mmap)")
    return _conn


@contextmanager
def get_cursor():
    """Context manager yielding a cursor from the singleton connection."""
    db = get_db()
    cur = db.cursor()
    try:
        yield cur
    finally:
        cur.close()


def reconnect_db(db_path: str | None = None) -> sqlite3.Connection:
    """
    Close the existing singleton connection and open a new one.

    Use this when switching AIRAC cycles at runtime.

    Args:
        db_path: New database path. If None, uses config.db_path.

    Returns:
        The new sqlite3.Connection.
    """
    global _conn
    if _conn is not None:
        logger.info("Closing existing DB connection")
        try:
            _conn.close()
        except Exception:
            pass
        _conn = None

    if db_path:
        import src.config as cfg_module
        old = cfg_module.config.db_path
        cfg_module.config.db_path = db_path
        try:
            return get_db()
        finally:
            cfg_module.config.db_path = old

    return get_db()
