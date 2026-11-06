window.__ModuleLoader__.load({
	id: "dsh-topmost-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { useState, useEffect, useRef } = react;
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
			muteOff: "Notifications for this chat are muted. Click to turn on.",
			"pluginSettings.intro": "Press Save to apply changes. The bell in the chat header mutes one chat.",
			"pluginSettings.general.title": "General",
			"pluginSettings.enabled.title": "Show notifications",
			"pluginSettings.enabled.description": "Show an always-on-top window when a task finishes, an answer is needed, or an agent asks a question.",
			"pluginSettings.durations.title": "On-screen time",
			"pluginSettings.durations.description": "How long each window stays visible, in seconds (0.3–10, step 0.1).",
			"pluginSettings.durationCompleted.title": "Task finished window",
			"pluginSettings.durationCompleted.description": "The window that appears after a task completes.",
			"pluginSettings.durationQuestion.title": "Answer needed window",
			"pluginSettings.durationQuestion.description": "The amber window that appears when an agent asks a question.",
			"pluginSettings.seconds": "s",
			"pluginSettings.range": "From 0.3 to 10 seconds, step 0.1",
			"pluginSettings.completedSound.title": "Sound when a task finishes",
			"pluginSettings.completedSound.description": "The bundled chime or your own MP3/WAV file.",
			"pluginSettings.questionSound.title": "Sound when an answer is needed",
			"pluginSettings.questionSound.description": "The bundled question chime or your own MP3/WAV file.",
			"pluginSettings.mode.label": "Sound source",
			"pluginSettings.mode.builtin": "Bundled signal",
			"pluginSettings.mode.custom": "Custom file",
			"pluginSettings.file.hint": "MP3 or WAV, up to 12 MB. The file uploads right away; press Save to use it.",
			"pluginSettings.builtin": "Bundled signal",
			"pluginSettings.noFile": "No file selected",
			"pluginSettings.uploading": "Uploading…",
			"pluginSettings.preview": "Listen",
			"pluginSettings.resetSound": "Reset",
			"pluginSettings.window": "Show window",
			"pluginSettings.extras.title": "Card contents",
			"pluginSettings.extras.description": "What the notification card shows besides the title.",
			"pluginSettings.showSessionTitle.title": "Session title",
			"pluginSettings.showSessionTitle.description": "Show which chat the notification belongs to.",
			"pluginSettings.showAnswerExcerpt.title": "Answer excerpt",
			"pluginSettings.showAnswerExcerpt.description": "Show the first lines of the finished answer.",
			"pluginSettings.notifyQuestions.title": "Answer needed card",
			"pluginSettings.notifyQuestions.description": "Show the amber card when an agent asks you a question.",
			"pluginSettings.save": "Save",
			"pluginSettings.reset": "Reset",
			"pluginSettings.unsaved": "Unsaved changes",
			"pluginSettings.saved": "Settings saved",
			"pluginSettings.failed": "Could not save settings",
			"pluginSettings.readOnly": "Settings are read-only right now.",
			"pluginSettings.summary": "Task notifications with per-kind display time and sound, a bundled or custom chime, and the card contents.",
			"pluginSettings.on": "on",
			"pluginSettings.off": "off",
			"pluginSettings.notice.saved": "Settings saved",
			"pluginSettings.notice.failed": "Could not save settings",
			"pluginSettings.notice.fileType": "Only MP3 and WAV files are supported.",
			"pluginSettings.notice.fileSize": "The file is larger than 12 MB.",
			"pluginSettings.notice.fileEmpty": "The file is empty.",
			"pluginSettings.notice.fileFailed": "Could not upload the sound file.",
			"pluginSettings.notice.uploaded": "Sound uploaded — press Save to apply it.",
			"pluginSettings.notice.previewFailed": "Could not play the preview."
		};
		/** Russian copy (the primary user-facing language of this plugin). */
		const ru = {
			title: "Уведомление о завершении задачи",
			description: "Показывать поверх всех окон окно со звуком, когда задача выполнена.",
			saved: "Настройка сохранена",
			failed: "Не удалось сохранить настройку",
			muteOn: "Уведомления для этого чата включены. Нажмите, чтобы отключить.",
			muteOff: "Уведомления для этого чата отключены. Нажмите, чтобы включить.",
			"pluginSettings.intro": "Нажмите «Сохранить», чтобы применить. Колокольчик в шапке чата отключает уведомления для одного чата.",
			"pluginSettings.general.title": "Основные",
			"pluginSettings.enabled.title": "Показывать уведомления",
			"pluginSettings.enabled.description": "Показывать окно поверх всех окон, когда задача выполнена, нужен ответ или агент задаёт вопрос.",
			"pluginSettings.durations.title": "Время показа",
			"pluginSettings.durations.description": "Сколько секунд окно остаётся на экране (0.3–10, шаг 0.1).",
			"pluginSettings.durationCompleted.title": "Окно «Задача выполнена»",
			"pluginSettings.durationCompleted.description": "Окно, которое появляется после завершения задачи.",
			"pluginSettings.durationQuestion.title": "Окно «Нужен ответ»",
			"pluginSettings.durationQuestion.description": "Жёлтое окно, которое появляется, когда агент задаёт вопрос.",
			"pluginSettings.seconds": "с",
			"pluginSettings.range": "От 0.3 до 10 секунд, шаг 0.1",
			"pluginSettings.completedSound.title": "Звук при завершении задачи",
			"pluginSettings.completedSound.description": "Встроенный сигнал или свой файл MP3/WAV.",
			"pluginSettings.questionSound.title": "Звук при вопросе",
			"pluginSettings.questionSound.description": "Встроенный сигнал вопроса или свой файл MP3/WAV.",
			"pluginSettings.mode.label": "Источник звука",
			"pluginSettings.mode.builtin": "Встроенный сигнал",
			"pluginSettings.mode.custom": "Свой файл",
			"pluginSettings.file.hint": "MP3 или WAV до 12 МБ. Файл загружается сразу; чтобы применить, нажмите «Сохранить».",
			"pluginSettings.builtin": "Встроенный сигнал",
			"pluginSettings.noFile": "Файл не выбран",
			"pluginSettings.uploading": "Загрузка…",
			"pluginSettings.preview": "Прослушать",
			"pluginSettings.resetSound": "Сбросить",
			"pluginSettings.window": "Показать окно",
			"pluginSettings.extras.title": "Содержимое карточки",
			"pluginSettings.extras.description": "Что показывать в уведомлении, кроме заголовка.",
			"pluginSettings.showSessionTitle.title": "Название чата",
			"pluginSettings.showSessionTitle.description": "Показывать, к какому чату относится уведомление.",
			"pluginSettings.showAnswerExcerpt.title": "Фрагмент ответа",
			"pluginSettings.showAnswerExcerpt.description": "Показывать первые строки готового ответа.",
			"pluginSettings.notifyQuestions.title": "Карточка «Нужен ответ»",
			"pluginSettings.notifyQuestions.description": "Показывать жёлтую карточку, когда агент задаёт вопрос.",
			"pluginSettings.save": "Сохранить",
			"pluginSettings.reset": "Сбросить",
			"pluginSettings.unsaved": "Есть несохранённые изменения",
			"pluginSettings.saved": "Настройки сохранены",
			"pluginSettings.failed": "Не удалось сохранить настройки",
			"pluginSettings.readOnly": "Сейчас настройки доступны только для чтения.",
			"pluginSettings.summary": "Уведомления о задачах: своя длительность и звук для каждого вида, встроенный сигнал или свой файл, настройка содержимого карточки.",
			"pluginSettings.on": "включены",
			"pluginSettings.off": "выключены",
			"pluginSettings.notice.saved": "Настройки сохранены",
			"pluginSettings.notice.failed": "Не удалось сохранить настройки",
			"pluginSettings.notice.fileType": "Поддерживаются только файлы MP3 и WAV.",
			"pluginSettings.notice.fileSize": "Файл больше 12 МБ.",
			"pluginSettings.notice.fileEmpty": "Файл пустой.",
			"pluginSettings.notice.fileFailed": "Не удалось загрузить звуковой файл.",
			"pluginSettings.notice.uploaded": "Звук загружен — нажмите «Сохранить», чтобы применить.",
			"pluginSettings.notice.previewFailed": "Не удалось воспроизвести пример."
		};
		/** Chinese copy. */
		const zh = {
			title: "任务完成时通知",
			description: "任务完成时显示置顶窗口并播放提示音。",
			saved: "设置已保存",
			failed: "无法保存设置",
			muteOn: "此会话的通知已开启，点击关闭。",
			muteOff: "此会话的通知已关闭，点击开启。",
			"pluginSettings.intro": "保存后立即生效。聊天顶部的铃铛可为单个会话关闭通知。",
			"pluginSettings.general.title": "常规",
			"pluginSettings.enabled.title": "显示通知",
			"pluginSettings.enabled.description": "任务完成、需要回答或智能体提问时显示置顶窗口。",
			"pluginSettings.durations.title": "显示时长",
			"pluginSettings.durations.description": "每个窗口停留的秒数（0.3–10，步长 0.1）。",
			"pluginSettings.durationCompleted.title": "任务完成窗口",
			"pluginSettings.durationCompleted.description": "任务完成后出现的窗口。",
			"pluginSettings.durationQuestion.title": "需要回答窗口",
			"pluginSettings.durationQuestion.description": "智能体提问时出现的黄色窗口。",
			"pluginSettings.seconds": "秒",
			"pluginSettings.range": "0.3 到 10 秒，步长 0.1",
			"pluginSettings.completedSound.title": "任务完成声音",
			"pluginSettings.completedSound.description": "内置提示音或自己的 MP3/WAV 文件。",
			"pluginSettings.questionSound.title": "提问声音",
			"pluginSettings.questionSound.description": "内置提问提示音或自己的 MP3/WAV 文件。",
			"pluginSettings.mode.label": "声音来源",
			"pluginSettings.mode.builtin": "内置提示音",
			"pluginSettings.mode.custom": "自定义文件",
			"pluginSettings.file.hint": "MP3 或 WAV，最大 12 MB。文件会立即上传；按「保存」后生效。",
			"pluginSettings.builtin": "内置提示音",
			"pluginSettings.noFile": "未选择文件",
			"pluginSettings.uploading": "上传中…",
			"pluginSettings.preview": "试听",
			"pluginSettings.resetSound": "重置",
			"pluginSettings.window": "显示窗口",
			"pluginSettings.extras.title": "卡片内容",
			"pluginSettings.extras.description": "通知卡片除标题外显示的内容。",
			"pluginSettings.showSessionTitle.title": "会话标题",
			"pluginSettings.showSessionTitle.description": "显示通知属于哪个会话。",
			"pluginSettings.showAnswerExcerpt.title": "回答摘要",
			"pluginSettings.showAnswerExcerpt.description": "显示已完成回答的开头几行。",
			"pluginSettings.notifyQuestions.title": "「需要回答」卡片",
			"pluginSettings.notifyQuestions.description": "智能体提问时显示黄色卡片。",
			"pluginSettings.save": "保存",
			"pluginSettings.reset": "重置",
			"pluginSettings.unsaved": "有未保存的更改",
			"pluginSettings.saved": "设置已保存",
			"pluginSettings.failed": "无法保存设置",
			"pluginSettings.readOnly": "当前设置只读。",
			"pluginSettings.summary": "任务通知：每种通知可单独设置显示时长和声音，支持内置或自定义提示音，并可设置卡片内容。",
			"pluginSettings.on": "已开启",
			"pluginSettings.off": "已关闭",
			"pluginSettings.notice.saved": "设置已保存",
			"pluginSettings.notice.failed": "无法保存设置",
			"pluginSettings.notice.fileType": "仅支持 MP3 和 WAV 文件。",
			"pluginSettings.notice.fileSize": "文件大于 12 MB。",
			"pluginSettings.notice.fileEmpty": "文件为空。",
			"pluginSettings.notice.fileFailed": "无法上传声音文件。",
			"pluginSettings.notice.uploaded": "声音已上传 — 按「保存」应用。",
			"pluginSettings.notice.previewFailed": "无法播放示例。"
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
		/** Plugin settings page column. */
		const PAGE_STYLE = {
			display: "flex",
			flexDirection: "column",
			padding: "4px 0 8px"
		};
		/** Intro paragraph of the plugin settings page. */
		const INTRO_STYLE = {
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 13,
			lineHeight: "20px",
			margin: "0 0 4px"
		};
		/** One block of the plugin settings page. */
		const SECTION_STYLE = {
			borderTop: ".5px solid var(--dsw-alias-border-l2)",
			padding: "16px 0"
		};
		/** Section headline. */
		const SECTION_TITLE_STYLE = {
			fontSize: 13,
			fontWeight: 600,
			lineHeight: "20px",
			marginBottom: 2
		};
		/** Two-column control row inside a plugin section. */
		const PLUGIN_ROW_STYLE = {
			alignItems: "flex-start",
			display: "flex",
			gap: 24,
			justifyContent: "space-between"
		};
		/** Title + description column of a plugin row. */
		const PLUGIN_TEXT_STYLE = {
			flex: "1 1 auto",
			minWidth: 0
		};
		/** Number input of a duration control. */
		const NUMBER_INPUT_STYLE = {
			background: "transparent",
			border: ".5px solid var(--dsw-alias-border-l3)",
			borderRadius: "var(--dsw-radius-sm)",
			boxSizing: "border-box",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 14,
			height: 34,
			padding: "0 10px",
			textAlign: "right",
			width: 96
		};
		/** Range slider of a duration control. */
		const RANGE_STYLE = {
			accentColor: "var(--dsw-alias-brand-primary)",
			margin: 0,
			maxWidth: 420,
			width: "100%"
		};
		/** Caption under a slider. */
		const CAPTION_STYLE = {
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: 12,
			lineHeight: "18px"
		};
		/** Caption shown when a duration value is out of range. */
		const CAPTION_ERROR_STYLE = {
			color: "var(--dsw-alias-state-error-primary)",
			fontSize: 12,
			lineHeight: "18px"
		};
		/** Small secondary button. */
		const SMALL_BUTTON_STYLE = {
			background: "transparent",
			border: ".5px solid var(--dsw-alias-border-l3)",
			borderRadius: "var(--dsw-radius-sm)",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer",
			font: "inherit",
			fontSize: 12,
			height: 28,
			padding: "0 10px"
		};
		/** Primary save button of the plugin settings page. */
		const PRIMARY_BUTTON_STYLE = {
			background: "var(--dsw-alias-button-primary-fill)",
			border: "none",
			borderRadius: "var(--dsw-radius-sm)",
			color: "var(--dsw-alias-label-primary-foreground)",
			cursor: "pointer",
			font: "inherit",
			fontSize: 13,
			height: 32,
			padding: "0 14px"
		};
		/** Footer row with save/reset controls. */
		const BUTTON_ROW_STYLE = {
			alignItems: "center",
			display: "flex",
			gap: 12,
			justifyContent: "flex-start",
			paddingTop: 4
		};
		/** Sound-source dropdown. */
		const SELECT_STYLE = {
			background: "transparent",
			border: ".5px solid var(--dsw-alias-border-l3)",
			borderRadius: "var(--dsw-radius-sm)",
			boxSizing: "border-box",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 13,
			height: 34,
			maxWidth: 380,
			padding: "0 10px",
			width: "100%"
		};
		/** Outline button that previews a sound or the window. */
		const OUTLINE_BUTTON_STYLE = {
			alignItems: "center",
			background: "transparent",
			border: ".5px solid var(--dsw-alias-border-l3)",
			borderRadius: "var(--dsw-radius-sm)",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer",
			display: "inline-flex",
			flex: "0 0 auto",
			font: "inherit",
			fontSize: 12,
			height: 32,
			padding: "0 12px"
		};
		/** Toggle track (off). */
		const TRACK_STYLE = {
			alignItems: "center",
			background: "var(--dsw-alias-border-l3)",
			border: "none",
			borderRadius: 999,
			boxSizing: "border-box",
			cursor: "pointer",
			display: "inline-flex",
			flex: "0 0 auto",
			height: 24,
			padding: 2,
			position: "relative",
			transition: "background-color .15s",
			width: 40
		};
		/** Toggle track (on). DSH keeps one track colour; the knob position is the state. */
		const TRACK_ON_STYLE = {
			...TRACK_STYLE
		};
		/** Toggle knob. */
		const KNOB_STYLE = {
			background: "var(--dsw-alias-switch-thumb)",
			borderRadius: "50%",
			boxShadow: "0 1px 2px rgba(0, 0, 0, 0.24)",
			display: "block",
			height: 20,
			transition: "transform .15s",
			width: 20
		};
		/** Toggle knob (on). */
		const KNOB_ON_STYLE = {
			...KNOB_STYLE,
			transform: "translateX(16px)"
		};
		/** Small hint line under a control. */
		const HINT_STYLE = {
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: 12,
			lineHeight: "18px"
		};
		/** Outcome notice (neutral / success). */
		const NOTICE_STYLE = {
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			lineHeight: "18px",
			marginTop: 4
		};
		/** Outcome notice (failure). */
		const NOTICE_ERROR_STYLE = {
			color: "var(--dsw-alias-state-error-primary)",
			fontSize: 12,
			lineHeight: "18px",
			marginTop: 4
		};
		/** File row inside a sound section. */
		const FILE_ROW_STYLE = {
			alignItems: "center",
			display: "flex",
			flexWrap: "wrap",
			gap: 10,
			marginTop: 10
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
		* @param params - optional `{name}` interpolation values.
		* @returns localized text, or the key when translation is unavailable.
		*/
		function translate(t, key, params) {
			try {
				return typeof t === "function" ? t(key, params) : key;
			} catch (error) {
				report(error);
				return key;
			}
		}
		//#endregion
		//#region lib/client/settings-page-config.js
		/** Host HTTP route prefix of the v1.1 settings API. */
		const ROUTE_PREFIX = "/dsh-topmost-notify";
		/** This bundle's npm package name (the first half of a Plugins row key). */
		const BUNDLE_NAME = "dsh-topmost-notify";
		/** Host row id declared by this bundle's patch; the row's Configure page key. */
		const ROW_ID = "topmost-notify";
		/** `plugins.row.config` key: bundle name + row id. */
		const PLUGIN_ROW_KEY = `${BUNDLE_NAME}#${ROW_ID}`;
		/** Duration bounds in seconds, mirrored by the Host Config schema. */
		const DURATION_SECONDS = {
			min: 0.3,
			max: 10,
			step: 0.1
		};
		/** Accepted upload size for a custom sound (12 MiB, the Host limit). */
		const MAX_SOUND_BYTES = 12 * 1024 * 1024;
		/** File picker filter of a custom sound. */
		const SOUND_ACCEPT = ".mp3,.wav,audio/mpeg,audio/wav";
		/** Bundled sound file names, shown when no custom file is chosen. */
		const BUNDLED_FILES = {
			completed: "chime.wav",
			question: "chime-question.wav"
		};
		/** Fallback values when the Host form has not loaded yet. */
		const DEFAULT_VALUES = {
			enabled: true,
			durationMs: 1000,
			questionDurationMs: 1500,
			completedSoundEnabled: true,
			questionSoundEnabled: true,
			completedSoundFile: "",
			questionSoundFile: "",
			showSessionTitle: true,
			showAnswerExcerpt: true,
			notifyQuestions: true
		};
		/** Config fields the page may write, in the order of the emitted ops. */
		const SAVE_FIELDS = [
			"enabled",
			"durationMs",
			"questionDurationMs",
			"completedSoundEnabled",
			"questionSoundEnabled",
			"completedSoundFile",
			"questionSoundFile",
			"showSessionTitle",
			"showAnswerExcerpt",
			"notifyQuestions"
		];
		/** Notice states rendered near the footer. */
		const NOTICE_KEYS = {
			saved: "pluginSettings.notice.saved",
			failed: "pluginSettings.notice.failed",
			fileType: "pluginSettings.notice.fileType",
			fileSize: "pluginSettings.notice.fileSize",
			fileEmpty: "pluginSettings.notice.fileEmpty",
			fileFailed: "pluginSettings.notice.fileFailed",
			uploaded: "pluginSettings.notice.uploaded",
			previewFailed: "pluginSettings.notice.previewFailed"
		};
		/** Notice states rendered with the success tone. */
		const SUCCESS_NOTICES = {
			saved: true,
			uploaded: true
		};
		/**
		* Read a Host-owned config form into one tolerant view.
		* A missing, throwing or malformed form degrades to a disabled page instead
		* of throwing out of the component.
		* @param form - `props.form` from the `plugins.row.config` owner.
		* @returns safe `{status, value, revision, writable}` view.
		*/
		function readFormView(form) {
			try {
				if (form === void 0 || form === null || typeof form !== "object") return {
					status: "loading",
					value: {},
					revision: void 0,
					writable: false
				};
				const state = form.state;
				if (state === void 0 || state === null || typeof state !== "object") return {
					status: "loading",
					value: {},
					revision: void 0,
					writable: false
				};
				const status = typeof state.status === "string" ? state.status : "loading";
				let value = {};
				try {
					if (state.value !== void 0 && state.value !== null && typeof state.value === "object" && !Array.isArray(state.value)) value = state.value;
				} catch (error) {
					report(error);
				}
				let revision;
				try {
					revision = state.revision;
				} catch (error) {
					report(error);
				}
				let writable = false;
				try {
					writable = state.writable === true;
				} catch (error) {
					report(error);
				}
				return {
					status,
					value,
					revision,
					writable
				};
			} catch (error) {
				report(error);
				return {
					status: "loading",
					value: {},
					revision: void 0,
					writable: false
				};
			}
		}
		/**
		* Clamp one duration in milliseconds to the Host range.
		* @param value - raw config value.
		* @returns clamped integer milliseconds, or null for a non-number.
		*/
		function clampMilliseconds(value) {
			const numeric = Number(value);
			if (!Number.isFinite(numeric)) return null;
			return Math.min(DURATION_SECONDS.max * 1000, Math.max(DURATION_SECONDS.min * 1000, Math.round(numeric)));
		}
		/**
		* Format milliseconds as the seconds text shown in the inputs.
		* @param milliseconds - duration.
		* @returns one-decimal seconds, without a trailing `.0`.
		*/
		function formatSeconds(milliseconds) {
			return String(Math.round(milliseconds / 100) / 10);
		}
		/**
		* Parse the seconds text typed into a duration input.
		* @param text - raw input value.
		* @returns rounded seconds within the range, or null when invalid.
		*/
		function parseSeconds(text) {
			const raw = String(text === void 0 || text === null ? "" : text).trim().replace(",", ".");
			if (raw === "") return null;
			const numeric = Number(raw);
			if (!Number.isFinite(numeric)) return null;
			const rounded = Math.round(numeric * 10) / 10;
			if (rounded < DURATION_SECONDS.min || rounded > DURATION_SECONDS.max) return null;
			return rounded;
		}
		/**
		* Convert validated seconds to the integer milliseconds the Config stores.
		* @param seconds - 0.3..10 with one decimal.
		* @returns milliseconds rounded to the 100 ms step.
		*/
		function secondsToMilliseconds(seconds) {
			return Math.round(seconds * 10) * 100;
		}
		/**
		* File name of an absolute Host path (Windows or POSIX separators).
		* @param filePath - configured file path.
		* @returns last path segment, or the path itself.
		*/
		function fileNameOf(filePath) {
			const text = String(filePath === void 0 || filePath === null ? "" : filePath);
			const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
			return cut >= 0 ? text.slice(cut + 1) : text;
		}
		/**
		* Validate a picked file before uploading it.
		* @param file - File-like object.
		* @returns notice key, or null when the file may be uploaded.
		*/
		function validateSoundFile(file) {
			if (file === void 0 || file === null || typeof file !== "object") return "fileEmpty";
			const name = typeof file.name === "string" ? file.name : "";
			if (!/\.(mp3|wav)$/i.test(name)) return "fileType";
			const size = Number(file.size);
			if (!Number.isFinite(size) || size <= 0) return "fileEmpty";
			if (size > MAX_SOUND_BYTES) return "fileSize";
			return null;
		}
		/**
		* Map a refused upload response to the page notice state.
		* @param response - fetch Response, or null for a transport failure.
		* @returns notice key (`fileSize`, `fileType` or `fileFailed`).
		*/
		function uploadFailureNotice(response) {
			const status = response !== null && response !== void 0 && typeof response.status === "number" ? response.status : 0;
			if (status === 413) return "fileSize";
			if (status === 400) return "fileType";
			return "fileFailed";
		}
		/**
		* Read the accepted (Host) values out of a config value object.
		* @param value - `form.state.value`.
		* @returns normalized accepted values with defaults.
		*/
		function readAcceptedValues(value) {
			const source = value !== null && typeof value === "object" ? value : {};
			const booleanOf = (field, fallback) => typeof source[field] === "boolean" ? source[field] : fallback;
			const stringOf = (field, fallback) => typeof source[field] === "string" ? source[field] : fallback;
			return {
				enabled: booleanOf("enabled", DEFAULT_VALUES.enabled),
				durationMs: clampMilliseconds(source.durationMs) ?? DEFAULT_VALUES.durationMs,
				questionDurationMs: clampMilliseconds(source.questionDurationMs) ?? DEFAULT_VALUES.questionDurationMs,
				completedSoundEnabled: booleanOf("completedSoundEnabled", DEFAULT_VALUES.completedSoundEnabled),
				questionSoundEnabled: booleanOf("questionSoundEnabled", DEFAULT_VALUES.questionSoundEnabled),
				completedSoundFile: stringOf("completedSoundFile", DEFAULT_VALUES.completedSoundFile),
				questionSoundFile: stringOf("questionSoundFile", DEFAULT_VALUES.questionSoundFile),
				showSessionTitle: booleanOf("showSessionTitle", DEFAULT_VALUES.showSessionTitle),
				showAnswerExcerpt: booleanOf("showAnswerExcerpt", DEFAULT_VALUES.showAnswerExcerpt),
				notifyQuestions: booleanOf("notifyQuestions", DEFAULT_VALUES.notifyQuestions)
			};
		}
		/**
		* Build the editable draft from accepted values.
		* @param accepted - normalized Host values.
		* @returns draft state of the settings page.
		*/
		function draftOf(accepted) {
			return {
				enabled: accepted.enabled === true,
				durationCompleted: formatSeconds(accepted.durationMs),
				durationQuestion: formatSeconds(accepted.questionDurationMs),
				completedSoundEnabled: accepted.completedSoundEnabled === true,
				questionSoundEnabled: accepted.questionSoundEnabled === true,
				completedMode: accepted.completedSoundFile === "" ? "builtin" : "custom",
				completedFile: accepted.completedSoundFile,
				completedPickedName: "",
				questionMode: accepted.questionSoundFile === "" ? "builtin" : "custom",
				questionFile: accepted.questionSoundFile,
				questionPickedName: "",
				showSessionTitle: accepted.showSessionTitle === true,
				showAnswerExcerpt: accepted.showAnswerExcerpt === true,
				notifyQuestions: accepted.notifyQuestions === true
			};
		}
		/**
		* Turn the draft into Host config values; `null` marks an invalid duration.
		* @param draft - current draft.
		* @returns config-shaped payload for saving and comparing.
		*/
		function payloadOf(draft) {
			const completedSeconds = parseSeconds(draft.durationCompleted);
			const questionSeconds = parseSeconds(draft.durationQuestion);
			return {
				enabled: draft.enabled === true,
				durationMs: completedSeconds === null ? null : secondsToMilliseconds(completedSeconds),
				questionDurationMs: questionSeconds === null ? null : secondsToMilliseconds(questionSeconds),
				completedSoundEnabled: draft.completedSoundEnabled === true,
				questionSoundEnabled: draft.questionSoundEnabled === true,
				completedSoundFile: draft.completedMode === "custom" ? draft.completedFile : "",
				questionSoundFile: draft.questionMode === "custom" ? draft.questionFile : "",
				showSessionTitle: draft.showSessionTitle === true,
				showAnswerExcerpt: draft.showAnswerExcerpt === true,
				notifyQuestions: draft.notifyQuestions === true
			};
		}
		/**
		* Whether both duration inputs hold a valid value.
		* @param draft - current draft.
		* @returns true when the page may be saved.
		*/
		function draftIsValid(draft) {
			return parseSeconds(draft.durationCompleted) !== null && parseSeconds(draft.durationQuestion) !== null;
		}
		/**
		* Ops for the Host form: only fields whose value differs from the baseline.
		* @param draft - current draft.
		* @param baseline - accepted values as last saved.
		* @returns ordered `{op:'set', path:[field], value}` operations.
		*/
		function buildOps(draft, baseline) {
			const payload = payloadOf(draft);
			const ops = [];
			for (const field of SAVE_FIELDS) {
				const next = payload[field];
				const previous = baseline[field];
				if (next === null || next === void 0) continue;
				if (next === previous) continue;
				ops.push({
					op: "set",
					path: [field],
					value: next
				});
			}
			return ops;
		}
		/**
		* Copy the plugin-settings-relevant fields out of the Host payload.
		* @param draft - current draft.
		* @returns normalized accepted-shaped snapshot.
		*/
		function baselineOf(draft) {
			const payload = payloadOf(draft);
			const baseline = {};
			for (const field of SAVE_FIELDS) if (payload[field] !== null && payload[field] !== void 0) baseline[field] = payload[field];
			return baseline;
		}
		/**
		* The resolved sound value the Host preview routes accept for one kind.
		* @param draft - current draft.
		* @param kind - `'completed'` or `'question'`.
		* @returns `false`, `true` (bundled) or an absolute custom path.
		*/
		function draftSoundValue(draft, kind) {
			const enabled = kind === "question" ? draft.questionSoundEnabled === true : draft.completedSoundEnabled === true;
			if (!enabled) return false;
			const file = kind === "question" ? draft.questionFile : draft.completedFile;
			return file !== "" ? file : true;
		}
		/**
		* Request an absolute route of this plugin, tolerating an absent fetch.
		* @param route - `/dsh-topmost-notify/...` path.
		* @param init - fetch options.
		* @returns the Response, or null when the transport failed.
		*/
		async function postToHost(route, init) {
			try {
				if (typeof fetch !== "function") return null;
				return await fetch(route, init);
			} catch (error) {
				report(error);
				return null;
			}
		}
		/**
		* Read a JSON response without letting a malformed body throw.
		* @param response - fetch Response.
		* @returns parsed body or null.
		*/
		async function jsonOf(response) {
			try {
				if (response === null || response === void 0 || typeof response.json !== "function") return null;
				return await response.json();
			} catch (error) {
				report(error);
				return null;
			}
		}
		/**
		* POST one JSON body to a control route.
		* @param route - route path.
		* @param body - JSON body.
		* @returns true when the Host answered `{ok:true}`.
		*/
		async function postJson(route, body) {
			const response = await postToHost(route, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			if (response === null) return false;
			const data = await jsonOf(response);
			return response.ok === true && data !== null && typeof data === "object" && data.ok === true;
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
		//#region lib/client/PluginSettings.js
		/**
		* The plugin's own settings page on the Plugins page
		* (`plugins.row.config`, key `dsh-topmost-notify#topmost-notify`).
		* A broken page must not blank the Plugins detail view: summary and page
		* bodies are wrapped, and every interactive failure is contained.
		* @param props - owner `view`/`form` + injected face + localized copy.
		* @returns one-line summary, the settings form, or null.
		*/
		function PluginSettings(props) {
			try {
				const view = props === void 0 || props === null ? void 0 : props.view;
				return view === "summary" ? renderPluginSettingsSummary(props) : renderPluginSettingsPage(props);
			} catch (error) {
				report(error);
				return null;
			}
		}
		/**
		* One-line description of the settings page for the Plugins row card.
		* @param props - owner props (only the copy is used).
		* @returns localized summary string.
		*/
		function renderPluginSettingsSummary(props) {
			const { t } = props ?? {};
			return translate(t, "pluginSettings.summary");
		}
		/**
		* The editable page: master switch, per-kind durations, per-kind sounds,
		* card contents and the save/reset footer. Owns its draft and only writes
		* through `props.form.mutate(ops, revision)`.
		* @param props - owner `form` (`{state, mutate}`) + localized copy.
		* @returns the settings page, disabled when the Host form is unusable.
		*/
		function renderPluginSettingsPage(props) {
			const { t } = props ?? {};
			const form = props?.form;
			const view = readFormView(form);
			const ready = view.status === "ready";
			const writable = ready && view.writable === true;
			const accepted = readAcceptedValues(view.value);
			const initialDraft = draftOf(accepted);
			const [draft, setDraft] = useState(initialDraft);
			const [baseline, setBaseline] = useState(baselineOf(initialDraft));
			const [notice, setNotice] = useState(null);
			const [uploading, setUploading] = useState(null);
			const [saving, setSaving] = useState(false);
			const acceptedSignature = ready ? JSON.stringify(accepted) : "";
			const lastSignatureRef = useRef(acceptedSignature);
			const mountedRef = useRef(true);
			useEffect(function syncAcceptedDraft() {
				if (!ready) return;
				if (lastSignatureRef.current === acceptedSignature) return;
				lastSignatureRef.current = acceptedSignature;
				const next = draftOf(readAcceptedValues(view.value));
				setBaseline(baselineOf(next));
				setDraft(next);
			}, [ready, acceptedSignature]);
			useEffect(function trackMount() {
				mountedRef.current = true;
				return function () {
					mountedRef.current = false;
				};
			}, []);
			const payload = payloadOf(draft);
			const valid = draftIsValid(draft);
			const ops = valid ? buildOps(draft, baseline) : [];
			const dirty = valid && ops.length > 0;
			const locked = !writable || saving || uploading !== null;
			const canSave = ready && writable && !saving && uploading === null && valid && dirty;
			/**
			* Merge one draft change and clear the previous outcome notice.
			* @param patch - draft fields to replace.
			* @returns void
			*/
			const updateDraft = (patch) => {
				try {
					setNotice(null);
					setDraft((current) => Object.assign({}, current, patch));
				} catch (error) {
					report(error);
				}
			};
			/**
			* Render one role=switch control with its test hook.
			* @param attr - `data-*` attribute name.
			* @param checked - current state.
			* @param disabled - interaction lock.
			* @param label - accessible label.
			* @param onToggle - handler on a real click.
			* @returns switch element.
			*/
			const renderToggle = (attr, checked, disabled, label, onToggle) => (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				role: "switch",
				[attr]: "",
				title: label,
				"aria-label": label,
				"aria-checked": checked ? "true" : "false",
				disabled,
				style: disabled ? Object.assign({}, checked ? TRACK_ON_STYLE : TRACK_STYLE, {
					cursor: "default",
					opacity: 0.5
				}) : checked ? TRACK_ON_STYLE : TRACK_STYLE,
				onClick: () => {
					try {
						if (!disabled) onToggle();
					} catch (error) {
						report(error);
					}
				},
				children: (0, react_jsx_runtime.jsx)("span", {
					"aria-hidden": "true",
					style: checked ? KNOB_ON_STYLE : KNOB_STYLE
				})
			});
			/**
			* Text column of a control row.
			* @param title - localized title.
			* @param description - localized description.
			* @returns descriptor.
			*/
			const renderText = (title, description) => (0, react_jsx_runtime.jsxs)("div", {
				style: PLUGIN_TEXT_STYLE,
				children: [(0, react_jsx_runtime.jsx)("div", {
					style: TITLE_STYLE,
					children: title
				}), (0, react_jsx_runtime.jsx)("div", {
					style: DESCRIPTION_STYLE,
					children: description
				})]
			});
			/**
			* One duration control: number input, slider and bounds hint.
			* @param kind - `'completed'` or `'question'`.
			* @returns descriptor.
			*/
			const renderDuration = (kind) => {
				const field = kind === "question" ? "durationQuestion" : "durationCompleted";
				const inputAttr = kind === "question" ? "data-tn-duration-question" : "data-tn-duration-completed";
				const rangeAttr = `${inputAttr}-range`;
				const title = translate(t, kind === "question" ? "pluginSettings.durationQuestion.title" : "pluginSettings.durationCompleted.title");
				const seconds = parseSeconds(draft[field]);
				const rangeValue = seconds === null ? DURATION_SECONDS.min : seconds;
				const setSeconds = (value) => updateDraft({
					[field]: String(value === void 0 || value === null ? "" : value)
				});
				return (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						flexDirection: "column",
						gap: 8,
						marginTop: 14
					},
					children: [(0, react_jsx_runtime.jsxs)("div", {
						style: PLUGIN_ROW_STYLE,
						children: [renderText(title, translate(t, kind === "question" ? "pluginSettings.durationQuestion.description" : "pluginSettings.durationCompleted.description")), (0, react_jsx_runtime.jsxs)("div", {
							style: {
								alignItems: "center",
								display: "flex",
								flex: "0 0 auto",
								gap: 8
							},
							children: [(0, react_jsx_runtime.jsx)("input", {
								type: "number",
								min: DURATION_SECONDS.min,
								max: DURATION_SECONDS.max,
								step: DURATION_SECONDS.step,
								inputMode: "numeric",
								[inputAttr]: "",
								"aria-label": title,
								value: draft[field],
								disabled: locked,
								style: locked ? Object.assign({}, NUMBER_INPUT_STYLE, { opacity: 0.5 }) : NUMBER_INPUT_STYLE,
								onChange: (event) => {
									setSeconds(event === void 0 || event === null || event.target === void 0 || event.target === null ? "" : event.target.value);
								}
							}), (0, react_jsx_runtime.jsx)("span", {
								style: CAPTION_STYLE,
								children: translate(t, "pluginSettings.seconds")
							})]
						})]
					}), (0, react_jsx_runtime.jsx)("input", {
						type: "range",
						min: DURATION_SECONDS.min,
						max: DURATION_SECONDS.max,
						step: DURATION_SECONDS.step,
						[rangeAttr]: "",
						"aria-label": title,
						value: rangeValue,
						disabled: locked,
						style: RANGE_STYLE,
						onChange: (event) => {
							setSeconds(event === void 0 || event === null || event.target === void 0 || event.target === null ? "" : event.target.value);
						}
					}), seconds === null ? (0, react_jsx_runtime.jsx)("div", {
						role: "status",
						style: CAPTION_ERROR_STYLE,
						children: translate(t, "pluginSettings.range")
					}) : (0, react_jsx_runtime.jsx)("div", {
						style: CAPTION_STYLE,
						children: translate(t, "pluginSettings.range")
					})]
				});
			};
			/**
			* Choose a sound file: validate it, upload it right away and put the
			* Host-returned path into the draft.
			* @param kind - `'completed'` or `'question'`.
			* @param file - picked File-like object.
			* @returns completion after the upload settles.
			*/
			const uploadSound = async (kind, file) => {
				const invalid = validateSoundFile(file);
				if (invalid !== null) {
					if (mountedRef.current) setNotice(invalid);
					return;
				}
				if (!ready || !writable) return;
				if (mountedRef.current) {
					setUploading(kind);
					setNotice(null);
				}
				try {
					const response = await postToHost(`${ROUTE_PREFIX}/sounds?kind=${kind}`, {
						method: "POST",
						headers: {
							"content-type": typeof file.type === "string" && file.type !== "" ? file.type : "application/octet-stream",
							"x-file-name": encodeURIComponent(typeof file.name === "string" ? file.name : "")
						},
						body: file
					});
					const data = await jsonOf(response);
					const path = data !== null && typeof data === "object" && typeof data.path === "string" ? data.path : "";
					if (response === null || response.ok !== true || data === null || data.ok !== true || path === "") {
						if (mountedRef.current) setNotice(uploadFailureNotice(response));
						return;
					}
					if (!mountedRef.current) return;
					const pickedName = typeof file.name === "string" ? file.name : "";
					if (kind === "question") setDraft((current) => Object.assign({}, current, {
						questionMode: "custom",
						questionFile: path,
						questionPickedName: pickedName
					}));
					else setDraft((current) => Object.assign({}, current, {
						completedMode: "custom",
						completedFile: path,
						completedPickedName: pickedName
					}));
					setNotice("uploaded");
				} catch (error) {
					report(error);
					if (mountedRef.current) setNotice("fileFailed");
				} finally {
					if (mountedRef.current) setUploading(null);
				}
			};
			/**
			* File input change handler; the upload promise is always contained.
			* @param kind - `'completed'` or `'question'`.
			* @param event - input change event.
			* @returns void
			*/
			const onPickSound = (kind, event) => {
				try {
					const files = event !== void 0 && event !== null && event.target !== void 0 && event.target !== null ? event.target.files : void 0;
					const file = files !== void 0 && files !== null && typeof files.length === "number" ? files[0] : void 0;
					if (file === void 0 || file === null) return;
					const pending = uploadSound(kind, file);
					if (pending !== void 0 && pending !== null && typeof pending.catch === "function") pending.catch(report);
				} catch (error) {
					report(error);
				}
			};
			/**
			* Play the draft sound of one kind (`POST /preview-sound`).
			* @param kind - `'completed'` or `'question'`.
			* @returns void
			*/
			const previewSound = (kind) => {
				try {
					const pending = postJson(`${ROUTE_PREFIX}/preview-sound`, {
						kind,
						sound: draftSoundValue(draft, kind)
					});
					pending.then((acceptedByHost) => {
						if (mountedRef.current && acceptedByHost !== true) setNotice("previewFailed");
					}).catch((error) => {
						report(error);
						if (mountedRef.current) setNotice("previewFailed");
					});
				} catch (error) {
					report(error);
				}
			};
			/**
			* Show a sample notification window with the draft duration and sound
			* (`POST /preview`).
			* @param kind - `'completed'` or `'question'`.
			* @returns void
			*/
			const previewWindow = (kind) => {
				try {
					const seconds = parseSeconds(kind === "question" ? draft.durationQuestion : draft.durationCompleted);
					if (seconds === null) return;
					const pending = postJson(`${ROUTE_PREFIX}/preview`, {
						kind,
						durationMs: secondsToMilliseconds(seconds),
						sound: draftSoundValue(draft, kind)
					});
					pending.then((acceptedByHost) => {
						if (mountedRef.current && acceptedByHost !== true) setNotice("previewFailed");
					}).catch((error) => {
						report(error);
						if (mountedRef.current) setNotice("previewFailed");
					});
				} catch (error) {
					report(error);
				}
			};
			/**
			* One sound section: enable switch, source select, file picker, file
			* name and the three preview/reset buttons.
			* @param kind - `'completed'` or `'question'`.
			* @returns descriptor.
			*/
			const renderSound = (kind) => {
				const completed = kind === "completed";
				const enabledField = completed ? "completedSoundEnabled" : "questionSoundEnabled";
				const modeField = completed ? "completedMode" : "questionMode";
				const fileField = completed ? "completedFile" : "questionFile";
				const pickedNameField = completed ? "completedPickedName" : "questionPickedName";
				const enabledAttr = completed ? "data-tn-completed-sound-enabled" : "data-tn-question-sound-enabled";
				const modeAttr = `data-tn-${kind}-file-mode`;
				const fileAttr = `data-tn-${kind}-file`;
				const nameAttr = `data-tn-${kind}-file-name`;
				const previewAttr = `data-tn-${kind}-preview`;
				const resetAttr = `data-tn-${kind}-file-reset`;
				const windowAttr = `data-tn-${kind}-window`;
				const enabled = draft[enabledField] === true;
				const custom = draft[modeField] === "custom";
				const file = draft[fileField];
				const title = translate(t, completed ? "pluginSettings.completedSound.title" : "pluginSettings.questionSound.title");
				const isUploading = uploading === kind;
				const pickedName = draft[pickedNameField];
				const displayName = isUploading ? translate(t, "pluginSettings.uploading") : custom ? file !== "" ? pickedName !== "" ? pickedName : fileNameOf(file) : translate(t, "pluginSettings.noFile") : translate(t, "pluginSettings.builtin");
				const soundDisabled = !ready || uploading !== null;
				const previewDisabled = soundDisabled || !enabled;
				return (0, react_jsx_runtime.jsxs)("section", {
					style: SECTION_STYLE,
					children: [(0, react_jsx_runtime.jsxs)("div", {
						style: PLUGIN_ROW_STYLE,
						children: [renderText(title, translate(t, completed ? "pluginSettings.completedSound.description" : "pluginSettings.questionSound.description")), renderToggle(enabledAttr, enabled, locked, title, () => updateDraft({
							[enabledField]: !enabled
						}))]
					}), (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 4,
							marginTop: 12
						},
						children: [(0, react_jsx_runtime.jsx)("label", {
							style: CAPTION_STYLE,
							children: translate(t, "pluginSettings.mode.label")
						}), (0, react_jsx_runtime.jsxs)("select", {
							[modeAttr]: "",
							"aria-label": translate(t, "pluginSettings.mode.label"),
							value: custom ? "custom" : "builtin",
							disabled: locked,
							style: locked ? Object.assign({}, SELECT_STYLE, { opacity: 0.5 }) : SELECT_STYLE,
							onChange: (event) => {
								const next = event !== void 0 && event !== null && event.target !== void 0 && event.target !== null && event.target.value === "custom" ? "custom" : "builtin";
								if (next === "custom") updateDraft({
									[modeField]: "custom"
								});
								else updateDraft({
									[modeField]: "builtin",
									[fileField]: "",
									[pickedNameField]: ""
								});
							},
							children: [(0, react_jsx_runtime.jsx)("option", {
								value: "builtin",
								children: translate(t, "pluginSettings.mode.builtin")
							}), (0, react_jsx_runtime.jsx)("option", {
								value: "custom",
								children: translate(t, "pluginSettings.mode.custom")
							})]
						})]
					}), (0, react_jsx_runtime.jsxs)("div", {
						style: FILE_ROW_STYLE,
						children: [(0, react_jsx_runtime.jsx)("input", {
							type: "file",
							accept: SOUND_ACCEPT,
							[fileAttr]: "",
							"aria-label": title,
							disabled: locked,
							onChange: (event) => {
								onPickSound(kind, event);
							}
						}), (0, react_jsx_runtime.jsx)("span", {
							[nameAttr]: "",
							title: custom && file !== "" ? file : BUNDLED_FILES[kind],
							style: CAPTION_STYLE,
							children: displayName
						})]
					}), (0, react_jsx_runtime.jsx)("div", {
						style: HINT_STYLE,
						children: translate(t, "pluginSettings.file.hint")
					}), (0, react_jsx_runtime.jsxs)("div", {
						style: FILE_ROW_STYLE,
						children: [(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							[previewAttr]: "",
							disabled: previewDisabled,
							style: previewDisabled ? Object.assign({}, OUTLINE_BUTTON_STYLE, {
								cursor: "default",
								opacity: 0.5
							}) : OUTLINE_BUTTON_STYLE,
							onClick: () => {
								if (!previewDisabled) previewSound(kind);
							},
							children: translate(t, "pluginSettings.preview")
						}), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							[resetAttr]: "",
							disabled: locked,
							style: locked ? Object.assign({}, SMALL_BUTTON_STYLE, {
								cursor: "default",
								opacity: 0.5
							}) : SMALL_BUTTON_STYLE,
							onClick: () => {
								if (locked) return;
								updateDraft({
									[modeField]: "builtin",
									[fileField]: "",
									[pickedNameField]: ""
								});
							},
							children: translate(t, "pluginSettings.resetSound")
						}), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							[windowAttr]: "",
							disabled: soundDisabled,
							style: soundDisabled ? Object.assign({}, OUTLINE_BUTTON_STYLE, {
								cursor: "default",
								opacity: 0.5
							}) : OUTLINE_BUTTON_STYLE,
							onClick: () => {
								if (!soundDisabled) previewWindow(kind);
							},
							children: translate(t, "pluginSettings.window")
						})]
					})]
				});
			};
			/**
			* Persist only the changed fields through the owner form.
			* @returns void
			*/
			const onSave = () => {
				if (!canSave || form === null || form === void 0 || typeof form.mutate !== "function") return;
				const nextOps = buildOps(draft, baseline);
				if (nextOps.length === 0) return;
				const snapshotBaseline = baselineOf(draft);
				const revision = view.revision;
				if (mountedRef.current) {
					setSaving(true);
					setNotice(null);
				}
				let pending;
				try {
					pending = form.mutate(nextOps, revision);
				} catch (error) {
					report(error);
					if (mountedRef.current) {
						setSaving(false);
						setNotice("failed");
					}
					return;
				}
				Promise.resolve(pending).then((acceptedByHost) => {
					if (!mountedRef.current) return;
					setSaving(false);
					if (acceptedByHost === true) {
						setBaseline(snapshotBaseline);
						setNotice("saved");
					} else setNotice("failed");
				}).catch((error) => {
					report(error);
					if (!mountedRef.current) return;
					setSaving(false);
					setNotice("failed");
				});
			};
			/**
			* Drop the draft back to the last accepted values.
			* @returns void
			*/
			const onReset = () => {
				if (!ready || saving) return;
				const next = draftOf(readAcceptedValues(view.value));
				if (mountedRef.current) {
					setBaseline(baselineOf(next));
					setDraft(next);
					setNotice(null);
				}
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				"data-topmost-notify-settings": "",
				style: PAGE_STYLE,
				children: [(0, react_jsx_runtime.jsx)("p", {
					style: INTRO_STYLE,
					children: translate(t, "pluginSettings.intro")
				}), (0, react_jsx_runtime.jsxs)("section", {
					style: SECTION_STYLE,
					children: [(0, react_jsx_runtime.jsx)("div", {
						style: SECTION_TITLE_STYLE,
						children: translate(t, "pluginSettings.general.title")
					}), (0, react_jsx_runtime.jsxs)("div", {
						style: PLUGIN_ROW_STYLE,
						children: [renderText(translate(t, "pluginSettings.enabled.title"), translate(t, "pluginSettings.enabled.description")), renderToggle("data-tn-enabled", draft.enabled === true, locked, translate(t, "pluginSettings.enabled.title"), () => updateDraft({
							enabled: draft.enabled !== true
						}))]
					})]
				}), (0, react_jsx_runtime.jsxs)("section", {
					style: SECTION_STYLE,
					children: [(0, react_jsx_runtime.jsx)("div", {
						style: SECTION_TITLE_STYLE,
						children: translate(t, "pluginSettings.durations.title")
					}), (0, react_jsx_runtime.jsx)("div", {
						style: CAPTION_STYLE,
						children: translate(t, "pluginSettings.durations.description")
					}), renderDuration("completed"), renderDuration("question")]
				}), renderSound("completed"), renderSound("question"), (0, react_jsx_runtime.jsxs)("section", {
					style: SECTION_STYLE,
					children: [(0, react_jsx_runtime.jsx)("div", {
						style: SECTION_TITLE_STYLE,
						children: translate(t, "pluginSettings.extras.title")
					}), (0, react_jsx_runtime.jsx)("div", {
						style: CAPTION_STYLE,
						children: translate(t, "pluginSettings.extras.description")
					}), (0, react_jsx_runtime.jsxs)("div", {
						style: PLUGIN_ROW_STYLE,
						children: [renderText(translate(t, "pluginSettings.notifyQuestions.title"), translate(t, "pluginSettings.notifyQuestions.description")), renderToggle("data-tn-notify-questions", draft.notifyQuestions === true, locked, translate(t, "pluginSettings.notifyQuestions.title"), () => updateDraft({
							notifyQuestions: draft.notifyQuestions !== true
						}))]
					}), (0, react_jsx_runtime.jsxs)("div", {
						style: PLUGIN_ROW_STYLE,
						children: [renderText(translate(t, "pluginSettings.showSessionTitle.title"), translate(t, "pluginSettings.showSessionTitle.description")), renderToggle("data-tn-show-session-title", draft.showSessionTitle === true, locked, translate(t, "pluginSettings.showSessionTitle.title"), () => updateDraft({
							showSessionTitle: draft.showSessionTitle !== true
						}))]
					}), (0, react_jsx_runtime.jsxs)("div", {
						style: PLUGIN_ROW_STYLE,
						children: [renderText(translate(t, "pluginSettings.showAnswerExcerpt.title"), translate(t, "pluginSettings.showAnswerExcerpt.description")), renderToggle("data-tn-show-answer-excerpt", draft.showAnswerExcerpt === true, locked, translate(t, "pluginSettings.showAnswerExcerpt.title"), () => updateDraft({
							showAnswerExcerpt: draft.showAnswerExcerpt !== true
						}))]
					})]
				}), (0, react_jsx_runtime.jsxs)("div", {
					style: BUTTON_ROW_STYLE,
					children: [(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						"data-tn-save": "",
						disabled: !canSave,
						style: !canSave ? Object.assign({}, PRIMARY_BUTTON_STYLE, {
							cursor: "default",
							opacity: 0.5
						}) : PRIMARY_BUTTON_STYLE,
						onClick: onSave,
						children: translate(t, "pluginSettings.save")
					}), (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						"data-tn-reset": "",
						disabled: !ready || saving,
						style: !ready || saving ? Object.assign({}, SMALL_BUTTON_STYLE, {
							cursor: "default",
							opacity: 0.5
						}) : SMALL_BUTTON_STYLE,
						onClick: onReset,
						children: translate(t, "pluginSettings.reset")
					}), notice !== null ? (0, react_jsx_runtime.jsx)("div", {
						role: "status",
						"data-tn-notice": notice,
						style: SUCCESS_NOTICES[notice] === true ? NOTICE_STYLE : NOTICE_ERROR_STYLE,
						children: translate(t, NOTICE_KEYS[notice] ?? "pluginSettings.notice.failed")
					}) : dirty ? (0, react_jsx_runtime.jsx)("div", {
						"data-tn-unsaved": "",
						style: CAPTION_STYLE,
						children: translate(t, "pluginSettings.unsaved")
					}) : null, ready && !writable ? (0, react_jsx_runtime.jsx)("div", {
						style: CAPTION_STYLE,
						children: translate(t, "pluginSettings.readOnly")
					}) : null]
				})]
			});
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
				try {
					if (typeof ctx.slots?.inject === "function") ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
						name: "plugins.row.config",
						key: PLUGIN_ROW_KEY,
						locale: LOCALE_NS,
						inject: face
					}, PluginSettings));
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
