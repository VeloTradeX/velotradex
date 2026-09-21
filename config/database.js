require('dotenv').config();

const path = require('path');

// 从 .env 读取配置，与 src/config.ts 保持一致
const dbStorage = process.env.DB_STORAGE || './data/velotradex.db';
const dbLogging = process.env.DB_LOGGING === 'true';

module.exports = {
  development: {
    dialect: 'sqlite',
    storage: dbStorage,
    logging: dbLogging ? console.log : false,
    pool: {
      max: 1,
      min: 0,
      idle: 10000,
      acquire: 30000
    }
  },
  test: {
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
    pool: {
      max: 1,
      min: 0,
      idle: 10000,
      acquire: 30000
    }
  },
  production: {
    dialect: 'sqlite',
    storage: dbStorage,
    logging: false,
    pool: {
      max: 1,
      min: 0,
      idle: 10000,
      acquire: 30000
    }
  }
};
