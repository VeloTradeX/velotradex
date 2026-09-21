'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    /**
     * 在这里编写迁移的 up 逻辑
     * 
     * 示例：添加新列
     * await queryInterface.addColumn('table_name', 'column_name', {
     *   type: Sequelize.STRING,
     *   allowNull: true,
     * });
     * 
     * 示例：创建新表
     * await queryInterface.createTable('table_name', {
     *   id: {
     *     type: Sequelize.INTEGER,
     *     primaryKey: true,
     *     autoIncrement: true,
     *   },
     *   name: {
     *     type: Sequelize.STRING,
     *     allowNull: false,
     *   },
     *   createdAt: {
     *     type: Sequelize.DATE,
     *     allowNull: false,
     *   },
     *   updatedAt: {
     *     type: Sequelize.DATE,
     *     allowNull: false,
     *   },
     * });
     * 
     * 示例：添加索引
     * await queryInterface.addIndex('table_name', ['column_name']);
     */
  },

  async down(queryInterface, Sequelize) {
    /**
     * 在这里编写迁移的 down 逻辑（回滚）
     * 
     * 示例：删除列
     * await queryInterface.removeColumn('table_name', 'column_name');
     * 
     * 示例：删除表
     * await queryInterface.dropTable('table_name');
     * 
     * 示例：删除索引
     * await queryInterface.removeIndex('table_name', ['column_name']);
     */
  }
};
