import { Response, NextFunction } from "express";

export const requireAuth = (req: any, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ status: "error", message: "Unauthorized. Please sign in." });
  }
  next();
};
