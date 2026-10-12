const mongoose = require('mongoose')
const logger = require('../utils/logger')

module.exports = async function connectDB() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/voicestack'
  await mongoose.connect(uri)
  logger.info('MongoDB connected')
}
