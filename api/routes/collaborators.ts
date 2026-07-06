import { Router, Request, Response } from "express";
import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index";
import { collaboratorTable, collaboratorInviteTable } from "../db/schema";
import { requireAuth } from "./shared";

import { requireGithubRepoWriteAccess } from "../lib/authz-server";
import { getInstallations, getInstallationRepos } from "../lib/github-app";
import { getBaseUrl } from "../lib/base-url";
import { sendEmail } from "../lib/mailer";
import { findVerifiedUserByEmail, normalizeEmail } from "../lib/collaborator-access";
import { sendErrorResponse } from "../lib/api-error";

const router = Router();

/* ==========================================
   9. COLLABORATOR MANAGEMENT ENDPOINTS
   ========================================== */
router.get("/api/collaborators/:owner/:repo", requireAuth, async (req: any, res: Response) => {
  try {
    const { owner, repo } = req.params;
    const { repoAccess } = await requireGithubRepoWriteAccess(req.user, owner, repo, "Only GitHub users can manage collaborators.");

    const collaborators = await db.query.collaboratorTable.findMany({
      where: and(
        eq(collaboratorTable.ownerId, repoAccess.ownerId),
        eq(collaboratorTable.repoId, repoAccess.repoId)
      )
    });

    res.json({ status: "success", data: collaborators });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

router.post("/api/collaborators", requireAuth, async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) throw new Error("You must be signed in with GitHub to invite collaborators.");

    const { owner, repo, emails: rawEmails } = req.body;
    if (!owner || !repo || !rawEmails) throw new Error("Owner, repo, and emails are required.");

    const emails = Array.isArray(rawEmails) ? rawEmails : [rawEmails];

    // Authorization Check
    const { repoAccess, installation } = await assertRepoInInstallation(user, owner, repo);

    const baseUrl = getBaseUrl();
    const repoUrl = new URL(`/${owner}/${repo}`, baseUrl).toString();
    const createdCollaborators: any[] = [];
    const errors: string[] = [];
    let immediateAccessCount = 0;
    let pendingInviteCount = 0;

    for (const email of emails) {
      const normalizedEmail = normalizeEmail(email);
      const existingUser = await findVerifiedUserByEmail(normalizedEmail);
      const collaborator = await db.query.collaboratorTable.findFirst({
        where: and(
          eq(collaboratorTable.ownerId, repoAccess.ownerId),
          eq(collaboratorTable.repoId, repoAccess.repoId),
          sql`lower(${collaboratorTable.email}) = lower(${normalizedEmail})`
        ),
      });

      if (collaborator) {
        if (existingUser && collaborator.userId !== existingUser.id) {
          const updated = await db.update(collaboratorTable)
            .set({ userId: existingUser.id })
            .where(eq(collaboratorTable.id, collaborator.id))
            .returning();
          if (updated.length > 0) {
            createdCollaborators.push(...updated);
            immediateAccessCount += 1;
          }
        }
        errors.push(`${normalizedEmail} is already invited.`);
        continue;
      }

      if (!existingUser) {
        const inviteUrl = await createCollaboratorInviteUrl({ email: normalizedEmail, owner, repo, baseUrl });
        try {
          const html = `
            <div style="font-family: sans-serif; padding: 20px;">
              <h2>Join "${owner}/${repo}" on Pages CMS</h2>
              <p>You have been invited by <strong>${user.name || user.githubUsername || user.email}</strong> to collaborate on the repository <strong>${owner}/${repo}</strong>.</p>
              <p>Click the link below to accept the invitation:</p>
              <p><a href="${inviteUrl}" style="background-color: #0070f3; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Accept Invitation</a></p>
            </div>
          `;
          await sendEmail({ to: normalizedEmail, subject: `Join "${owner}/${repo}" on Pages CMS`, html });
        } catch (error: any) {
          errors.push(`${normalizedEmail}: ${error.message}`);
          continue;
        }
      } else {
        try {
          const html = `
            <div style="font-family: sans-serif; padding: 20px;">
              <h2>You were added to "${owner}/${repo}" on Pages CMS</h2>
              <p>You have been added by <strong>${user.name || user.githubUsername || user.email}</strong> as a collaborator on the repository <strong>${owner}/${repo}</strong>.</p>
              <p><a href="${repoUrl}">Go to Repository</a></p>
            </div>
          `;
          await sendEmail({ to: normalizedEmail, subject: `You were added to "${owner}/${repo}" on Pages CMS`, html });
        } catch (error: any) {
          errors.push(`${normalizedEmail}: ${error.message}`);
        }
      }

      const inserted = await db.insert(collaboratorTable).values({
        type: repoAccess.ownerType,
        installationId: installation.id,
        ownerId: repoAccess.ownerId,
        repoId: repoAccess.repoId,
        owner: repoAccess.ownerLogin,
        repo: repoAccess.repoName,
        email: normalizedEmail,
        userId: existingUser?.id ?? null,
        invitedBy: user.id
      }).returning();

      if (inserted.length > 0) {
        createdCollaborators.push(...inserted);
        if (existingUser) immediateAccessCount += 1;
        else pendingInviteCount += 1;
      }
    }

    if (createdCollaborators.length === 0) {
      throw new Error(errors.join(" "));
    }

    res.json({
      status: "success",
      message: immediateAccessCount > 0 && pendingInviteCount > 0
        ? `${immediateAccessCount} collaborator(s) added and ${pendingInviteCount} invite(s) sent.`
        : immediateAccessCount > 0
          ? `${immediateAccessCount} collaborator(s) added.`
          : `Invite sent.`,
      data: createdCollaborators,
      errors
    });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

router.delete("/api/collaborators/:id", requireAuth, async (req: any, res: Response) => {
  try {
    const collaboratorId = Number(req.params.id);
    const { owner, repo } = req.body; // passes owner/repo context in request body
    const user = req.user;

    const collaborator = await db.query.collaboratorTable.findFirst({ where: eq(collaboratorTable.id, collaboratorId) });
    if (!collaborator) throw new Error("Collaborator not found");

    const { repoAccess } = await assertRepoInInstallation(user, owner, repo);
    const deleted = await db.delete(collaboratorTable).where(
      and(eq(collaboratorTable.id, collaboratorId), eq(collaboratorTable.repoId, repoAccess.repoId))
    ).returning();

    if (!deleted || deleted.length === 0) throw new Error("Failed to delete collaborator");

    await db.delete(collaboratorInviteTable).where(and(
      sql`lower(${collaboratorInviteTable.email}) = lower(${collaborator.email})`,
      sql`lower(${collaboratorInviteTable.owner}) = lower(${owner})`,
      sql`lower(${collaboratorInviteTable.repo}) = lower(${repo})`,
    ));

    res.json({ status: "success", message: `Collaborator successfully removed.` });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

router.post("/api/collaborators/resend-invite", requireAuth, async (req: any, res: Response) => {
  try {
    const { id: collaboratorId, owner, repo } = req.body;
    const user = req.user;

    await assertRepoInInstallation(user, owner, repo);
    const collaborator = await db.query.collaboratorTable.findFirst({ where: eq(collaboratorTable.id, collaboratorId) });
    if (!collaborator) throw new Error("Collaborator not found");

    const baseUrl = getBaseUrl();
    const inviteUrl = await createCollaboratorInviteUrl({ email: collaborator.email, owner, repo, baseUrl });

    const html = `
      <div style="font-family: sans-serif; padding: 20px;">
        <h2>Join "${owner}/${repo}" on Pages CMS</h2>
        <p>You have been invited by <strong>${user.name || user.githubUsername || user.email}</strong> to collaborate on the repository <strong>${owner}/${repo}</strong>.</p>
        <p><a href="${inviteUrl}">Accept Invitation</a></p>
      </div>
    `;
    await sendEmail({ to: collaborator.email, subject: `Join "${owner}/${repo}" on Pages CMS`, html });

    res.json({ status: "success", message: `Invitation email resent to ${collaborator.email}.` });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

// Helper functions for Collaborators
const assertRepoInInstallation = async (user: any, owner: string, repo: string) => {
  const { token, repoAccess } = await requireGithubRepoWriteAccess(user, owner, repo);
  const installations = await getInstallations(token, [owner]);
  if (installations.length !== 1) throw new Error(`"${owner}" is not part of GitHub App installations.`);
  const installationRepos = await getInstallationRepos(token, installations[0].id);
  const isInstalledForRepo = installationRepos.some((installationRepo) =>
    installationRepo.id === repoAccess.repoId ||
    (installationRepo.owner?.login?.toLowerCase() === owner.toLowerCase() && installationRepo.name?.toLowerCase() === repo.toLowerCase())
  );
  if (!isInstalledForRepo) throw new Error(`"${owner}/${repo}" is not part of your installation.`);
  return { repoAccess, installation: installations[0] };
};

const generateInviteToken = () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(32);
  let token = "";
  for (let i = 0; i < 32; i += 1) {
    token += alphabet[bytes[i] % alphabet.length];
  }
  return token;
};

const createCollaboratorInviteUrl = async ({ email, owner, repo, baseUrl }: any) => {
  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + ((Number(process.env.COLLABORATOR_INVITE_LINK_EXPIRES_IN) || 86400) * 1000));

  await db.delete(collaboratorInviteTable).where(and(
    sql`lower(${collaboratorInviteTable.email}) = lower(${email})`,
    sql`lower(${collaboratorInviteTable.owner}) = lower(${owner})`,
    sql`lower(${collaboratorInviteTable.repo}) = lower(${repo})`,
  ));

  await db.insert(collaboratorInviteTable).values({ token, email, owner, repo, expiresAt });
  const inviteUrl = new URL("/sign-in/collaborator", baseUrl);
  inviteUrl.searchParams.set("token", token);
  return inviteUrl.toString();
};

/* ==========================================
   10. COLLABORATOR INVITES ENDPOINTS
   ========================================== */
router.get("/api/collaborator-invites/:token", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const invite = await getInvite(token);
    if (!invite) return res.json({ status: "unavailable" });

    // Since Better Auth session exists on req.user, we can verify auth
    const user = (req as any).user;
    const destinationPath = `/${invite.owner}/${invite.repo}`;

    if (!user) {
      return res.json({
        status: "otp_required",
        email: invite.email,
        maskedEmail: maskEmail(invite.email),
        destinationPath,
      });
    }

    const claimed = await claimInvite(invite, user);
    if (!claimed) return res.json({ status: "wrong_account" });

    res.json({ status: "ready", destinationPath });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

router.post("/api/collaborator-invites/:token/accept", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const invite = await getInvite(token);
    if (!invite) return res.status(404).json({ status: "unavailable" });

    const user = (req as any).user;
    if (!user) return res.status(401).json({ status: "unavailable" });

    const claimed = await claimInvite(invite, user);
    if (!claimed) return res.status(403).json({ status: "wrong_account" });

    res.json({ status: "ready", destinationPath: `/${invite.owner}/${invite.repo}` });
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

// Helper functions for Invites
const getInvite = async (token: string) => {
  const invite = await db.query.collaboratorInviteTable.findFirst({ where: eq(collaboratorInviteTable.token, token) });
  if (!invite) return null;

  if (invite.expiresAt <= new Date()) {
    await db.delete(collaboratorInviteTable).where(eq(collaboratorInviteTable.id, invite.id));
    return null;
  }

  const collaborator = await db.query.collaboratorTable.findFirst({
    where: and(
      sql`lower(${collaboratorTable.email}) = lower(${invite.email})`,
      sql`lower(${collaboratorTable.owner}) = lower(${invite.owner})`,
      sql`lower(${collaboratorTable.repo}) = lower(${invite.repo})`,
    ),
  });

  if (!collaborator) {
    await db.delete(collaboratorInviteTable).where(eq(collaboratorInviteTable.id, invite.id));
    return null;
  }
  return invite;
};

const maskEmail = (email: string) => {
  const [name, domain] = email.split("@");
  if (!name || !domain) return email;
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${"*".repeat(Math.max(1, name.length - visible.length))}@${domain}`;
};

const claimInvite = async (invite: any, user: { id: string; email: string }) => {
  if (normalizeEmail(user.email) !== normalizeEmail(invite.email)) return false;

  await db.update(collaboratorTable).set({ userId: user.id })
    .where(and(
      sql`lower(${collaboratorTable.email}) = lower(${invite.email})`,
      sql`lower(${collaboratorTable.owner}) = lower(${invite.owner})`,
      sql`lower(${collaboratorTable.repo}) = lower(${invite.repo})`,
    ));

  await db.delete(collaboratorInviteTable).where(eq(collaboratorInviteTable.id, invite.id));
  return true;
};

export { router };
