const nodemailer = require("nodemailer");
const env = require("../config/env");

let transporter = null;

function isEmailConfigured() {
  return Boolean(
    (env.brevoSmtpUser && env.brevoSmtpKey) ||
    (env.gmailUser && env.gmailAppPassword)
  );
}

function getTransporter() {
  if (!transporter) {
    if (env.brevoSmtpUser && env.brevoSmtpKey) {
      transporter = nodemailer.createTransport({
        host: "smtp-relay.brevo.com",
        port: 587,
        secure: false,
        auth: {
          user: env.brevoSmtpUser,
          pass: env.brevoSmtpKey,
        },
      });
    } else if (env.gmailUser && env.gmailAppPassword) {
      transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: env.gmailUser,
          pass: env.gmailAppPassword,
        },
      });
    }
  }

  return transporter;
}

async function sendEmail(to, subject, html) {
  const mailer = getTransporter();

  if (!mailer) {
    console.warn("Email skipped: configure BREVO_SMTP_USER/BREVO_SMTP_KEY or Gmail credentials.");
    return false;
  }

  try {
    await mailer.sendMail({
      from: env.emailFrom || env.gmailUser || env.brevoSmtpUser,
      to,
      subject,
      html,
    });
    return true;
  } catch (error) {
    console.error("Email failed:", error.message);
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
