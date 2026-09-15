const dotenv = require("dotenv");

dotenv.config();

function normalizeOrigin(url) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function addOriginPair(origins, url) {
  const origin = normalizeOrigin(url);

  if (!origin) {
    return;
  }

  origins.add(origin);

  if (origin.includes("://localhost")) {
    origins.add(origin.replace("://localhost", "://127.0.0.1"));
  }

  if (origin.includes("://127.0.0.1")) {
    origins.add(origin.replace("://127.0.0.1", "://localhost"));
  }
}

function buildCorsOrigins(frontendUrl) {
  const origins = new Set();

  addOriginPair(origins, frontendUrl);
  addOriginPair(origins, "http://localhost:5500");
  addOriginPair(origins, "http://localhost:3000");

  return Array.from(origins);
}

const nodeEnv = process.env.NODE_ENV || "development";
const jwtSecret = process.env.JWT_SECRET || "development-secret";

if (nodeEnv === "production" && (!process.env.JWT_SECRET || jwtSecret === "development-secret")) {
  throw new Error("JWT_SECRET must be set to a strong value in production");
}

if (nodeEnv === "production" && !process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI must be set in production; refusing to use localhost MongoDB");
}

const isRenderDeployment =
  process.env.RENDER === "true" || Boolean(process.env.RENDER_SERVICE_ID);
const configuredFrontendUrl = process.env.FRONTEND_URL || "";
const frontendUrl =
  isRenderDeployment &&
  (!configuredFrontendUrl || configuredFrontendUrl.includes("localhost"))
    ? "https://travel-request.onrender.com"
    : configuredFrontendUrl || "http://localhost:5500";

const env = {
  nodeEnv,
  port: Number(process.env.PORT) || 5000,
  mongodbUri:
    process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/care-travel-request",
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "1d",
  gmailUser: process.env.GMAIL_USER || "",
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD || "",
  brevoSmtpUser: process.env.BREVO_SMTP_USER || "",
  brevoSmtpKey: process.env.BREVO_SMTP_KEY || "",
  emailFrom: process.env.EMAIL_FROM || process.env.GMAIL_USER || process.env.BREVO_SMTP_USER || "",
  frontendUrl,
  corsOrigins: buildCorsOrigins(frontendUrl),
};

module.exports = env;
