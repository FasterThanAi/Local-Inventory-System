const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "super_secret_local_inventory_key";

module.exports = function (req, res, next) {
  // Get token from header
  const authHeader = req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token, authorization denied" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.ownerId = decoded.ownerId;
    next();
  } catch (err) {
    res.status(401).json({ error: "Token is not valid" });
  }
};
