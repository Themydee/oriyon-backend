import { Request, Response, NextFunction } from "express";
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
export declare function authenticate(req: Request, res: Response, next: NextFunction): Response<any, Record<string, any>> | undefined;
export declare function requireRole(...roles: Array<"trainee" | "trainer" | "lead_trainer" | "coordinator" | "admin">): (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
//# sourceMappingURL=auth.d.ts.map