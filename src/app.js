const express = require("express");
const cors = require("cors");
const compression = require("compression");
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
    origin: (requestOrigin, callback) => {
      const isLocalFrontend =
        requestOrigin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin);

      if (!requestOrigin || env.corsOrigins.includes(requestOrigin) || isLocalFrontend) {
        return callback(null, true);
      }

      return callback(null, false);
    },
  });
}

function createApp() {
  const app = express();

  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(compression());
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
