import { Sequelize } from 'sequelize';
import config from './config';

const isTest = process.env.NODE_ENV === 'test';

// 连接池中连接闲置多少毫秒后释放
const POOL_IDLE_MS = 10_000;
// 获取连接超时时间（毫秒）
const POOL_ACQUIRE_MS = 30_000;

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: isTest ? ':memory:' : (config.db.storage || './velotradex.db'),
  logging: isTest ? false : config.db.logging,
  pool: {
    max: 1, // Force serial execution for SQLite to reduce locking
    min: 0,
    idle: POOL_IDLE_MS,
    acquire: POOL_ACQUIRE_MS
  }
});

// Enable WAL mode for better concurrency and NORMAL synchronous for durability/performance balance
sequelize.query('PRAGMA journal_mode=WAL;').catch(err => {
    console.error('Failed to enable WAL mode', err);
});

sequelize.query('PRAGMA synchronous=NORMAL;').catch(err => {
    console.error('Failed to set synchronous mode', err);
});

sequelize.query('PRAGMA busy_timeout=5000;').catch(err => {
    console.error('Failed to set busy_timeout', err);
});

sequelize.query('PRAGMA wal_autocheckpoint=1000;').catch(err => {
    console.error('Failed to set wal_autocheckpoint', err);
});

