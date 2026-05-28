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

    # Keep original for 'raw' field
    original_raw = raw.strip()

    # Strip "METAR" prefix for parsing
    metar_str = raw.strip()
    if metar_str.upper().startswith("METAR "):
        metar_str = metar_str[6:].strip()

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
            "raw": original_raw,
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

    # Flight rules — manual calculation (metar library's flight_rules() is buggy)
    flight_rules = _calc_flight_rules(visibility_m, clouds)

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
        "raw": original_raw,
    }


def _calc_flight_rules(vis_m: float | None, clouds: list[dict]) -> str:
    """Determine flight rules (VFR/MVFR/IFR/LIFR) from visibility and ceilings."""
    lowest_ceiling = None
    for c in clouds:
        if c.get("cover") in ("BKN", "OVC"):
            h = c.get("height_ft")
            if h is not None and (lowest_ceiling is None or h < lowest_ceiling):
                lowest_ceiling = h

    vis = vis_m if vis_m else 99999

    if vis >= 8000 and (lowest_ceiling is None or lowest_ceiling > 3000):
        return "VFR"
    elif (vis >= 5000 and vis < 8000) or (lowest_ceiling is not None and 1000 < lowest_ceiling <= 3000):
        return "MVFR"
    elif (vis >= 1600 and vis < 5000) or (lowest_ceiling is not None and 500 <= lowest_ceiling <= 1000):
        return "IFR"
    else:
        return "LIFR"


def parse_taf(raw: str) -> dict | None:
    """
    Parse a raw TAF string into structured fields.

    TAF format: TAF VHHH 272300Z 2800/2906 22010KT 9999 FEW015 TX34/2806Z ...
    """
    if not raw or not raw.strip():
        return None

    line = raw.strip()
    if line.upper().startswith("TAF "):
        line = line[4:].strip()

    parts = line.split()
    if len(parts) < 2:
        return None

    result: dict = {"raw": raw}

    # ICAO
    result["icao"] = parts[0] if len(parts[0]) == 4 else ""

    # Time range: 2800/2906
    for p in parts:
        if "/" in p and p[0].isdigit():
            from_s, to_s = p.split("/")
            result["time_from"] = f"20{p[:2]}-{p[2:4]}-{p[4:6]} {from_s}:00 UTC"
            result["time_to"] = f"20{p[:2]}-{p[2:4]}-{p[4:6]} {to_s}:00 UTC"
            break

    # Wind: 22010KT
    wind_match = re.search(r"(\d{3})(\d{2,3})(G\d{2,3})?KT", line)
    if wind_match:
        wdir = float(wind_match.group(1))
        wspd = float(wind_match.group(2))
        gust = wind_match.group(3)
        result["wind"] = {
            "dir": wdir,
            "speed_kts": wspd,
            "gust_kts": float(gust[1:]) if gust else None,
            "dir_compass": _compass(wdir),
        }
        result["wind_text"] = f"{_compass(wdir)} {wspd}kt"
        if gust:
            result["wind_text"] += f" G{gust[1:]}kt"

    # Visibility: 9999
    vis_match = re.search(r" (\d{4}) ", " " + line + " ")
    if vis_match:
        vis = int(vis_match.group(1))
        result["visibility_m"] = float(vis)
        result["visibility_str"] = f"{vis}m" if vis < 10000 else "10km+"

    # Clouds: FEW015 BKN030
    clouds = []
    for m in re.finditer(r"(FEW|SCT|BKN|OVC)(\d{3})", line):
        clouds.append({
            "cover": m.group(1),
            "cover_cn": _CLOUD_CN.get(m.group(1), m.group(1)),
            "height_ft": int(m.group(2)) * 100,
        })
    result["clouds"] = clouds

    # Weather
    wx_list = []
    for m in re.finditer(r"([+-]?(?:VC)?(?:TS|SH|RA|SN|DZ|GR|GS|FG|BR|HZ|FU|SA|DU|VA|SQ|DS|SS|PO|FC|PY))", line):
        wx_list.append(m.group(0))
    result["weather"] = wx_list

    # TX/TN temperature extremes
    tx = re.search(r"TX(\d+)/(\d{4}Z)", line)
    tn = re.search(r"TN(\d+)/(\d{4}Z)", line)
    result["max_temp_c"] = float(tx.group(1)) if tx else None
    result["min_temp_c"] = float(tn.group(1)) if tn else None

    return result
