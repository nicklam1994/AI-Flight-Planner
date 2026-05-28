# AI Flight Planner v3

Natural language flight route planning powered by LLM + real Navigraph data.

**AI Flight Planner** takes a free-text routing request (e.g., "VHHH to RJTT, high altitude airways") and returns ATS route strings using:

- **SID/STAR fix-pair search** — routes anchored to real departure/arrival fixes from PMDG .s3db
- **NetworkX shortest paths** through real airway data (LNM Navigraph SQLite)
- **Dual LLM calls**: NLP parsing (NL → structured intent) + route evaluation (ranking candidates, optional)
- **NOAA Aviation Weather API** for real-time METAR/TAF with Chinese parsing
- **Airport detail**: runways with ILS, COM frequencies, SID/STAR filtered by fix, linked approach procedures

## Quick Start

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Place databases under data/cycles/:
#   data/cycles/2605/little_navmap_navigraph.sqlite
#   data/cycles/2605/e_dfd_PMDG.s3db

# 3. Start server
cd ~/repos/ai-flight-planner && source venv/bin/activate
python -m uvicorn src.api.app:app --host 127.0.0.1 --port 8080
```

## API Endpoints (14 total)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Service health, graph stats, AIRAC cycle |
| GET | `/api/cycles` | List available AIRAC cycles |
| POST | `/api/cycle` | Switch AIRAC cycle |
| POST | `/api/plan` | Plan route (NL → candidates + parsed intent) |
| GET | `/api/airports?q=` | Airport autocomplete |
| GET | `/api/waypoints?q=` | Waypoint autocomplete |
| **GET** | **`/api/airport/{icao}/detail?fix=`** | **Airport detail: runways, COM, SID/STAR filtered by fix** |
| GET | `/api/route/{idx}/waypoints` | Waypoint details for candidate route |
| GET | `/api/weather?dep=&arr=` | METAR/TAF for departure + arrival |
| POST | `/api/llm/models` | CORS proxy: fetch LLM model list |

## v3 Features

- **Fix-pair routing**: dep_fix from SID exit, arr_fix from STAR initial fix, airway class weighting (A>G>R>Y>W/V)
- **Route cards**: clickable cards (★ best, ○ alternate), no buttons, 3 candidates max
- **Parsed intent**: 4-column table with IATA/ICAO, cruise altitude min/max, aircraft type (182 ICAO codes), evaluator toggle
- **Route description**: click-to-copy route string, direct distance (haversine), RVSM altitudes
- **Airport cards**: SID/STAR filtered by departure/arrival fix, runway table (ILS CAT II/III recommendation), COM frequencies grouped by type
- **Approach procedures**: linked to STARs (ILS/LOC/RNAV only)
- **Weather**: METAR compact 4-col + 2-col tables, TAF natural language with TEMPO/BECMG parsing, variable wind detection, local time computation
- **Settings**: language (zh-TW/zh-CN/en), timezone, route evaluator toggle (default off)

## User Flow (v3)

```
Step 1: Enter routing request → "VHHH to ZSSS, high altitude, B738"
Step 2: POST /api/plan → Parsed intent table + 1-3 route cards
Step 3: Click route card → Parallel loads:
   • Airport detail (runways, COM, SID/STAR, approaches)
   • Waypoint details
   • Weather (METAR + TAF)
Step 4: Scroll through:
   • Route description card (click-to-copy)
   • Departure airport card (SIDs + runways + COM + weather)
   • Arrival airport card (STARs + approaches + runways + COM + weather)
   • Route detail table (airway, from, to, distance, heading)
   • Navigation table (waypoint, type, frequency, lat, lon)
```

## License

MIT
