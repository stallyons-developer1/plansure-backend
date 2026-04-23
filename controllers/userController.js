const User = require("../models/userModel");

const createUser = async (req, res) => {
  try {
    const { name, email } = req.body;

    const user = await User.create({ name, email });
    res.status(201).json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getUsers = async (req, res) => {
  const users = await User.find();
  res.json(users);
};

module.exports = { createUser, getUsers };
