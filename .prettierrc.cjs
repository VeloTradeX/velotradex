module.exports = {
  singleQuote: true,
  semi: true,
  trailingComma: 'es5',
  printWidth: 100,
  // 实测项目现有代码（config/database.js、ecosystem.config.js、*.ts 等）
  // 均为 2 空格缩进，与 prettier 默认值一致，故使用 2 而非任务假设的 4。
  tabWidth: 2,
  arrowParens: 'avoid',
};