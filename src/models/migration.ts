import log from "../lib/logger";
import sequelize from "../lib/sequelize";
import "./client";
import "./lidMapping";

export default async function () {
  //await Client.sync({alter:true});
  await sequelize.sync({ alter: true });
  log.info("All models were synchronized successfully.");
}
