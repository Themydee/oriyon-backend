import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface JwtPayload {
  userId: string;
  email: string;
  role: "trainee" | "trainer" | "lead_trainer" | "coordinator" | "admin";
  assignedState?: string | null;
  assignedLga?: string | null;
  assignedZone?: string | null;
  isCooperativeOnly?: boolean;
  iat: number;
  exp: number;
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
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const token = authHeader.split(" ")[1];
  const secret = process.env.JWT_SECRET;
  if (!token) {
    return res.status(401).json({ error: "Missing or invalid token" });
  }
  if (!secret) {
    return res.status(500).json({ error: "JWT secret not configured" });
  }

  try {
    const payload = jwt.verify(token, secret) as unknown as JwtPayload;
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireRole(...roles: Array<"trainee" | "trainer" | "lead_trainer" | "coordinator" | "admin">) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthenticated" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}
