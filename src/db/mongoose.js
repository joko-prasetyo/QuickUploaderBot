require("dotenv").config();
const mongoose = require("mongoose");
const connection =
  process.env.MONGODB_NATIVE_URL ||
  "mongodb://localhost:27017/quick-uploader";
mongoose.set("useFindAndModify", false);
mongoose.connect(connection, {
  useNewUrlParser: true,
  useCreateIndex: true,
  useUnifiedTopology: true
});