#!/bin/bash
# AI Flight Planner 啟動腳本

set -e

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 項目根目錄
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 檢查虛擬環境
if [ ! -d "venv" ]; then
    echo -e "${RED}錯誤: 虛擬環境不存在${NC}"
    echo "請先運行: python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt"
    exit 1
fi

# 檢查端口佔用
PORT=8080
PID=$(lsof -ti:$PORT 2>/dev/null || true)

if [ ! -z "$PID" ]; then
    echo -e "${YELLOW}警告: 端口 $PORT 已被佔用 (PID: $PID)${NC}"
    echo -n "是否終止進程並繼續? [y/N]: "
    read -r response
    if [[ "$response" =~ ^[Yy]$ ]]; then
        echo "終止進程 $PID..."
        kill -9 $PID 2>/dev/null || true
        sleep 1
    else
        echo "啟動已取消"
        exit 0
    fi
fi

# 激活虛擬環境
echo -e "${GREEN}激活虛擬環境...${NC}"
source venv/bin/activate

# 啟動服務
echo -e "${GREEN}啟動 AI Flight Planner 服務...${NC}"
echo -e "${GREEN}訪問地址: http://127.0.0.1:$PORT${NC}"
echo -e "${YELLOW}按 Ctrl+C 停止服務${NC}"
echo ""

python3 -m uvicorn src.api.app:app --host 127.0.0.1 --port $PORT --reload
