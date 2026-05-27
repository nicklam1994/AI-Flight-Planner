# AI Flight Planner v2

Natural language flight route planning powered by LLM + real Navigraph data.

**AI Flight Planner** takes a free-text routing request (e.g., "VHHH to RJTT, high altitude airways") and returns ATS route strings using:

- **K-shortest paths** (NetworkX Yen's algorithm) through real airway data
- **Dual LLM calls**: NLP parsing (NL → structured intent) + route evaluation (ranking candidates)
- **LNM Navigraph SQLite** database for real-world waypoints, airways, and airports
- **PMDG .s3db** database for SID/STAR procedure data
- **NOAA Aviation Weather API** for real-time METAR/TAF

### v2 Features

- **Four-panel route details**: Departure SIDs, Arrival STARs, Route string, Navigation waypoints
- **Automatic SID/STAR filtering**: Extracts filter waypoints from route string, queries PMDG database
- **Weather integration**: Real-time METAR (parsed) + TAF (raw) from NOAA API
- **Improved UI**: 2x2 CSS Grid layout, structured tables, mobile responsive
- **SID/STAR dropdown removed**: v2 auto-filters procedures instead of manual selection

## Quick Start

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Set up database
# Place your Little Navmap Navigraph databases under data/cycles/:
#   data/cycles/2602/little_navmap_navigraph.sqlite
#   data/cycles/2604/little_navmap_navigraph.sqlite
# Place PMDG .s3db databases alongside:
#   data/cycles/2602/e_dfd_PMDG.s3db
#   data/cycles/2604/e_dfd_PMDG.s3db
# Or set DB_PATH / SID_STAR_DB_PATH in .env to point directly to files.

# 3. Configure LLM (optional — can be set from the web UI)
cp .env.example .env
# Edit .env if you need to customize defaults.

# 4. Start the server
python -m uvicorn src.api.app:app --host 0.0.0.0 --port 8000

# 5. Open http://localhost:8000
```

## Project Structure

```
src/
├── config.py              # Configuration (env vars, AIRAC cycles)
├── api/
│   ├── app.py             # FastAPI app, graph lifecycle
│   ├── routes.py          # REST endpoints (11 total)
│   └── schemas.py         # Pydantic request/response models
├── db/
│   ├── connection.py      # SQLite connection manager (LNM + PMDG)
│   ├── airport.py         # Airport queries + waypoint details
│   ├── graph_builder.py   # NetworkX airway graph builder
│   └── sidstar.py         # SID/STAR procedure queries
├── route/
│   ├── models.py          # Route data models
│   ├── graph_search.py    # K-shortest paths (Yen's algorithm)
│   ├── airport_connector.py  # Airport → nearest airway node connector
│   └── step3_filter.py    # Route string extraction + SID/STAR filter
├── weather/
│   ├── metar.py           # METAR parser + NOAA API client
│   └── client.py          # NOAA Aviation Weather API client
├── ai/
│   ├── llm_client.py      # LLM abstraction (Ollama/OpenAI/DeepSeek)
│   ├── nlp_parser.py      # NL → structured intent (LLM + regex fallback)
│   ├── route_evaluator.py # Route ranking via LLM
│   └── prompt_templates.py # System prompts for LLM calls
static/
├── index.html             # Single-page frontend (v2: four-panel layout)
├── css/style.css          # Dark theme styles (v2: grid, tables, weather)
└── js/
    ├── app.js             # Main app logic (v2: state mgmt, parallel requests)
    ├── api.js             # Backend API client (v2: filter + waypoint + weather)
    ├── settings.js        # LLM settings (localStorage)
    └── i18n.js            # i18n (zh-CN / zh-TW / en)
data/cycles/               # AIRAC cycle databases
├── 2602/                  # Cycle 2602 (valid FEB–MAR 2026)
└── 2604/                  # Cycle 2604 (valid APR–MAY 2026)
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Service health, graph stats, AIRAC cycle |
| GET | `/api/cycles` | List available AIRAC cycles |
| POST | `/api/cycle` | Switch AIRAC cycle + reload graph |
| POST | `/api/plan` | Plan a flight route (NL input → ATS route) |
| GET | `/api/airports?q=...` | Airport autocomplete |
| GET | `/api/waypoints?q=...` | Waypoint autocomplete |
| GET | `/api/procedures?airport=&type=` | List SID/STAR procedures |
| GET | `/api/procedures/{name}?airport=&type=` | Procedure detail (leg-by-leg) |
| POST | `/api/procedures/filter` | Filter SID/STAR by route (legacy v1) |
| **POST** | **`/api/route/filter`** | **v2: Filter SID/STAR by route waypoint** |
| **GET** | **`/api/route/{idx}/waypoints`** | **v2: Waypoint details for candidate** |
| **GET** | **`/api/weather?dep=&arr=`** | **v2: METAR/TAF for departure + arrival** |
| POST | `/api/llm/models` | CORS proxy: fetch LLM model list |

## User Flow (v2)

```
Step 1: Enter routing request → "VHHH to ZSSS, high altitude"
Step 2: POST /api/plan → Parsed intent + 5 candidate routes
   ↓ Click [Select] on a candidate
Step 3: POST /api/route/filter → Auto-filter SIDs/STARs
   ↓ (parallel requests with Promise.allSettled)
Step 4: Four-panel display
   • Departure: SID table (name + runways)
   • Arrival: STAR table (name + runways)
   • Route: Route string + copy button + stats
   • Navigation: Waypoint table (ident/type/freq/lat/lon)
Step 5: Weather display
   • Departure METAR (parsed) + TAF (raw)
   • Arrival METAR (parsed) + TAF (raw)
   • 🔄 Manual refresh button
```

## LLM Configuration

The frontend includes a settings panel (⚙️) where you can configure:

- **Provider**: Ollama, OpenAI, DeepSeek, Nvidia NIM, or custom OpenAI-compatible
- **Base URL** + **Model** + **API Key**
- **Temperature** (0.0–1.0)

Settings persist in browser localStorage. Defaults:

```
Provider:  ollama
Base URL:  http://localhost:11434/v1
Model:     qwen3.5:9b-agent
API Key:   ollama
```

## License

MIT
