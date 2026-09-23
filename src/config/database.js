const mongoose = require("mongoose");

function normalizeMongoUri(mongodbUri) {
  return mongodbUri.replace("mongodb://localhost", "mongodb://localhost:27017/");
}

async function connectDatabase(mongodbUri) {
  const uri = normalizeMongoUri(mongodbUri);
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, {
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 20),
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 5),
    serverSelectionTimeoutMS: Number(
      process.env.MONGO_SERVER_SELECTION_TIMEOUT || 5000
    ),
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT || 45000),
  });

  const { host, name } = mongoose.connection;
  console.log(`Connected to MongoDB at ${host}/${name}`);
}

async function disconnectDatabase() {
  await mongoose.disconnect();
}

module.exports = {
  connectDatabase,
  disconnectDatabase,
};
