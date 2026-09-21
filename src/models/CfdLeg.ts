import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

// ── CFD 单腿明细（Gate-CFD /tradfi/* 交易所）──────────────────────────
// 需求方硬性要求：Order 表零改动，腿数据独立建表，通过 orderId 关联。
// 本表为「单腿明细」：每腿一行记录，orderId 指向 orders 表对应的一条
// Order 行（每腿一行 Order），positionId 为 CFD 交易所持仓 ID（成交后
// 回写，作为 closePosition / updatePosition 的锚点）。
//
// 设计文档 内部设计文档 §5.1 关联查询示例：
//   - 回滚：SELECT * FROM cfd_leg WHERE legGroupId = ? → 逐腿取 orderId / positionId 平仓或撤单
//   - 前端腿分组展示：cfd_leg_group JOIN cfd_leg JOIN Order
//   - 对账：以 positionId 反查 cfd_leg → 更新腿状态 / 写回 Order 终态
// ──────────────────────────────────────────────────────────────────────

class CfdLeg extends Model {
  public id!: string;
  public legGroupId!: string; // 所属腿组（cfd_leg_groups.id）
  public orderId!: number | null; // 该腿对应的 Order 行 id（orders.id）
  public legIndex!: number; // 腿序号（0-based）
  public tpPrice!: string | null; // 该腿止盈价
  public volume!: string; // 该腿手数（已含放大 / 封顶后值）
  public positionId!: string | null; // CFD 交易所持仓 ID（成交后回写）
  public status!: string; // pending / open / closed / failed
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

CfdLeg.init(
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
    },
    legGroupId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    orderId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    legIndex: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    tpPrice: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    volume: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    positionId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'pending',
      validate: {
        isIn: [['pending', 'open', 'closed', 'failed']],
      },
    },
  },
  {
    sequelize,
    tableName: 'cfd_legs',
    indexes: [{ fields: ['legGroupId'] }, { fields: ['orderId'] }],
  }
);

export default CfdLeg;
