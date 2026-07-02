import jwt from "jsonwebtoken";
import { hashIdentifier } from "./logging.js";

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
  return async (req, res, next) => {
    const header = req.get("authorization") || "";
    const match = header.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      if (required) {
        req.log?.("authentication", {
          eventType: "auth_required_missing_token",
          severity: "WARN",
          outcome: "failure",
          what: { required }
        });
        req.log?.("access_authorization", {
          eventType: "request_denied_missing_authentication",
          severity: "WARN",
          outcome: "denied",
          what: { required }
        });
        return res.status(401).json({ error: "Authentication required." });
      }
      req.user = null;
      return next();
    }

    try {
      const payload = jwt.verify(match[1], jwtSecret);
      const user = await store.findById("users", payload.sub);
      if (!user) {
        req.log?.("authentication", {
          eventType: "session_user_not_found",
          severity: "WARN",
          outcome: "failure",
          actor: {
            userId: payload.sub || null,
            userEmailHash: hashIdentifier(payload.email),
            authenticated: false
          },
          what: { tokenSubject: payload.sub || null }
        });
        req.log?.("session", {
          eventType: "session_token_orphaned",
          severity: "WARN",
          outcome: "failure",
          actor: {
            userId: payload.sub || null,
            userEmailHash: hashIdentifier(payload.email),
            authenticated: false
          }
        });
        return res.status(401).json({ error: "Session user was not found." });
      }
      req.user = user;
      req.log?.("authentication", {
        eventType: "session_token_validated",
        severity: "INFO",
        outcome: "success",
        actor: {
          userId: user.id,
          userEmailHash: hashIdentifier(user.email),
          authenticated: true
        }
      });
      req.log?.("session", {
        eventType: "session_validated",
        severity: "INFO",
        outcome: "success",
        actor: {
          userId: user.id,
          userEmailHash: hashIdentifier(user.email),
          authenticated: true
        }
      });
      return next();
    } catch (error) {
      req.log?.("authentication", {
        eventType: "session_token_invalid",
        severity: "WARN",
        outcome: "failure",
        error
      });
      req.log?.("session", {
        eventType: "session_token_rejected",
        severity: "WARN",
        outcome: "failure",
        error
      });
      return res.status(401).json({ error: "Invalid or expired session." });
    }
  };
}
