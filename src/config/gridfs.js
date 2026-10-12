const mongoose = require('mongoose')

const BUCKET_NAME = 'uploads'

function getBucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME })
}

module.exports = { getBucket }
