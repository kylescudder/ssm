import { DatabaseSync } from "node:sqlite";
import { passkey } from "@better-auth/passkey";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { emailOTP, magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { sendEmail } from "./email";
import { env, isAllowedEmail } from "./env";

/** Endpoints that take an email in the body — rejected before anything is sent or created. */
const EMAIL_GATED_PATHS = new Set([
	"/sign-up/email",
	"/sign-in/email",
	"/sign-in/magic-link",
	"/sign-in/email-otp",
	"/email-otp/send-verification-otp",
	"/email-otp/request-password-reset",
	"/forget-password/email-otp",
	"/request-password-reset",
]);

const notAllowed = () =>
	new APIError("FORBIDDEN", { message: "This email is not on the list." });

const options = {
	database: new DatabaseSync(env.databasePath),
	appName: "SSM",
	emailAndPassword: {
		enabled: true,
		// Accounts are created only by email code or magic link (whitelisted); a password
		// is added later from Profile through the reset email.
		disableSignUp: true,
		requireEmailVerification: true,
		minPasswordLength: 12,
		maxPasswordLength: 128,
		resetPasswordTokenExpiresIn: 1800,
		revokeSessionsOnPasswordReset: true,
		sendResetPassword: async ({ user, url }) => {
			if (!isAllowedEmail(user.email)) return;
			await sendEmail({
				to: user.email,
				subject: "Set your SSM password",
				text: `Set your SSM password: ${url}\n\nExpires in 30 minutes.`,
				html: `<p><a href="${url}">Set your SSM password</a></p><p>Expires in 30 minutes.</p>`,
			});
		},
	},
	user: {
		changeEmail: { enabled: false },
		additionalFields: {
			givenName: { type: "string", required: false, defaultValue: "" },
			familyName: { type: "string", required: false, defaultValue: "" },
		},
	},
	session: { expiresIn: 60 * 60 * 24 * 30 },
	hooks: {
		before: createAuthMiddleware(async (ctx) => {
			if (!EMAIL_GATED_PATHS.has(ctx.path)) return;
			if (!isAllowedEmail(ctx.body?.email)) throw notAllowed();
		}),
	},
	databaseHooks: {
		user: {
			create: {
				// Backstop: no account can ever be created for a non-whitelisted email.
				before: async (user) => {
					if (!isAllowedEmail(user.email)) throw notAllowed();
					// Code/link sign-ins arrive without a name; Profile requires one.
					return {
						data: { ...user, name: user.name || user.email.split("@")[0] },
					};
				},
			},
		},
	},
	plugins: [
		magicLink({
			storeToken: "hashed",
			expiresIn: 60 * 10,
			sendMagicLink: async ({ email, url }) => {
				await sendEmail({
					to: email,
					subject: "Your SSM sign-in link",
					text: `Sign in to SSM: ${url}\n\nExpires in 10 minutes.`,
					html: `<p><a href="${url}">Sign in to SSM</a></p><p>Expires in 10 minutes.</p>`,
				});
			},
		}),
		emailOTP({
			allowedAttempts: 5,
			otpLength: 6,
			expiresIn: 60 * 10,
			sendVerificationOTP: async ({ email, otp }) => {
				await sendEmail({
					to: email,
					subject: `SSM code: ${otp}`,
					text: `Your SSM sign-in code is ${otp}\n\nExpires in 10 minutes.`,
					html: `<p>Your SSM sign-in code is <strong style="font-size:20px;letter-spacing:4px">${otp}</strong></p><p>Expires in 10 minutes.</p>`,
				});
			},
		}),
		passkey({ rpName: "SSM" }),
		tanstackStartCookies(),
	],
} satisfies BetterAuthOptions;

export const auth = betterAuth(options);

let migrated: Promise<void> | undefined;
/** Creates/updates the SQLite schema on first use. */
export function ensureMigrated() {
	migrated ??= getMigrations(options).then(({ runMigrations }) =>
		runMigrations(),
	);
	return migrated;
}
