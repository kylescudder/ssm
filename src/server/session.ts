import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth, ensureMigrated } from "./auth";
import { isAllowedEmail } from "./env";

export async function getSession() {
	await ensureMigrated();
	const session = await auth.api.getSession({ headers: getRequestHeaders() });
	if (!session || !isAllowedEmail(session.user.email)) return null;
	return session;
}

export async function requireUser() {
	const session = await getSession();
	if (!session) throw new Error("Unauthorised");
	return session.user;
}
