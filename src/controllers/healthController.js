const env = require("../config/env");

function getHealth(req, res) {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    apiBase: "/api",
    frontendUrl: env.frontendUrl,
  });
}

module.exports = {
  getHealth,
};
