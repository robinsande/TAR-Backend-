const createApp = require("./app");
const env = require("./config/env");
const { connectDatabase } = require("./config/database");
const { startPendingApprovalReminderScheduler } = require("./services/pendingReminderScheduler");

async function startServer() {
  const app = createApp();
  let reconnectTimer;

  const connectWithRetry = async () => {
    try {
      await connectDatabase(env.mongodbUri);
      console.log("MongoDB connection ready");
      startPendingApprovalReminderScheduler();
    } catch (error) {
      console.error("MongoDB unavailable; retrying in 5 seconds", error.message);
      reconnectTimer = setTimeout(connectWithRetry, 5000);
    }
  };

  const server = app.listen(env.port, () => {
    console.log(`Server listening on port ${env.port} in ${env.nodeEnv} mode`);
  });

  server.on("close", () => clearTimeout(reconnectTimer));
  connectWithRetry();
}

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
