import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { getBaseUrl } from "./base-url.ts";
import { repairLegacyGithubStubOnLogin } from "./github-legacy-stub-repair.ts";
import { sendEmail } from "./mailer.ts";
import { syncGithubProfileOnLogin } from "./github-account.ts";
import { bindCollaboratorInvitesToUser } from "./collaborator-access.ts";

export const auth = betterAuth({
  baseURL: getBaseUrl(),
  secret: (process.env.AUTH_SECRET || process.env.BETTER_AUTH_SECRET) as string,
  user: {
    additionalFields: {
      githubUsername: {
        type: "string",
        required: false,
        input: false,
      },
    },
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["github"],
      disableImplicitLinking: false,
      updateUserInfoOnLink: true,
      allowUnlinkingAll: false,
    },
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_APP_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET as string,
      overrideUserInfoOnSignIn: false,
      mapProfileToUser: (profile) => ({
        name: profile.name ?? profile.login,
        image: profile.avatar_url ?? null,
        githubUsername: profile.login,
      }),
      scope: ["repo", "user:email"],
      getUserInfo: async (token) => {
        const profileResponse = await fetch("https://api.github.com/user", {
          headers: {
            "User-Agent": "better-auth",
            Authorization: `Bearer ${token.accessToken}`,
          },
        });

        if (!profileResponse.ok) {
          console.warn("[auth] github getUserInfo failed", {
            status: profileResponse.status,
            githubRequestId: profileResponse.headers.get("x-github-request-id"),
            rateLimitRemaining: profileResponse.headers.get("x-ratelimit-remaining"),
          });
          return null;
        }

        const profile = (await profileResponse.json()) as any;

        let emails:
          | Array<{ email: string; primary: boolean; verified: boolean; visibility: "public" | "private" }>
          | undefined;
        try {
          const emailsResponse = await fetch("https://api.github.com/user/emails", {
            headers: {
              Authorization: `Bearer ${token.accessToken}`,
              "User-Agent": "better-auth",
            },
          });
          if (emailsResponse.ok) {
            emails = (await emailsResponse.json()) as any;
          }
        } catch {}

        if (!profile.email && emails) {
          profile.email = (emails.find((entry) => entry.primary) ?? emails[0])?.email as string;
        }
        const emailVerified = emails?.find((entry) => entry.email === profile.email)?.verified ?? false;

        const userMap = {
          name: profile.name ?? profile.login,
          image: profile.avatar_url ?? null,
          githubUsername: profile.login,
        };

        return {
          user: {
            id: profile.id,
            email: profile.email,
            emailVerified,
            ...userMap,
          },
          data: profile,
        };
      },
    },
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.userTable,
      session: schema.sessionTable,
      account: schema.accountTable,
      verification: schema.verificationTable,
    },
  }),
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          try {
            await repairLegacyGithubStubOnLogin(session.id, session.userId);
          } catch (error) {
            console.warn("[auth] legacy github stub repair failed", {
              sessionId: session.id,
              userId: session.userId,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          try {
            await syncGithubProfileOnLogin(session.userId);
          } catch (error) {
            console.warn("[auth] github profile sync failed", {
              sessionId: session.id,
              userId: session.userId,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          try {
            const user = await db.query.userTable.findFirst({
              where: (table, { eq }) => eq(table.id, session.userId),
            });
            if (user) {
              await bindCollaboratorInvitesToUser(user);
            }
          } catch (error) {
            console.warn("[auth] collaborator invite binding failed", {
              sessionId: session.id,
              userId: session.userId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      },
    },
  },
  plugins: [
    emailOTP({
      expiresIn: 300,
      otpLength: 6,
      allowedAttempts: 5,
      storeOTP: "encrypted",
      resendStrategy: "reuse",
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== "sign-in") return;

        const subject = `Your Pages CMS temporary code is ${otp}`;
        const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Sign in to Pages CMS</title>
</head>
<body style="background-color: #fafafa; color: #171717; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 20px;">
  <div style="max-width: 465px; margin: 40px auto; background-color: #ffffff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 20px;">
    <h2 style="font-size: 24px; font-weight: 600; text-align: center; margin: 30px 0;">Sign in to Pages CMS</h2>
    <p style="font-size: 16px; line-height: 24px;">Enter this temporary verification code to continue:</p>
    <div style="text-align: center; margin: 24px 0;">
      <span style="display: inline-block; background-color: #f5f5f5; color: #171717; font-size: 28px; font-weight: 500; font-family: monospace; letter-spacing: 8px; padding: 12px 12px 12px 20px; border-radius: 6px;">${otp}</span>
    </div>
    <p style="font-size: 16px; line-height: 24px;">This code will expire in 5 minutes.</p>
    <hr style="border: 0; border-top: 1px solid #e5e5e5; margin: 36px 0 24px 0;" />
    <p style="font-size: 14px; line-height: 24px; color: #737373;">
      This email was intended for <a href="mailto:${email}" style="color: #000; text-decoration: underline;">${email}</a>. If you didn't try to sign in, you can safely ignore this email.
    </p>
  </div>
</body>
</html>
        `;

        await sendEmail({
          to: email,
          subject,
          html,
        });
      },
    }),
  ],
});
