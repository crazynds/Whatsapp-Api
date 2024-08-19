import { Sequelize } from '@sequelize/core';
import { SqliteDialect } from '@sequelize/sqlite3';


const sequelize = new Sequelize({
  dialect: SqliteDialect,
  storage: ':memory:', 
  pool: { max: 1, idle: Infinity, maxUses: Infinity },
});

export default sequelize;
