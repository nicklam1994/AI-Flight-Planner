"""
Airport queries — look up airports by ICAO/IATA code, name, or city.

In Little Navmap DB, the primary airport code is in the `ident` column;
`icao` is often null. This module searches both.
"""
import logging
from dataclasses import dataclass

from src.db.connection import get_db

logger = logging.getLogger(__name__)


@dataclass
class Airport:
    """A simplified airport record for the API layer."""
    airport_id: int
    ident: str
    icao: str | None
    iata: str | None
    name: str
    city: str
    country: str
    lat: float
    lon: float
    altitude: int | None


def _row_to_airport(row) -> Airport:
    """Convert a sqlite3.Row to an Airport dataclass."""
    return Airport(
        airport_id=row["airport_id"],
        ident=row["ident"],
        icao=row["icao"],
        iata=row["iata"],
        name=row["name"],
        city=row["city"],
        country=row["country"],
        lat=row["laty"],
        lon=row["lonx"],
        altitude=row["altitude"],
    )


def find_by_icao(icao: str) -> Airport | None:
    """
    Find an airport by its ICAO code (case-insensitive).

    In Little Navmap DB, the primary code is in the `ident` column;
    `icao` is often null. We check both.
    """
    db = get_db()
    row = db.execute(
        "SELECT airport_id, ident, icao, iata, name, city, country, laty, lonx, altitude "
        "FROM airport WHERE upper(ident) = ? OR upper(icao) = ?",
        (icao.upper(), icao.upper()),
    ).fetchone()
    if row is None:
        return None
    return _row_to_airport(row)


def find_by_ident(ident: str) -> Airport | None:
    """Find an airport by its ident (case-insensitive)."""
    db = get_db()
    row = db.execute(
        "SELECT airport_id, ident, icao, iata, name, city, country, laty, lonx, altitude "
        "FROM airport WHERE upper(ident) = ?",
        (ident.upper(),),
    ).fetchone()
    if row is None:
        return None
    return _row_to_airport(row)


def search(query: str, limit: int = 10) -> list[Airport]:
    """
    Search airports by ICAO, IATA, name, or city (prefix match).

    Used by the autocomplete endpoint.
    """
    db = get_db()
    pattern = f"{query.upper()}%"
    rows = db.execute(
        """SELECT airport_id, ident, icao, iata, name, city, country, laty, lonx, altitude
           FROM airport
           WHERE upper(ident) LIKE ? OR upper(icao) LIKE ? OR upper(iata) LIKE ?
              OR upper(name) LIKE ? OR upper(city) LIKE ?
           ORDER BY
             CASE WHEN upper(ident) = ? THEN 0
                  WHEN upper(icao) = ? THEN 1
                  WHEN upper(iata) = ? THEN 2
                  ELSE 3 END,
             name
           LIMIT ?""",
        (pattern, pattern, pattern, f"%{query.upper()}%", f"%{query.upper()}%",
         query.upper(), query.upper(), query.upper(), limit),
    ).fetchall()

    return [_row_to_airport(r) for r in rows]
