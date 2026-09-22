const env = require("../config/env");
const { isEmailConfigured } = require("../services/emailService");

function getHealth(req, res) {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    apiBase: "/api",
    frontendUrl: env.frontendUrl,
    emailConfigured: isEmailConfigured(),
  });
}

module.exports = {
  getHealth,
};
