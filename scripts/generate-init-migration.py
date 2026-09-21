#!/usr/bin/env python3
"""从现有数据库反推「首个迁移之前」的 schema，生成初始迁移文件。

用法：
    python3 scripts/generate-init-migration.py [源数据库路径]

源数据库路径缺省时依次尝试：命令行参数 -> DB_STORAGE 环境变量 -> .env 中的 DB_STORAGE
-> ./data/velotradex.db。

排除项：
- 由后续迁移负责创建的表：cfd_leg_groups / cfd_legs / exchange_connection_logs / backtest_runs
- 由后续迁移负责新增的列：strategies.signalOrigin / orders.fees / orders.mathMultiplier
- 无对应模型的历史遗留表：__schema_sync_meta / deepcoin_* / virtual_accounts_backup
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_DB = "./data/velotradex.db"
TMP_DB = "/tmp/schema_gen.db"

TABLES = [
    "users",
    "exchange_instances",
    "strategies",
    "strategy_positions",
    "orders",
    "parser_configs",
    "signal_routes",
    "pending_protections",
    "soft_stop_losses",
    "audit_logs",
    "api_audit_logs",
    "api_credentials",
    "ai_configs",
    "ai_logs",
    "webhook_configs",
    "image_download_caches",
    "idempotency_keys",
    "market_data_sources",
    "lighter_tx_journals",
    "lighter_client_order_indexes",
    "virtual_accounts",
    "virtual_positions",
    "virtual_orders",
    "virtual_trades",
]

DROP_COLUMNS = {
    "strategies": ["signalOrigin"],
    "orders": ["fees", "mathMultiplier"],
}


def resolve_src_db() -> str:
    """确定源数据库路径，优先命令行参数，其次环境变量 / .env。"""
    if len(sys.argv) > 1:
        return sys.argv[1]
    if os.environ.get("DB_STORAGE"):
        return os.environ["DB_STORAGE"]

    env_file = Path(".env")
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("DB_STORAGE="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return DEFAULT_DB


def sqlite(db, sql):
    return subprocess.run(
        ["sqlite3", db, sql], capture_output=True, text=True, check=True
    ).stdout


def main():
    src_db = resolve_src_db()
    if not Path(src_db).exists():
        sys.exit(
            f"source database not found: {src_db}\n"
            "pass the path explicitly, e.g. python3 scripts/generate-init-migration.py ./data/velotradex.db"
        )
    print(f"source database: {src_db}")
    subprocess.run(["rm", "-f", TMP_DB], check=True)

    for table in TABLES:
        ddl = sqlite(src_db, f"SELECT sql FROM sqlite_master WHERE type='table' AND name='{table}';")
        if not ddl.strip():
            sys.exit(f"missing table in source db: {table}")
        subprocess.run(["sqlite3", TMP_DB], input=ddl, text=True, check=True)

    for table, columns in DROP_COLUMNS.items():
        for column in columns:
            sqlite(TMP_DB, f"ALTER TABLE `{table}` DROP COLUMN `{column}`;")

    index_rows = sqlite(
        src_db,
        "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL;",
    ).strip().splitlines()
    for row in index_rows:
        name, tbl = row.split("|")
        if tbl not in TABLES:
            continue
        ddl = sqlite(src_db, f"SELECT sql FROM sqlite_master WHERE type='index' AND name='{name}';")
        subprocess.run(["sqlite3", TMP_DB], input=ddl, text=True, check=True)

    # 导出最终 DDL（保持表在 TABLES 中的顺序，索引随后）
    statements = []
    for table in TABLES:
        ddl = sqlite(TMP_DB, f"SELECT sql FROM sqlite_master WHERE type='table' AND name='{table}';").strip()
        statements.append(ddl)
    for row in index_rows:
        name, tbl = row.split("|")
        if tbl not in TABLES:
            continue
        ddl = sqlite(TMP_DB, f"SELECT sql FROM sqlite_master WHERE type='index' AND name='{name}';").strip()
        statements.append(ddl)

    # 幂等化：已存在 schema 的库（迁移记录缺失）上重复执行必须无害
    def make_idempotent(sql):
        sql = re.sub(r"^CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", sql)
        sql = re.sub(r"^CREATE UNIQUE INDEX ", "CREATE UNIQUE INDEX IF NOT EXISTS ", sql)
        sql = re.sub(r"^CREATE INDEX ", "CREATE INDEX IF NOT EXISTS ", sql)
        return sql

    statements = [make_idempotent(s) for s in statements]

    body = ",\n".join("  " + json.dumps(s, ensure_ascii=False) for s in statements)
    tables_js = ",\n".join("  " + json.dumps(t) for t in TABLES)

    content = f"""'use strict';

/**
 * 初始 schema（基线迁移）。
 *
 * 背景：本仓库长期依赖“已有数据库”迭代，基础表从未有迁移文件覆盖，
 * 导致全新环境执行 `sequelize-cli db:migrate` 会在
 * `20260821000100-add-signal-origin-to-strategies` 处报
 * `no such table: strategies`，空库完全无法启动。
 *
 * 本迁移补齐全部基础表，且刻意**不包含**后续迁移负责的部分：
 *   - 表：cfd_leg_groups / cfd_legs / exchange_connection_logs / backtest_runs
 *   - 列：strategies.signalOrigin / orders.fees / orders.mathMultiplier
 * 它们由 20260820000100 / 20260821000100 / 20260823000100 /
 * 20260824000100 / 20260901000100 负责，保证历史迁移链在空库上依然成立。
 *
 * 全部语句使用 IF NOT EXISTS，因此在“表已存在但缺少迁移记录”的旧库上
 * 重复执行是安全的（no-op）。
 *
 * 该文件由 scripts/generate-init-migration.py 生成，请勿手工调整语句顺序。
 */

const TABLES = [
{tables_js}
];

const STATEMENTS = [
{body}
];

module.exports = {{
  async up(queryInterface) {{
    for (const statement of STATEMENTS) {{
      await queryInterface.sequelize.query(statement);
    }}
  }},

  async down(queryInterface) {{
    for (const table of [...TABLES].reverse()) {{
      await queryInterface.dropTable(table);
    }}
  }},
}};
"""

    out = "migrations/20260101000000-init-schema.js"
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(content)
    print(f"wrote {out}: {len(statements)} statements, {len(TABLES)} tables")


if __name__ == "__main__":
    main()
