const crypto = require("crypto");
const QRCode = require("qrcode");
const env = require("../config/env");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ENCRYPTION_KEY = crypto
  .createHmac("sha256", env.jwtSecret)
  .update("care-tar:mfa-secret-encryption:v1")
  .digest();
const TOTP_STEP_MS = 30_000;

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function decodeBase32(value) {
  let bits = 0;
  let accumulator = 0;
  const bytes = [];

  for (const character of String(value).replace(/=+$/u, "").toUpperCase()) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) {
      throw new Error("Invalid base32 authenticator secret");
    }
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function generateAuthenticatorSecret() {
  return encodeBase32(crypto.randomBytes(20));
}

function generateTotpCode(secret, timeMs = Date.now()) {
  const counter = Math.floor(timeMs / TOTP_STEP_MS);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto
    .createHmac("sha1", decodeBase32(secret))
    .update(counterBuffer)
    .digest();
  const offset = digest[digest.length - 1] & 15;
  const binary =
    ((digest[offset] & 127) << 24) |
    ((digest[offset + 1] & 255) << 16) |
    ((digest[offset + 2] & 255) << 8) |
    (digest[offset + 3] & 255);

  return String(binary % 1_000_000).padStart(6, "0");
}

function verifyTotpCode(secret, code, timeMs = Date.now()) {
  const candidate = Buffer.from(String(code || ""));
  if (!/^\d{6}$/u.test(String(code || ""))) {
    return false;
  }

  const currentStep = Math.floor(timeMs / TOTP_STEP_MS);
  for (const stepOffset of [-1, 0, 1]) {
    const expected = Buffer.from(
      generateTotpCode(secret, (currentStep + stepOffset) * TOTP_STEP_MS)
    );
    if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) {
      return true;
    }
  }

  return false;
}

function encryptAuthenticatorSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    encrypted.toString("hex"),
  ].join(".");
}

function decryptAuthenticatorSecret(encryptedSecret) {
  const [version, ivHex, authTagHex, encryptedHex] = String(encryptedSecret || "").split(".");
  if (version !== "v1" || !ivHex || !authTagHex || !encryptedHex) {
    throw new Error("Stored authenticator secret is invalid");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    ENCRYPTION_KEY,
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

async function createAuthenticatorQrCode(secret, email) {
  const issuer = "CARE TAR";
  const label = `${issuer}:${email}`;
  const provisioningUri =
    `otpauth://totp/${encodeURIComponent(label)}?` +
    `secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}` +
    "&algorithm=SHA1&digits=6&period=30";

  return {
    qrCodeDataUrl: await QRCode.toDataURL(provisioningUri, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 240,
    }),
    manualEntryKey: secret,
  };
}

module.exports = {
  createAuthenticatorQrCode,
  decryptAuthenticatorSecret,
  encryptAuthenticatorSecret,
  generateAuthenticatorSecret,
  generateTotpCode,
  verifyTotpCode,
};
