const createApp = require("./app");
const env = require("./config/env");
const { connectDatabase } = require("./config/database");

async function startServer() {
  const app = createApp();
  let reconnectTimer;

  const connectWithRetry = async () => {
    try {
      await connectDatabase(env.mongodbUri);
      console.log("MongoDB connection ready");
    } catch (error) {
      console.error("MongoDB unavailable; retrying in 5 seconds", error.message);
      reconnectTimer = setTimeout(connectWithRetry, 5000);
    }
  };

  const server = app.listen(env.port, () => {
    console.log(`Server listening on mongodb://localhost:27017/
        :${env.port}`);
  });

  server.on("close", () => clearTimeout(reconnectTimer));
  connectWithRetry();
}

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
