const nodemailer = require("nodemailer");
const env = require("../config/env");

let transporter = null;

function isEmailConfigured() {
  return Boolean(
    env.emailFrom && (
      env.brevoApiKey ||
      (env.brevoSmtpUser && env.brevoSmtpKey)
    )
  );
}

async function sendBrevoApiEmail(to, subject, html, replyTo = null, from = null) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": env.brevoApiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: { email: from || env.emailFrom },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      ...(replyTo ? { replyTo: { email: replyTo } } : {}),
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Brevo API ${response.status}: ${message}`);
  }

  return true;
}

function getTransporter() {
  if (!transporter) {
    if (env.brevoSmtpUser && env.brevoSmtpKey) {
      transporter = nodemailer.createTransport({
        host: "smtp-relay.brevo.com",
        port: 2525,
        secure: false,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
        auth: {
          user: env.brevoSmtpUser,
          pass: env.brevoSmtpKey,
        },
      });
    }
  }

  return transporter;
}

async function sendEmail(to, subject, html, options = {}) {
  const replyTo = options.replyTo || null;
  const from = options.from || null;
  if (env.brevoApiKey) {
    try {
      return await sendBrevoApiEmail(to, subject, html, replyTo, from);
    } catch (error) {
      console.error("Brevo API email failed:", error.message);
      return false;
    }
  }

  const mailer = getTransporter();

  if (!mailer) {
    console.warn("Email skipped: configure BREVO_API_KEY or BREVO_SMTP_USER/BREVO_SMTP_KEY.");
    return false;
  }

  try {
    await mailer.sendMail({
      from: from || env.emailFrom || env.brevoSmtpUser,
      to,
      subject,
      html,
      ...(replyTo ? { replyTo } : {}),
    });
    return true;
  } catch (error) {
    console.error("Email failed:", error.message);
      console.error(`Email failed for ${to || "unknown recipient"}:`, error.message);
    return false;
  }
}

function buildActivationEmail(user, inviteToken) {
  const activationUrl = `${env.frontendUrl.replace(/\/+$/, "")}/activate.html?email=${encodeURIComponent(user.email)}&token=${inviteToken}`;

  return {
    subject: "Activate your CARE travel request account",
    html: `
      <p>Hello ${user.name},</p>
      <p>Your CARE travel request account has been created. Please set your password to activate it:</p>
      <p><a href="${activationUrl}">Activate your account</a></p>
      <p>Or use this activation token in the app:</p>
      <p><strong>${inviteToken}</strong></p>
      <p>This link expires in 7 days.</p>
    `,
  };
}

async function sendActivationEmail(user, inviteToken) {
  const content = buildActivationEmail(user, inviteToken);
  return sendEmail(user.email, content.subject, content.html);
}

function buildTemporaryPasswordEmail(user, temporaryPassword, expiresAt) {
  const loginUrl = `${env.frontendUrl.replace(/\/+$/, "")}/login.html?email=${encodeURIComponent(user.email)}`;
  const expiry = new Date(expiresAt).toLocaleDateString("en-KE");

  return {
    subject: "Your CARE travel request system access",
    html: `
      <p>Hello ${user.name},</p>
      <p>Your CARE travel request system account is ready. Use the secure link below to sign in:</p>
      <p><a href="${loginUrl}">Sign in to the CARE travel request system</a></p>
      <p><strong>Email:</strong> ${user.email}<br />
      <strong>Temporary password:</strong> ${temporaryPassword}</p>
      <p>This temporary password expires on ${expiry}. You must choose a new password after signing in.</p>
    `,
  };
}

async function sendTemporaryPasswordEmail(user, temporaryPassword, expiresAt) {
  const content = buildTemporaryPasswordEmail(user, temporaryPassword, expiresAt);
  return sendEmail(user.email, content.subject, content.html);
}

module.exports = {
  isEmailConfigured,
  sendEmail,
  sendActivationEmail,
  sendTemporaryPasswordEmail,
  buildActivationEmail,
  buildTemporaryPasswordEmail,
};
