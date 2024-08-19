import migration from "./models/migration";
import sequelize from "./lib/sequelize";
import {createWebServer} from "./webServer";



sequelize
    // Test if database can auth
    .authenticate()
    // Migrate the database
    .then(migration)
    // Start webServer
    .then(createWebServer)
.catch((error)=>{
    console.error('Unable to start:', error);
    process.exit(1);
});


