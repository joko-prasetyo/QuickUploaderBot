const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    telegram_user_id: {
      type: String,
      required: true,
      unique: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    role: {
      type: String,
      lowercase: true,
      required: true,
      default: "user",
      enum: ["admin", "user"],
    },
    tokens: {
        type: Array,
        default: []
    },
    plan: {
      type: String,
      lowercase: true,
      default: "free",
      enum: ["free", "basic", "premium", "lifetime"],
    },
    current_folder_id: {
      type: String,
      default: "root"
    },
    selected_credentials_index: {
      type: Number,
      default: 0
    },
    username: {
      type: String,
    },
    first_name: {
      type: String,
    },
    last_name: {
      type: String,
    },
    email: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

userSchema.index({ telegram_user_id: 1 });

userSchema.methods.toJSON = function () {
  const user = this.toObject();
  delete user.__v;
  return user;
};

const User = mongoose.model("User", userSchema);

module.exports = User;
