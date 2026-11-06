/**
 * dsh-voice-reply — browser half.
 *
 * Adds four contributions to the DSH Web client:
 *   1. a speaker / stop action in `conversation.chat.assistant-actions` on every
 *      finalized assistant answer (replay, no second synthesis for the same answer);
 *   2. an ambient auto-speak chip in `conversation.composer.dock` that follows the
 *      playback state and can stop or dismiss it;
 *   3. the `autoSpeak` preference row in Settings → General;
 *   4. the plugin's own settings page on the Plugins page
 *      (`plugins.row.config`, key `dsh-voice-reply#voice-reply`), where the
 *      maximum spoken-summary length is edited.
 *
 * The module is a plain browser module-loader factory: no JSX, no TypeScript,
 * no build step. Only `react` and `react/jsx-runtime` come from the browser
 * module table. All user-visible copy lives in the `voiceReply` locale
 * namespace.
 */

window.__ModuleLoader__.load({
	id: 'dsh-voice-reply',
	factory(require) {
		const React = require('react');
		const { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } = React;
		const { jsx, jsxs } = require('react/jsx-runtime');

		/* ------------------------------------------------------------------ */
		/* Constants                                                          */
		/* ------------------------------------------------------------------ */

		/** Locale namespace owned by this plugin (also the slot `locale` seat). */
		const LOCALE_NS = 'voiceReply';
		/** Host HTTP route prefix (see CONTRACT.md, host HTTP API). */
		const ROUTE = '/dsh-voice-reply';
		/** Host-side claim store for finished answers (separate plugin row). */
		const PENDING_ROUTE = '/dsh-voice-pending';
		/** Separator used to pack `messageId` + text into one primitive selector value. */
		const SELECTOR_SEPARATOR = '\u0000';
		/** Newest chunk-cache entries kept in memory (audio itself stays on the Host). */
		const CHUNK_CACHE_LIMIT = 200;
		/** This bundle's npm package name (the first half of a Plugins row key). */
		const BUNDLE_NAME = 'dsh-voice-reply';
		/** Host row id declared by this bundle's patch; the row's Configure page key. */
		const PLUGIN_ROW_KEY = `${BUNDLE_NAME}#voice-reply`;
		/** Fallback spoken-summary budget; the Host status supplies the real one. */
		const DEFAULT_SUMMARY_MAX_CHARS = 500;
		/** Fallback bounds for the summary-budget control; the Host status supplies the real ones. */
		const DEFAULT_SUMMARY_LIMITS = Object.freeze({ min: 100, max: 2000, step: 50 });
		/** Chars-per-second estimate used only for the settings-page hint. */
		const SPEECH_CHARS_PER_SECOND = 15;
		/** Fallback voice/speed until the Host status answers. */
		const DEFAULT_VOICE = 'marina';
		const DEFAULT_SPEED = 1.32;
		/** Default intonation: an empty string means "let the voice decide". */
		const DEFAULT_EMOTION = '';
		/** Speed control bounds (the TTS API accepts 0.1–3.0, two decimals). */
		const SPEED_LIMITS = Object.freeze({ min: 0.1, max: 3, step: 0.01 });
		/** Prefix of the player message id used for a settings-page voice preview. */
		const PREVIEW_MESSAGE_PREFIX = 'voice-preview:';

		/* ------------------------------------------------------------------ */
		/* Locale dictionaries                                                */
		/* ------------------------------------------------------------------ */

		/** English copy. */
		const en = {
			'action.play': 'Read the answer aloud',
			'action.stop': 'Stop reading',
			'action.loading': 'Preparing audio…',
			'autoSpeak.title': 'Read answers aloud',
			'autoSpeak.description': 'Speak a short summary of every finished answer with Yandex SpeechKit and show a replay button on each answer. Set the character limit in Plugins → Voice replies → Configure.',
			'status.loading': 'Preparing the short audio…',
			'status.playing': 'Reading the short summary aloud…',
			'status.error': 'Could not read the answer aloud',
			'status.blocked': 'The browser blocked audio playback',
			'status.blockedHint': 'Press the speaker button again to allow sound.',
			'status.dismiss': 'Dismiss',
			'settings.saved': 'Preference saved',
			'settings.failed': 'Could not save the preference',
			'error.notConfigured': 'Text-to-speech is not configured',
			'error.generic': 'Could not play the answer. Try again.',
			'pluginSettings.title': 'Voice reply settings',
			'pluginSettings.description': 'Answers are read aloud as a short summary — up to the character limit below.',
			'pluginSettings.summary': 'Short spoken answers',
			'pluginSettings.chars': 'characters',
			'pluginSettings.maxChars.title': 'Maximum speech characters',
			'pluginSettings.maxChars.description': 'A longer answer is reduced to its key points. 500 characters is about 30 seconds of speech.',
			'pluginSettings.estimatePrefix': 'About',
			'pluginSettings.estimateSuffix': 'seconds of speech',
			'pluginSettings.presets': 'Quick presets',
			'pluginSettings.presetShort': 'Shorter',
			'pluginSettings.presetDefault': 'Standard',
			'pluginSettings.presetDetailed': 'Longer',
			'pluginSettings.save': 'Save',
			'pluginSettings.saved': 'Settings saved',
			'pluginSettings.reset': 'Reset',
			'pluginSettings.autoSpeak.title': 'Speak automatically',
			'pluginSettings.autoSpeak.description': 'Start the voice right after an answer finishes.',
			'pluginSettings.voice': 'Voice',
			'pluginSettings.voice.description': 'The Yandex SpeechKit voice used for answers. Press “Preview” to hear a short sample with the current voice, intonation and speed.',
			'pluginSettings.emotion': 'Intonation',
			'pluginSettings.emotion.description': 'Voice colouring: neutral, cheerful, angry, whisper or friendly. The available set depends on the selected voice; press “Preview” to hear the chosen intonation.',
			'pluginSettings.emotion.default': 'Voice default',
			'pluginSettings.emotion.unsupported': 'This voice offers no selectable intonations — it always sounds neutral.',
			'pluginSettings.emotionValue.neutral': 'Neutral',
			'pluginSettings.emotionValue.good': 'Cheerful',
			'pluginSettings.emotionValue.evil': 'Angry',
			'pluginSettings.emotionValue.whisper': 'Whisper',
			'pluginSettings.emotionValue.friendly': 'Friendly',
			'pluginSettings.speed': 'Speed',
			'pluginSettings.speed.description': 'Speech rate from 0.1 to 3.0. 1.32 is the current default.',
			'pluginSettings.preview': 'Preview',
			'pluginSettings.previewStop': 'Stop',
			'pluginSettings.previewLoading': 'Preparing sample…',
			'pluginSettings.previewError': 'Could not play the voice sample',
			'pluginSettings.range': 'Allowed range: 100 to 2000 characters.',
			'pluginSettings.unsaved': 'Unsaved changes',
		};

		/** Russian copy (the primary user-facing language of this plugin). */
		const ru = {
			'action.play': 'Озвучить ответ',
			'action.stop': 'Остановить озвучивание',
			'action.loading': 'Готовлю озвучку…',
			'autoSpeak.title': 'Озвучивать ответы голосом',
			'autoSpeak.description': 'Проговаривать краткое содержание каждого готового ответа через Yandex SpeechKit и показывать кнопку повторного прослушивания у каждого ответа. Лимит символов настраивается в разделе «Плагины» → «Голосовые ответы» → «Настроить».',
			'status.loading': 'Готовлю краткую озвучку…',
			'status.playing': 'Озвучиваю краткое содержание…',
			'status.error': 'Не удалось озвучить ответ',
			'status.blocked': 'Браузер заблокировал воспроизведение',
			'status.blockedHint': 'Нажмите кнопку с динамиком ещё раз, чтобы включить звук.',
			'status.dismiss': 'Закрыть',
			'settings.saved': 'Настройка сохранена',
			'settings.failed': 'Не удалось сохранить настройку',
			'error.notConfigured': 'Озвучивание не настроено: добавьте ключ Yandex SpeechKit с доступом к TTS',
			'error.generic': 'Не удалось воспроизвести ответ. Попробуйте ещё раз.',
			'pluginSettings.title': 'Настройки озвучки',
			'pluginSettings.description': 'Ответы читаются голосом как краткое содержание — до выбранного ниже лимита символов.',
			'pluginSettings.summary': 'Краткая озвучка ответов',
			'pluginSettings.chars': 'символов',
			'pluginSettings.maxChars.title': 'Максимум символов озвучки',
			'pluginSettings.maxChars.description': 'Длинный ответ сокращается до главного. 500 символов — примерно 30 секунд речи.',
			'pluginSettings.estimatePrefix': 'Около',
			'pluginSettings.estimateSuffix': 'секунд речи',
			'pluginSettings.presets': 'Быстрый выбор',
			'pluginSettings.presetShort': 'Короче',
			'pluginSettings.presetDefault': 'Обычно',
			'pluginSettings.presetDetailed': 'Подробнее',
			'pluginSettings.save': 'Сохранить',
			'pluginSettings.saved': 'Настройки сохранены',
			'pluginSettings.reset': 'Сбросить',
			'pluginSettings.autoSpeak.title': 'Озвучивать автоматически',
			'pluginSettings.autoSpeak.description': 'Включать голос сразу после завершения ответа.',
			'pluginSettings.voice': 'Голос',
			'pluginSettings.voice.description': 'Голос Yandex SpeechKit для ответов. Нажмите «Прослушать», чтобы услышать короткий пример с текущими голосом, интонацией и скоростью.',
			'pluginSettings.emotion': 'Интонация',
			'pluginSettings.emotion.description': 'Окраска голоса: нейтральная, радостная, злая, шёпот или дружелюбная. Набор зависит от выбранного голоса; нажмите «Прослушать», чтобы оценить выбранную интонацию.',
			'pluginSettings.emotion.default': 'Как у голоса',
			'pluginSettings.emotion.unsupported': 'У этого голоса нет вариантов интонации — он звучит нейтрально.',
			'pluginSettings.emotionValue.neutral': 'Нейтральная',
			'pluginSettings.emotionValue.good': 'Радостная',
			'pluginSettings.emotionValue.evil': 'Злая',
			'pluginSettings.emotionValue.whisper': 'Шёпот',
			'pluginSettings.emotionValue.friendly': 'Дружелюбная',
			'pluginSettings.speed': 'Скорость',
			'pluginSettings.speed.description': 'Скорость речи от 0.1 до 3.0. 1.32 — текущее значение по умолчанию.',
			'pluginSettings.preview': 'Прослушать',
			'pluginSettings.previewStop': 'Остановить',
			'pluginSettings.previewLoading': 'Готовлю пример…',
			'pluginSettings.previewError': 'Не удалось прослушать пример',
			'pluginSettings.range': 'Допустимо от 100 до 2000 символов.',
			'pluginSettings.unsaved': 'Есть несохранённые изменения',
		};

		/** Chinese copy. */
		const zh = {
			'action.play': '朗读回复',
			'action.stop': '停止朗读',
			'action.loading': '正在准备语音…',
			'autoSpeak.title': '朗读回复',
			'autoSpeak.description': '使用 Yandex SpeechKit 朗读每条已完成回复的简短摘要，并在每条回复上显示重播按钮。字符上限可在「插件」→「语音回复」→「配置」中调整。',
			'status.loading': '正在准备简短语音…',
			'status.playing': '正在朗读简短摘要…',
			'status.error': '无法朗读回复',
			'status.blocked': '浏览器阻止了音频播放',
			'status.blockedHint': '请再次点击喇叭按钮以允许声音。',
			'status.dismiss': '关闭',
			'settings.saved': '设置已保存',
			'settings.failed': '无法保存设置',
			'error.notConfigured': '语音合成尚未配置：请添加具有 TTS 权限的 Yandex SpeechKit 密钥',
			'error.generic': '无法播放回复，请重试。',
			'pluginSettings.title': '朗读设置',
			'pluginSettings.description': '回复以简短摘要形式朗读，长度不超过下方字符上限。',
			'pluginSettings.summary': '简短语音回复',
			'pluginSettings.chars': '字符',
			'pluginSettings.maxChars.title': '朗读字符上限',
			'pluginSettings.maxChars.description': '较长回复会缩减为要点。500 个字符约等于 30 秒语音。',
			'pluginSettings.estimatePrefix': '约',
			'pluginSettings.estimateSuffix': '秒语音',
			'pluginSettings.presets': '快速选择',
			'pluginSettings.presetShort': '更短',
			'pluginSettings.presetDefault': '标准',
			'pluginSettings.presetDetailed': '更长',
			'pluginSettings.save': '保存',
			'pluginSettings.saved': '设置已保存',
			'pluginSettings.reset': '重置',
			'pluginSettings.autoSpeak.title': '自动朗读',
			'pluginSettings.autoSpeak.description': '回复结束后立即开始朗读。',
			'pluginSettings.voice': '声音',
			'pluginSettings.voice.description': '用于朗读回复的 Yandex SpeechKit 声音。点击“试听”可听到当前声音、语调和语速的短示例。',
			'pluginSettings.emotion': '语调',
			'pluginSettings.emotion.description': '声音的情绪色彩：中性、欢快、愤怒、低语或友好。可选范围取决于所选声音；点击“试听”即可听到所选语调。',
			'pluginSettings.emotion.default': '声音默认',
			'pluginSettings.emotion.unsupported': '此声音没有可选语调，始终为中性。',
			'pluginSettings.emotionValue.neutral': '中性',
			'pluginSettings.emotionValue.good': '欢快',
			'pluginSettings.emotionValue.evil': '愤怒',
			'pluginSettings.emotionValue.whisper': '低语',
			'pluginSettings.emotionValue.friendly': '友好',
			'pluginSettings.speed': '语速',
			'pluginSettings.speed.description': '语速范围 0.1–3.0。当前默认值为 1.32。',
			'pluginSettings.preview': '试听',
			'pluginSettings.previewStop': '停止',
			'pluginSettings.previewLoading': '正在准备示例…',
			'pluginSettings.previewError': '无法播放试听示例',
			'pluginSettings.range': '允许范围：100 到 2000 个字符。',
			'pluginSettings.unsaved': '有未保存的更改',
		};

		/* ------------------------------------------------------------------ */
		/* Small helpers                                                      */
		/* ------------------------------------------------------------------ */

		/**
		 * Contain one failure without disturbing the host application.
		 * @param {unknown} error - caught value.
		 * @returns {void}
		 */
		function report(error) {
			try {
				console.warn('[dsh-voice-reply] client:', error);
			} catch (ignored) {
				/* nothing sensible left to do */
			}
		}

		/**
		 * Resolve one localized key, degrading to the key instead of throwing.
		 * @param {((key: string) => string) | undefined} t - slot-bound translator.
		 * @param {string} key - dictionary key.
		 * @returns {string} localized text or the key.
		 */
		function translate(t, key) {
			try {
				return typeof t === 'function' ? t(key) : key;
			} catch (error) {
				report(error);
				return key;
			}
		}

		/**
		 * Join the visible text blocks of one assistant payload.
		 * @param {readonly unknown[] | undefined} blocks - assistant blocks.
		 * @returns {string} plain answer text (may be empty).
		 */
		function joinTextBlocks(blocks) {
			if (!Array.isArray(blocks)) return '';
			const parts = [];
			for (const block of blocks) {
				if (!block || typeof block !== 'object') continue;
				if (block.kind !== 'text') continue;
				if (typeof block.text !== 'string') continue;
				if (block.text.trim() === '') continue;
				parts.push(block.text);
			}
			return parts.join('\n\n').trim();
		}

		/**
		 * Test whether one chat node carries the finalized assistant message.
		 * @param {any} node - chat node (kind `assistant-step`).
		 * @param {string} messageId - durable message identity.
		 * @returns {boolean} true when the node owns this answer.
		 */
		function nodeMatchesMessage(node, messageId) {
			const data = node && node.data;
			if (!data || typeof data !== 'object') return false;
			const finalId = data.finalNode !== null && data.finalNode !== undefined ? data.finalNode.messageId : undefined;
			if (finalId !== null && finalId !== undefined) return String(finalId) === messageId;
			// Running/interrupted projections may not carry a final node yet; fall back
			// to block-level or payload-level identity when one is present.
			if (data.messageId !== null && data.messageId !== undefined && String(data.messageId) === messageId) return true;
			const blocks = Array.isArray(data.blocks) ? data.blocks : [];
			for (const block of blocks) {
				if (!block || typeof block !== 'object') continue;
				const candidate = block.messageId !== undefined ? block.messageId : block.block && block.block.messageId;
				if (candidate !== null && candidate !== undefined && String(candidate) === messageId) return true;
			}
			return false;
		}

		/**
		 * Resolve the answer text of one finalized assistant message.
		 * Primitive selector result: walks the immutable `order` and the keyed
		 * `nodes` store, joins the `kind: 'text'` blocks. Returns '' when absent.
		 * @param {any} snapshot - Chat snapshot.
		 * @param {unknown} messageId - durable message identity.
		 * @returns {string} answer text.
		 */
		function resolveAnswerText(snapshot, messageId) {
			try {
				if (!snapshot || messageId === null || messageId === undefined) return '';
				const order = snapshot.order;
				const nodes = snapshot.nodes;
				if (!Array.isArray(order) || !nodes || typeof nodes.get !== 'function') return '';
				const id = String(messageId);
				for (let index = order.length - 1; index >= 0; index -= 1) {
					const node = nodes.get(order[index]);
					if (!node || node.kind !== 'assistant-step') continue;
					if (!nodeMatchesMessage(node, id)) continue;
					const data = node.data || {};
					let text = joinTextBlocks(data.blocks);
					if (text === '' && data.finalNode) text = joinTextBlocks(data.finalNode.blocks);
					return text;
				}
				return '';
			} catch (error) {
				report(error);
				return '';
			}
		}

		/**
		 * Last Turn that closed in this snapshot.
		 * Primitive selector result.
		 * @param {any} snapshot - Chat snapshot.
		 * @returns {number} Turn number, or -1 when nothing closed yet.
		 */
		function lastEndedTurn(snapshot) {
			try {
				const turnEnds = snapshot && snapshot.legacy ? snapshot.legacy.turnEnds : null;
				if (!turnEnds || typeof turnEnds.keys !== 'function') return -1;
				let latest = -1;
				for (const key of turnEnds.keys()) {
					const turn = Number(key);
					if (Number.isFinite(turn) && turn > latest) latest = turn;
				}
				return latest;
			} catch (error) {
				report(error);
				return -1;
			}
		}

		/**
		 * Closing answer of one finished Turn, packed into one primitive so the
		 * selector never returns a fresh object per call.
		 * @param {any} snapshot - Chat snapshot.
		 * @param {number} turn - finished Turn number.
		 * @returns {string} `messageId\u0000text`, or '' when there is no answer.
		 */
		function closingAnswerKey(snapshot, turn) {
			try {
				if (!snapshot || !Number.isFinite(turn) || turn < 0) return '';
				const order = snapshot.order;
				const nodes = snapshot.nodes;
				const pack = (messageId, text) => {
					if (messageId === null || messageId === undefined) return '';
					const id = String(messageId);
					if (id === '' || text === '') return '';
					return id + SELECTOR_SEPARATOR + text;
				};
				if (Array.isArray(order) && nodes && typeof nodes.get === 'function') {
					for (let index = order.length - 1; index >= 0; index -= 1) {
						const node = nodes.get(order[index]);
						if (!node || node.kind !== 'turn-tail') continue;
						const data = node.data;
						if (!data || Number(data.turn) !== turn) continue;
						const closing = data.closing;
						if (!closing || !closing.finalNode) continue;
						let text = joinTextBlocks(closing.blocks);
						if (text === '' && Array.isArray(closing.finalNode.blocks)) text = joinTextBlocks(closing.finalNode.blocks);
						const packed = pack(closing.finalNode.messageId, text);
						if (packed !== '') return packed;
					}
				}
				// Compatibility fallback: the legacy slice still lists the durable
				// assistant nodes; use its last one for this Turn.
				const legacyNodes = snapshot.legacy && Array.isArray(snapshot.legacy.nodes) ? snapshot.legacy.nodes : null;
				if (legacyNodes !== null) {
					for (let index = legacyNodes.length - 1; index >= 0; index -= 1) {
						const node = legacyNodes[index];
						if (!node || node.kind !== 'assistant') continue;
						if (Number(node.turn) !== turn) continue;
						const packed = pack(node.messageId, joinTextBlocks(node.blocks));
						if (packed !== '') return packed;
					}
				}
				return '';
			} catch (error) {
				report(error);
				return '';
			}
		}

		/**
		 * Unpack the closing-answer selector value.
		 * @param {string} key - packed value.
		 * @returns {{ messageId: string, text: string } | null} answer identity and text.
		 */
		function splitClosingAnswer(key) {
			if (typeof key !== 'string' || key === '') return null;
			const index = key.indexOf(SELECTOR_SEPARATOR);
			if (index <= 0) return null;
			const messageId = key.slice(0, index);
			const text = key.slice(index + 1);
			if (messageId === '' || text === '') return null;
			return { messageId, text };
		}

		/* ------------------------------------------------------------------ */
		/* Player singleton                                                   */
		/* ------------------------------------------------------------------ */

		/* ------------------------------------------------------------------ */
		/* Shared translator + Host transport                                 */
		/* ------------------------------------------------------------------ */

		/** Namespace-bound translator installed by `apply`; key fallback until then. */
		let translateFn = null;

		/**
		 * Localize one key, degrading to the key instead of throwing.
		 * @param {string} key - dictionary key.
		 * @returns {string} localized text.
		 */
		function localize(key) {
			try {
				return typeof translateFn === 'function' ? translateFn(key) : key;
			} catch (error) {
				report(error);
				return key;
			}
		}

		/**
		 * One JSON round-trip against the Host routes.
		 * @param {string} url - request URL.
		 * @param {object} [init] - fetch options.
		 * @returns {Promise<{ ok: boolean, status: number, payload: any }>} parsed answer.
		 */
		async function requestJson(url, init) {
			const response = await fetch(url, init);
			let payload = null;
			try {
				payload = await response.json();
			} catch (error) {
				report(error);
			}
			return { ok: response.ok, status: response.status, payload };
		}

		/** Idle player snapshot; the store always returns a stable reference. */
		function emptyPlayerState() {
			return {
				status: 'idle',
				messageId: null,
				error: null,
				hint: null,
				chunkIndex: 0,
				chunkCount: 0,
			};
		}

		/**
		 * Observable player shared by every slot component: one playback at a
		 * time, per-message chunk cache, cancellable fetch + media, and the
		 * `useSyncExternalStore` pair (`subscribe` + `getState`).
		 * @returns {object} player store and verbs.
		 */
		function createPlayer() {
			let state = emptyPlayerState();
			const listeners = new Set();
			let statusPromise = null;
			let controller = null;
			let generation = 0;
			let currentAudio = null;
			let currentFinish = null;
			let disposed = false;
			const chunkCache = new Map();

			/**
			 * Replace the published state and notify subscribers.
			 * @param {object} patch - changed fields.
			 * @returns {void}
			 */
			function publish(patch) {
				if (disposed) return;
				const next = Object.assign({}, state, patch);
				state = next;
				for (const listener of Array.from(listeners)) {
					try {
						listener();
					} catch (error) {
						report(error);
					}
				}
			}

			/**
			 * Whether one async step still owns the current playback generation.
			 * @param {number} run - captured generation.
			 * @returns {boolean} true while the step may publish.
			 */
			function isCurrent(run) {
				return !disposed && run === generation;
			}

			/**
			 * Report a terminal failure for the current generation.
			 * @param {number} run - captured generation.
			 * @param {string} status - `error` or `blocked`.
			 * @param {unknown} message - already-localized message.
			 * @param {unknown} hint - optional extra guidance.
			 * @returns {void}
			 */
			function fail(run, status, message, hint) {
				if (!isCurrent(run)) return;
				publish({
					status,
					error: typeof message === 'string' && message !== '' ? message : localize('error.generic'),
					hint: typeof hint === 'string' && hint !== '' ? hint : null,
					chunkIndex: 0,
				});
				// Media elements are released by the caller (playChunk) or stop().
			}

			/**
			 * Abort everything in flight without publishing the idle state.
			 * @returns {void}
			 */
			function stopInternal() {
				generation += 1;
				if (controller !== null) {
					const active = controller;
					controller = null;
					try {
						active.abort();
					} catch (error) {
						report(error);
					}
				}
				const finish = currentFinish;
				currentFinish = null;
				const audio = currentAudio;
				currentAudio = null;
				if (audio !== null) {
					try {
						audio.onended = null;
						audio.onerror = null;
					} catch (error) {
						report(error);
					}
					try {
						audio.pause();
					} catch (error) {
						report(error);
					}
				}
				if (typeof finish === 'function') {
					try {
						finish('stopped');
					} catch (error) {
						report(error);
					}
				}
			}

			/** Public stop: abort, pause, clear the queue and return to idle. */
			function stop() {
				try {
					stopInternal();
					publish(emptyPlayerState());
				} catch (error) {
					report(error);
				}
			}

			/**
			 * GET the Host status once; the promise is cached until a failure.
			 * @returns {Promise<any>} status payload.
			 */
			function readStatus() {
				if (statusPromise === null) {
					statusPromise = (async () => {
						try {
							const result = await requestJson(`${ROUTE}/status`, {
								method: 'GET',
								headers: { accept: 'application/json' },
								credentials: 'same-origin',
							});
							if (!result.ok || !result.payload || result.payload.ok !== true) {
								throw new Error(`voice-reply status replied ${result.status}`);
							}
							return result.payload;
						} catch (error) {
							statusPromise = null;
							throw error;
						}
					})();
				}
				return statusPromise;
			}

			/**
			 * Turn one non-2xx Host answer into an Error carrying a user-facing
			 * message and optional hint.
			 * @param {{ status: number, payload: any }} result - Host answer.
			 * @returns {Error} user-facing error.
			 */
			function hostError(result) {
				const failure = result.payload && typeof result.payload === 'object' ? result.payload.error : null;
				const code = failure && typeof failure.code === 'string' ? failure.code : '';
				const hostMessage = failure && typeof failure.message === 'string' ? failure.message : '';
				const message = hostMessage !== '' ? hostMessage : code === 'not-configured' ? localize('error.notConfigured') : localize('error.generic');
				const hint = failure && typeof failure.hint === 'string' ? failure.hint : null;
				const error = new Error(message);
				error.userMessage = message;
				error.userHint = hint;
				return error;
			}

			/**
			 * Validate the playable chunk descriptors of one speak/preview answer.
			 * @param {any} payload - Host JSON body.
			 * @returns {Array<{ url: string }>} playable chunks.
			 * @throws {Error} when the answer carries no playable audio.
			 */
			function playableChunks(payload) {
				const chunks = payload && Array.isArray(payload.chunks) ? payload.chunks : [];
				const playable = [];
				for (const chunk of chunks) {
					if (!chunk || typeof chunk !== 'object') continue;
					if (typeof chunk.url !== 'string' || chunk.url === '') continue;
					playable.push({ url: chunk.url });
				}
				if (!payload || payload.ok !== true || playable.length === 0) {
					const message = localize('error.generic');
					const error = new Error(message);
					error.userMessage = message;
					error.userHint = null;
					throw error;
				}
				return playable;
			}

			/**
			 * Remember one chunk list in the bounded per-message cache.
			 * @param {string} key - message identity.
			 * @param {object} record - cache record.
			 * @returns {void}
			 */
			function rememberChunks(key, record) {
				if (chunkCache.size >= CHUNK_CACHE_LIMIT) {
					const first = chunkCache.keys().next();
					if (!first.done) chunkCache.delete(first.value);
				}
				chunkCache.set(key, record);
			}

			/**
			 * POST the text for synthesis, reusing the per-message chunk cache.
			 * @param {string} messageId - durable answer identity.
			 * @param {string} text - answer text.
			 * @returns {Promise<Array<{ url: string }>>} chunk URLs in playback order.
			 */
			async function resolveChunks(messageId, text) {
				const cached = chunkCache.get(messageId);
				if (cached !== undefined && cached.text === text && cached.chunks.length > 0) return cached.chunks;
				const result = await requestJson(`${ROUTE}/speak`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify({ text, messageId }),
					signal: controller !== null ? controller.signal : undefined,
				});
				if (!result.ok) throw hostError(result);
				const playable = playableChunks(result.payload);
				rememberChunks(messageId, { text, chunks: playable });
				return playable;
			}

			/**
			 * Request the short voice sample for the drafts on the settings page,
			 * reusing the cached sample for the same voice/emotion/speed triple.
			 * @param {string} messageId - preview identity.
			 * @param {string} voice - voice id.
			 * @param {string} emotion - Yandex `emotion` ('' for the voice default).
			 * @param {number|null} speed - speech rate.
			 * @returns {Promise<Array<{ url: string }>>} chunk URLs in playback order.
			 */
			async function resolvePreviewChunks(messageId, voice, emotion, speed) {
				const cached = chunkCache.get(messageId);
				if (
					cached !== undefined &&
					cached.preview === true &&
					cached.voice === voice &&
					cached.emotion === emotion &&
					cached.speed === speed &&
					cached.chunks.length > 0
				) {
					return cached.chunks;
				}
				const result = await requestJson(`${ROUTE}/preview`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify({ voice, emotion, speed }),
					signal: controller !== null ? controller.signal : undefined,
				});
				if (!result.ok) throw hostError(result);
				const playable = playableChunks(result.payload);
				rememberChunks(messageId, { preview: true, voice, emotion, speed, text: '', chunks: playable });
				return playable;
			}

			/**
			 * Whether a media rejection is the browser refusing an ungestured play.
			 * @param {any} error - rejection reason.
			 * @returns {boolean} true for NotAllowedError.
			 */
			function isPlaybackBlocked(error) {
				if (!error) return false;
				if (typeof error === 'object') {
					if (error.name === 'NotAllowedError') return true;
					if (error.code === 18) return true;
				}
				return /NotAllowedError|not allowed to start/i.test(String(error && error.message ? error.message : ''));
			}

			/**
			 * Whether a rejection is our own abort.
			 * @param {any} error - rejection reason.
			 * @returns {boolean} true when playback was cancelled.
			 */
			function isAbortError(error) {
				if (!error) return false;
				if (error.name === 'AbortError') return true;
				return /aborted/i.test(String(error && error.message ? error.message : ''));
			}

			/**
			 * Play one audio chunk and resolve when it ends (or failed/stopped).
			 * @param {string} url - same-origin audio URL.
			 * @param {number} run - captured generation.
			 * @returns {Promise<'ended'|'blocked'|'error'|'stopped'>} outcome.
			 */
			function playChunk(url, run) {
				return new Promise((resolve) => {
					let audio = null;
					try {
						audio = new Audio(url);
					} catch (error) {
						report(error);
						fail(run, 'error', localize('error.generic'), null);
						resolve('error');
						return;
					}
					currentAudio = audio;
					let settled = false;
					const finish = (outcome) => {
						if (settled) return;
						settled = true;
						if (currentAudio === audio) currentAudio = null;
						if (currentFinish === finish) currentFinish = null;
						try {
							audio.onended = null;
							audio.onerror = null;
						} catch (error) {
							report(error);
						}
						try {
							audio.pause();
						} catch (error) {
							report(error);
						}
						resolve(outcome);
					};
					currentFinish = finish;
					audio.onended = () => finish('ended');
					audio.onerror = () => {
						fail(run, 'error', localize('error.generic'), null);
						finish('error');
					};
					const onPlayFailure = (error) => {
						if (settled) return;
						if (isAbortError(error)) {
							finish('stopped');
							return;
						}
						if (isPlaybackBlocked(error)) {
							fail(run, 'blocked', localize('status.blocked'), localize('status.blockedHint'));
							finish('blocked');
							return;
						}
						report(error);
						fail(run, 'error', localize('error.generic'), null);
						finish('error');
					};
					let playing = null;
					try {
						playing = audio.play();
					} catch (error) {
						onPlayFailure(error);
						return;
					}
					if (playing && typeof playing.then === 'function') {
						playing.catch((error) => {
							onPlayFailure(error);
						});
					}
				});
			}

			/**
			 * Speak one answer: load status, synthesize (or reuse cache), play the
			 * chunks in order. Clicking the same answer while it is loading/playing
			 * stops it (toggle).
			 * @param {{ messageId?: unknown, text?: unknown }} request - answer.
			 * @returns {Promise<void>} settlement after playback or failure.
			 */
			async function speak(request) {
				if (disposed) return;
				const requestedId = request && request.messageId !== null && request.messageId !== undefined ? String(request.messageId) : null;
				const text = request && typeof request.text === 'string' ? request.text : '';
				if (text.trim() === '') return;
				if (requestedId !== null && state.messageId === requestedId && (state.status === 'loading' || state.status === 'playing')) {
					stop();
					return;
				}
				stopInternal();
				const run = generation;
				const messageId = requestedId !== null && requestedId !== '' ? requestedId : `anonymous-${Date.now()}`;
				publish(Object.assign(emptyPlayerState(), { status: 'loading', messageId }));
				try {
					let statusPayload = null;
					try {
						statusPayload = await readStatus();
					} catch (error) {
						report(error);
						fail(run, 'error', localize('error.generic'), null);
						return;
					}
					if (!isCurrent(run)) return;
					if (statusPayload.configured === false) {
						fail(run, 'error', localize('error.notConfigured'), typeof statusPayload.error === 'string' ? statusPayload.error : null);
						return;
					}
					controller = typeof AbortController === 'function' ? new AbortController() : null;
					let chunks = [];
					try {
						chunks = await resolveChunks(messageId, text);
					} catch (error) {
						if (!isCurrent(run)) return;
						if (isAbortError(error)) return;
						fail(run, 'error', error && error.userMessage ? error.userMessage : localize('error.generic'), error && error.userHint ? error.userHint : null);
						return;
					}
					if (!isCurrent(run)) return;
					publish({ status: 'playing', chunkCount: chunks.length, chunkIndex: 0 });
					for (let index = 0; index < chunks.length; index += 1) {
						if (!isCurrent(run)) return;
						publish({ chunkIndex: index });
						const outcome = await playChunk(chunks[index].url, run);
						if (!isCurrent(run)) return;
						if (outcome !== 'ended') return;
					}
					if (isCurrent(run)) publish(emptyPlayerState());
				} catch (error) {
					report(error);
					if (isCurrent(run) && !isAbortError(error)) fail(run, 'error', localize('error.generic'), null);
				}
			}

			/**
			 * Play a short voice sample for the settings page drafts. Clicking the
			 * same preview again stops it. The sample never claims or caches an
			 * assistant answer and uses its own message identity.
			 * @param {{ voice?: unknown, emotion?: unknown, speed?: unknown }} request - draft voice/intensity/speed.
			 * @returns {Promise<void>} settlement after playback or failure.
			 */
			async function preview(request) {
				if (disposed) return;
				const voice = request && typeof request.voice === 'string' ? request.voice : '';
				if (voice === '') return;
				const emotion = request && typeof request.emotion === 'string' ? request.emotion : '';
				const speed =
					request && request.speed !== undefined && request.speed !== null && Number.isFinite(Number(request.speed))
						? Math.round(Number(request.speed) * 100) / 100
						: null;
				const messageId = `${PREVIEW_MESSAGE_PREFIX}${voice}:${emotion}:${speed === null ? '' : speed}`;
				if (state.messageId === messageId && (state.status === 'loading' || state.status === 'playing')) {
					stop();
					return;
				}
				stopInternal();
				const run = generation;
				publish(Object.assign(emptyPlayerState(), { status: 'loading', messageId }));
				try {
					let statusPayload = null;
					try {
						statusPayload = await readStatus();
					} catch (error) {
						report(error);
						fail(run, 'error', localize('error.generic'), null);
						return;
					}
					if (!isCurrent(run)) return;
					if (statusPayload.configured === false) {
						fail(run, 'error', localize('error.notConfigured'), typeof statusPayload.error === 'string' ? statusPayload.error : null);
						return;
					}
					controller = typeof AbortController === 'function' ? new AbortController() : null;
					let chunks = [];
					try {
						chunks = await resolvePreviewChunks(messageId, voice, emotion, speed);
					} catch (error) {
						if (!isCurrent(run)) return;
						if (isAbortError(error)) return;
						fail(
							run,
							'error',
							error && error.userMessage ? error.userMessage : localize('pluginSettings.previewError'),
							error && error.userHint ? error.userHint : null,
						);
						return;
					}
					if (!isCurrent(run)) return;
					publish({ status: 'playing', chunkCount: chunks.length, chunkIndex: 0 });
					for (let index = 0; index < chunks.length; index += 1) {
						if (!isCurrent(run)) return;
						publish({ chunkIndex: index });
						const outcome = await playChunk(chunks[index].url, run);
						if (!isCurrent(run)) return;
						if (outcome !== 'ended') return;
					}
					if (isCurrent(run)) publish(emptyPlayerState());
				} catch (error) {
					report(error);
					if (isCurrent(run) && !isAbortError(error)) fail(run, 'error', localize('pluginSettings.previewError'), null);
				}
			}

			/**
			 * Toggle one answer: stop it when it is the current playback, else speak.
			 * @param {{ messageId?: unknown, text?: unknown }} request - answer.
			 * @returns {void}
			 */
			function toggle(request) {
				try {
					if (disposed) return;
					const id = request && request.messageId !== null && request.messageId !== undefined ? String(request.messageId) : null;
					if (id !== null && state.messageId === id && (state.status === 'loading' || state.status === 'playing')) {
						stop();
						return;
					}
					const pending = speak(request);
					if (pending && typeof pending.catch === 'function') pending.catch(report);
				} catch (error) {
					report(error);
				}
			}

			return {
				/** @param {() => void} listener - change callback. @returns {() => void} unsubscribe. */
				subscribe(listener) {
					if (typeof listener !== 'function' || disposed) return () => {};
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				/** @returns {object} current immutable snapshot (stable reference). */
				getState() {
					return state;
				},
				/** Alias accepted by generic snapshot stores. @returns {object} current snapshot. */
				getSnapshot() {
					return state;
				},
				speak,
				preview,
				toggle,
				stop,
				/**
				 * Warm the status probe lazily; failures are silent.
				 * @returns {void}
				 */
				prefetchStatus() {
					try {
						const pending = readStatus();
						if (pending && typeof pending.catch === 'function') pending.catch(() => {});
					} catch (error) {
						report(error);
					}
				},
				/** Release every resource; the player becomes inert. */
				dispose() {
					if (disposed) return;
					disposed = true;
					stopInternal();
					chunkCache.clear();
					listeners.clear();
					statusPromise = null;
				},
			};
		}

		/* ------------------------------------------------------------------ */
		/* Player instance (one per materialized module)                      */
		/* ------------------------------------------------------------------ */

		const player = createPlayer();

		/* ------------------------------------------------------------------ */
		/* Deferred auto-speak: one Host-claimed answer per finished Turn      */
		/* ------------------------------------------------------------------ */

		/** Session currently rendered by the Conversation (composer-dock entry). */
		let activeSessionId = null;

		/**
		 * Last finalized answer per Session, kept only as a fallback when the
		 * Host claim route is temporarily unreachable.
		 * @type {Map<string, { messageId: string, text: string }>}
		 */
		const lastClosingBySession = new Map();

		/** Pending one-shot retry of a claim (the Host may record a turn a moment later). */
		let claimRetryTimer = null;

		/**
		 * Stable string identity for a Session (the Host uses integers/strings).
		 * @param {unknown} sessionId - Session identity.
		 * @returns {string} key used by the pending map.
		 */
		function sessionKeyOf(sessionId) {
			return sessionId === null || sessionId === undefined ? '' : String(sessionId);
		}

		/**
		 * Whether the DSH page is the one the user is actually looking at right
		 * now. Speech must never start in a hidden tab or an unfocused window.
		 * @returns {boolean} true when the page is visible and focused.
		 */
		function pageIsActive() {
			try {
				if (typeof document === 'undefined') return true;
				if (document.visibilityState === 'hidden') return false;
				if (typeof document.hasFocus === 'function' && document.hasFocus() === false) return false;
				return true;
			} catch (error) {
				report(error);
				return true;
			}
		}

		/**
		 * Remember one finalized answer for the claim fallback.
		 * @param {string} key - Session key.
		 * @param {string} messageId - answer identity.
		 * @param {string} text - answer text.
		 * @returns {void}
		 */
		function rememberClosing(key, messageId, text) {
			try {
				if (typeof text !== 'string' || text === '') return;
				if (lastClosingBySession.size > 80) {
					const oldest = lastClosingBySession.keys().next()
					if (!oldest.done) lastClosingBySession.delete(oldest.value)
				}
				lastClosingBySession.set(key, { messageId: String(messageId), text })
			} catch (error) {
				report(error)
			}
		}

		/**
		 * Speak one answer unless exactly that answer is already loading/playing.
		 * @param {string} messageId - durable answer identity.
		 * @param {string} text - answer text.
		 * @returns {void}
		 */
		function speakAnswer(messageId, text) {
			try {
				const current = player.getState()
				const same =
					current.messageId !== null &&
					current.messageId !== undefined &&
					String(current.messageId) === String(messageId) &&
					(current.status === 'loading' || current.status === 'playing')
				if (same) return
				const started = player.speak({ messageId, text })
				if (started && typeof started.catch === 'function') started.catch(report)
			} catch (error) {
				report(error)
			}
		}

		/**
		 * One claim/discard round-trip against the host-side pending store.
		 * @param {string} path - route below the pending prefix.
		 * @param {string} sessionId - Session key.
		 * @returns {Promise<{ ok: boolean, status: number, payload: any }>} answer.
		 */
		function postPending(path, sessionId) {
			return requestJson(`${PENDING_ROUTE}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ sessionId }),
			})
		}

		/**
		 * Acknowledge (drop) the stored answer of one Session without speaking it.
		 * @param {string} sessionId - Session key.
		 * @returns {Promise<void>} completion; failures are ignored.
		 */
		async function discardPending(sessionId) {
			try {
				await postPending('/discard', sessionId)
			} catch {
				/* the store is best-effort */
			}
		}

		/**
		 * Claim the Host-stored finished answer of one Session and speak it once.
		 * The claim deletes the item atomically, so page reloads, chat switches and
		 * a second tab can never auto-speak the same answer again. Manual replay
		 * never claims anything.
		 * @param {unknown} sessionId - Session that owns the answer.
		 * @param {{ retryOnEmpty?: boolean, allowFallback?: boolean }} [options] - retry/fallback policy.
		 * @returns {Promise<void>} completion after the decision.
		 */
		async function claimFinishedAnswer(sessionId, options = {}) {
			try {
				if (!pageIsActive()) return
				const key = sessionKeyOf(sessionId)
				if (key === '') return
				const state = settings.getState()
				if (state.status !== 'ready') return
				if (state.autoSpeak !== true || state.enabled !== true) {
					void discardPending(key)
					return
				}
				let item = null
				let failed = false
				try {
					const result = await postPending('/take', key)
					if (result.ok && result.payload !== null && typeof result.payload === 'object' && result.payload.ok === true) {
						item = result.payload.item ?? null
					} else {
						failed = true
					}
				} catch (error) {
					report(error)
					failed = true
				}
				if (sessionKeyOf(activeSessionId) !== key) return
				if (!pageIsActive()) return
				if (item !== null && typeof item === 'object' && typeof item.text === 'string' && item.text !== '') {
					speakAnswer(typeof item.messageId === 'string' ? item.messageId : `claimed-${Date.now()}`, item.text)
					return
				}
				if (failed && options.allowFallback === true) {
					const closing = lastClosingBySession.get(key)
					if (closing !== undefined) speakAnswer(closing.messageId, closing.text)
					return
				}
				if (options.retryOnEmpty === true) {
					if (claimRetryTimer !== null) clearTimeout(claimRetryTimer)
					claimRetryTimer = setTimeout(() => {
						claimRetryTimer = null
						if (sessionKeyOf(activeSessionId) !== key) return
						void claimFinishedAnswer(sessionId, { allowFallback: true })
					}, 700)
				}
			} catch (error) {
				report(error)
			}
		}

		/**
		 * Claim the stored answer of the Session that is on screen right now.
		 * @param {{ retryOnEmpty?: boolean, allowFallback?: boolean }} [options] - policy.
		 * @returns {void}
		 */
		function claimForActiveSession(options = {}) {
			const key = sessionKeyOf(activeSessionId)
			if (key === '') return
			void claimFinishedAnswer(activeSessionId, options)
		}

		/* ------------------------------------------------------------------ */
		/* Preferences store                                                  */
		/* ------------------------------------------------------------------ */

		/** Idle settings snapshot; the store always returns a stable reference. */
		function emptySettingsState() {
			return {
				status: 'idle',
				autoSpeak: true,
				enabled: true,
				summaryMaxChars: DEFAULT_SUMMARY_MAX_CHARS,
				summaryLimits: DEFAULT_SUMMARY_LIMITS,
				voices: [],
				voice: DEFAULT_VOICE,
				lang: null,
				emotion: DEFAULT_EMOTION,
				speed: DEFAULT_SPEED,
				format: null,
				busy: false,
				error: null,
			};
		}

		/**
		 * Coerce a summary-budget candidate into the supported range.
		 * @param {unknown} value - candidate.
		 * @param {{ min: number, max: number }} limits - current bounds.
		 * @returns {number} integer budget.
		 */
		function clampSummaryChars(value, limits) {
			const number = typeof value === 'number' ? value : Number(value);
			if (!Number.isFinite(number)) return DEFAULT_SUMMARY_MAX_CHARS;
			const min = limits && Number.isFinite(limits.min) ? limits.min : DEFAULT_SUMMARY_LIMITS.min;
			const max = limits && Number.isFinite(limits.max) ? limits.max : DEFAULT_SUMMARY_LIMITS.max;
			return Math.round(Math.min(max, Math.max(min, number)));
		}

		/**
		 * Intonations the Host catalogue lists for one voice.
		 * @param {Array<{ id: string, emotions?: string[] }>} voices - voice catalogue.
		 * @param {string} voiceId - voice id.
		 * @returns {string[]} supported Yandex `emotion` values (empty when none).
		 */
		function emotionsForVoice(voices, voiceId) {
			try {
				const entry = Array.isArray(voices) ? voices.find((voice) => voice && voice.id === voiceId) : undefined;
				return entry && Array.isArray(entry.emotions) ? entry.emotions : [];
			} catch (error) {
				report(error);
				return [];
			}
		}

		/**
		 * Effective intonation shown in the selector. The accepted value may be
		 * empty (the voice default), which is presented as `neutral` when the
		 * voice supports explicit emotions so the dropdown always has a value.
		 * @param {string} emotion - accepted/draft emotion.
		 * @param {string[]} supported - emotions of the current voice.
		 * @returns {string} value to keep in state and show in the selector.
		 */
		function normalizeEmotion(emotion, supported) {
			const list = Array.isArray(supported) ? supported : [];
			if (list.length === 0) return '';
			if (list.includes(emotion)) return emotion;
			if (list.includes('neutral')) return 'neutral';
			return list[0];
		}

		/**
		 * Observable preferences store backed by the Host: `GET /status` seeds the
		 * values lazily (once; failures are retried), `POST /preferences` persists
		 * `autoSpeak` and `summaryMaxChars`. Same store shape as the player
		 * (`subscribe` + `getState`).
		 * @returns {object} settings store and verbs.
		 */
		function createSettingsStore() {
			let state = emptySettingsState();
			const listeners = new Set();
			let statusPromise = null;
			let disposed = false;

			/**
			 * Replace the published state and notify subscribers.
			 * @param {object} patch - changed fields.
			 * @returns {void}
			 */
			function publish(patch) {
				if (disposed) return;
				state = Object.assign({}, state, patch);
				for (const listener of Array.from(listeners)) {
					try {
						listener();
					} catch (error) {
						report(error);
					}
				}
			}

			/**
			 * GET the Host status once; the promise is cached until a failure so a
			 * later refresh can retry a transiently unreachable Host.
			 * @returns {Promise<any>} status payload.
			 */
			function readStatus() {
				if (statusPromise === null) {
					statusPromise = (async () => {
						try {
							const result = await requestJson(`${ROUTE}/status`, {
								method: 'GET',
								headers: { accept: 'application/json' },
								credentials: 'same-origin',
							});
							if (!result.ok || !result.payload || result.payload.ok !== true) {
								throw new Error(`voice-reply status replied ${result.status}`);
							}
							return result.payload;
						} catch (error) {
							statusPromise = null;
							throw error;
						}
					})();
				}
				return statusPromise;
			}

			/**
			 * Load the persisted preferences. Idempotent while a value is known.
			 * @returns {Promise<boolean>} true once the store holds Host values.
			 */
			async function refresh() {
				if (disposed) return false;
				if (state.status === 'ready' && statusPromise !== null) return true;
				try {
					const payload = await readStatus();
					if (disposed) return false;
					const limits =
						payload.summaryLimits !== null && typeof payload.summaryLimits === 'object'
							? payload.summaryLimits
							: DEFAULT_SUMMARY_LIMITS;
					publish({
						status: 'ready',
						autoSpeak: payload.autoSpeak === true,
						enabled: payload.enabled === true,
						summaryMaxChars: clampSummaryChars(payload.summaryMaxChars, limits),
						summaryLimits: {
							min: Number.isFinite(Number(limits.min)) ? Number(limits.min) : DEFAULT_SUMMARY_LIMITS.min,
							max: Number.isFinite(Number(limits.max)) ? Number(limits.max) : DEFAULT_SUMMARY_LIMITS.max,
							step: Number.isFinite(Number(limits.step)) ? Number(limits.step) : DEFAULT_SUMMARY_LIMITS.step,
						},
						voice: typeof payload.voice === 'string' ? payload.voice : DEFAULT_VOICE,
						lang: typeof payload.lang === 'string' ? payload.lang : null,
						emotion: typeof payload.emotion === 'string' ? payload.emotion : DEFAULT_EMOTION,
						voices: Array.isArray(payload.voices)
							? payload.voices
									.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
									.map((entry) => ({
										id: entry.id,
										label: typeof entry.label === 'string' ? entry.label : entry.id,
										lang: typeof entry.lang === 'string' ? entry.lang : '',
										gender: typeof entry.gender === 'string' ? entry.gender : '',
										emotions: Array.isArray(entry.emotions)
											? entry.emotions.filter((item) => typeof item === 'string')
											: [],
									}))
							: [],
						speed: Number.isFinite(Number(payload.speed)) ? Number(payload.speed) : DEFAULT_SPEED,
						format: typeof payload.format === 'string' ? payload.format : null,
						error: null,
					});
					return true;
				} catch (error) {
					if (!disposed) publish({ status: 'error', error: localize('settings.failed') });
					return false;
				}
			}

			/**
			 * Persist one or more UI-owned preferences and mirror the Host's answer.
			 * @param {{ autoSpeak?: boolean, summaryMaxChars?: number, voice?: string, emotion?: string, speed?: number }} patch - changed fields.
			 * @returns {Promise<boolean>} true when the Host accepted the write.
			 */
			async function savePreferences(patch) {
				if (disposed) return false;
				const body = {};
				if (patch !== null && typeof patch === 'object') {
					if (typeof patch.autoSpeak === 'boolean') body.autoSpeak = patch.autoSpeak;
					if (patch.summaryMaxChars !== undefined) body.summaryMaxChars = clampSummaryChars(patch.summaryMaxChars, state.summaryLimits);
					if (typeof patch.voice === 'string' && patch.voice !== '') body.voice = patch.voice;
					if (typeof patch.emotion === 'string') body.emotion = patch.emotion;
					if (patch.speed !== undefined && Number.isFinite(Number(patch.speed))) body.speed = Number(patch.speed);
				}
				if (Object.keys(body).length === 0) return false;
				publish({ busy: true, error: null });
				try {
					const result = await requestJson(`${ROUTE}/preferences`, {
						method: 'POST',
						headers: { 'content-type': 'application/json', accept: 'application/json' },
						credentials: 'same-origin',
						body: JSON.stringify(body),
					});
					const payload = result.payload;
					if (!result.ok || !payload || payload.ok !== true) {
						publish({ busy: false, error: localize('settings.failed') });
						return false;
					}
					const next = {
						status: 'ready',
						autoSpeak: payload.autoSpeak === true,
						enabled: payload.enabled === true,
						busy: false,
						error: null,
					};
					if (Number.isFinite(Number(payload.summaryMaxChars))) {
						next.summaryMaxChars = clampSummaryChars(payload.summaryMaxChars, state.summaryLimits);
					}
					if (typeof payload.voice === 'string' && payload.voice !== '') next.voice = payload.voice;
					if (typeof payload.lang === 'string') next.lang = payload.lang;
					if (typeof payload.emotion === 'string') next.emotion = payload.emotion;
					if (Number.isFinite(Number(payload.speed))) next.speed = Number(payload.speed);
					publish(next);
					return true;
				} catch (error) {
					publish({ busy: false, error: localize('settings.failed') });
					return false;
				}
			}

			/**
			 * Persist the auto-speak preference.
			 * @param {unknown} value - requested state.
			 * @returns {Promise<boolean>} true when the Host accepted the write.
			 */
			async function setAutoSpeak(value) {
				return savePreferences({ autoSpeak: value === true });
			}

			/**
			 * Persist the spoken-summary budget.
			 * @param {unknown} value - requested characters.
			 * @returns {Promise<boolean>} true when the Host accepted the write.
			 */
			async function setSummaryMaxChars(value) {
				return savePreferences({ summaryMaxChars: value });
			}

			return {
				/** @param {() => void} listener - change callback. @returns {() => void} unsubscribe. */
				subscribe(listener) {
					if (typeof listener !== 'function' || disposed) return () => {};
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				/** @returns {object} current immutable snapshot (stable reference). */
				getState() {
					return state;
				},
				/** Alias accepted by generic snapshot stores. @returns {object} current snapshot. */
				getSnapshot() {
					return state;
				},
				refresh,
				setAutoSpeak,
				setSummaryMaxChars,
				savePreferences,
				/** Release listeners; the store becomes inert. */
				dispose() {
					if (disposed) return;
					disposed = true;
					listeners.clear();
					statusPromise = null;
				},
			};
		}

		const settings = createSettingsStore();

		/* ------------------------------------------------------------------ */
		/* Icons                                                              */
		/* ------------------------------------------------------------------ */

		/** 17px speaker glyph (host action-strip size). */
		function SpeakerIcon() {
			return jsx('svg', {
				width: 17,
				height: 17,
				viewBox: '0 0 24 24',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.8,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': 'true',
				focusable: 'false',
				children: [
					jsx('path', { d: 'M11 5 6.5 9H3v6h3.5L11 19z' }, 'speaker'),
					jsx('path', { d: 'M15.5 8.5a5 5 0 0 1 0 7' }, 'wave'),
				],
			});
		}

		/** Stop square shown while this answer is playing. */
		function StopIcon() {
			return jsx('svg', {
				width: 17,
				height: 17,
				viewBox: '0 0 24 24',
				fill: 'none',
				'aria-hidden': 'true',
				focusable: 'false',
				children: jsx('rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2, fill: 'currentColor' }),
			});
		}

		/** Endless spinner without any stylesheet dependency (SMIL rotation). */
		function SpinnerIcon() {
			return jsx('svg', {
				width: 17,
				height: 17,
				viewBox: '0 0 24 24',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 2.4,
				strokeLinecap: 'round',
				'aria-hidden': 'true',
				focusable: 'false',
				children: [
					jsx('circle', { cx: 12, cy: 12, r: 9, strokeOpacity: 0.2 }, 'track'),
					jsx('path', {
						d: 'M21 12a9 9 0 0 0-9-9',
						children: jsx('animateTransform', {
							attributeName: 'transform',
							type: 'rotate',
							from: '0 12 12',
							to: '360 12 12',
							dur: '0.8s',
							repeatCount: 'indefinite',
						}),
					}, 'arc'),
				],
			});
		}

		/** Small play triangle for the ambient chip. */
		function PlayGlyph() {
			return jsx('svg', {
				width: 12,
				height: 12,
				viewBox: '0 0 24 24',
				'aria-hidden': 'true',
				focusable: 'false',
				children: jsx('path', { d: 'M8 5v14l11-7z', fill: 'currentColor' }),
			});
		}

		/** Small stop square for the ambient chip. */
		function StopGlyph() {
			return jsx('svg', {
				width: 12,
				height: 12,
				viewBox: '0 0 24 24',
				'aria-hidden': 'true',
				focusable: 'false',
				children: jsx('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2, fill: 'currentColor' }),
			});
		}

		/** Small warning glyph for the ambient chip. */
		function AlertGlyph() {
			return jsx('svg', {
				width: 13,
				height: 13,
				viewBox: '0 0 24 24',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.8,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': 'true',
				focusable: 'false',
				children: [
					jsx('path', { d: 'M12 3 2.5 20h19z' }, 'shape'),
					jsx('path', { d: 'M12 9v5' }, 'bar'),
					jsx('path', { d: 'M12 17.2v.1' }, 'dot'),
				],
			});
		}

		/** Small close glyph for dismissing the ambient chip. */
		function CloseGlyph() {
			return jsx('svg', {
				width: 13,
				height: 13,
				viewBox: '0 0 24 24',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.9,
				strokeLinecap: 'round',
				'aria-hidden': 'true',
				focusable: 'false',
				children: [
					jsx('path', { d: 'M6 6l12 12' }, 'a'),
					jsx('path', { d: 'M18 6 6 18' }, 'b'),
				],
			});
		}

		/* ------------------------------------------------------------------ */
		/* Styles (inline + host tokens only)                                 */
		/* ------------------------------------------------------------------ */

		/** 28×28 action-strip button, mirroring the host copy button. */
		const ACTION_BUTTON_STYLE = Object.freeze({
			alignItems: 'center',
			background: 'transparent',
			border: 'none',
			borderRadius: 'var(--dsw-radius-sm)',
			boxSizing: 'border-box',
			color: 'var(--dsw-alias-label-tertiary)',
			cursor: 'pointer',
			display: 'inline-flex',
			flex: '0 0 auto',
			height: 28,
			justifyContent: 'center',
			padding: 6,
			width: 28,
		});

		/** Ambient chip under the composer card. */
		const CHIP_STYLE = Object.freeze({
			alignItems: 'center',
			background: 'var(--dsw-alias-interactive-bg-hover)',
			border: '.5px solid var(--dsw-alias-border-l3)',
			borderRadius: 'var(--dsw-radius-sm)',
			boxSizing: 'border-box',
			color: 'var(--dsw-alias-label-secondary)',
			display: 'flex',
			fontSize: 'inherit',
			gap: 8,
			lineHeight: 'inherit',
			margin: '0 0 6px',
			minHeight: 30,
			padding: '5px 8px',
			width: '100%',
		});

		/** Leading glyph slot of the ambient chip. */
		const CHIP_LEAD_STYLE = Object.freeze({
			alignItems: 'center',
			color: 'var(--dsw-alias-label-tertiary)',
			display: 'inline-flex',
			flex: '0 0 auto',
			height: 16,
			justifyContent: 'center',
			width: 16,
		});

		/** Single-line status copy of the ambient chip. */
		const CHIP_TEXT_STYLE = Object.freeze({
			flex: '1 1 auto',
			minWidth: 0,
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			whiteSpace: 'nowrap',
		});

		/** Error copy of the ambient chip; two lines at most. */
		const CHIP_ERROR_TEXT_STYLE = Object.freeze({
			display: '-webkit-box',
			flex: '1 1 auto',
			minWidth: 0,
			overflow: 'hidden',
			whiteSpace: 'pre-line',
			WebkitBoxOrient: 'vertical',
			WebkitLineClamp: 2,
		});

		/** Small icon button inside the ambient chip. */
		const CHIP_BUTTON_STYLE = Object.freeze({
			alignItems: 'center',
			background: 'transparent',
			border: 'none',
			borderRadius: 'var(--dsw-radius-sm)',
			color: 'var(--dsw-alias-label-tertiary)',
			cursor: 'pointer',
			display: 'inline-flex',
			flex: '0 0 auto',
			height: 22,
			justifyContent: 'center',
			padding: 0,
			width: 22,
		});

		/** Settings row shell, mirroring the shipped General preference rows. */
		const ROW_STYLE = Object.freeze({
			alignItems: 'center',
			borderBottom: '.5px solid var(--dsw-alias-border-l2)',
			display: 'flex',
			gap: 24,
			justifyContent: 'space-between',
			padding: '16px 0',
		});

		/** Settings row title. */
		const ROW_TITLE_STYLE = Object.freeze({
			fontSize: 14,
			lineHeight: '20px',
		});

		/** Settings row description. */
		const ROW_DESCRIPTION_STYLE = Object.freeze({
			color: 'var(--dsw-alias-label-secondary)',
			fontSize: 12,
			lineHeight: '18px',
			marginTop: 4,
		});

		/** Settings row notice (saved). */
		const ROW_NOTICE_STYLE = Object.freeze({
			color: 'var(--dsw-alias-label-tertiary)',
			fontSize: 12,
			lineHeight: '18px',
			marginTop: 4,
		});

		/** Settings row notice (failed). */
		const ROW_NOTICE_ERROR_STYLE = Object.freeze({
			color: 'var(--dsw-alias-state-error-primary)',
			fontSize: 12,
			lineHeight: '18px',
			marginTop: 4,
		});

		/** Plugin settings page column. */
		const PLUGIN_PAGE_STYLE = Object.freeze({
			display: 'flex',
			flexDirection: 'column',
			padding: '4px 0 8px',
		});

		/** Intro paragraph of the plugin settings page. */
		const PLUGIN_INTRO_STYLE = Object.freeze({
			color: 'var(--dsw-alias-label-secondary)',
			fontSize: 13,
			lineHeight: '20px',
			margin: '0 0 4px',
		});

		/** One block of the plugin settings page. */
		const PLUGIN_SECTION_STYLE = Object.freeze({
			borderTop: '.5px solid var(--dsw-alias-border-l2)',
			padding: '16px 0',
		});

		/** Two-column control row inside a plugin section. */
		const PLUGIN_ROW_STYLE = Object.freeze({
			alignItems: 'flex-start',
			display: 'flex',
			gap: 24,
			justifyContent: 'space-between',
		});

		/** Title + description column of a plugin row. */
		const PLUGIN_TEXT_STYLE = Object.freeze({
			flex: '1 1 auto',
			minWidth: 0,
		});

		/** Number input of the summary-budget control. */
		const NUMBER_INPUT_STYLE = Object.freeze({
			background: 'transparent',
			border: '.5px solid var(--dsw-alias-border-l3)',
			borderRadius: 'var(--dsw-radius-sm)',
			boxSizing: 'border-box',
			color: 'var(--dsw-alias-label-primary)',
			font: 'inherit',
			fontSize: 14,
			height: 34,
			padding: '0 10px',
			textAlign: 'right',
			width: 96,
		});

		/** Range slider of the summary-budget control. */
		const RANGE_STYLE = Object.freeze({
			accentColor: 'var(--dsw-alias-brand-primary)',
			margin: 0,
			maxWidth: 420,
			width: '100%',
		});

		/** Caption under the slider. */
		const CAPTION_STYLE = Object.freeze({
			color: 'var(--dsw-alias-label-tertiary)',
			fontSize: 12,
			lineHeight: '18px',
		});

		/** Quick-preset button row. */
		const PRESET_ROW_STYLE = Object.freeze({
			alignItems: 'center',
			display: 'flex',
			flexWrap: 'wrap',
			gap: 8,
		});

		/** Small secondary/preset button. */
		const SMALL_BUTTON_STYLE = Object.freeze({
			background: 'transparent',
			border: '.5px solid var(--dsw-alias-border-l3)',
			borderRadius: 'var(--dsw-radius-sm)',
			color: 'var(--dsw-alias-label-secondary)',
			cursor: 'pointer',
			font: 'inherit',
			fontSize: 12,
			height: 28,
			padding: '0 10px',
		});

		/** Primary save button of the plugin settings page. */
		const PRIMARY_BUTTON_STYLE = Object.freeze({
			background: 'var(--dsw-alias-button-primary-fill)',
			border: 'none',
			borderRadius: 'var(--dsw-radius-sm)',
			color: 'var(--dsw-alias-label-primary-foreground)',
			cursor: 'pointer',
			font: 'inherit',
			fontSize: 13,
			height: 32,
			padding: '0 14px',
		});

		/** Footer row with save/reset controls. */
		const BUTTON_ROW_STYLE = Object.freeze({
			alignItems: 'center',
			display: 'flex',
			gap: 12,
			justifyContent: 'flex-start',
			paddingTop: 4,
		});

		/** Read-only configuration facts (voice, speed, format). */
		const FACTS_ROW_STYLE = Object.freeze({
			color: 'var(--dsw-alias-label-tertiary)',
			display: 'flex',
			flexWrap: 'wrap',
			fontSize: 12,
			gap: 18,
			lineHeight: '18px',
		});

		/** Voice dropdown of the plugin settings page. */
		const SELECT_STYLE = Object.freeze({
			background: 'transparent',
			border: '.5px solid var(--dsw-alias-border-l3)',
			borderRadius: 'var(--dsw-radius-sm)',
			boxSizing: 'border-box',
			color: 'var(--dsw-alias-label-primary)',
			font: 'inherit',
			fontSize: 13,
			height: 34,
			maxWidth: 380,
			padding: '0 10px',
			width: '100%',
		});

		/** Numeric speed readout beside the slider. */
		const SPEED_VALUE_STYLE = Object.freeze({
			color: 'var(--dsw-alias-label-secondary)',
			fontSize: 13,
			fontVariantNumeric: 'tabular-nums',
			minWidth: 54,
			textAlign: 'right',
		});

		/** Outline button that plays the voice sample. */
		const PREVIEW_BUTTON_STYLE = Object.freeze({
			alignItems: 'center',
			background: 'transparent',
			border: '.5px solid var(--dsw-alias-border-l3)',
			borderRadius: 'var(--dsw-radius-sm)',
			color: 'var(--dsw-alias-label-secondary)',
			cursor: 'pointer',
			display: 'inline-flex',
			flex: '0 0 auto',
			font: 'inherit',
			fontSize: 12,
			height: 32,
			padding: '0 12px',
		});

		/* ------------------------------------------------------------------ */
		/* Slot 1: per-message replay action                                  */
		/* ------------------------------------------------------------------ */

		/**
		 * Entry wrapper: a throwing slot entry would blank the whole host slot, so
		 * every render body runs behind a catch that degrades to `null`.
		 * @param {object} props - owner message identity + session props + face.
		 * @returns {any} the action button, or null.
		 */
		function VoiceReplyAction(props) {
			try {
				return renderVoiceReplyAction(props);
			} catch (error) {
				report(error);
				return null;
			}
		}

		/**
		 * One finalized assistant answer's speaker/stop control.
		 * @param {object} props - composed slot props.
		 * @returns {any} the action button, or null.
		 */
		function renderVoiceReplyAction(props) {
			const { messageId, useChat, player: playerRef, t } = props || {};
			if (typeof useChat !== 'function') return null;
			if (!playerRef || typeof playerRef.subscribe !== 'function' || typeof playerRef.getState !== 'function') return null;
			const globalState = useSyncExternalStore(playerRef.subscribe, playerRef.getState);
			const text = useChat((snapshot) => resolveAnswerText(snapshot, messageId));
			const [hovered, setHovered] = useState(false);
			if (messageId === null || messageId === undefined) return null;
			if (typeof text !== 'string' || text === '') return null;
			const id = String(messageId);
			const state = globalState || {};
			const mine = state.messageId !== null && state.messageId !== undefined && String(state.messageId) === id;
			const playing = mine && state.status === 'playing';
			const loading = mine && state.status === 'loading';
			const label = loading ? translate(t, 'action.loading') : playing ? translate(t, 'action.stop') : translate(t, 'action.play');
			const style = Object.assign({}, ACTION_BUTTON_STYLE);
			if (loading) {
				style.cursor = 'default';
				style.opacity = 0.4;
			} else if (hovered) {
				style.background = 'var(--dsw-alias-interactive-bg-hover)';
				style.color = 'var(--dsw-alias-label-secondary)';
			}
			if (playing) style.color = 'var(--dsw-alias-label-secondary)';
			return jsx('button', {
				type: 'button',
				title: label,
				'aria-label': label,
				'aria-pressed': playing ? 'true' : 'false',
				'data-voice-reply-action': '',
				'data-voice-reply-state': typeof state.status === 'string' ? state.status : 'idle',
				'data-voice-reply-message-id': id,
				disabled: loading,
				style,
				onMouseEnter: () => setHovered(true),
				onMouseLeave: () => setHovered(false),
				onFocus: () => setHovered(true),
				onBlur: () => setHovered(false),
				onClick: () => {
					try {
						playerRef.toggle({ messageId: id, text });
					} catch (error) {
						report(error);
					}
				},
				children: loading ? jsx(SpinnerIcon, {}) : playing ? jsx(StopIcon, {}) : jsx(SpeakerIcon, {}),
			});
		}

		/* ------------------------------------------------------------------ */
		/* Slot 2: ambient auto-speak chip                                    */
		/* ------------------------------------------------------------------ */

		/**
		 * Entry wrapper: never throw into the composer dock.
		 * @param {object} props - session props + face.
		 * @returns {any} the chip, or null.
		 */
		function VoiceReplyAutoSpeak(props) {
			try {
				return renderVoiceReplyAutoSpeak(props);
			} catch (error) {
				report(error);
				return null;
			}
		}

		/**
		 * Auto-speak driver + ambient playback chip below the composer card.
		 * @param {object} props - composed slot props.
		 * @returns {any} the chip while speech is active/failed, else null.
		 */
		function renderVoiceReplyAutoSpeak(props) {
			const { sessionId, useChat, settings: settingsRef, player: playerRef, t } = props || {};
			if (typeof useChat !== 'function') return null;
			if (!playerRef || typeof playerRef.subscribe !== 'function' || typeof playerRef.getState !== 'function') return null;
			if (!settingsRef || typeof settingsRef.subscribe !== 'function' || typeof settingsRef.getState !== 'function') return null;
			const playerState = useSyncExternalStore(playerRef.subscribe, playerRef.getState);
			const settingsState = useSyncExternalStore(settingsRef.subscribe, settingsRef.getState);
			const endedTurn = useChat((snapshot) => lastEndedTurn(snapshot));
			const closingKey = useChat((snapshot) => closingAnswerKey(snapshot, endedTurn));
			const seenTurnRef = useRef(endedTurn);
			const sessionRef = useRef(sessionId);
			const settingsStatus = settingsState !== null && settingsState !== undefined && typeof settingsState.status === 'string' ? settingsState.status : 'idle';
			const autoSpeak =
				settingsStatus === 'ready' &&
				settingsState.autoSpeak === true &&
				settingsState.enabled === true;
			// Preferences are loaded lazily on mount; a transient Host failure is
			// retried while the store is not yet ready.
			useEffect(() => {
				try {
					if (settingsStatus === 'ready') return;
					const pending = settingsRef.refresh();
					if (pending && typeof pending.catch === 'function') pending.catch(report);
				} catch (error) {
					report(error);
				}
			}, [settingsRef, settingsStatus]);
			// Track which Session the Conversation shows: the Host keeps one claimed
			// answer per chat, so opening that chat speaks it exactly once.
			useEffect(() => {
				try {
					activeSessionId = sessionKeyOf(sessionId);
					claimForActiveSession({ allowFallback: true, retryOnEmpty: true });
				} catch (error) {
					report(error);
				}
				return () => {
					try {
						if (activeSessionId === sessionKeyOf(sessionId)) activeSessionId = null;
					} catch (error) {
						report(error);
					}
				};
			}, [sessionId]);
			// Preferences arrive asynchronously; retry the claim once they are known.
			useEffect(() => {
				try {
					if (settingsStatus !== 'ready') return;
					claimForActiveSession({ allowFallback: false, retryOnEmpty: true });
				} catch (error) {
					report(error);
				}
			}, [settingsStatus]);
			useEffect(() => {
				try {
					if (sessionRef.current !== sessionId) {
						sessionRef.current = sessionId;
						seenTurnRef.current = endedTurn;
						return;
					}
					if (!Number.isFinite(endedTurn) || endedTurn <= seenTurnRef.current) {
						if (Number.isFinite(endedTurn)) seenTurnRef.current = endedTurn;
						return;
					}
					if (!autoSpeak) {
						seenTurnRef.current = endedTurn;
						return;
					}
					const closing = splitClosingAnswer(closingKey);
					// Wait for the closing answer of this Turn before consuming it, so a
					// snapshot that lands the end boundary before the node still speaks.
					if (closing === null) return;
					seenTurnRef.current = endedTurn;
					const key = sessionKeyOf(sessionId);
					rememberClosing(key, closing.messageId, closing.text);
					void claimFinishedAnswer(sessionId, { retryOnEmpty: true, allowFallback: true });
				} catch (error) {
					report(error);
				}
			}, [sessionId, endedTurn, closingKey, autoSpeak]);
			const state = playerState || {};
			const status = typeof state.status === 'string' ? state.status : 'idle';
			if (status !== 'loading' && status !== 'playing' && status !== 'error' && status !== 'blocked') return null;
			const failed = status === 'error' || status === 'blocked';
			const statusText = status === 'playing' ? translate(t, 'status.playing') : translate(t, 'status.loading');
			const errorText = typeof state.error === 'string' && state.error !== '' ? state.error : translate(t, 'status.error');
			const hintText = typeof state.hint === 'string' ? state.hint : '';
			const actionLabel = failed ? translate(t, 'status.dismiss') : translate(t, 'action.stop');
			const children = [
				jsx('span', {
					key: 'lead',
					style: CHIP_LEAD_STYLE,
					'aria-hidden': 'true',
					children: status === 'loading' ? jsx(SpinnerIcon, {}) : failed ? jsx(AlertGlyph, {}) : jsx(PlayGlyph, {}),
				}),
				jsx('span', {
					key: 'text',
					style: failed ? CHIP_ERROR_TEXT_STYLE : CHIP_TEXT_STYLE,
					children: failed ? (hintText !== '' ? `${errorText}\n${hintText}` : errorText) : statusText,
				}),
				jsx('button', {
					key: 'action',
					type: 'button',
					title: actionLabel,
					'aria-label': actionLabel,
					style: CHIP_BUTTON_STYLE,
					onClick: () => {
						try {
							playerRef.stop();
						} catch (error) {
							report(error);
						}
					},
					children: failed ? jsx(CloseGlyph, {}) : jsx(StopGlyph, {}),
				}),
			];
			if (typeof state.chunkCount === 'number' && state.chunkCount > 1 && (status === 'playing' || status === 'loading')) {
				children.push(
					jsx('span', {
						key: 'progress',
						style: { color: 'var(--dsw-alias-label-tertiary)', flex: '0 0 auto' },
						'aria-hidden': 'true',
						children: `${Math.min((state.chunkIndex || 0) + 1, state.chunkCount)}/${state.chunkCount}`,
					}),
				);
			}
			return jsx('div', {
				'data-voice-reply-chip': '',
				'data-voice-reply-state': status,
				role: 'status',
				style: CHIP_STYLE,
				children,
			});
		}

		/* ------------------------------------------------------------------ */
		/* Slot 3: Settings → General row                                     */
		/* ------------------------------------------------------------------ */

		/**
		 * Entry wrapper: a broken settings row must not blank the General page.
		 * @param {object} props - settings hooks + writer + copy.
		 * @returns {any} the preference row, or null.
		 */
		function VoiceReplySettingsRow(props) {
			try {
				return renderVoiceReplySettingsRow(props);
			} catch (error) {
				report(error);
				return null;
			}
		}

		/**
		 * "Read answers aloud" preference row bound to the Host `autoSpeak`
		 * preference through the shared settings store.
		 * @param {object} props - composed slot props.
		 * @returns {any} the row, or null.
		 */
		function renderVoiceReplySettingsRow(props) {
			const { settings: settingsRef, t } = props || {};
			if (!settingsRef || typeof settingsRef.subscribe !== 'function' || typeof settingsRef.getState !== 'function') return null;
			const settingsState = useSyncExternalStore(settingsRef.subscribe, settingsRef.getState);
			const status = settingsState !== null && settingsState !== undefined && typeof settingsState.status === 'string' ? settingsState.status : 'idle';
			const ready = status === 'ready';
			const busy = settingsState !== null && settingsState !== undefined && settingsState.busy === true;
			const checked = ready && settingsState.autoSpeak === true;
			const [notice, setNotice] = useState(null);
			const mountedRef = useRef(true);
			useEffect(() => {
				mountedRef.current = true;
				return () => {
					mountedRef.current = false;
				};
			}, []);
			useEffect(() => {
				if (ready) return undefined;
				try {
					const pending = settingsRef.refresh();
					if (pending && typeof pending.catch === 'function') pending.catch(report);
				} catch (error) {
					report(error);
				}
				return undefined;
			}, [settingsRef, status]);
			useEffect(() => {
				if (notice !== 'saved') return undefined;
				const timer = setTimeout(() => {
					if (mountedRef.current) setNotice(null);
				}, 2400);
				return () => clearTimeout(timer);
			}, [notice]);
			const onToggle = useCallback(() => {
				if (!ready || busy) return;
				setNotice(null);
				let pending = null;
				try {
					pending = settingsRef.setAutoSpeak(!checked);
				} catch (error) {
					report(error);
					pending = null;
				}
				Promise.resolve(pending)
					.then((accepted) => {
						if (mountedRef.current) setNotice(accepted === true ? 'saved' : 'failed');
					})
					.catch((error) => {
						report(error);
						if (mountedRef.current) setNotice('failed');
					});
			}, [busy, checked, ready, settingsRef]);
			const title = translate(t, 'autoSpeak.title');
			const description = translate(t, 'autoSpeak.description');
			const disabled = !ready || busy;
			const trackStyle = {
				alignItems: 'center',
				background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l3)',
				border: 'none',
				borderRadius: 999,
				boxSizing: 'border-box',
				cursor: disabled ? 'default' : 'pointer',
				display: 'inline-flex',
				flex: '0 0 auto',
				height: 24,
				opacity: disabled ? 0.5 : 1,
				padding: 2,
				position: 'relative',
				transition: 'background-color .15s',
				width: 40,
			};
			const knobStyle = {
				background: 'var(--dsw-alias-switch-thumb)',
				borderRadius: '50%',
				boxShadow: '0 1px 2px rgba(0, 0, 0, 0.24)',
				display: 'block',
				height: 20,
				transform: checked ? 'translateX(16px)' : 'translateX(0)',
				transition: 'transform .15s',
				width: 20,
			};
			const noticeStyle = notice === 'failed' ? ROW_NOTICE_ERROR_STYLE : ROW_NOTICE_STYLE;
			return jsxs('div', {
				'data-voice-reply-settings': '',
				style: ROW_STYLE,
				children: [
					jsxs('div', {
						style: { flex: '1 1 auto', minWidth: 0 },
						children: [
							jsx('div', { style: ROW_TITLE_STYLE, children: title }),
							jsx('div', { style: ROW_DESCRIPTION_STYLE, children: description }),
							notice !== null
								? jsx('div', {
										role: 'status',
										style: noticeStyle,
										children: translate(t, notice === 'saved' ? 'settings.saved' : 'settings.failed'),
								  })
								: null,
						],
					}),
					jsx('button', {
						type: 'button',
						role: 'switch',
						'aria-checked': checked ? 'true' : 'false',
						'aria-label': title,
						title,
						disabled,
						style: trackStyle,
						onClick: onToggle,
						children: jsx('span', { 'aria-hidden': 'true', style: knobStyle }),
					}),
				],
			});
		}

		/* ------------------------------------------------------------------ */
		/* Slot 4: Plugins → this bundle → row → Configure (plugin settings)  */
		/* ------------------------------------------------------------------ */

		/**
		 * Entry wrapper for the plugin's own settings page: a broken page must not
		 * blank the Plugins detail view.
		 * @param {object} props - owner `view`/`form` + injected face + copy.
		 * @returns {any} one-line summary or the settings form, or null.
		 */
		function VoiceReplyPluginSettings(props) {
			try {
				return props && props.view === 'summary' ? renderVoiceReplyPluginSettingsSummary(props) : renderVoiceReplyPluginSettingsPage(props);
			} catch (error) {
				report(error);
				return null;
			}
		}

		/**
		 * One-line description used by the Plugins page when the row has no
		 * metadata description of its own.
		 * @param {object} props - injected settings store + copy.
		 * @returns {string} short localized summary.
		 */
		function renderVoiceReplyPluginSettingsSummary(props) {
			const { settings: settingsRef, t } = props || {};
			let limit = DEFAULT_SUMMARY_MAX_CHARS;
			try {
				const state = settingsRef && typeof settingsRef.getState === 'function' ? settingsRef.getState() : null;
				if (state !== null && state !== undefined && Number.isFinite(state.summaryMaxChars)) limit = state.summaryMaxChars;
			} catch (error) {
				report(error);
			}
			return `${translate(t, 'pluginSettings.summary')} — ${limit} ${translate(t, 'pluginSettings.chars')}`;
		}

		/**
		 * The plugin's own settings page (Plugins → Голосовые ответы → Настроить).
		 * Owns its draft and save control, as `plugins.row.config` `view: 'page'`
		 * requires; all writes go through the shared preferences store.
		 * @param {object} props - owner `view`/`form` + injected face + copy.
		 * @returns {any} the settings form, or null while the store is unusable.
		 */
		function renderVoiceReplyPluginSettingsPage(props) {
			const { settings: settingsRef, player: playerRef, t } = props || {};
			if (!settingsRef || typeof settingsRef.subscribe !== 'function' || typeof settingsRef.getState !== 'function') return null;
			if (!playerRef || typeof playerRef.subscribe !== 'function' || typeof playerRef.getState !== 'function') return null;
			const settingsState = useSyncExternalStore(settingsRef.subscribe, settingsRef.getState);
			const playerState = useSyncExternalStore(playerRef.subscribe, playerRef.getState);
			const state = settingsState || {};
			const status = typeof state.status === 'string' ? state.status : 'idle';
			const ready = status === 'ready';
			const busy = state.busy === true;
			const limits =
				state.summaryLimits !== null && typeof state.summaryLimits === 'object'
					? state.summaryLimits
					: DEFAULT_SUMMARY_LIMITS;
			const min = Number.isFinite(Number(limits.min)) ? Number(limits.min) : DEFAULT_SUMMARY_LIMITS.min;
			const max = Number.isFinite(Number(limits.max)) ? Number(limits.max) : DEFAULT_SUMMARY_LIMITS.max;
			const step = Number.isFinite(Number(limits.step)) ? Number(limits.step) : DEFAULT_SUMMARY_LIMITS.step;
			const accepted = Number.isFinite(state.summaryMaxChars) ? state.summaryMaxChars : DEFAULT_SUMMARY_MAX_CHARS;
			const acceptedVoice = typeof state.voice === 'string' && state.voice !== '' ? state.voice : DEFAULT_VOICE;
			const acceptedEmotion = typeof state.emotion === 'string' ? state.emotion : DEFAULT_EMOTION;
			const acceptedSpeed = Number.isFinite(state.speed) ? state.speed : DEFAULT_SPEED;
			const voices =
				Array.isArray(state.voices) && state.voices.length > 0
					? state.voices
					: [{ id: acceptedVoice, label: acceptedVoice, emotions: [] }];
			const autoSpeak = ready && state.autoSpeak === true;
			const [draft, setDraft] = useState(String(accepted));
			const [draftVoice, setDraftVoice] = useState(acceptedVoice);
			const [draftEmotion, setDraftEmotion] = useState(() =>
				normalizeEmotion(acceptedEmotion, emotionsForVoice(voices, acceptedVoice)),
			);
			const [draftSpeed, setDraftSpeed] = useState(acceptedSpeed);
			const [notice, setNotice] = useState(null);
			const mountedRef = useRef(true);
			const acceptedRef = useRef(accepted);
			const acceptedVoiceRef = useRef(acceptedVoice);
			const acceptedEmotionRef = useRef(normalizeEmotion(acceptedEmotion, emotionsForVoice(voices, acceptedVoice)));
			const acceptedSpeedRef = useRef(acceptedSpeed);

			useEffect(() => {
				mountedRef.current = true;
				return () => {
					mountedRef.current = false;
				};
			}, []);
			useEffect(() => {
				if (ready) return undefined;
				try {
					const pending = settingsRef.refresh();
					if (pending && typeof pending.catch === 'function') pending.catch(report);
				} catch (error) {
					report(error);
				}
				return undefined;
			}, [ready, settingsRef]);
			useEffect(() => {
				if (acceptedRef.current === accepted) return;
				acceptedRef.current = accepted;
				setDraft(String(accepted));
			}, [accepted]);
			useEffect(() => {
				if (acceptedVoiceRef.current === acceptedVoice) return;
				acceptedVoiceRef.current = acceptedVoice;
				setDraftVoice(acceptedVoice);
			}, [acceptedVoice]);
			useEffect(() => {
				const nextEmotion = normalizeEmotion(acceptedEmotion, emotionsForVoice(voices, acceptedVoice));
				if (acceptedEmotionRef.current === nextEmotion) return;
				acceptedEmotionRef.current = nextEmotion;
				setDraftEmotion(nextEmotion);
			}, [acceptedEmotion, acceptedVoice, voices]);
			useEffect(() => {
				if (acceptedSpeedRef.current === acceptedSpeed) return;
				acceptedSpeedRef.current = acceptedSpeed;
				setDraftSpeed(acceptedSpeed);
			}, [acceptedSpeed]);
			useEffect(() => {
				if (notice !== 'saved') return undefined;
				const timer = setTimeout(() => {
					if (mountedRef.current) setNotice(null);
				}, 2400);
				return () => clearTimeout(timer);
			}, [notice]);

			const draftText = String(draft);
			const draftNumber = Number(draftText);
			const valid = draftText !== '' && Number.isFinite(draftNumber) && draftNumber >= min && draftNumber <= max;
			const effective = valid ? Math.round(draftNumber) : accepted;
			const acceptedEmotionValue = normalizeEmotion(acceptedEmotion, emotionsForVoice(voices, acceptedVoice));
			const draftEmotionSupported = emotionsForVoice(voices, draftVoice);
			const draftEmotionValue = normalizeEmotion(draftEmotion, draftEmotionSupported);
			const voiceDirty = ready && draftVoice !== acceptedVoice;
			const emotionDirty = ready && draftEmotionValue !== acceptedEmotionValue;
			const speedDirty = ready && Math.abs(draftSpeed - acceptedSpeed) > 1e-9;
			const dirty = ready && valid && (effective !== accepted || voiceDirty || emotionDirty || speedDirty);
			const seconds = Math.max(3, Math.round(effective / SPEECH_CHARS_PER_SECOND));
			const disabled = !ready || busy;
			const previewSpeed = Math.round(draftSpeed * 100) / 100;
			const previewMessageId = `${PREVIEW_MESSAGE_PREFIX}${draftVoice}:${draftEmotionValue}:${previewSpeed}`;
			const previewStatus =
				playerState !== null && playerState !== undefined && playerState.messageId === previewMessageId && typeof playerState.status === 'string'
					? playerState.status
					: 'idle';
			const previewing = previewStatus === 'loading' || previewStatus === 'playing';
			const previewFailed = previewStatus === 'error';
			const previewLabel = previewStatus === 'loading'
				? translate(t, 'pluginSettings.previewLoading')
				: previewing
					? translate(t, 'pluginSettings.previewStop')
					: translate(t, 'pluginSettings.preview');
			const previewErrorText =
				previewFailed && playerState && typeof playerState.error === 'string' && playerState.error !== ''
					? playerState.error
					: translate(t, 'pluginSettings.previewError');

			/**
			 * Store one draft change and clear the previous outcome notice.
			 * @param {string} value - raw input value.
			 * @returns {void}
			 */
			const changeDraft = useCallback((value) => {
				setNotice(null);
				setDraft(String(value));
			}, []);
			const onInputChange = useCallback(
				(event) => {
					changeDraft(event && event.target ? event.target.value : '');
				},
				[changeDraft],
			);
			const onRangeChange = useCallback(
				(event) => {
					changeDraft(event && event.target ? event.target.value : '');
				},
				[changeDraft],
			);
			const onPreset = useCallback(
				(value) => {
					changeDraft(String(value));
				},
				[changeDraft],
			);
			const onVoiceChange = useCallback(
				(event) => {
					setNotice(null);
					const value = event && event.target ? String(event.target.value) : '';
					if (value === '') return;
					setDraftVoice(value);
					// An intonation is voice-specific: keep the draft only when the
					// newly selected voice supports it, otherwise fall back to its default.
					setDraftEmotion((current) => normalizeEmotion(current, emotionsForVoice(voices, value)));
				},
				[voices],
			);
			const onEmotionChange = useCallback(
				(event) => {
					setNotice(null);
					const value = event && event.target ? String(event.target.value) : '';
					setDraftEmotion(value);
				},
				[],
			);
			const onSpeedChange = useCallback(
				(event) => {
					setNotice(null);
					const value = Number(event && event.target ? event.target.value : NaN);
					if (Number.isFinite(value)) setDraftSpeed(Math.round(value * 100) / 100);
				},
				[],
			);
			const onSpeedPreset = useCallback((value) => {
				setNotice(null);
				setDraftSpeed(Math.round(Number(value) * 100) / 100);
			}, []);
			const onPreview = useCallback(() => {
				if (disabled) return;
				let pending = null;
				try {
					pending = playerRef.preview({ voice: draftVoice, emotion: draftEmotionValue, speed: previewSpeed });
				} catch (error) {
					report(error);
					pending = null;
				}
				if (pending && typeof pending.catch === 'function') pending.catch(report);
			}, [disabled, draftEmotionValue, draftVoice, playerRef, previewSpeed]);
			const onReset = useCallback(() => {
				setNotice(null);
				setDraft(String(accepted));
				setDraftVoice(acceptedVoice);
				setDraftEmotion(acceptedEmotionValue);
				setDraftSpeed(acceptedSpeed);
			}, [accepted, acceptedEmotionValue, acceptedSpeed, acceptedVoice]);
			const onSave = useCallback(() => {
				if (!ready || busy || !valid) return;
				const patch = {};
				if (effective !== accepted) patch.summaryMaxChars = effective;
				if (draftVoice !== acceptedVoice) patch.voice = draftVoice;
				if (draftEmotionValue !== acceptedEmotionValue) patch.emotion = draftEmotionValue;
				if (Math.abs(draftSpeed - acceptedSpeed) > 1e-9) patch.speed = previewSpeed;
				if (Object.keys(patch).length === 0) {
					setDraft(String(accepted));
					setDraftVoice(acceptedVoice);
					setDraftEmotion(acceptedEmotionValue);
					setDraftSpeed(acceptedSpeed);
					return;
				}
				setNotice(null);
				let pending = null;
				try {
					pending = settingsRef.savePreferences(patch);
				} catch (error) {
					report(error);
					pending = null;
				}
				Promise.resolve(pending)
					.then((ok) => {
						if (mountedRef.current) setNotice(ok === true ? 'saved' : 'failed');
					})
					.catch((error) => {
						report(error);
						if (mountedRef.current) setNotice('failed');
					});
			}, [accepted, acceptedEmotionValue, acceptedSpeed, acceptedVoice, busy, draftEmotionValue, draftSpeed, draftVoice, effective, previewSpeed, ready, settingsRef, valid]);
			const onToggleAutoSpeak = useCallback(() => {
				if (!ready || busy) return;
				setNotice(null);
				let pending = null;
				try {
					pending = settingsRef.setAutoSpeak(!autoSpeak);
				} catch (error) {
					report(error);
					pending = null;
				}
				Promise.resolve(pending)
					.then((ok) => {
						if (mountedRef.current) setNotice(ok === true ? 'saved' : 'failed');
					})
					.catch((error) => {
						report(error);
						if (mountedRef.current) setNotice('failed');
					});
			}, [autoSpeak, busy, ready, settingsRef]);

			const trackStyle = {
				alignItems: 'center',
				background: autoSpeak ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l3)',
				border: 'none',
				borderRadius: 999,
				boxSizing: 'border-box',
				cursor: disabled ? 'default' : 'pointer',
				display: 'inline-flex',
				flex: '0 0 auto',
				height: 24,
				opacity: disabled ? 0.5 : 1,
				padding: 2,
				position: 'relative',
				transition: 'background-color .15s',
				width: 40,
			};
			const knobStyle = {
				background: 'var(--dsw-alias-switch-thumb)',
				borderRadius: '50%',
				boxShadow: '0 1px 2px rgba(0, 0, 0, 0.24)',
				display: 'block',
				height: 20,
				transform: autoSpeak ? 'translateX(16px)' : 'translateX(0)',
				transition: 'transform .15s',
				width: 20,
			};
			const noticeStyle = notice === 'failed' ? ROW_NOTICE_ERROR_STYLE : ROW_NOTICE_STYLE;
			const inputStyle = Object.assign({}, NUMBER_INPUT_STYLE, disabled ? { opacity: 0.5 } : {});
			const selectStyle = Object.assign({}, SELECT_STYLE, disabled ? { opacity: 0.5 } : {});
			const previewStyle = Object.assign({}, PREVIEW_BUTTON_STYLE, disabled ? { cursor: 'default', opacity: 0.5 } : {});
			const saveStyle = Object.assign({}, PRIMARY_BUTTON_STYLE, !dirty || busy ? { cursor: 'default', opacity: 0.5 } : {});
			const resetStyle = Object.assign({}, SMALL_BUTTON_STYLE, !ready || busy ? { cursor: 'default', opacity: 0.5 } : {});

			return jsxs('div', {
				'data-voice-reply-plugin-settings': '',
				'data-voice-reply-summary-value': String(effective),
				style: PLUGIN_PAGE_STYLE,
				children: [
					jsx('p', { style: PLUGIN_INTRO_STYLE, children: translate(t, 'pluginSettings.description') }),
					jsxs('section', {
						style: PLUGIN_SECTION_STYLE,
						children: [
							jsxs('div', {
								style: PLUGIN_ROW_STYLE,
								children: [
									jsxs('div', {
										style: PLUGIN_TEXT_STYLE,
										children: [
											jsx('div', { style: ROW_TITLE_STYLE, children: translate(t, 'pluginSettings.maxChars.title') }),
											jsx('div', { style: ROW_DESCRIPTION_STYLE, children: translate(t, 'pluginSettings.maxChars.description') }),
										],
									}),
									jsxs('div', {
										style: { alignItems: 'center', display: 'flex', flex: '0 0 auto', gap: 8 },
										children: [
											jsx('input', {
												type: 'number',
												min,
												max,
												step,
												inputMode: 'numeric',
												'data-voice-reply-summary-input': '',
												'aria-label': translate(t, 'pluginSettings.maxChars.title'),
												value: draftText,
												disabled,
												style: inputStyle,
												onChange: onInputChange,
											}),
											jsx('span', { style: CAPTION_STYLE, children: translate(t, 'pluginSettings.chars') }),
										],
									}),
								],
							}),
							jsxs('div', {
								style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 },
								children: [
									jsx('input', {
										type: 'range',
										min,
										max,
										step,
										'data-voice-reply-summary-range': '',
										'aria-label': translate(t, 'pluginSettings.maxChars.title'),
										value: effective,
										disabled,
										style: RANGE_STYLE,
										onChange: onRangeChange,
									}),
									jsx('div', {
										'data-voice-reply-summary-seconds': String(seconds),
										style: CAPTION_STYLE,
										children: `${translate(t, 'pluginSettings.estimatePrefix')} ${seconds} ${translate(t, 'pluginSettings.estimateSuffix')}`,
									}),
									valid
										? jsx('div', { style: CAPTION_STYLE, children: translate(t, 'pluginSettings.range') })
										: jsx('div', { role: 'status', style: ROW_NOTICE_ERROR_STYLE, children: translate(t, 'pluginSettings.range') }),
									jsxs('div', {
										style: PRESET_ROW_STYLE,
										children: [
											jsx('span', { style: CAPTION_STYLE, children: translate(t, 'pluginSettings.presets') }),
											jsx('button', {
												type: 'button',
												style: SMALL_BUTTON_STYLE,
												disabled,
												onClick: () => onPreset(250),
												children: translate(t, 'pluginSettings.presetShort'),
											}),
											jsx('button', {
												type: 'button',
												style: SMALL_BUTTON_STYLE,
												disabled,
												onClick: () => onPreset(500),
												children: translate(t, 'pluginSettings.presetDefault'),
											}),
											jsx('button', {
												type: 'button',
												style: SMALL_BUTTON_STYLE,
												disabled,
												onClick: () => onPreset(1000),
												children: translate(t, 'pluginSettings.presetDetailed'),
											}),
										],
									}),
								],
							}),
						],
					}),
					jsx('section', {
						style: PLUGIN_SECTION_STYLE,
						children: jsxs('div', {
							style: PLUGIN_ROW_STYLE,
							children: [
								jsxs('div', {
									style: PLUGIN_TEXT_STYLE,
									children: [
										jsx('div', { style: ROW_TITLE_STYLE, children: translate(t, 'pluginSettings.autoSpeak.title') }),
										jsx('div', { style: ROW_DESCRIPTION_STYLE, children: translate(t, 'pluginSettings.autoSpeak.description') }),
									],
								}),
								jsx('button', {
									type: 'button',
									role: 'switch',
									'data-voice-reply-plugin-autospeak': '',
									'aria-checked': autoSpeak ? 'true' : 'false',
									'aria-label': translate(t, 'pluginSettings.autoSpeak.title'),
									disabled,
									style: trackStyle,
									onClick: onToggleAutoSpeak,
									children: jsx('span', { 'aria-hidden': 'true', style: knobStyle }),
								}),
							],
						}),
					}),
					jsx('section', {
						style: PLUGIN_SECTION_STYLE,
						children: [
							jsxs('div', {
								style: PLUGIN_ROW_STYLE,
								children: [
									jsxs('div', {
										style: PLUGIN_TEXT_STYLE,
										children: [
											jsx('div', { style: ROW_TITLE_STYLE, children: translate(t, 'pluginSettings.voice') }),
											jsx('div', { style: ROW_DESCRIPTION_STYLE, children: translate(t, 'pluginSettings.voice.description') }),
										],
									}),
									jsx('button', {
										type: 'button',
										'data-voice-reply-preview': '',
										disabled,
										style: previewStyle,
										onClick: onPreview,
										children: previewLabel,
									}),
								],
							}),
							jsxs('div', {
								style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 },
								children: [
									jsx('select', {
										'data-voice-reply-voice-select': '',
										'aria-label': translate(t, 'pluginSettings.voice'),
										value: draftVoice,
										disabled,
										style: selectStyle,
										onChange: onVoiceChange,
										children: voices.map((voice) => jsx('option', { value: voice.id, children: voice.label })),
									}),
									previewFailed
										? jsx('div', { role: 'status', style: ROW_NOTICE_ERROR_STYLE, children: previewErrorText })
										: null,
								],
							}),
						],
					}),
					jsx('section', {
						style: PLUGIN_SECTION_STYLE,
						children: [
							jsxs('div', {
								style: PLUGIN_ROW_STYLE,
								children: [
									jsxs('div', {
										style: PLUGIN_TEXT_STYLE,
										children: [
											jsx('div', { style: ROW_TITLE_STYLE, children: translate(t, 'pluginSettings.emotion') }),
											jsx('div', { style: ROW_DESCRIPTION_STYLE, children: translate(t, 'pluginSettings.emotion.description') }),
										],
									}),
									jsx('button', {
										type: 'button',
										'data-voice-reply-preview-emotion': '',
										disabled,
										style: previewStyle,
										onClick: onPreview,
										children: previewLabel,
									}),
								],
							}),
							jsxs('div', {
								style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 },
								children: [
									jsx('select', {
										'data-voice-reply-emotion-select': '',
										'aria-label': translate(t, 'pluginSettings.emotion'),
										value: draftEmotionValue,
										disabled: disabled || draftEmotionSupported.length === 0,
										style: selectStyle,
										onChange: onEmotionChange,
										children:
											draftEmotionSupported.length === 0
												? [jsx('option', { value: '', children: translate(t, 'pluginSettings.emotion.default') })]
												: draftEmotionSupported.map((emotion) =>
														jsx('option', {
															value: emotion,
															children: translate(t, `pluginSettings.emotionValue.${emotion}`),
														}),
													),
									}),
									draftEmotionSupported.length === 0
										? jsx('div', { style: CAPTION_STYLE, children: translate(t, 'pluginSettings.emotion.unsupported') })
										: null,
								],
							}),
						],
					}),
					jsx('section', {
						style: PLUGIN_SECTION_STYLE,
						children: [
							jsxs('div', {
								style: PLUGIN_ROW_STYLE,
								children: [
									jsxs('div', {
										style: PLUGIN_TEXT_STYLE,
										children: [
											jsx('div', { style: ROW_TITLE_STYLE, children: translate(t, 'pluginSettings.speed') }),
											jsx('div', { style: ROW_DESCRIPTION_STYLE, children: translate(t, 'pluginSettings.speed.description') }),
										],
									}),
									jsxs('div', {
										style: { alignItems: 'center', display: 'flex', flex: '0 0 auto', gap: 10 },
										children: [
											jsx('span', {
												'data-voice-reply-speed-value': '',
												style: SPEED_VALUE_STYLE,
												children: `${previewSpeed.toFixed(2)}×`,
											}),
											jsx('button', {
												type: 'button',
												'data-voice-reply-preview-speed': '',
												disabled,
												style: previewStyle,
												onClick: onPreview,
												children: previewLabel,
											}),
										],
									}),
								],
							}),
							jsxs('div', {
								style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 },
								children: [
									jsx('input', {
										type: 'range',
										min: SPEED_LIMITS.min,
										max: SPEED_LIMITS.max,
										step: SPEED_LIMITS.step,
										'data-voice-reply-speed-range': '',
										'aria-label': translate(t, 'pluginSettings.speed'),
										value: draftSpeed,
										disabled,
										style: RANGE_STYLE,
										onChange: onSpeedChange,
									}),
									jsxs('div', {
										style: PRESET_ROW_STYLE,
										children: [
											jsx('span', { style: CAPTION_STYLE, children: translate(t, 'pluginSettings.presets') }),
											...[0.9, 1.1, 1.32, 1.5].map((value) =>
												jsx('button', {
													type: 'button',
													style: SMALL_BUTTON_STYLE,
													disabled,
													onClick: () => onSpeedPreset(value),
													children: `${value.toFixed(2)}×`,
												}),
											),
										],
									}),
								],
							}),
						],
					}),
					jsxs('div', {
						style: BUTTON_ROW_STYLE,
						children: [
							jsx('button', {
								type: 'button',
								'data-voice-reply-summary-save': '',
								disabled: !dirty || busy,
								style: saveStyle,
								onClick: onSave,
								children: translate(t, 'pluginSettings.save'),
							}),
							jsx('button', {
								type: 'button',
								'data-voice-reply-summary-reset': '',
								disabled,
								style: resetStyle,
								onClick: onReset,
								children: translate(t, 'pluginSettings.reset'),
							}),
							notice !== null
								? jsx('div', {
										role: 'status',
										style: noticeStyle,
										children: translate(t, notice === 'saved' ? 'pluginSettings.saved' : 'settings.failed'),
								  })
								: dirty
									? jsx('div', { style: CAPTION_STYLE, children: translate(t, 'pluginSettings.unsaved') })
									: null,
						],
					}),
				],
			});
		}

		/* ------------------------------------------------------------------ */
		/* Plugin wiring                                                      */
		/* ------------------------------------------------------------------ */

		/** Services used by the browser companion (preferences ride the Host route). */
		const inject = ['slots', 'locale'];

		/** Slot props supplied by this plugin: playback and persisted preferences. */
		const face = { player, settings };

		/**
		 * Register the locale dictionary and the three slot contributions, warm the
		 * preferences lazily, and release the stores on unload.
		 * @param {any} ctx - browser plugin context.
		 * @returns {void}
		 */
		function apply(ctx) {
			try {
				try {
					if (ctx.locale && typeof ctx.locale.register === 'function') {
						ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, ru, zh }), 'voice-reply: dictionaries');
					}
				} catch (error) {
					report(error);
				}
				try {
					if (ctx.locale && typeof ctx.locale.bind === 'function') translateFn = ctx.locale.bind(LOCALE_NS);
				} catch (error) {
					report(error);
				}
				try {
					if (ctx.slots && typeof ctx.slots.inject === 'function') {
						ctx.slots.inject('conversation.chat.assistant-actions', () =>
							ctx.slots.register(
								{
									name: 'conversation.chat.assistant-actions',
									id: 'voice-reply',
									order: 40,
									locale: LOCALE_NS,
									inject: () => face,
								},
								VoiceReplyAction,
							),
						);
					}
				} catch (error) {
					report(error);
				}
				try {
					if (ctx.slots && typeof ctx.slots.inject === 'function') {
						ctx.slots.inject('conversation.composer.dock', () =>
							ctx.slots.register(
								{
									name: 'conversation.composer.dock',
									id: 'voice-reply-autospeak',
									order: 30,
									locale: LOCALE_NS,
									inject: () => face,
								},
								VoiceReplyAutoSpeak,
							),
						);
					}
				} catch (error) {
					report(error);
				}
				try {
					if (ctx.slots && typeof ctx.slots.inject === 'function') {
						ctx.slots.inject('settings.general.item', () =>
							ctx.slots.register(
								{
									name: 'settings.general.item',
									id: 'voice-reply',
									order: 96,
									locale: LOCALE_NS,
									inject: () => face,
								},
								VoiceReplySettingsRow,
							),
						);
					}
				} catch (error) {
					report(error);
				}
				try {
					if (ctx.slots && typeof ctx.slots.inject === 'function') {
						ctx.slots.inject('plugins.row.config', () =>
							ctx.slots.register(
								{
									name: 'plugins.row.config',
									key: PLUGIN_ROW_KEY,
									locale: LOCALE_NS,
									inject: () => face,
								},
								VoiceReplyPluginSettings,
							),
						);
					}
				} catch (error) {
					report(error);
				}
				try {
					const pending = settings.refresh();
					if (pending && typeof pending.catch === 'function') pending.catch(report);
				} catch (error) {
					report(error);
				}
				try {
					ctx.effect(() => {
						try {
							if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;
							let resumeTimer = null;
							const resume = () => {
								if (resumeTimer !== null) clearTimeout(resumeTimer);
								// Let a click that focuses the window settle on its chat first:
								// an answer of the previous chat must not speak over navigation.
								resumeTimer = setTimeout(() => {
									resumeTimer = null;
									try {
										claimForActiveSession({ allowFallback: true, retryOnEmpty: true });
									} catch (error) {
										report(error);
									}
								}, 250);
							};
							document.addEventListener('visibilitychange', resume);
							window.addEventListener('focus', resume);
							return () => {
								try {
									if (resumeTimer !== null) clearTimeout(resumeTimer);
									document.removeEventListener('visibilitychange', resume);
									window.removeEventListener('focus', resume);
								} catch (error) {
									report(error);
								}
								try {
									if (claimRetryTimer !== null) clearTimeout(claimRetryTimer);
									claimRetryTimer = null;
									lastClosingBySession.clear();
									activeSessionId = null;
								} catch (error) {
									report(error);
								}
							};
						} catch (error) {
							report(error);
							return undefined;
						}
					}, 'voice-reply: resume deferred speech on return');
				} catch (error) {
					report(error);
				}
				try {
					ctx.effect(
						() => () => {
							try {
								player.dispose();
							} catch (error) {
								report(error);
							}
							try {
								settings.dispose();
							} catch (error) {
								report(error);
							}
						},
						'voice-reply: stores cleanup',
					);
				} catch (error) {
					report(error);
				}
			} catch (error) {
				report(error);
			}
		}

		return { inject, apply };
	},
});
