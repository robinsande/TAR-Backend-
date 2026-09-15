#!/usr/bin/env node
const User = require("../src/models/User");
const env = require("../src/config/env");
const { connectDatabase, disconnectDatabase } = require("../src/config/database");
const { hashPassword } = require("../src/services/passwordService");

async function setUserPassword(email, password, { clearMustSetPassword = true } = {}) {
  const user = await User.findOne({ email: email.toLowerCase() });

  if (!user) {
    throw new Error(`No user found with email ${email}`);
  }

  user.passwordHash = await hashPassword(password);

  if (clearMustSetPassword) {
    user.mustSetPassword = false;
    user.inviteToken = null;
    user.inviteTokenExpires = null;
  }

  await user.save();
  return user;
}

async function run() {
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email || !password) {
    throw new Error("Usage: node scripts/setPassword.js <email> <password>");
  }

  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  await connectDatabase(env.mongodbUri);
  const user = await setUserPassword(email, password);
  await disconnectDatabase();

  console.log(`Password updated for ${user.email} (${user.name})`);
}

if (require.main === module) {
  run().catch(async (error) => {
    console.error("Password update failed:", error.message);
    await disconnectDatabase();
    process.exit(1);
  });
}

module.exports = {
  setUserPassword,
};
