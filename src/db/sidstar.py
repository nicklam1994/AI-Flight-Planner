"""
SID/STAR procedure queries against the PMDG .s3db database.

Provides data classes for procedure legs and full procedures, plus query
functions that operate on tbl_sids / tbl_stars in the PMDG format.

The PMDG database embeds all procedure leg data directly in the procedure
tables - each row is one leg of a SID or STAR.  Legs are grouped by
(procedure_identifier, transition_identifier) and ordered by seqno.

Route type semantics (from data analysis of cycle 2605):
  - SIDs:  route_type IN ('2','5') - rt=2 for RNAV SIDs, rt=5 for conventional SIDs
           (VHHH example: 41 procedures rt=5, 6 procedures rt=2)
  - STARs: route_type IN ('3','5') - rt=5 dominant, rt=3 for approach transitions

All functions return empty results (never crash) when the .s3db is absent,
allowing the application to gracefully degrade without SID/STAR support.
"""
import logging
from dataclasses import dataclass, field

from src.db.connection import get_s3db

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Route type filters (based on ARINC 424 data analysis)
# ---------------------------------------------------------------------------
# SIDs: both rt='5' (conventional) and rt='2' (RNAV) are valid SIDs
SID_RT = "IN ('2','5')"
# STARs: rt='5' is dominant, rt='3' covers approach transitions
STAR_RT = "IN ('3','5')"


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class ProcedureLeg:
    """A single leg within a SID or STAR procedure."""

    seqno: int
    waypoint_identifier: str | None      # None for VM (heading-to-manual) legs
    path_termination: str                 # CF, TF, IF, DF, VM, etc.
    waypoint_latitude: float | None
    waypoint_longitude: float | None
    turn_direction: str | None            # L or R
    magnetic_course: float | None
    altitude_description: str | None      # + (at/above), - (at/below), B (between)
    altitude1: int | None                 # Primary altitude constraint (ft)
    altitude2: int | None                 # Secondary altitude constraint for 'B' (ft)
    speed_limit: int | None               # Speed constraint (kt IAS)
    transition_identifier: str | None     # Runway or transition (e.g., "RW07C")


@dataclass
class Procedure:
    """A complete SID or STAR procedure with all its legs (per-runway)."""

    name: str                             # e.g., "RAME1C"
    procedure_type: str                   # "SID" or "STAR"
    runways: list[str]                    # e.g., ["RW07C"]
    legs: list[ProcedureLeg] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Query functions
# ---------------------------------------------------------------------------

def _query_distinct_procedures(
    table: str, icao: str, route_type_filter: str
) -> list[str]:
    """
    Return distinct procedure_identifier values for a given airport and table.

    Args:
        table: 'tbl_sids' or 'tbl_stars'
        icao: 4-letter ICAO airport code
        route_type_filter: SQL clause for route_type (e.g., "IN ('2','5')")
    """
    db = get_s3db()
    if db is None:
        return []

    rows = db.execute(
        f"SELECT DISTINCT procedure_identifier FROM {table} "
        f"WHERE airport_identifier = ? AND route_type {route_type_filter} "
        f"AND waypoint_identifier IS NOT NULL "
        "ORDER BY procedure_identifier",
        (icao,),
    ).fetchall()
    return [r["procedure_identifier"] for r in rows]


def list_sids(icao: str) -> list[str]:
    """
    List all SID names for an airport.

    Queries tbl_sids where route_type IN ('2','5') to cover both RNAV and
    conventional SIDs. Returns an empty list if no s3db is available.

    Args:
        icao: 4-letter ICAO airport code (e.g., "VHHH")
    """
    return _query_distinct_procedures("tbl_sids", icao, SID_RT)


def list_stars(icao: str) -> list[str]:
    """
    List all STAR names for an airport.

    Queries tbl_stars where route_type IN ('3','5') to maximise coverage
    across different data versions. Returns an empty list if no s3db is
    available.

    Args:
        icao: 4-letter ICAO airport code (e.g., "VHHH")
    """
    return _query_distinct_procedures("tbl_stars", icao, STAR_RT)


