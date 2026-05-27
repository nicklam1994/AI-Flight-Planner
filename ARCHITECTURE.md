# AI Flight Planner v2 — 架構設計

## 用戶流程

```
Step 1: 自然語言輸入
  "VHHH to ZSSS, high altitude airways"

Step 2: 輸出 3-5 條候選航線（含評分）
  ⭐ Route #1: VHHH SID OCEAN V3 SIKOU A1 ELATO ... SASAN STAR ZSSS (918NM, 9.5)
  ○ Route #2: VHHH SID BEKOL A461 SHL ... SASAN STAR ZSSS (945NM, 8.0)

Step 3: 點選一條 → 提取 SID後節點 / STAR前節點 → 過濾程序
  路由: VHHH SID OCEAN V3 ... SASAN STAR ZSSS
  提取: SID後=OCEAN, STAR前=SASAN
  過濾: .s3db tbl_sids WHERE waypoints contain OCEAN
        .s3db tbl_stars WHERE waypoints contain SASAN

Step 4: 四區展示
  ┌ 離場詳情 ┐  SID程序表 + 跑道資訊（只顯示與所選航線相關的）
  ├ 進場詳情 ┤  STAR程序表 + 跑道資訊
  ├ 航路詳情 ┤  完整航路字串 + 飛行計劃 + 📋複製
  └ 導航詳情 ┘  航點表格（航點/類型/頻率/經緯度）

Step 5: 氣象查詢（Step 1 後自動觸發）
  調用 NOAA API → 中文解析 → 顯示 METAR & TAF + 🔄手動刷新
```

## 任務模塊

### #1 移除 SID/STAR 下拉列表
- 移除 `static/index.html` 中的獨立 SID/STAR selector
- 移除 `static/js/app.js` 中相關事件和 fetchProcedures 調用
- 保留 `src/db/sidstar.py`（供 Step 3 使用）

### #2 Step 3 篩選邏輯
- `src/route/step3_filter.py`（新增）：
  - `extract_nodes(route_string)` → 返回 (sid_node, star_node)
  - `filter_sids(airport, waypoint)` → 查 .s3db tbl_sids
  - `filter_stars(airport, waypoint)` → 查 .s3db tbl_stars
- API: `POST /api/procedures/filter` {route_string, airport} → {sids, stars}

**關鍵技術**：
- 從 route_string 提取節點：正則匹配 `SID\s+(\w+)` 和 `(\w+)\s+STAR`
- .s3db 的 tbl_sids 結構：`procedure_identifier, waypoint_identifier, route_type`
- 過濾方式：查 tbl_sids 中 waypoint_identifier 包含目標節點的記錄

### #3 前端四區 UI
- 重構 `static/index.html`：
  - 輸入區（保留）：自然語言輸入 + 候選數 + Plan Route 按鈕
  - 候選列表（保留）：3-5 條航線，點選切換
  - 四區詳情（新增）：可折疊面板或 tab 切換

**離場詳情區**：
- 標題：`SID 離場程序 (經 {waypoint})`
- SID 表：程序名 | 跑道 | 過渡點
- 跑道資訊：跑道號 | 長度/寬度 | ILS頻率 | 類別 | 推薦標記

**進場詳情區**：
- 標題：`STAR 進場程序 (經 {waypoint})`
- 同上結構

**航路詳情區**：
- 完整航路字串（含 SID...STAR 包裹）
- 飛行計劃航路字串（只含航路部分，可複製）
- 📋 複製按鈕（複製飛行計劃航路）

**導航詳情區**：
- 航點表格：航點名 | 類型 | 頻率 | 緯度 | 經度
- 來源：LNM .sqlite 的 waypoint 表 + vor 表

### #4 氣象查詢
- `src/weather/metar.py`（新增）：
  - `parse_metar(raw)` → dict with structured fields + Chinese translation
  - `_lookup_airport(icao)` → airport name/city from LNM .sqlite
  - 使用 `metar` 庫解析原始報文
- REST API: `GET /api/weather?dep=VHHH&arr=ZSSS`
  - 調用 NOAA: `https://aviationweather.gov/api/data/metar/?ids={dep},{arr}&taf=1`
  - 返回 JSON：
    ```json
    {
      "departure": {
        "icao": "VHHH",
        "airport": {"name": "Hong Kong Intl", "city": "Hong Kong"},
        "metar": {"raw": "...", "time": "...", "wind": {...}, "temp_c": 30, ...},
        "taf": {"raw": "..."}
      },
      "arrival": {...}
    }
    ```
- 前端：Step 1 後自動調用 → 顯示中文解析 + 🔄 Refresh 按鈕
- 顯示格式：
  ```
  🛫 VHHH (香港國際機場)
    METAR | 200° 7節 | 30°C/25°C | 1009hPa | FEW010 SCT025 | VFR
    TAF  | 22010KT 9999 FEW015...
  ```

## 資料來源

| 資料 | 來源 | 格式 |
|---|---|---|
| 航路搜尋 | `data/cycles/{cycle}/little_navmap_navigraph.sqlite` | LNM |
| SID/STAR | `data/cycles/{cycle}/e_dfd_PMDG.s3db` | PMDG |
| 氣象 | `aviationweather.gov/api/data/metar/` | NOAA |

## 不做

- 氣象自動刷新（改手動刷新）
- Leaflet 地圖
- 航線文件多格式下載
- Windy.com 嵌入
