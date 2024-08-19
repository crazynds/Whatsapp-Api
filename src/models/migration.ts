import Client from "./client";
import sequelize from "../lib/sequelize";



export default async function () {
    //await Client.sync({alter:true});
    await sequelize.sync({alter:true});
    console.log('All models were synchronized successfully.');
}
