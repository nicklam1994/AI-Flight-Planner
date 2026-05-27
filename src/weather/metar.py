"""
Weather module — METAR/TAF parsing and NOAA API integration.

Parses raw METAR strings into structured fields matched to the
WeatherMetar / WeatherResponse API schemas.
"""
import logging
import re
from datetime import datetime

import httpx
from metar import Metar as MetarParser

from src.db.connection import get_db

logger = logging.getLogger(__name__)

# NOAA aviation weather API
NOAA_METAR_URL = "https://aviationweather.gov/api/data/metar/"

# Wind direction → compass map
_DIR_COMPASS = {
    0: "N", 45: "NE", 90: "E", 135: "SE",
    180: "S", 225: "SW", 270: "W", 315: "NW",
}
_DIR_CN = {
    "N": "北", "S": "南", "E": "東", "W": "西",
    "NE": "東北", "NW": "西北", "SE": "東南", "SW": "西南",
}

# Cloud cover Chinese translations
_CLOUD_CN = {
    "FEW": "少雲", "SCT": "疏雲", "BKN": "多雲",
    "OVC": "陰天", "SKC": "晴空", "CLR": "晴空",
    "NSC": "無顯著雲", "NCD": "無雲", "CAVOK": "晴空",
}

# Weather phenomenon Chinese
_WX_CN = {
    "RA": "雨", "SN": "雪", "TS": "雷暴", "FG": "霧",
    "BR": "靄", "HZ": "霾", "DZ": "毛毛雨", "SH": "陣雨",
    "GR": "冰雹", "GS": "小冰雹", "SQ": "颮", "DS": "沙塵暴",
    "SS": "沙暴", "DU": "浮塵", "FU": "煙", "VA": "火山灰",
    "SA": "沙", "PY": "水霧", "+": "大", "-": "小",
    "VC": "附近",
}


def _lookup_airport(icao: str) -> dict:
    """Look up airport info from LNM database."""
    db = get_db()
    row = db.execute(
        "SELECT ident, name, city, country FROM airport WHERE upper(ident) = ? OR upper(icao) = ?",
        (icao.upper(), icao.upper()),
    ).fetchone()

    if row:
        return {
            "ident": row["ident"] or icao,
            "name": row["name"] or "",
            "city": row["city"] or "",
            "country": row["country"] or "",
        }
    return {"ident": icao, "name": "", "city": "", "country": ""}


def _compass(deg: float) -> str:
    """Convert wind direction degrees to compass point."""
    if deg is None:
        return ""
    deg = deg % 360
    points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
              "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    idx = round(deg / 22.5) % 16
    return points[idx]


def parse_metar(raw: str) -> dict | None:
    """
    Parse a raw METAR string into structured fields matching WeatherMetar schema.

    The METAR line from NOAA has format: "METAR VHHH 281030Z 20007KT ..."

    Returns:
        Dict with keys: icao, time, airport, wind, wind_text, temp_c, dewpt_c,
        visibility_m, visibility_str, visibility_qualifier, pressure_hpa,
        pressure_inhg, clouds, weather, flight_rules, raw.
        Returns None if the raw string is empty or None.
    """
    if not raw or not raw.strip():
        return None

    # Strip "METAR" prefix if present
    metar_str = raw.strip()
    if metar_str.upper().startswith("METAR "):
        metar_str = metar_str[6:].strip()
        raw = raw  # keep original for 'raw' field

    try:
        obs = MetarParser.Metar(metar_str)
    except Exception as e:
        logger.warning(f"Failed to parse METAR: {e} | raw={metar_str[:80]}")
        return {
            "icao": metar_str[:4] if len(metar_str) >= 4 else "",
            "time": None,
            "airport": _lookup_airport(metar_str[:4]) if len(metar_str) >= 4 else {},
            "wind": {},
            "wind_text": "",
            "temp_c": None,
            "dewpt_c": None,
            "visibility_m": None,
            "visibility_str": "",
            "visibility_qualifier": "",
            "pressure_hpa": None,
            "pressure_inhg": None,
            "clouds": [],
            "weather": [],
            "flight_rules": "",
            "raw": raw,
        }

    icao = obs.station_id or ""
    airport = _lookup_airport(icao)

    # Time
    time_str = obs.time.strftime("%Y-%m-%d %H:%M UTC") if obs.time else None

    # Wind
    wind = {}
    wind_text = ""
    if obs.wind_dir and obs.wind_speed:
        wdir = obs.wind_dir.value()
        wspd = obs.wind_speed.value()
        compass = _compass(wdir)
        wind = {
            "dir": wdir,
            "speed_kts": wspd,
            "gust_kts": obs.wind_gust.value() if obs.wind_gust else None,
            "dir_compass": compass,
        }
        wind_text = f"{compass} {wspd}kt"
        if obs.wind_gust:
            wind_text += f" G{obs.wind_gust.value()}kt"

    # Temperature / Dew point
    temp_c = obs.temp.value() if obs.temp else None
    dewpt_c = obs.dewpt.value() if obs.dewpt else None

    # Visibility
    visibility_m = None
    visibility_str = ""
    visibility_qualifier = ""
    if obs.vis:
        try:
            vis_sm = float(obs.vis.value("SM"))
            visibility_m = round(vis_sm * 1609.34)
            visibility_str = f"{visibility_m}m"
            if vis_sm >= 5:
                visibility_qualifier = ">5SM"
            elif vis_sm >= 3:
                visibility_qualifier = "3-5SM"
            else:
                visibility_qualifier = "<3SM"
        except Exception:
            pass

    # Pressure
    pressure_hpa = None
    pressure_inhg = None
    if obs.press:
        try:
            pressure_hpa = round(obs.press.value("HPA"), 1)
            pressure_inhg = round(obs.press.value("IN"), 2)
        except Exception:
            pass

    # Clouds
    clouds = []
    if obs.sky:
        for sky_cond in obs.sky:
            cover = sky_cond[0]
            alt = sky_cond[1]
            height_ft = alt.value() * 100 if alt else None
            clouds.append({
                "cover": cover,
                "cover_cn": _CLOUD_CN.get(cover, cover),
                "height_ft": height_ft,
            })

    # Weather phenomena
    weather = []
    if obs.weather:
        for wx in obs.weather:
            weather.append(str(wx))

    # Flight rules
    flight_rules = ""
    try:
        flight_rules = obs.flight_rules() or ""
    except Exception:
        pass

    return {
        "icao": icao,
        "time": time_str,
        "airport": airport,
        "wind": wind,
        "wind_text": wind_text,
        "temp_c": temp_c,
        "dewpt_c": dewpt_c,
        "visibility_m": visibility_m,
        "visibility_str": visibility_str,
        "visibility_qualifier": visibility_qualifier,
        "pressure_hpa": pressure_hpa,
        "pressure_inhg": pressure_inhg,
        "clouds": clouds,
        "weather": weather,
        "flight_rules": flight_rules,
        "raw": raw,
    }
