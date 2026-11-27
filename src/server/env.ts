const str = (k: string, fallback = "") =>
	(process.env[k] ?? "").trim() || fallback;
const list = (k: string, fallback = "") =>
	str(k, fallback)
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

export const env = {
	get allowedEmails() {
		return list("ALLOWED_EMAILS").map((e) => e.toLowerCase());
	},
	get databasePath() {
		return str("DATABASE_PATH", "ssm.db");
	},
	get resendKey() {
		return str("RESEND_API_KEY");
	},
	get emailFrom() {
		return str("EMAIL_FROM", "SSM <onboarding@resend.dev>");
	},
	ado: {
		get org() {
			return str("ADO_ORG");
		},
		get project() {
			return str("ADO_PROJECT");
		},
		get pat() {
			return str("ADO_PAT");
		},
		get tenant() {
			return str("ADO_TENANT");
		},
		get coderabbitMatch() {
			return list("CODERABBIT_MATCH", "coderabbit");
		},
		get qaMatch() {
			return list("QA_REVIEWER_MATCH", "QA");
		},
		/** Close threads that are only "@coderabbitai review" + CodeRabbit's acknowledgement. */
		get autoResolveChatter() {
			return str("CODERABBIT_AUTO_RESOLVE", "true").toLowerCase() !== "false";
		},
		/** How SSM completes a PR: noFastForward (your usual), squash, rebase or rebaseMerge. */
		get mergeStrategy() {
			return str("ADO_MERGE_STRATEGY", "noFastForward");
		},
		get deleteSourceBranch() {
			return str("ADO_DELETE_SOURCE_BRANCH", "true").toLowerCase() !== "false";
		},
		get retriggerComment() {
			return str("CODERABBIT_RETRIGGER_COMMENT", "@coderabbitai review");
		},
	},
	jira: {
		get baseUrl() {
			return str("JIRA_BASE_URL").replace(/\/+$/, "");
		},
		/** Scoped API tokens must go via the gateway: https://api.atlassian.com/ex/jira/<cloudId> */
		get apiUrl() {
			return str("JIRA_API_URL").replace(/\/+$/, "") || this.baseUrl;
		},
		get email() {
			return str("JIRA_EMAIL");
		},
		get token() {
			return str("JIRA_API_TOKEN");
		},
		get projects() {
			return list("JIRA_PROJECTS");
		},
		get prStatus() {
			return str("JIRA_PR_STATUS", "IN PR");
		},
		get okStatuses() {
			return list("JIRA_OK_STATUSES");
		},
		get openJql() {
			return str(
				"JIRA_OPEN_JQL",
				'assignee = currentUser() AND statusCategory = "In Progress" ORDER BY updated DESC',
			);
		},
		get configured() {
			return Boolean(this.baseUrl && this.email && this.token);
		},
	},
};

export function isAllowedEmail(email: string | null | undefined) {
	return !!email && env.allowedEmails.includes(email.trim().toLowerCase());
}
