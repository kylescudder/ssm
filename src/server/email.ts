import { env } from "./env";

export async function sendEmail(msg: {
	to: string;
	subject: string;
	text: string;
	html: string;
}) {
	if (!env.resendKey) {
		console.log(
			`\n✉️  [ssm] email to ${msg.to} — ${msg.subject}\n${msg.text}\n`,
		);
		return;
	}
	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.resendKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ from: env.emailFrom, ...msg }),
	});
	if (!res.ok)
		console.error("[ssm] Resend failed", res.status, await res.text());
}
