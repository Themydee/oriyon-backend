import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

interface JwtPayload {
  userId: string;
  email: string;
  role: "trainee" | "trainer" | "lead_trainer" | "coordinator" | "admin";
  assignedState?: string | null;
  assignedLga?: string | null;
  assignedZone?: string | null;
  isCooperativeOnly?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    req.user = payload;
    req.headers["x-user-id"] = payload.userId;
    req.headers["x-user-email"] = payload.email;
    req.headers["x-user-role"] = payload.role;
    req.headers["x-user-assigned-state"] = payload.assignedState || "";
    req.headers["x-user-assigned-lga"] = payload.assignedLga || "";
    req.headers["x-user-assigned-zone"] = payload.assignedZone || "";
    req.headers["x-user-is-cooperative-only"] = payload.isCooperativeOnly ? "true" : "false";

    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}


export function requireRole(...roles: Array<"trainee" | "trainer" | "lead_trainer" | "coordinator" | "admin">) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden — insufficient role" });
    }
    next();
  };
}