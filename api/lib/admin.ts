import { createHttpError } from "./api-error.ts";

const getAdminEmails = () => {
  return new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
};

const isBootstrapAdminEmail = (email: string | null | undefined) => {
  if (!email) return false;
  return getAdminEmails().has(email.trim().toLowerCase());
};

const hasAdminAccess = (user: any | null | undefined) => {
  return Boolean(user && isBootstrapAdminEmail(user.email));
};

const requireAdmin = (req: any, res: any, next: any) => {
  if (!req.user) {
    return res.status(401).json({ status: "error", message: "Not signed in." });
  }
  if (!hasAdminAccess(req.user)) {
    return res.status(403).json({ status: "error", message: "Admin access required." });
  }
  next();
};

export {
  getAdminEmails,
  hasAdminAccess,
  isBootstrapAdminEmail,
  requireAdmin,
};
