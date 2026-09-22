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
    emailSenderConfigured: Boolean(env.emailFrom),
    emailProvider: env.brevoApiKey ? "brevo-api" : env.brevoSmtpUser && env.brevoSmtpKey ? "brevo-smtp" : null,
  });
}

module.exports = {
  getHealth,
};
