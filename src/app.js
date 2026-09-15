const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const env = require("./config/env");
const routes = require("./routes");
const {
  errorHandler,
  notFoundHandler,
} = require("./middleware/errorHandler");

function createCorsMiddleware() {
  return cors({
    origin(origin, callback) {
      if (
        !origin ||
        env.corsOrigins.includes(origin) ||
        env.nodeEnv === "development"
      ) {
        return callback(null, true);
      }

      return callback(null, false);
    },
  });
}

function createApp() {
  const app = express();

  app.use(helmet());
  app.use(createCorsMiddleware());
  app.use(express.json({ limit: "1mb" }));
  if (process.env.NODE_ENV !== "test") {
    app.use(morgan("dev"));
  }

  app.use("/api", routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
