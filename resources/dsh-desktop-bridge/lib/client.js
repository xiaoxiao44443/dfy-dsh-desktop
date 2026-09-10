window.__ModuleLoader__.load({
	id: "dsh-desktop-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const Cordis = require("@deepseek-ai/cordis");
		const React = require("react");
		const Primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const SETTINGS_PATH = "/api/dsh-desktop/notifications/settings";
		const SHOW_PATH = "/api/dsh-desktop/notifications/show";
		const NOTIFICATION_APPROVAL_TRANSPORT_KEY = "dsh.desktop.notification-approval.transport.v1";
		const DEFAULT_SETTINGS = Object.freeze({
			turnCompletion: "unfocused",
			permissionRequests: true,
			questions: true
		});
		const CONTEXT_MENU_ICONS = new Set([
			"copy", "cut", "paste", "undo", "redo", "select-all", "external-link", "link", "plugin",
			"archive", "trash", "edit", "folder", "settings", "terminal", "sparkles", "refresh"
		]);
		const CONTEXT_MENU_TRANSPORT_SYMBOL = Symbol.for("dsh.desktop.context-menu.transport.v1");
		const captureContextMenuSymbol = Symbol("desktopContextMenu.capture");
		const collectContextMenuSymbol = Symbol("desktopContextMenu.collect");
		const executeContextMenuSymbol = Symbol("desktopContextMenu.execute");
		const dismissContextMenuSymbol = Symbol("desktopContextMenu.dismiss");
		const clearContextMenuSymbol = Symbol("desktopContextMenu.clear");

		function boundedMenuText(value, maxLength) {
			if (typeof value !== "string") return undefined;
			const text = value.trim();
			return text.length > 0 && text.length <= maxLength && !/[\r\n\0]/u.test(text) ? text : undefined;
		}

		function menuTarget(value) {
			if (value instanceof Element) return value;
			if (value instanceof Node) return value.parentElement;
			return null;
		}

		function editableMenuTarget(target) {
			const candidate = target?.closest("input, textarea, [contenteditable]");
			if (candidate instanceof HTMLTextAreaElement) return candidate.disabled || candidate.readOnly ? null : candidate;
			if (candidate instanceof HTMLInputElement) {
				const textTypes = new Set(["text", "search", "email", "url", "tel", "password", "number"]);
				return !candidate.disabled && !candidate.readOnly && textTypes.has(candidate.type) ? candidate : null;
			}
			return candidate instanceof HTMLElement && candidate.isContentEditable ? candidate : null;
		}

		function selectedMenuText(editable) {
			if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
				const start = editable.selectionStart;
				const end = editable.selectionEnd;
				if (typeof start === "number" && typeof end === "number" && end > start) return editable.value.slice(start, end);
			}
			return window.getSelection()?.toString() ?? "";
		}

		function captureContextMenu(event) {
			const target = menuTarget(event.target);
			if (target === null) return undefined;
			const editable = editableMenuTarget(target);
			const link = target.closest("a[href]");
			return {
				target,
				editableElement: editable,
				editable: editable !== null,
				selectionText: selectedMenuText(editable),
				linkUrl: link instanceof HTMLAnchorElement ? link.href : "",
				x: event.clientX,
				y: event.clientY,
				event,
				capturedAt: performance.now()
			};
		}

		function normalizeContextMenuContribution(value) {
			if (value === null || typeof value !== "object") throw new TypeError("Context menu contribution must be an object");
			const rawId = boundedMenuText(value.id, 80)?.replace(/^plugin\./u, "");
			if (!rawId || !/^[a-z0-9][a-z0-9._:-]{0,79}$/iu.test(rawId)) throw new TypeError("Context menu contribution id is invalid");
			if (typeof value.onSelect !== "function") throw new TypeError("Context menu contribution requires onSelect(context)");
			if (typeof value.label !== "string" && typeof value.label !== "function") throw new TypeError("Context menu contribution label is invalid");
			if (value.linkURL !== undefined && typeof value.linkURL !== "string" && typeof value.linkURL !== "function") throw new TypeError("Context menu contribution linkURL is invalid");
			const group = boundedMenuText(value.group, 48) ?? "plugins";
			const order = Number.isFinite(value.order) ? Math.max(-10_000, Math.min(10_000, value.order)) : 0;
			return {
				...value,
				id: `plugin.${rawId}`,
				group,
				order,
				icon: CONTEXT_MENU_ICONS.has(value.icon) ? value.icon : "plugin"
			};
		}

		function resolveContributionValue(value, context, fallback) {
			try { return typeof value === "function" ? value(context) : value ?? fallback; }
			catch (error) {
				console.warn("[desktop-context-menu] contribution predicate failed", error);
				return fallback;
			}
		}

		function focusContextMenuTarget(context) {
			const target = context.editableElement ?? context.target.closest("button, a[href], input, textarea, [tabindex], [contenteditable]");
			if (target instanceof HTMLElement) {
				try { target.focus({ preventScroll: true }); } catch {}
			}
		}

		class DesktopContextMenuService extends Cordis.Service {
			constructor(ctx) {
				super(ctx, "desktopContextMenu");
				this.version = 1;
				this.icons = Object.freeze([...CONTEXT_MENU_ICONS]);
				this._state = {
					contributions: new Map(),
					invocations: new Map(),
					captured: undefined,
					token: 0
				};
			}

			register(value) {
				const contribution = normalizeContextMenuContribution(value);
				const state = this._state;
				return this.ctx.effect(() => {
					if (state.contributions.size >= 64) throw new Error("Too many desktop context menu contributions");
					if (state.contributions.has(contribution.id)) throw new Error(`Duplicate context menu contribution: ${contribution.id}`);
					state.contributions.set(contribution.id, contribution);
					return () => {
						if (state.contributions.get(contribution.id) === contribution) state.contributions.delete(contribution.id);
					};
				}, `desktopContextMenu: ${contribution.id}`);
			}

			[captureContextMenuSymbol](event) {
				this._state.captured = captureContextMenu(event);
			}

			[collectContextMenuSymbol]() {
				const state = this._state;
				const context = state.captured;
				state.captured = undefined;
				if (context === undefined || performance.now() - context.capturedAt > 1_500) return null;

				const evaluated = [];
				for (const contribution of state.contributions.values()) {
					if (resolveContributionValue(contribution.when, context, true) !== true) continue;
					const label = boundedMenuText(resolveContributionValue(contribution.label, context, ""), 120);
					if (label === undefined) continue;
					evaluated.push({
						contribution,
						group: contribution.group,
						order: contribution.order,
						linkURL: boundedMenuText(resolveContributionValue(contribution.linkURL, context, ""), 2_048),
						item: {
							kind: "item",
							id: contribution.id,
							label,
							enabled: resolveContributionValue(contribution.enabled, context, true) !== false,
							icon: contribution.icon,
							...(contribution.checked === undefined ? {} : { checked: resolveContributionValue(contribution.checked, context, false) === true }),
							...(contribution.danger === undefined ? {} : { danger: resolveContributionValue(contribution.danger, context, false) === true })
						}
					});
				}
				const contributedLinks = [...new Set(evaluated.flatMap((entry) => entry.linkURL === undefined ? [] : [entry.linkURL]))];
				const linkURL = context.linkUrl || (contributedLinks.length === 1 ? contributedLinks[0] : "");
				if (evaluated.length === 0 && linkURL === "") return null;
				evaluated.sort((left, right) => left.group.localeCompare(right.group) || left.order - right.order || left.item.id.localeCompare(right.item.id));

				const items = [];
				const actions = new Map();
				let lastGroup;
				let separator = 0;
				for (const entry of evaluated) {
					if (lastGroup !== undefined && lastGroup !== entry.group) {
						items.push({ kind: "separator", id: `plugin.separator.${separator++}` });
					}
					items.push(entry.item);
					actions.set(entry.item.id, entry.contribution.onSelect);
					lastGroup = entry.group;
				}

				const token = `plugin-menu-${Date.now().toString(36)}-${(++state.token).toString(36)}`;
				state.invocations.set(token, { context, actions });
				while (state.invocations.size > 8) state.invocations.delete(state.invocations.keys().next().value);
				return { token, items, ...(linkURL === "" ? {} : { linkURL }) };
			}

			[executeContextMenuSymbol](token, itemId) {
				const invocation = this._state.invocations.get(token);
				this._state.invocations.delete(token);
				if (invocation === undefined) return false;
				const action = invocation.actions.get(itemId);
				if (typeof action !== "function") return false;
				focusContextMenuTarget(invocation.context);
				void Promise.resolve().then(() => action(invocation.context)).catch((error) => {
					console.warn(`[desktop-context-menu] ${itemId} failed`, error);
				});
				return true;
			}

			[dismissContextMenuSymbol](token, restoreFocus = true) {
				const invocation = this._state.invocations.get(token);
				this._state.invocations.delete(token);
				if (invocation === undefined) return false;
				if (restoreFocus) focusContextMenuTarget(invocation.context);
				return true;
			}

			[clearContextMenuSymbol]() {
				this._state.captured = undefined;
				this._state.contributions.clear();
				this._state.invocations.clear();
			}
		}

		function installContextMenuTransport(service) {
			const transport = Object.freeze({
				collect: () => service[collectContextMenuSymbol](),
				execute: (token, itemId) => service[executeContextMenuSymbol](token, itemId),
				dismiss: (token, restoreFocus) => service[dismissContextMenuSymbol](token, restoreFocus)
			});
			Object.defineProperty(window, CONTEXT_MENU_TRANSPORT_SYMBOL, {
				configurable: true,
				enumerable: false,
				value: transport
			});
			return () => {
				if (window[CONTEXT_MENU_TRANSPORT_SYMBOL] === transport) delete window[CONTEXT_MENU_TRANSPORT_SYMBOL];
			};
		}

		function createDesktopContextMenuInspectProvider() {
			return {
				manifest: {
					id: "DesktopContextMenu",
					description: "DFY DSH Desktop context-menu contribution Service.",
					methods: [{
						name: "describe",
						description: "Return the exact Client Service contract, supported icons, and a lifecycle-safe example.",
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
						outputSchema: { description: "Desktop context-menu Service contract." }
					}]
				},
				async query(method) {
					if (method !== "describe") throw new Error(`Unknown DesktopContextMenu inspect method: ${method}`);
					return {
						service: "desktopContextMenu",
						access: {
							hardDependency: { inject: ["desktopContextMenu"], expression: "ctx.desktopContextMenu" },
							optional: { expression: "ctx.get('desktopContextMenu')", requiresUndefinedCheck: true }
						},
						properties: [
							"version: 1",
							"icons: readonly ContextMenuIcon[]"
						],
						methods: [
							"register(contribution: DesktopContextMenuContribution): () => void"
						],
						types: {
							DesktopContextMenuContribution: "{ id: string; label: string | ((context) => string); linkURL?: string | ((context) => string); icon?: ContextMenuIcon; group?: string; order?: number; when?: (context) => boolean; enabled?: boolean | ((context) => boolean); checked?: boolean | ((context) => boolean); danger?: boolean | ((context) => boolean); onSelect(context): void | Promise<void> }",
							DesktopContextMenuContext: "{ target: Element; editableElement: HTMLInputElement | HTMLTextAreaElement | HTMLElement | null; editable: boolean; selectionText: string; linkUrl: string; x: number; y: number; event: MouseEvent }"
						},
						icons: [...CONTEXT_MENU_ICONS],
						example: "return { inject: ['desktopContextMenu'], apply(ctx) { ctx.desktopContextMenu.register({ id: 'my-plugin.action', label: 'Run action', icon: 'plugin', onSelect(context) { console.log(context.target) } }) } }"
					};
				}
			};
		}

		function projectSessions(snapshot, interactions) {
			const projected = new Map();
			const byId = snapshot !== null && typeof snapshot === "object" ? snapshot.byId : undefined;
			for (const [id, value] of Object.entries(byId ?? {})) {
				if (value === null || typeof value !== "object") continue;
				projected.set(id, {
					id,
					displayTitle: typeof value.displayTitle === "string" ? value.displayTitle : id,
					running: value.running === true,
					pendingInteraction: interactions === undefined ? value.pendingInteraction : undefined,
					updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0
				});
			}
			for (const [id, interaction] of interactions ?? []) {
				if (interaction === null || typeof interaction !== "object" || typeof interaction.kind !== "string") continue;
				const current = projected.get(id) ?? { id, displayTitle: id, running: false, updatedAt: 0 };
				projected.set(id, { ...current, pendingInteraction: interaction.kind, interactionKey: interaction.key, interaction });
			}
			return projected;
		}

		function diffSessionNotifications(previous, next) {
			const notifications = [];
			for (const [id, current] of next) {
				const prior = previous.get(id);
				const interactionChanged = current.pendingInteraction !== undefined
					&& (current.pendingInteraction !== prior?.pendingInteraction || current.interactionKey !== prior?.interactionKey);
				let kind;
				if (interactionChanged && current.pendingInteraction === "approval") kind = "approval";
				else if (interactionChanged && current.pendingInteraction === "question") kind = "question";
				else if (interactionChanged && current.pendingInteraction === "plan-review") kind = "plan-review";
				else if (prior?.running && !current.running && current.pendingInteraction === undefined) kind = "turn-complete";
				if (kind !== undefined) notifications.push({
					kind,
					sessionId: id,
					sessionTitle: current.displayTitle,
					key: `${kind}:${id}:${current.interactionKey ?? current.updatedAt}`
				});
			}
			return notifications;
		}

		function latestAssistantMessage(binding) {
			let nodes;
			try { nodes = binding?.session?.getSnapshot?.()?.nodes; } catch { return void 0; }
			if (!Array.isArray(nodes)) return void 0;
			for (let index = nodes.length - 1; index >= 0; index -= 1) {
				const node = nodes[index];
				if (node === null || typeof node !== "object" || node.kind !== "assistant" || !Array.isArray(node.blocks)) continue;
				const text = node.blocks
					.filter((block) => block !== null && typeof block === "object" && block.kind === "text" && typeof block.text === "string")
					.map((block) => block.text.trim())
					.filter(Boolean)
					.join("\n\n")
					.trim();
				const marker = node.messageId ?? node.seq
					?? `${String(node.turn ?? "")}:${String(node.step ?? "")}:${String(node.time ?? "")}`;
				return { marker, text: text.length > 0 ? text.slice(0, 4e3) : void 0 };
			}
			return void 0;
		}

		function latestAssistantReply(binding) {
			return latestAssistantMessage(binding)?.text;
		}

		function latestAssistantMarker(binding) {
			return latestAssistantMessage(binding)?.marker;
		}

		function waitForSessionValue(binding, read, timeoutMs = 1e3, signal) {
			if (signal?.aborted) return Promise.resolve(void 0);
			const immediate = read();
			if (immediate !== void 0) return Promise.resolve(immediate);
			const session = binding?.session;
			if (session === void 0 || typeof session.subscribe !== "function") return Promise.resolve(void 0);
			return new Promise((resolve) => {
				let settled = false;
				let unsubscribe = () => {};
				const aborted = () => finish(void 0);
				const finish = (value) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					unsubscribe();
					signal?.removeEventListener("abort", aborted);
					resolve(value);
				};
				const check = () => {
					const value = read();
					if (value !== void 0) finish(value);
				};
				const timer = setTimeout(() => finish(void 0), timeoutMs);
				unsubscribe = session.subscribe(check);
				signal?.addEventListener("abort", aborted, { once: true });
				if (signal?.aborted) aborted();
				queueMicrotask(check);
			});
		}

		function waitForAssistantReply(binding, baseline, timeoutMs, signal) {
			return waitForSessionValue(binding, () => {
				const current = latestAssistantMessage(binding);
				if (current === void 0 || current.marker === baseline) return void 0;
				return current.text;
			}, timeoutMs, signal);
		}

		function pendingInteractionSummary(binding, status, interaction) {
			let detail = interaction;
			if (detail === undefined) {
				let pending;
				try { pending = binding?.session?.getSnapshot?.()?.pending; } catch { return void 0; }
				if (!Array.isArray(pending)) return void 0;
				detail = [...pending].reverse().find((item) => item?.kind === (status === "approval" ? "approval" : "question"))?.payload;
			}
			if (detail === null || typeof detail !== "object") return void 0;
			if (status === "approval") {
				const reason = typeof detail.reason === "string" ? detail.reason.trim() : "";
				const toolName = typeof detail.toolName === "string" ? detail.toolName.trim() : "";
				if (reason.length > 0 && toolName.length > 0) return `${toolName}：${reason}`.slice(0, 4e3);
				if (reason.length > 0) return reason.slice(0, 4e3);
				if (toolName.length > 0) return `请求使用 ${toolName}`;
				return void 0;
			}
			const questions = detail.questions;
			if (!Array.isArray(questions) || questions.length === 0) return void 0;
			const question = status === "plan-review"
				? questions.find((item) => item?.intent?.kind === "plan-review") ?? questions[0]
				: questions[0];
			if (question === null || typeof question !== "object") return void 0;
			const questionText = typeof question.question === "string" ? question.question.trim() : "";
			const header = typeof question.header === "string" ? question.header.trim() : "";
			const questionDetail = typeof question.detail === "string" ? question.detail.trim() : "";
			if (status !== "plan-review" && questionText.length > 0 && header.length > 0
				&& !questionText.includes(header)) return `${header}：${questionText}`.slice(0, 4e3);
			const summary = [questionText, header, questionDetail].find((value) => value.length > 0);
			return summary?.slice(0, 4e3);
		}

		function waitForPendingInteractionSummary(binding, status, timeoutMs, signal) {
			return waitForSessionValue(binding, () => pendingInteractionSummary(binding, status), timeoutMs, signal);
		}

		function createNotificationApprovals(readInteractions, isActive) {
			const requests = new Map();
			let tokens = new WeakMap();
			const matches = (request) => {
				const current = readInteractions()?.get(request.sessionId);
				return current === request.interaction && current.kind === "approval"
					&& current.key === request.interactionKey && current.sessionId === request.sessionId
					&& typeof current.answer === "function";
			};
			const transport = Object.freeze({
				async answer(value) {
					if (!isActive() || value === null || typeof value !== "object"
						|| (value.decision !== "allowed-once" && value.decision !== "rejected")) return "expired";
					const request = requests.get(value.token);
					if (request === undefined || request.sessionId !== value.sessionId || request.interactionKey !== value.interactionKey) return "expired";
					// Consume before invoking the real object, so concurrent clicks cannot answer twice.
					requests.delete(value.token);
					if (!matches(request)) return "expired";
					await request.interaction.answer(value.decision);
					return "answered";
				}
			});
			return {
				transport,
				register(sessionId, interaction) {
					if (!isActive() || interaction?.kind !== "approval" || typeof interaction.answer !== "function"
						|| typeof interaction.key !== "string" || interaction.key.length === 0) return;
					const request = { sessionId, interactionKey: interaction.key, interaction };
					if (!matches(request)) return;
					let token = tokens.get(interaction);
					if (token === undefined) {
						token = globalThis.crypto.randomUUID();
						tokens.set(interaction, token);
						requests.set(token, request);
					}
					if (requests.has(token)) return { token, interactionKey: interaction.key };
				},
				prune() {
					for (const [token, request] of requests) {
						if (matches(request)) continue;
						requests.delete(token);
						tokens.delete(request.interaction);
					}
				},
				clear() { requests.clear(); tokens = new WeakMap(); }
			};
		}

		function installSessionNotifications(ctx, send = postNotification) {
			let active = true;
			const cancel = new AbortController();
			let interactions;
			const approvals = createNotificationApprovals(() => interactions?.getSnapshot(), () => active);
			const transportWindow = window;
			const transportSymbol = Symbol.for(NOTIFICATION_APPROVAL_TRANSPORT_KEY);
			const snapshot = () => projectSessions(ctx.sessions.list.getSnapshot(), interactions?.getSnapshot());
			let previous = snapshot();
			const runBaselines = new Map();
			const runVersions = new Map();
			for (const [id, session] of previous) {
				if (session.running) runBaselines.set(id, latestAssistantMarker(ctx.sessions.binding(id)));
			}
			const onSessionsChanged = () => {
				if (!active) return;
				approvals.prune();
				const next = snapshot();
				for (const [id, session] of next) {
					if (session.running && !previous.get(id)?.running) {
						runBaselines.set(id, latestAssistantMarker(ctx.sessions.binding(id)));
						runVersions.set(id, (runVersions.get(id) ?? 0) + 1);
					}
				}
				const notifications = diffSessionNotifications(previous, next);
				previous = next;
				for (const notification of notifications) {
					const binding = ctx.sessions.binding(notification.sessionId);
					const baseline = runBaselines.get(notification.sessionId);
					const runVersion = runVersions.get(notification.sessionId);
					const interaction = next.get(notification.sessionId)?.interaction;
					if (notification.kind === "turn-complete") runBaselines.delete(notification.sessionId);
					void (async () => {
						// Controller and UI-interaction stores publish independently; let both settle before completion checks.
						if (notification.kind === "turn-complete") await new Promise((resolve) => setTimeout(resolve, 0));
						if (!active) return;
						const summary = notification.kind === "turn-complete"
							? await waitForAssistantReply(binding, baseline, undefined, cancel.signal)
							: interaction !== undefined
								? pendingInteractionSummary(binding, notification.kind, interaction)
								: await waitForPendingInteractionSummary(binding, notification.kind, undefined, cancel.signal);
						if (!active) return;
						const current = snapshot().get(notification.sessionId);
						if (notification.kind === "turn-complete" && (current === undefined || current.running || current.pendingInteraction !== undefined || runVersions.get(notification.sessionId) !== runVersion)) return;
						if (summary !== void 0) notification.summary = summary;
						if (notification.kind === "approval") {
							const approval = approvals.register(notification.sessionId, interaction);
							if (approval !== undefined) notification.approval = approval;
						}
						await send(notification);
					})();
				}
			};
			ctx.effect(() => {
				Object.defineProperty(transportWindow, transportSymbol, { configurable: true, enumerable: false, value: approvals.transport });
				const unsubscribe = ctx.sessions.list.subscribe(onSessionsChanged);
				return () => {
					active = false;
					cancel.abort();
					unsubscribe();
					approvals.clear();
					if (transportWindow[transportSymbol] === approvals.transport) delete transportWindow[transportSymbol];
				};
			}, "desktop-notifications: session transitions");
			// A child injection waits for the newer UI service without requiring it on old Harness versions.
			ctx.inject(["uiSession"], (uiCtx) => {
				const source = uiCtx.uiSession.pendingInteractions;
				if (source === undefined) return;
				uiCtx.effect(() => {
					interactions = source;
					const unsubscribe = source.subscribe(onSessionsChanged);
					onSessionsChanged();
					return () => {
						unsubscribe();
						if (interactions === source) {
							interactions = undefined;
							approvals.clear();
							previous = snapshot();
						}
					};
				}, "desktop-notifications: pending interactions");
			});
		}

		async function postNotification(notification) {
			try {
				await fetch(SHOW_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(notification)
				});
			} catch (error) {
				console.warn("[desktop-notifications] failed to show notification", error);
			}
		}

		function normalizeSettings(value) {
			const candidate = value !== null && typeof value === "object" ? value : {};
			return {
				turnCompletion: candidate.turnCompletion === "never" || candidate.turnCompletion === "unfocused" || candidate.turnCompletion === "always"
					? candidate.turnCompletion
					: DEFAULT_SETTINGS.turnCompletion,
				permissionRequests: typeof candidate.permissionRequests === "boolean"
					? candidate.permissionRequests
					: DEFAULT_SETTINGS.permissionRequests,
				questions: typeof candidate.questions === "boolean"
					? candidate.questions
					: DEFAULT_SETTINGS.questions
			};
		}

		function NotificationSettingsSection() {
			const [settings, setSettings] = React.useState(DEFAULT_SETTINGS);
			const [loading, setLoading] = React.useState(true);
			const [saving, setSaving] = React.useState(false);
			const [error, setError] = React.useState("");

			React.useEffect(() => {
				let active = true;
				void fetch(SETTINGS_PATH, { cache: "no-store" })
					.then(async (response) => {
						const payload = await response.json();
						if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
						if (active) setSettings(normalizeSettings(payload.settings));
					})
					.catch((cause) => {
						if (active) setError(cause instanceof Error ? cause.message : String(cause));
					})
					.finally(() => {
						if (active) setLoading(false);
					});
				return () => { active = false; };
			}, []);

			const update = React.useCallback(async (patch) => {
				const next = { ...settings, ...patch };
				setSettings(next);
				setSaving(true);
				setError("");
				try {
					const response = await fetch(SETTINGS_PATH, {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(next)
					});
					const payload = await response.json();
					if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
					setSettings(normalizeSettings(payload.settings));
				} catch (cause) {
					setSettings(settings);
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setSaving(false);
				}
			}, [settings]);

			const disabled = loading || saving;
			return React.createElement("section", { style: styles.section },
				React.createElement("h2", { style: styles.heading }, "通知"),
				React.createElement("div", { style: styles.card },
					React.createElement(SettingRow, {
						title: "轮次完成通知",
						description: "设置回复完成时提醒你的时机"
					}, React.createElement(CompletionMenu, {
						value: settings.turnCompletion,
						disabled,
						onChange: (value) => void update({ turnCompletion: value })
					})),
					React.createElement(SettingRow, {
						title: "启用权限通知",
						description: "在需要通知和权限时显示提醒"
					}, React.createElement(Toggle, {
						checked: settings.permissionRequests,
						disabled,
						label: "启用权限通知",
						onChange: (checked) => void update({ permissionRequests: checked })
					})),
					React.createElement(SettingRow, {
						title: "启用问题通知",
						description: "需要输入才能继续时显示提醒",
						last: true
					}, React.createElement(Toggle, {
						checked: settings.questions,
						disabled,
						label: "启用问题通知",
						onChange: (checked) => void update({ questions: checked })
					}))
				),
				error ? React.createElement("p", { role: "alert", style: styles.error }, `通知功能操作失败：${error}`) : null
			);
		}

		function CompletionMenu({ value, disabled, onChange }) {
			const [open, setOpen] = React.useState(false);
			const [hovered, setHovered] = React.useState(false);
			const labels = {
				never: "从不",
				unfocused: "仅当应用失焦时",
				always: "始终"
			};
			const anchor = React.createElement("button", {
				type: "button",
				"aria-label": "轮次完成通知",
				"aria-haspopup": "menu",
				"aria-expanded": open,
				disabled,
				onClick: () => setOpen((current) => !current),
				onPointerEnter: () => setHovered(true),
				onPointerLeave: () => setHovered(false),
				style: {
					...styles.menuTrigger,
					background: !disabled && (hovered || open)
						? "var(--dsw-alias-interactive-bg-hover)"
						: "var(--dsw-alias-bg-module-platform)",
					opacity: disabled ? 0.6 : 1
				}
			},
				React.createElement("span", null, labels[value]),
				React.createElement(Primitives.IconChevronDownOutline14, { size: 14 })
			);
			return React.createElement(Primitives.Menu, {
				open,
				anchor,
				items: [
					{ id: "never", label: labels.never },
					{ id: "unfocused", label: labels.unfocused },
					{ id: "always", label: labels.always }
				],
				selectedId: value,
				onSelect: (id) => {
					setOpen(false);
					onChange(id);
				},
				onClose: () => setOpen(false),
				align: "end",
				portal: true
			});
		}

		function SettingRow({ title, description, last = false, children }) {
			return React.createElement("div", { style: { ...styles.row, ...(last ? styles.lastRow : {}) } },
				React.createElement("div", { style: styles.copy },
					React.createElement("div", { style: styles.title }, title),
					React.createElement("div", { style: styles.description }, description)
				),
				React.createElement("div", { style: styles.control }, children)
			);
		}

		function Toggle({ checked, disabled, label, onChange }) {
			return React.createElement("button", {
				type: "button",
				role: "switch",
				"aria-checked": checked,
				"aria-label": label,
				disabled,
				onClick: () => onChange(!checked),
				style: {
					...styles.toggle,
					background: checked ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-bg-module-platform)",
					opacity: disabled ? 0.6 : 1
				}
			}, React.createElement("span", {
				style: {
					...styles.knob,
					transform: checked ? "translateX(12px)" : "translateX(0)"
				}
			}));
		}

		const styles = {
			section: { width: "100%", color: "var(--dsw-alias-label-primary)" },
			heading: { margin: "0 0 22px", fontSize: 18, fontWeight: 650 },
			card: { width: "100%" },
			row: { display: "flex", alignItems: "center", gap: 8, padding: "16px 0", borderBottom: "1px solid var(--dsw-alias-border-l2)" },
			lastRow: {},
			copy: { flex: 1, minWidth: 0, paddingRight: 48 },
			title: { color: "var(--dsw-alias-label-primary)", fontSize: 14, fontWeight: 400, lineHeight: "22px" },
			description: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, fontWeight: 400, lineHeight: "18px" },
			control: { flex: "0 0 auto" },
			menuTrigger: { minWidth: 142, height: 36, padding: "0 14px", borderRadius: 18, border: 0, background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-primary)", font: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
			toggle: { width: 32, height: 20, padding: 2, border: 0, borderRadius: 999, cursor: "pointer", transition: "background 120ms ease" },
			knob: { display: "block", width: 16, height: 16, borderRadius: "50%", background: "white", boxShadow: "0 1px 2px rgba(0,0,0,.3)", transition: "transform 120ms ease" },
			error: { margin: "12px 0 0", color: "#ef6b73", fontSize: 12 }
		};

		function installSessionOpenFeedback(sessions, report) {
			const original = sessions.open;
			const wrapped = function (...args) {
				try {
					return original.apply(this, args);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					report(message.startsWith("sessions.select: unknown session ")
						? "无法打开这条会话：当前没有对应的会话记录。请刷新后重试；如果历史文件已被删除，列表中的残留条目无法恢复对话。"
						: `无法打开会话：${message}`);
				}
			};
			sessions.open = wrapped;
			return () => { if (sessions.open === wrapped) sessions.open = original; };
		}

		exports.installSessionOpenFeedback = installSessionOpenFeedback;
		exports.name = "desktop-notifications";
		exports.inject = ["slots", "sessions", "cordisInspect"];
		exports.projectSessions = projectSessions;
		exports.diffSessionNotifications = diffSessionNotifications;
		exports.latestAssistantReply = latestAssistantReply;
		exports.latestAssistantMarker = latestAssistantMarker;
		exports.waitForAssistantReply = waitForAssistantReply;
		exports.pendingInteractionSummary = pendingInteractionSummary;
		exports.installSessionNotifications = installSessionNotifications;
		exports.NOTIFICATION_APPROVAL_TRANSPORT_KEY = NOTIFICATION_APPROVAL_TRANSPORT_KEY;
		exports.DesktopContextMenuService = DesktopContextMenuService;
		exports.createDesktopContextMenuInspectProvider = createDesktopContextMenuInspectProvider;
		exports.apply = function apply(ctx) {
			ctx.effect(() => installSessionOpenFeedback(ctx.sessions, (message) => window.alert(message)), "desktop: session open errors");
			const desktopContextMenu = new DesktopContextMenuService(ctx);
			ctx.effect(() => installContextMenuTransport(desktopContextMenu), "desktop-context-menu: Electron transport");
			ctx.effect(
				() => ctx.cordisInspect.register(createDesktopContextMenuInspectProvider()),
				"desktop-context-menu: inspect provider"
			);

			installSessionNotifications(ctx);

			const onDesktopMessage = (event) => {
				const value = event.data;
				if (event.source !== window || value === null || typeof value !== "object") return;
				if (value.source !== "dfy-dsh-desktop" || value.type !== "notification-click") return;
				if (typeof value.sessionId !== "string" || value.sessionId.length === 0) return;
				try { ctx.sessions.open(value.sessionId); } catch {}
			};
			window.addEventListener("message", onDesktopMessage);
			ctx.effect(() => () => window.removeEventListener("message", onDesktopMessage), "desktop-notifications: notification click");

			const onContextMenu = (event) => { desktopContextMenu[captureContextMenuSymbol](event); };
			window.addEventListener("contextmenu", onContextMenu, true);
			ctx.effect(() => () => {
				window.removeEventListener("contextmenu", onContextMenu, true);
				desktopContextMenu[clearContextMenuSymbol]();
			}, "desktop-context-menu: capture plugin context");

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "desktop-notifications",
				order: 20,
				label: "通知"
			}, NotificationSettingsSection));
		};
		return module.exports;
	}
});