def _get_all_runways(icao: str, table: str, rt_filter: str) -> dict[str, list[str]]:
    """
    Return {procedure_identifier: [transition_identifier, ...]} for all
    procedures at an airport in a single batch query.

    Replaces the N+1 pattern of calling _get_runways() per procedure inside
    get_procedures().  For VHHH (47 SIDs + 14 STARs) this cuts 63 round-trips
    down to 2.

    Args:
        icao: 4-letter ICAO airport code
        table: 'tbl_sids' or 'tbl_stars'
        rt_filter: SQL clause for route_type (e.g., "IN ('2','5')")
    """
    db = get_s3db()
    if db is None:
        return {}
    rows = db.execute(
        f"SELECT DISTINCT procedure_identifier, transition_identifier "
        f"FROM {table} "
        "WHERE airport_identifier = ? "
        f"AND route_type {rt_filter} "
        "AND waypoint_identifier IS NOT NULL "
        "ORDER BY procedure_identifier, transition_identifier",
        (icao,),
    ).fetchall()
    result: dict[str, list[str]] = {}
    for r in rows:
        result.setdefault(r["procedure_identifier"], []).append(
            r["transition_identifier"]
        )
    return result


def _get_runways(icao: str, name: str, proc_type: str) -> list[str]:
    """Return distinct runway/transition identifiers for a procedure."""
    table = "tbl_sids" if proc_type == "SID" else "tbl_stars"
    db = get_s3db()
    if db is None:
        return []

    rt_filter = SID_RT if proc_type == "SID" else STAR_RT
    rows = db.execute(
        f"SELECT DISTINCT transition_identifier FROM {table} "
        "WHERE airport_identifier = ? AND procedure_identifier = ? "
        f"AND route_type {rt_filter} "
        "ORDER BY transition_identifier",
        (icao, name),
    ).fetchall()
    return [r["transition_identifier"] for r in rows]


def get_procedure_legs(icao: str, name: str, proc_type: str) -> Procedure | None:
    """
    Get the complete leg sequence for a specific SID or STAR.

    Legs are ordered by transition_identifier (runway) then seqno. A single
    procedure name may have different legs for different runways.

    Args:
        icao: 4-letter ICAO airport code
        name: Procedure name (e.g., "RAME1C")
        proc_type: "SID" or "STAR"

    Returns:
        A Procedure with all legs, or None if the procedure is not found
        or the s3db is unavailable.
    """
    table = "tbl_sids" if proc_type == "SID" else "tbl_stars"
    db = get_s3db()
    if db is None:
        return None

    rt_filter = SID_RT if proc_type == "SID" else STAR_RT
    rows = db.execute(
        f"SELECT seqno, waypoint_identifier, path_termination, "
        "waypoint_latitude, waypoint_longitude, turn_direction, "
        "magnetic_course, altitude_description, altitude1, altitude2, "
        "speed_limit, transition_identifier "
        f"FROM {table} "
        "WHERE airport_identifier = ? AND procedure_identifier = ? "
        f"AND route_type {rt_filter} AND waypoint_identifier IS NOT NULL "
        "ORDER BY transition_identifier, seqno",
        (icao, name),
    ).fetchall()

    if not rows:
        return None

    runways = list(dict.fromkeys(r["transition_identifier"] for r in rows))
    legs = [
        ProcedureLeg(
            seqno=r["seqno"],
            waypoint_identifier=r["waypoint_identifier"],
            path_termination=r["path_termination"],
            waypoint_latitude=r["waypoint_latitude"],
            waypoint_longitude=r["waypoint_longitude"],
            turn_direction=r["turn_direction"],
            magnetic_course=r["magnetic_course"],
            altitude_description=r["altitude_description"],
            altitude1=r["altitude1"],
            altitude2=r["altitude2"],
            speed_limit=r["speed_limit"],
            transition_identifier=r["transition_identifier"],
        )
        for r in rows
    ]

    return Procedure(
        name=name,
        procedure_type=proc_type,
        runways=runways,
        legs=legs,
    )


def get_procedures(icao: str) -> dict:
    """
    Get all SIDs and STARs for an airport, with runway lists.

    Suitable for API endpoints that need a summary view (name + runways)
    without the full leg data. Use get_procedure_legs() for detailed leg
    sequences.

    Uses _get_all_runways() — 2 queries total regardless of procedure count,
    instead of N+1 individual _get_runways() calls.

    Args:
        icao: 4-letter ICAO airport code

    Returns:
        {"icao": str, "sids": [...], "stars": [...]}
        Each entry in the lists has {"name": str, "runways": [str]}.
    """
    # Two batch queries — one per table — instead of N+1 per-procedure calls.
    sid_runways = _get_all_runways(icao, "tbl_sids", SID_RT)
    star_runways = _get_all_runways(icao, "tbl_stars", STAR_RT)

    return {
        "icao": icao,
        "sids": [
            {"name": name, "runways": rwys}
            for name, rwys in sid_runways.items()
        ],
        "stars": [
            {"name": name, "runways": rwys}
            for name, rwys in star_runways.items()
        ],
    }
