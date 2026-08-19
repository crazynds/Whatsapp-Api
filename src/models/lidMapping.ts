import sequelize from "../lib/sequelize";
import { DataTypes } from "@sequelize/core";

/**
 * Mapeamento global lid -> phone, compartilhado entre todas as sessões/clientes.
 * Alimentado tanto pelo lidMapping nativo do Baileys (signalRepository) quanto
 * pelo evento `lid-mapping.update`.
 */
const LidMapping = sequelize.define("lidMapping", {
  lid: {
    type: DataTypes.STRING,
    primaryKey: true,
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: false,
  },
});

export default LidMapping;
