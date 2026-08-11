#!/bin/bash
# AI Flight Planner 啟動腳本 (背景運行)

set -e

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 項目根目錄
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 配置
PORT=8080
LOG_FILE="logs/server.log"
PID_FILE="logs/server.pid"

# 創建日誌目錄
mkdir -p logs

# 檢查虛擬環境
if [ ! -d "venv" ]; then
    echo -e "${RED}錯誤: 虛擬環境不存在${NC}"
    echo "請先運行: python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt"
    exit 1
fi

# 檢查端口佔用
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

# 背景啟動服務
echo -e "${GREEN}啟動 AI Flight Planner 服務 (背景模式)...${NC}"
nohup python3 -m uvicorn src.api.app:app --host 127.0.0.1 --port $PORT --reload > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# 保存 PID
echo $SERVER_PID > "$PID_FILE"

# 等待啟動
sleep 2

# 檢查是否成功啟動
if kill -0 $SERVER_PID 2>/dev/null; then
    echo -e "${GREEN}✓ 服務已啟動${NC}"
    echo -e "  PID: ${GREEN}$SERVER_PID${NC}"
    echo -e "  地址: ${GREEN}http://127.0.0.1:$PORT${NC}"
    echo -e "  日誌: ${GREEN}$LOG_FILE${NC}"
    echo ""
    echo -e "${YELLOW}停止服務: ./stop.sh${NC}"
    echo -e "${YELLOW}查看日誌: tail -f $LOG_FILE${NC}"
else
    echo -e "${RED}✗ 服務啟動失敗，請檢查日誌: $LOG_FILE${NC}"
    tail -20 "$LOG_FILE"
    exit 1
fi
