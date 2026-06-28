import jwt from "jsonwebtoken";

export function toPublicUser(user) {
  if (!user) {
    return null;
  }
  const { passwordHash, ...publicUser } = user;
  return publicUser;
}

export function signToken(user, jwtSecret) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      planId: user.planId || "free"
    },
    jwtSecret,
    { expiresIn: "14d" }
  );
}

export function attachUser(store, jwtSecret, required = false) {
  return (req, res, next) => {
    const header = req.get("authorization") || "";
    const match = header.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      if (required) {
        return res.status(401).json({ error: "Authentication required." });
      }
      req.user = null;
      return next();
    }

    try {
      const payload = jwt.verify(match[1], jwtSecret);
      const user = store.find("users", (candidate) => candidate.id === payload.sub);
      if (!user) {
        return res.status(401).json({ error: "Session user was not found." });
      }
      req.user = user;
      return next();
    } catch {
      return res.status(401).json({ error: "Invalid or expired session." });
    }
  };
}
