#!/bin/bash
# SQLite 查詢工具
# 用法: ./db.sh [數據庫] [SQL]
# 示例: ./db.sh navigraph "SELECT COUNT(*) FROM waypoint"

set -e

DB_FILE="${1:-navigraph}"
SQL="$2"

# 數據庫映射
case "$DB_FILE" in
    navigraph|lnm|nav)
        DB_PATH="data/cycles/2608/little_navmap_navigraph.sqlite"
        ;;
    pmdg|sidstar|s3db)
        DB_PATH="data/cycles/2608/e_dfd_PMDG.s3db"
        ;;
    *)
        DB_PATH="$DB_FILE"
        ;;
esac

if [ -z "$SQL" ]; then
    echo "用法: ./db.sh [navigraph|pmdg|數據庫路徑] \"SQL語句\""
    echo ""
    echo "示例:"
    echo "  ./db.sh navigraph \"SELECT COUNT(*) FROM waypoint\""
    echo "  ./db.sh pmdg \"SELECT name FROM tbl_airports WHERE code='VHHH'\""
    echo "  ./db.sh navigraph \".tables\""
    exit 1
fi

python3 -c "
import sqlite3, sys
conn = sqlite3.connect('$DB_PATH')
cur = conn.cursor()
try:
    if '$SQL'.startswith('.'):
        # 處理 .tables, .schema 等特殊命令
        if '$SQL' == '.tables':
            cur.execute(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\")
            for r in cur.fetchall():
                print(r[0])
        elif '$SQL'.startswith('.schema'):
            tbl = '$SQL'.split()[-1] if len('$SQL'.split()) > 1 else '%'
            cur.execute(\"SELECT sql FROM sqlite_master WHERE name LIKE ?\", (tbl,))
            for r in cur.fetchall():
                print(r[0])
        else:
            print(f'不支持的命令: $SQL')
    else:
        cur.execute(\"$SQL\")
        if cur.description:  # 有返回結果
            cols = [d[0] for d in cur.description]
            print(' | '.join(cols))
            print('-' * (len(' | '.join(cols))))
            for row in cur.fetchall():
                print(' | '.join(str(v) for v in row))
        else:
            conn.commit()
            print(f'Affected {cur.rowcount} rows')
except Exception as e:
    print(f'錯誤: {e}', file=sys.stderr)
    sys.exit(1)
conn.close()
"
