window.__ModuleLoader__.load({
	id: "dsh-topmost-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/client/locales.js
		/** Locale namespace owned by this plugin (the General row copy). */
		const LOCALE_NS = "settings.topmostNotify";
		/** Settings namespace == the Host plugin entry id in the Loader. */
		const NAMESPACE = "topmost-notify";
		/** English copy. */
		const en = {
			title: "Notify when a task finishes",
			description: "Show an always-on-top window with a chime when a task completes.",
			saved: "Preference saved",
			failed: "Could not save preference",
			muteOn: "Notifications for this chat are on. Click to mute.",
			muteOff: "Notifications for this chat are muted. Click to turn on."
		};
		/** Russian copy. */
		const ru = {
			title: "Уведомление о завершении задачи",
			description: "Показывать поверх всех окон окно со звуком, когда задача выполнена.",
			saved: "Настройка сохранена",
			failed: "Не удалось сохранить настройку",
			muteOn: "Уведомления для этого чата включены. Нажмите, чтобы отключить.",
			muteOff: "Уведомления для этого чата отключены. Нажмите, чтобы включить."
		};
		/** Chinese copy. */
		const zh = {
			title: "任务完成时通知",
			description: "任务完成时显示置顶窗口并播放提示音。",
			saved: "设置已保存",
			failed: "无法保存设置",
			muteOn: "此会话的通知已开启，点击关闭。",
			muteOff: "此会话的通知已关闭，点击开启。"
		};
		//#endregion
		//#region lib/client/styles.js
		/** Inline styles mirroring the shipped General preference rows (no CSS modules). */
		const ROW_STYLE = {
			borderBottom: ".5px solid var(--dsw-alias-border-l2)",
			justifyContent: "space-between",
			alignItems: "center",
			gap: 24,
			padding: "16px 0",
			display: "flex"
		};
		const TITLE_STYLE = {
			fontSize: 14,
			lineHeight: "20px"
		};
		const DESCRIPTION_STYLE = {
			color: "var(--dsw-alias-label-secondary)",
			marginTop: 4,
			fontSize: 12,
			lineHeight: "18px"
		};
		/** Compact bell control for the session header utilities row. */
		const MUTE_BUTTON_STYLE = {
			alignItems: "center",
			background: "transparent",
			border: "none",
			borderRadius: 6,
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer",
			display: "flex",
			fontSize: 14,
			height: 28,
			justifyContent: "center",
			lineHeight: 1,
			padding: 0,
			width: 28
		};
		//#endregion
		//#region lib/client/safe.js
		/** Report a contained failure without disturbing the host application. */
		function report(error) {
			try {
				console.warn("[dsh-topmost-notify] client:", error);
			} catch (_ignored) {}
		}
		/**
		* Resolve one localized key, degrading to the key instead of throwing.
		* @param t - slot-bound translator, possibly absent.
		* @param key - dictionary key.
		* @returns localized text, or the key when translation is unavailable.
		*/
		function translate(t, key) {
			try {
				return typeof t === "function" ? t(key) : key;
			} catch (error) {
				report(error);
				return key;
			}
		}
		//#endregion
		//#region lib/client/topmost-notify-preference.js
		/** Ordered preference writes and notices that survive the settings panel. */
		/** Writes the Host setting without publishing an optimistic notification state. */
		var TurnNotifyPreference = class {
			form;
			/** Observable mutation outcome. */
			state = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				busy: false,
				notice: null,
				sequence: 0
			});
			/** @param form - Host-owned configuration form, if the settings service is available. */
			constructor(form) {
				this.form = form;
			}
			/**
			* Persist the enablement; a refusal or transport failure leaves the accepted value visible.
			* @param enabled - requested notification state.
			* @returns completion after the write settles.
			*/
			async setEnabled(enabled) {
				try {
					if (this.state.getSnapshot().busy) return;
					this.state.update((state) => {
						state.busy = true;
						state.notice = null;
					});
					let accepted = false;
					try {
						accepted = await this.form.set("enabled", enabled);
					} catch (error) {
						report(error);
					}
					this.state.update((state) => {
						state.busy = false;
						state.notice = accepted ? "saved" : "failed";
						state.sequence++;
					});
				} catch (error) {
					report(error);
				}
			}
			/**
			* Persist this chat's mute state in the shared `mutedSessions` list.
			* A refusal or transport failure leaves the accepted value visible.
			* @param sessionId - chat whose notifications change.
			* @param muted - requested mute state.
			* @returns completion after the write settles.
			*/
			async setMuted(sessionId, muted) {
				try {
					if (this.form === void 0 || sessionId === void 0 || sessionId === null) return;
					if (this.state.getSnapshot().busy) return;
					const id = String(sessionId);
					if (id.length === 0) return;
					const snapshot = this.form.getSnapshot();
					const current = Array.isArray(snapshot?.value?.mutedSessions) ? snapshot.value.mutedSessions.map(String) : [];
					const includes = current.includes(id);
					if (includes === muted) return;
					const next = muted ? current.concat([id]) : current.filter((value) => value !== id);
					this.state.update((state) => {
						state.busy = true;
						state.notice = null;
					});
					let accepted = false;
					try {
						accepted = await this.form.mutate([{
							op: "set",
							path: ["mutedSessions"],
							value: next
						}]);
					} catch (error) {
						report(error);
					}
					this.state.update((state) => {
						state.busy = false;
						state.notice = accepted ? "saved" : "failed";
						state.sequence++;
					});
				} catch (error) {
					report(error);
				}
			}
			/** Clear the displayed mutation notice. */
			dismiss() {
				try {
					this.state.update((state) => {
						state.notice = null;
					});
				} catch (error) {
					report(error);
				}
			}
		};
		//#endregion
		//#region lib/client/TurnNotifyRow.js
		/**
		* Render the "task finished notification" preference row.
		* @param props - settings hooks, writer and localized copy.
		* @returns the bottom preference row, or nothing if composition is missing.
		*/
		function TurnNotifyRow(props) {
			try {
				return renderTurnNotifyRow(props);
			} catch (error) {
				report(error);
				return null;
			}
		}
		/** @param props - composed slot props (contract/slots). */
		function renderTurnNotifyRow(props) {
			const { useForm, useMutation, setEnabled, t } = props ?? {};
			const form = useForm((snapshot) => snapshot);
			const mutation = useMutation((snapshot) => snapshot);
			const busy = mutation?.busy === true;
			const ready = form?.status === "ready";
			const writable = form?.writable === true;
			return (0, react_jsx_runtime.jsxs)("div", {
				style: ROW_STYLE,
				children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("div", {
					style: TITLE_STYLE,
					children: translate(t, "title")
				}), (0, react_jsx_runtime.jsx)("div", {
					style: DESCRIPTION_STYLE,
					children: translate(t, "description")
				})] }), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
					checked: form?.value?.enabled === true,
					label: translate(t, "title"),
					disabled: busy || !ready || !writable,
					onChange: (enabled) => {
						try {
							const pending = setEnabled(enabled);
							if (pending !== void 0 && pending !== null && typeof pending.catch === "function") pending.catch(report);
						} catch (error) {
							report(error);
						}
					}
				})]
			});
		}
		//#endregion
		//#region lib/client/SessionMuteToggle.js
		/**
		* Header bell that mutes task-finished notifications for the current chat.
		* @param props - session identity, settings hook, writer and localized copy.
		* @returns the bell button, or nothing when the composition is missing.
		*/
		function SessionMuteToggle(props) {
			try {
				return renderSessionMuteToggle(props);
			} catch (error) {
				report(error);
				return null;
			}
		}
		/** @param props - session-scope slot props. */
		function renderSessionMuteToggle(props) {
			const { sessionId, useForm, setMuted, t } = props ?? {};
			if (sessionId === void 0 || sessionId === null || typeof useForm !== "function") return null;
			const id = String(sessionId);
			if (id.length === 0) return null;
			const form = useForm((snapshot) => snapshot);
			const list = Array.isArray(form?.value?.mutedSessions) ? form.value.mutedSessions.map(String) : [];
			const muted = list.includes(id);
			const label = translate(t, muted ? "muteOff" : "muteOn");
			return (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				title: label,
				"aria-label": label,
				"aria-pressed": muted ? "true" : "false",
				style: MUTE_BUTTON_STYLE,
				onClick: () => {
					try {
						const pending = setMuted(id, !muted);
						if (pending !== void 0 && pending !== null && typeof pending.catch === "function") pending.catch(report);
					} catch (error) {
						report(error);
					}
				},
				children: muted ? "🔕" : "🔔"
			});
		}
		//#endregion
		//#region lib/client/TurnNotifyToast.js
		/**
		* Keep the save outcome visible after settings closes.
		* @param props - mutation hook, dismissal and localized copy.
		* @returns the current toast, or nothing.
		*/
		function TurnNotifyToast(props) {
			try {
				return renderTurnNotifyToast(props);
			} catch (error) {
				report(error);
				return null;
			}
		}
		/** @param props - composed shell.overlay props. */
		function renderTurnNotifyToast(props) {
			const { useMutation, dismiss, t } = props ?? {};
			const state = useMutation((snapshot) => snapshot);
			if (state === void 0 || state === null || state.notice === null || state.notice === void 0) return null;
			const toastProps = {
				text: translate(t, state.notice),
				onDone: () => {
					try {
						dismiss();
					} catch (error) {
						report(error);
					}
				}
			};
			if (state.notice === "saved") toastProps.tone = "success";
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, toastProps, state.sequence);
		}
		//#endregion
		//#region lib/client/index.js
		/** Services used by the browser companion. */
		const inject = [
			"slots",
			"locale",
			"configForms"
		];
		/**
		* Register the locale dictionary and the two contributions.
		* @param ctx - browser plugin context.
		*/
		function apply(ctx) {
			try {
				try {
					if (typeof ctx.locale?.register === "function") ctx.effect(() => ctx.locale.register(LOCALE_NS, {
						en,
						ru,
						zh
					}));
				} catch (error) {
					report(error);
				}
				let form;
				try {
					form = ctx.configForms.get(NAMESPACE);
				} catch (error) {
					report(error);
				}
				let preference;
				try {
					preference = new TurnNotifyPreference(form);
				} catch (error) {
					report(error);
				}
				const face = () => ({
					hooks: {
						form,
						mutation: preference === void 0 ? void 0 : preference.state
					},
					setEnabled: (enabled) => {
						try {
							if (preference === void 0) return void 0;
							return preference.setEnabled(enabled);
						} catch (error) {
							report(error);
							return void 0;
						}
					},
					setMuted: (sessionId, muted) => {
						try {
							if (preference === void 0) return void 0;
							return preference.setMuted(sessionId, muted);
						} catch (error) {
							report(error);
							return void 0;
						}
					},
					dismiss: () => {
						try {
							preference?.dismiss();
						} catch (error) {
							report(error);
						}
					}
				});
				try {
					if (typeof ctx.configForms?.whileServed === "function" && typeof ctx.slots?.inject === "function") ctx.effect(() => ctx.configForms.whileServed([NAMESPACE], () => ctx.slots.inject("settings.general.item", () => ctx.slots.register({
						name: "settings.general.item",
						id: "topmost-notify",
						order: 95,
						locale: LOCALE_NS,
						inject: face
					}, TurnNotifyRow))));
				} catch (error) {
					report(error);
				}
				try {
					if (typeof ctx.slots?.inject === "function") ctx.slots.inject("shell.overlay", () => ctx.slots.register({
						name: "shell.overlay",
						id: "topmost-notify-toast",
						locale: LOCALE_NS,
						inject: face
					}, TurnNotifyToast));
				} catch (error) {
					report(error);
				}
				try {
					if (typeof ctx.configForms?.whileServed === "function" && typeof ctx.slots?.inject === "function") ctx.effect(() => ctx.configForms.whileServed([NAMESPACE], () => ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
						name: "conversation.session.header.utilities",
						id: "topmost-notify-mute",
						order: 50,
						locale: LOCALE_NS,
						inject: face
					}, SessionMuteToggle))));
				} catch (error) {
					report(error);
				}
			} catch (error) {
				report(error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
