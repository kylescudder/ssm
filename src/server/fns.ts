import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import * as ado from "./ado";
import { loadBoard } from "./board";
import { env } from "./env";
import * as jira from "./jira";
import { getSession, requireUser } from "./session";

export const getSessionFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const s = await getSession();
		return s ? { user: { name: s.user.name, email: s.user.email } } : null;
	},
);

export const getBoardFn = createServerFn({ method: "GET" }).handler(
	async () => {
		await requireUser();
		return loadBoard();
	},
);

export const requeueChecksFn = createServerFn({ method: "POST" })
	.validator(
		z.object({ evaluationIds: z.array(z.string().uuid()).min(1).max(20) }),
	)
	.handler(async ({ data }) => {
		await requireUser();
		// One at a time: requeuing several build policies at once can make ADO cancel and re-queue.
		for (const id of data.evaluationIds) await ado.requeueEvaluation(id);
		return { ok: true };
	});

export const retriggerCodeRabbitFn = createServerFn({ method: "POST" })
	.validator(z.object({ repoId: z.string().uuid(), prId: z.number().int() }))
	.handler(async ({ data }) => {
		await requireUser();
		await ado.postComment(data.repoId, data.prId, env.ado.retriggerComment);
		return { ok: true };
	});

/** Only ever closes threads SSM itself flagged as CodeRabbit acknowledgements; the UI passes their ids. */
export const closeThreadsFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			repoId: z.string().uuid(),
			prId: z.number().int(),
			threadIds: z.array(z.number().int()).min(1).max(20),
		}),
	)
	.handler(async ({ data }) => {
		await requireUser();
		await ado.closeThreads(data.repoId, data.prId, data.threadIds);
		return { ok: true };
	});

export const mergePrFn = createServerFn({ method: "POST" })
	.validator(z.object({ repoId: z.string().uuid(), prId: z.number().int() }))
	.handler(async ({ data }) => {
		await requireUser();
		return ado.completePr(data.repoId, data.prId);
	});

export const setDraftFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			repoId: z.string().uuid(),
			prId: z.number().int(),
			isDraft: z.boolean(),
		}),
	)
	.handler(async ({ data }) => {
		await requireUser();
		await ado.setDraft(data.repoId, data.prId, data.isDraft);
		return { ok: true };
	});

const jiraKey = z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/);

export const getTransitionsFn = createServerFn({ method: "GET" })
	.validator(z.object({ key: jiraKey }))
	.handler(async ({ data }) => {
		await requireUser();
		return jira.transitions(data.key);
	});

export const transitionJiraFn = createServerFn({ method: "POST" })
	.validator(z.object({ key: jiraKey, transitionId: z.string().min(1) }))
	.handler(async ({ data }) => {
		await requireUser();
		await jira.transition(data.key, data.transitionId);
		return { ok: true };
	});

export const searchAssigneesFn = createServerFn({ method: "GET" })
	.validator(z.object({ key: jiraKey, query: z.string().max(100) }))
	.handler(async ({ data }) => {
		await requireUser();
		return jira.assignableUsers(data.key, data.query);
	});

export const assignJiraFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			key: jiraKey,
			accountId: z.string().min(1).max(128).nullable(),
		}),
	)
	.handler(async ({ data }) => {
		await requireUser();
		await jira.assign(data.key, data.accountId);
		return { ok: true };
	});

/** Moves a ticket to JIRA_PR_STATUS if a direct transition exists — never steps through other statuses. */
export const moveToPrStatusFn = createServerFn({ method: "POST" })
	.validator(z.object({ key: jiraKey }))
	.handler(async ({ data }) => {
		await requireUser();
		const target = env.jira.prStatus.toLowerCase();
		const ts = await jira.transitions(data.key);
		const t = ts.find((x) => x.to.toLowerCase() === target);
		if (!t)
			throw new Error(
				`No direct transition to "${env.jira.prStatus}". Available: ${ts.map((x) => x.to).join(", ") || "none"}`,
			);
		await jira.transition(data.key, t.id);
		return { ok: true, to: t.to };
	});
