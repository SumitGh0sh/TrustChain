const mongoose = require('mongoose');
const config = require('./env');
const { ensureMongoServer } = require('./embeddedMongo');

mongoose.set('bufferTimeoutMS', 10000);

const connectDB = async () => {
  try {
    await ensureMongoServer(config.mongoUri);

    const conn = await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 10000,
    });
    console.log(`[MongoDB] Connected successfully: ${conn.connection.host}/${conn.connection.name}`);
    return conn;
  } catch (error) {
    console.warn(`[MongoDB Warning] Could not connect to MongoDB at ${config.mongoUri}.`);
    console.warn(`[MongoDB Warning] Error: ${error.message}`);
    return null;
  }
};

module.exports = connectDB;
