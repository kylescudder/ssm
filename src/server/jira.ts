import type { JiraTicket, JiraTransition, JiraUser } from "#/lib/types";
import { env } from "./env";

async function jira<T>(path: string, init: RequestInit = {}): Promise<T> {
	if (!env.jira.configured)
		throw new Error("Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN");
	const res = await fetch(`${env.jira.apiUrl}${path}`, {
		...init,
		headers: {
			Authorization: `Basic ${Buffer.from(`${env.jira.email}:${env.jira.token}`).toString("base64")}`,
			Accept: "application/json",
			"Content-Type": "application/json",
			...init.headers,
		},
	});
	if (!res.ok)
		throw Object.assign(
			new Error(
				`Jira ${path.split("?")[0]} → ${res.status}: ${(await res.text()).slice(0, 300)}`,
			),
			{ status: res.status },
		);
	const text = await res.text();
	return (text ? JSON.parse(text) : undefined) as T;
}

interface RawIssue {
	key: string;
	fields: {
		summary: string;
		status: { name: string; statusCategory: { key: string } };
		assignee: { displayName: string; accountId: string } | null;
		issuetype?: { name: string; iconUrl: string };
	};
}

const FIELDS = ["summary", "status", "assignee", "issuetype"];

const toTicket = (i: RawIssue): JiraTicket => ({
	key: i.key,
	url: `${env.jira.baseUrl}/browse/${i.key}`,
	summary: i.fields.summary,
	status: i.fields.status.name,
	statusCategory: i.fields.status.statusCategory.key,
	assignee: i.fields.assignee?.displayName ?? null,
	assigneeId: i.fields.assignee?.accountId ?? null,
	issueType: i.fields.issuetype?.name ?? null,
	issueTypeIcon: i.fields.issuetype?.iconUrl ?? null,
});

let myAccountId: string | null = null;
/** The Jira account behind the API token — used to tell "assigned to me" apart. */
export async function myself() {
	myAccountId ??= (await jira<{ accountId: string }>("/rest/api/3/myself"))
		.accountId;
	return myAccountId;
}

export async function search(jql: string, max = 100) {
	const data = await jira<{ issues: RawIssue[] }>("/rest/api/3/search/jql", {
		method: "POST",
		body: JSON.stringify({ jql, fields: FIELDS, maxResults: max }),
	});
	return data.issues.map(toTicket);
}

export async function getMany(
	keys: string[],
): Promise<Map<string, JiraTicket>> {
	const out = new Map<string, JiraTicket>();
	if (!keys.length) return out;
	try {
		for (const t of await search(`key in (${keys.join(",")})`, keys.length))
			out.set(t.key, t);
	} catch (e) {
		// One bad key fails the whole JQL — fall back to per-issue lookups.
		if ((e as { status?: number }).status !== 400) throw e;
		await Promise.all(
			keys.map(async (k) => {
				const i = await jira<RawIssue>(
					`/rest/api/3/issue/${k}?fields=${FIELDS.join(",")}`,
				).catch(() => null);
				if (i) out.set(i.key, toTicket(i));
			}),
		);
	}
	return out;
}

export async function transitions(key: string): Promise<JiraTransition[]> {
	const data = await jira<{
		transitions: { id: string; name: string; to: { name: string } }[];
	}>(`/rest/api/3/issue/${key}/transitions`);
	return data.transitions.map((t) => ({
		id: t.id,
		name: t.name,
		to: t.to.name,
	}));
}

export function transition(key: string, transitionId: string) {
	return jira(`/rest/api/3/issue/${key}/transitions`, {
		method: "POST",
		body: JSON.stringify({ transition: { id: transitionId } }),
	});
}

/** People Jira allows on this ticket, filtered by name or email. */
export async function assignableUsers(
	key: string,
	query: string,
): Promise<JiraUser[]> {
	const q = new URLSearchParams({ issueKey: key, query, maxResults: "20" });
	const users = await jira<
		{
			accountId: string;
			displayName: string;
			active: boolean;
			avatarUrls?: Record<string, string>;
		}[]
	>(`/rest/api/3/user/assignable/search?${q}`);
	return users
		.filter((u) => u.active)
		.map((u) => ({
			accountId: u.accountId,
			name: u.displayName,
			avatar: u.avatarUrls?.["24x24"] ?? null,
		}));
}

/** accountId null unassigns. */
export function assign(key: string, accountId: string | null) {
	return jira(`/rest/api/3/issue/${key}/assignee`, {
		method: "PUT",
		body: JSON.stringify({ accountId }),
	});
}
