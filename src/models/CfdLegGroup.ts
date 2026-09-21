import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

// ── CFD 多腿分组 / 腿明细（Gate-CFD /tradfi/* 交易所）──────────────────
// 需求方硬性要求：Order 表零改动，腿数据独立建表，通过 orderId 关联。
// 本表为「多腿分组 + 决策快照」：cfd_leg_group 聚合一次信号的腿规划
// （CfdLegPlanner 决策快照、分组级 symbol/side/entry/SL、实际腿数），
// 每腿一行 cfd_leg，并与 orders 表一一关联（每腿一条普通 Order 记录）。
//
// 设计文档 内部设计文档 §5.1 关联查询示例：
//   - 回滚：SELECT * FROM cfd_leg WHERE legGroupId = ? → 逐腿取 orderId / positionId 平仓或撤单
//   - 前端腿分组展示：cfd_leg_group JOIN cfd_leg JOIN Order
//   - 对账：以 positionId 反查 cfd_leg → 更新腿状态 / 写回 Order 终态
// ──────────────────────────────────────────────────────────────────────

class CfdLegGroup extends Model {
  public id!: string; // 腿组 ID，如 'lg-{orderRecord.id}'，单腿信号也建组（统一语义）
  public orderRecordId!: string | null; // 关联原始信号订单记录（order_records.id）
  public symbol!: string; // 品种
  public side!: string; // 方向
  public entryPrice!: string | null; // 入场价（分组级）
  public slPrice!: string | null; // 止损价（分组级，全腿共用 SL）
  public legCount!: number; // 实际腿数（减腿后可能与信号档位数不同）
  public legPlan!: string | null; // CfdLegPlanner 决策快照 JSON（原始 TPs + 分配比例、放大/减腿过程、totalRisk/totalNotional、downgradedFrom）
  public status!: string; // pending / filled / partially_filled / failed（全回滚时标 failed）
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

CfdLegGroup.init(
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
    },
    orderRecordId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    symbol: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    side: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    entryPrice: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    slPrice: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    legCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    legPlan: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'pending',
      validate: {
        isIn: [['pending', 'filled', 'partially_filled', 'failed']],
      },
    },
  },
  {
    sequelize,
    tableName: 'cfd_leg_groups',
    indexes: [{ fields: ['orderRecordId'] }],
  }
);

export default CfdLegGroup;
