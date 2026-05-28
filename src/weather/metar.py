"""
Weather module — METAR/TAF parsing and NOAA API integration.

Parses raw METAR/TAF strings into structured fields matched to the
WeatherMetar / WeatherTaf / TafTrend API schemas.
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

# Cloud type (CB, TCU) — dangerous cloud types
_CLOUD_TYPE_CN = {
    "CB": "積雨雲", "TCU": "濃積雲",
}

# Weather phenomenon Chinese (enhanced from reference doc)
_WX_CN = {
    "+": "大", "-": "小", "VC": "附近",
    "MI": "淺", "PR": "部分", "BC": "碎片", "DR": "低吹",
    "BL": "高吹", "SH": "陣性", "TS": "雷暴", "FZ": "凍結",
    "RA": "雨", "SN": "雪", "DZ": "毛毛雨", "SG": "雪粒",
    "PL": "冰粒", "GR": "冰雹", "GS": "小冰雹",
    "BR": "靄", "FG": "霧", "HZ": "霾", "SA": "揚沙",
    "DU": "浮塵", "FU": "煙", "VA": "火山灰",
    "SQ": "颮", "DS": "沙塵暴", "SS": "沙暴",
    "PY": "水霧", "FC": "漏斗雲",
}

# Weather emoji — matched to codes
_WX_EMOJI = {
    "TS": "🌩️", "SH": "🌦️", "RA": "🌧️", "SN": "🌨️",
    "FG": "🌫️", "BR": "🌁", "HZ": "😶‍🌫️", "DZ": "🌦️",
    "GR": "🧊", "SQ": "💨", "DS": "🏜️", "DU": "🌫️",
    "FZ": "🧊",
}


def _lookup_airport(icao: str) -> dict:
    """Look up airport info from LNM database including elevation and coordinates."""
    db = get_db()
    row = db.execute(
        "SELECT ident, name, city, country, altitude, laty, lonx "
        "FROM airport WHERE upper(ident) = ? OR upper(icao) = ?",
        (icao.upper(), icao.upper()),
    ).fetchone()

    if row:
        alt_ft = row["altitude"]
        return {
            "ident": row["ident"] or icao,
            "name": row["name"] or "",
            "city": row["city"] or "",
            "country": row["country"] or "",
            "elevation_m": round(alt_ft * 0.3048, 1) if alt_ft is not None else None,
            "lat": row["laty"],
            "lon": row["lonx"],
        }
    return {"ident": icao, "name": "", "city": "", "country": "",
            "elevation_m": None, "lat": None, "lon": None}


def _compass(deg: float) -> str:
    """Convert wind direction degrees to compass point."""
    if deg is None:
        return ""
    deg = deg % 360
    points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
              "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    idx = round(deg / 22.5) % 16
    return points[idx]


def _compass_cn(compass: str) -> str:
    """Convert compass point to Chinese."""
    if not compass:
        return ""
    # Handle compound: NNE → 北北東
    c = compass.upper()
    if c in _DIR_CN:
        return _DIR_CN[c]
    # Build from cardinal components
    parts = []
    for ch in c:
        if ch in _DIR_CN:
            parts.append(_DIR_CN[ch])
    return "".join(parts) if parts else c


def _wind_arrow(compass: str) -> str:
    """Convert compass direction to arrow emoji."""
    arrows = {
        "N": "↓", "NNE": "↙", "NE": "↙", "ENE": "↙",
        "E": "←", "ESE": "↖", "SE": "↖", "SSE": "↖",
        "S": "↑", "SSW": "↗", "SW": "↗", "WSW": "↗",
        "W": "→", "WNW": "↘", "NW": "↘", "NNW": "↘",
    }
    return arrows.get(compass, "?")


def _vis_emoji(vis_m: float | None) -> str:
    """Get visibility emoji."""
    if vis_m is None:
        return "❓"
    if vis_m >= 9999:
        return "🔭"
    if vis_m >= 5000:
        return "👁️"
    if vis_m >= 1600:
        return "🌫️"
    return "🌁"


def _cloud_emoji(cover: str) -> str:
    """Get cloud cover emoji."""
    return {
        "FEW": "🌤️", "SCT": "⛅", "BKN": "☁️",
        "OVC": "🌥️", "SKC": "☀️", "CLR": "☀️",
        "NSC": "☀️", "NCD": "☀️",
    }.get(cover, "☁️")


def _wx_emoji(wx_code: str) -> str:
    """Get weather phenomenon emoji."""
    if "TS" in wx_code:
        return "⛈️" if "RA" in wx_code else "🌩️"
    if "SH" in wx_code:
        return "🌦️"
    if "RA" in wx_code:
        return "🌧️"
    if "SN" in wx_code:
        return "🌨️"
    if "FG" in wx_code:
        return "🌫️"
    if "BR" in wx_code:
        return "🌁"
    if "HZ" in wx_code:
        return "😶‍🌫️"
    if "DZ" in wx_code:
        return "🌦️"
    if "FZ" in wx_code:
        return "🧊"
    if "GR" in wx_code:
        return "🧊"
    return "🌡️"


def _wx_cn(wx_code: str) -> str:
    """
    Translate weather phenomenon code to Chinese.
    Handles: intensity (+/-) + descriptor (MI/PR/BC/DR/BL/SH/TS/FZ) + type (RA/SN/DZ/...)
    """
    if not wx_code:
        return ""

    code = wx_code.upper()
    parts = []

    # Intensity
    if code.startswith("+"):
        parts.append(_WX_CN.get("+", "+"))
        code = code[1:]
    elif code.startswith("-"):
        parts.append(_WX_CN.get("-", "-"))
        code = code[1:]

    # Proximity
    if code.startswith("VC"):
        parts.append(_WX_CN.get("VC", "VC"))
        code = code[2:]

    # Descriptors
    for desc in ["MI", "PR", "BC", "DR", "BL", "SH", "TS", "FZ"]:
        if code.startswith(desc):
            parts.append(_WX_CN.get(desc, desc))
            code = code[len(desc):]
            break

    # Precipitation/Obscuration type
    for key in sorted(_WX_CN.keys(), key=len, reverse=True):
        if key in ("+", "-", "VC"):
            continue
        if key == code or code.startswith(key):
            parts.append(_WX_CN.get(key, key))
            code = code[len(key):]
            break

    if not parts:
        return wx_code
    return "".join(parts)


def parse_metar(raw: str) -> dict | None:
    """
    Parse a raw METAR string into structured fields matching WeatherMetar schema.

    Returns:
        Dict with keys: icao, time, time_iso, airport, wind, wind_text, temp_c, dewpt_c,
        visibility_m, visibility_str, visibility_qualifier, pressure_hpa,
        pressure_inhg, clouds, weather, flight_rules, elevation_m, raw.
    """
    if not raw or not raw.strip():
        return None

    original_raw = raw.strip()

    # Strip "METAR" prefix
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
            "time_iso": None,
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
            "elevation_m": None,
            "raw": original_raw,
        }

    icao = obs.station_id or ""
    airport = _lookup_airport(icao)

    # Time
    time_str = obs.time.strftime("%Y-%m-%d %H:%M UTC") if obs.time else None
    time_iso = obs.time.strftime("%Y-%m-%dT%H:%M:00.000Z") if obs.time else None

    # Elevation from airport lookup (meters)
    elevation_m = airport.get("elevation_m")

    # Wind
    wind = {}
    wind_text = ""
    if obs.wind_dir and obs.wind_speed:
        wdir = obs.wind_dir.value()
        wspd = obs.wind_speed.value()
        compass = _compass(wdir)
        arrow = _wind_arrow(compass)
        cn_dir = _compass_cn(compass)
        wind = {
            "dir": wdir,
            "speed_kts": wspd,
            "gust_kts": obs.wind_gust.value() if obs.wind_gust else None,
            "dir_compass": compass,
            "dir_cn": cn_dir,
            "arrow": arrow,
        }
        gust_str = f" Gust {obs.wind_gust.value()}kt" if obs.wind_gust else ""
        wind_text = f"{arrow} {cn_dir} @ {wspd} 節{gust_str}"

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
            if visibility_m >= 10000:
                visibility_str = "🔭 能見度良好"
            else:
                visibility_str = f"👁️ {visibility_m}m"
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
            # sky_cond is a 3-tuple: (cover, distance, type)
            cover = sky_cond[0]
            alt = sky_cond[1]
            height_ft = alt.value() if alt else None
            cloud_type = sky_cond[2] if len(sky_cond) > 2 else None  # CB or TCU

            cloud_entry = {
                "cover": cover,
                "cover_cn": _CLOUD_CN.get(cover, cover),
                "height_ft": height_ft,
                "emoji": _cloud_emoji(cover),
            }

            # If cloud type is CB or TCU, flag it
            if cloud_type:
                type_str = str(cloud_type) if cloud_type else ""
                cloud_entry["cloud_type"] = type_str
                cloud_entry["cloud_type_cn"] = _CLOUD_TYPE_CN.get(type_str, type_str)
                cloud_entry["is_dangerous"] = True
                cloud_entry["emoji"] = "⛈️" if type_str == "CB" else "🌩️"

            clouds.append(cloud_entry)

    # Weather phenomena
    weather = []
    weather_cn = []
    if obs.weather:
        for wx in obs.weather:
            # metar library returns weather as tuple: (intensity, desc, precip, ...)
            # Reconstruct raw code: ('-', 'SH', 'RA', None, None) → "-SHRA"
            parts = [p for p in wx if p is not None]
            wx_s = "".join(parts)
            weather.append(wx_s)
            weather_cn.append({"code": wx_s, "cn": _wx_cn(wx_s), "emoji": _wx_emoji(wx_s)})

    # Flight rules
    flight_rules = _calc_flight_rules(visibility_m, clouds)
    flight_rules_cn = {
        "VFR": "VFR (目視飛行規則)",
        "MVFR": "MVFR (邊際目視飛行規則)",
        "IFR": "IFR (儀表飛行規則)",
        "LIFR": "LIFR (低儀表飛行規則)",
    }.get(flight_rules, flight_rules)

    return {
        "icao": icao,
        "time": time_str,
        "time_iso": time_iso,
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
        "weather_cn": weather_cn,
        "flight_rules": flight_rules,
        "flight_rules_cn": flight_rules_cn,
        "elevation_m": elevation_m,
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


def _parse_taf_time_range(day_hour: str, base_day: int) -> dict:
    """Parse a TAF time range like '2814/2818' or '2903/2906'."""
    if not day_hour or "/" not in day_hour:
        return {}

    parts = day_hour.split("/")
    out = {}
    labels = ["time_from", "time_to"]
    for i, part in enumerate(parts[:2]):
        if len(part) >= 4:
            d = int(part[:2])
            h = int(part[2:4])
            out[labels[i]] = f"{d}日{h:02d}Z"
    return out


def _parse_trend_line(line: str, trend_kind: str, base_day: int) -> dict | None:
    """
    Parse a single TAF trend line (TEMPO, BECMG, PROBnn, FM).
    
    Examples:
        "TEMPO 2814/2818 VRB05KT"
        "BECMG 2812/2815 32006KT"
        "PROB30 2814/2818 TSRA BKN020CB"
        "FM281200 32015G25KT 4000 +TSRA BKN015CB"
    """
    if not line or not line.strip():
        return None

    s = line.strip()
    # Strip trend keyword
    for kw in ["TEMPO", "BECMG", "PROB30", "PROB40"]:
        if s.upper().startswith(kw):
            s = s[len(kw):].strip()
            break

    # FM: "FM281200" → single time
    fm_match = re.match(r'^FM(\d{6})\b', s.upper())
    if fm_match:
        s = s[fm_match.end():].strip()

    result: dict = {"kind": trend_kind, "raw": line.strip()}

    # Time range: "2814/2818" (TEMPO/BECMG) or single time
    time_match = re.search(r"(\d{4}/\d{4})", s)
    if time_match:
        tr = _parse_taf_time_range(time_match.group(1), base_day)
        result.update(tr)

    # For FM: extract single time "FM281200" → "28日12Z"
    if fm_match:
        dh = fm_match.group(1)
        result["time_from"] = f"{dh[0:2]}日{dh[2:4]}Z"
        result["time_to"] = None  # FM has no end time, it lasts till next FM or end

    # Wind
    wind_match = re.search(r"(\d{3})(\d{2,3})(G\d{2,3})?KT", s)
    if wind_match:
        wdir = float(wind_match.group(1))
        wspd = float(wind_match.group(2))
        gust = wind_match.group(3)
        compass = _compass(wdir)
        result["wind"] = {
            "dir": wdir, "speed_kts": wspd,
            "gust_kts": float(gust[1:]) if gust else None,
            "dir_compass": compass,
            "dir_cn": _compass_cn(compass),
            "arrow": _wind_arrow(compass),
        }
        result["wind_text"] = f"{_wind_arrow(compass)} {_compass_cn(compass)} @ {wspd} 節"
        if gust:
            result["wind_text"] += f" Gust {gust[1:]}kt"

    # VRB wind
    vrb_match = re.search(r"VRB(\d{2,3})KT", s)
    if vrb_match and "wind" not in result:
        wspd = float(vrb_match.group(1))
        result["wind"] = {
            "dir": None, "speed_kts": wspd, "gust_kts": None,
            "dir_compass": "", "dir_cn": "不定", "arrow": "🔄",
        }
        result["wind_text"] = f"🔄 風向不定 @ {wspd} 節"

    # Visibility — strip time range first to avoid matching DDHH as visibility
    vis_str = re.sub(r"\d{4}/\d{4}", "", s)
    vis_match = re.search(r"(?<!\d)(\d{4})(?!\d)", vis_str)
    if vis_match:
        vis = int(vis_match.group(1))
        result["visibility_m"] = float(vis)
        if vis >= 10000:
            result["visibility_str"] = "🔭 10公里或以上 (9999)"
        elif vis >= 5000:
            result["visibility_str"] = f"👁️ {vis}米"
        else:
            result["visibility_str"] = f"🌫️ {vis}米"
    else:
        # Check for CAVOK
        if re.search(r"\bCAVOK\b", s, re.IGNORECASE):
            result["visibility_m"] = float(10000)
            result["visibility_str"] = "🔭 CAVOK"

    # Clouds
    clouds = []
    for m in re.finditer(r"(FEW|SCT|BKN|OVC)(\d{3})", s):
        clouds.append({
            "cover": m.group(1),
            "cover_cn": _CLOUD_CN.get(m.group(1), m.group(1)),
            "height_ft": int(m.group(2)) * 100,
            "emoji": _cloud_emoji(m.group(1)),
        })
    result["clouds"] = clouds

    # Weather phenomena — skip "PO" (matches TEMPO substring, PO is dust devil modifier)
    wx_list = []
    for m in re.finditer(r"([+-]?(?:VC)?(?:TS|SH|RA|SN|DZ|GR|GS|FG|BR|HZ|FU|SA|DU|VA|SQ|DS|SS|FC|PY))", s):
        wx_list.append(m.group(0))
    result["weather"] = wx_list

    return result


def parse_taf(raw: str) -> dict | None:
    """
    Parse a raw TAF string into structured fields including trend lines.

    Handles TEMPO, BECMG, PROB30/PROB40 trend groups.
    """
    if not raw or not raw.strip():
        return None

    # Handle multi-line TAF — join continuation lines
    raw_stripped = raw.strip()
    if "\n" in raw_stripped:
        # Join all lines: strip TAF prefix from first line, concat continuations
        lines = raw_stripped.splitlines()
        joined = []
        for i, ln in enumerate(lines):
            ln = ln.strip()
            if i == 0 and ln.upper().startswith("TAF "):
                ln = ln[4:].strip()
            joined.append(ln)
        raw_stripped = " ".join(joined)

    line = raw_stripped
    if line.upper().startswith("TAF "):
        line = line[4:].strip()

    parts = line.split()
    if len(parts) < 2:
        return None

    result: dict = {"raw": raw.strip()}

    # ICAO
    icao = parts[0] if len(parts[0]) == 4 else ""
    result["icao"] = icao

    # Time range: 2800/2906 — the main validity is always at parts[2]
    base_day = None
    # Main validity period: DDHH/DDHH format, e.g., "2800/2906"
    validity_re = re.match(r"(\d{2})(\d{2})/(\d{2})(\d{2})", parts[2]) if len(parts) > 2 else None
    if validity_re:
        from_d, from_h, to_d, to_h = validity_re.groups()
        base_day = int(from_d)
        result["time_from"] = f"2026-05-{from_d} {from_h}:00 UTC"
        result["time_to"] = f"2026-05-{to_d} {to_h}:00 UTC"

    # Wind: 22010KT
    wind_match = re.search(r"(\d{3})(\d{2,3})(G\d{2,3})?KT", line)
    if wind_match:
        wdir = float(wind_match.group(1))
        wspd = float(wind_match.group(2))
        gust = wind_match.group(3)
        compass = _compass(wdir)
        result["wind"] = {
            "dir": wdir,
            "speed_kts": wspd,
            "gust_kts": float(gust[1:]) if gust else None,
            "dir_compass": compass,
            "dir_cn": _compass_cn(compass),
            "arrow": _wind_arrow(compass),
        }
        result["wind_text"] = f"{_wind_arrow(compass)} {_compass_cn(compass)} @ {wspd} 節"
        if gust:
            result["wind_text"] += f" Gust {gust[1:]}kt"

    # VRB wind
    vrb_match = re.search(r"VRB(\d{2,3})KT", line)
    if vrb_match and "wind" not in result:
        wspd = float(vrb_match.group(1))
        result["wind"] = {
            "dir": None, "speed_kts": wspd, "gust_kts": None,
            "dir_compass": "", "dir_cn": "不定", "arrow": "🔄",
        }
        result["wind_text"] = f"🔄 風向不定 @ {wspd} 節"

    # Visibility: 9999 — only in main body (before first trend keyword)
    main_body = line
    first_trend = re.search(r'\b(TEMPO|BECMG|PROB3\d|PROB4\d|FM\d{6})\b', line, re.IGNORECASE)
    if first_trend:
        main_body = line[:first_trend.start()]

    vis_match = re.search(r'\b(9999|CAVOK)\b', main_body, re.IGNORECASE)
    if vis_match:
        if vis_match.group(1).upper() == "CAVOK":
            result["visibility_m"] = float(10000)
            result["visibility_str"] = "🔭 CAVOK"
        else:
            vis = int(vis_match.group(1))
            result["visibility_m"] = float(vis)
            result["visibility_str"] = "🔭 10公里或以上 (9999)"

    # Clouds: FEW015 BKN030 — only in main body
    clouds = []
    for m in re.finditer(r"(FEW|SCT|BKN|OVC)(\d{3})", main_body):
        clouds.append({
            "cover": m.group(1),
            "cover_cn": _CLOUD_CN.get(m.group(1), m.group(1)),
            "height_ft": int(m.group(2)) * 100,
            "emoji": _cloud_emoji(m.group(1)),
        })
    result["clouds"] = clouds

    # Weather — only in main body (exclude "PO" which matches TEMPO substring)
    wx_list = []
    for m in re.finditer(r"([+-]?(?:VC)?(?:TS|SH|RA|SN|DZ|GR|GS|FG|BR|HZ|FU|SA|DU|VA|SQ|DS|SS|FC|PY))", main_body):
        wx_list.append(m.group(0))
    result["weather"] = wx_list

    # TX/TN temperature extremes with time
    tx_match = re.search(r"TX(\d{2})/(\d{4}Z)", line)
    tn_match = re.search(r"TN(\d{2})/(\d{4}Z)", line)
    result["max_temp_c"] = float(tx_match.group(1)) if tx_match else None
    result["min_temp_c"] = float(tn_match.group(1)) if tn_match else None

    if tx_match:
        td = tx_match.group(2)
        result["max_temp_time"] = f"{td[0:2]}日{td[2:4]}Z"
    if tn_match:
        td = tn_match.group(2)
        result["min_temp_time"] = f"{td[0:2]}日{td[2:4]}Z"

    # Parse trend lines (TEMPO, BECMG, PROB, FM)
    # Split the raw TAF text on trend keywords
    trends = []
    trend_re = re.compile(r'\b(TEMPO|BECMG|PROB3\d|PROB4\d|FM\d{6})\b', re.IGNORECASE)
    # Find all trend markers and their positions
    splits = list(trend_re.finditer(line))
    for i, match in enumerate(splits):
        raw_kind = match.group(0).upper()
        start = match.start()

        # Determine trend kind
        kind = raw_kind
        if re.match(r'^PROB\d', raw_kind):
            kind = raw_kind  # "PROB30", "PROB40"
        elif re.match(r'^FM\d{6}$', raw_kind):
            kind = "FM"

        # Text from this keyword to the next keyword or end
        end = splits[i + 1].start() if i + 1 < len(splits) else len(line)
        trend_text = line[start:end].strip()
        parsed = _parse_trend_line(trend_text, kind, base_day or 28)
        if parsed:
            trends.append(parsed)

    result["trends"] = trends

    return result
