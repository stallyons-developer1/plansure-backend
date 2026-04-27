const mongoose = require("mongoose");
const crypto = require("crypto");

const tokenSchema = new mongoose.Schema(
  {
    tokenId: {
      type: Number,
      required: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

tokenSchema.statics.generateToken = async function (userId) {
  const lastToken = await this.findOne().sort({ tokenId: -1 });
  const tokenId = lastToken ? lastToken.tokenId + 1 : 1;

  const randomToken = crypto.randomBytes(32).toString("base64url");

  const tokenDoc = await this.create({
    tokenId,
    token: randomToken,
    user: userId,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  return `${tokenId}|${randomToken}`;
};

tokenSchema.statics.verifyToken = async function (bearerToken) {
  if (!bearerToken || !bearerToken.includes("|")) {
    return null;
  }

  const [tokenId, token] = bearerToken.split("|");

  const tokenDoc = await this.findOne({
    tokenId: parseInt(tokenId),
    token: token,
  }).populate("user", "-password");

  if (!tokenDoc) {
    return null;
  }

  if (new Date() > tokenDoc.expiresAt) {
    await this.findByIdAndDelete(tokenDoc._id);
    return null;
  }

  return tokenDoc.user;
};

module.exports = mongoose.model("Token", tokenSchema);
