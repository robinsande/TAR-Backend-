const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongoServer = null;
let usesExternalDatabase = false;

async function startTestDatabase() {
  const externalUri = process.env.TEST_MONGODB_URI;
  if (externalUri) {
    usesExternalDatabase = true;
    await mongoose.connect(externalUri);
    return null;
  }

  try {
    mongoServer = await MongoMemoryServer.create();
  } catch (error) {
    const isChecksumFailure = /MD5 check failed|checksum/i.test(error.message || "");
    if (!isChecksumFailure) throw error;

    // Some corporate proxies rewrite MongoDB download metadata. Let the binary
    // validate itself at startup instead of failing on the altered checksum.
    process.env.MONGOMS_MD5_CHECK = "false";
    mongoServer = await MongoMemoryServer.create();
  }

  await mongoose.connect(mongoServer.getUri());
  return mongoServer;
}

async function stopTestDatabase() {
  await mongoose.disconnect();
  if (!usesExternalDatabase && mongoServer) {
    await mongoServer.stop();
  }
  mongoServer = null;
  usesExternalDatabase = false;
}

module.exports = {
  startTestDatabase,
  stopTestDatabase,
};
