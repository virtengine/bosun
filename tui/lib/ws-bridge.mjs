import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";

import { resolveTuiAuthToken as resolveSharedTuiAuthToken } from "../../infra/tui-bridge.mjs";
import {
	defaultConfigDir,
	normalizeWsProtocol,
	normalizeHttpProtocol,
	readUiInstanceLock,
} from "./connection-target.mjs";

function resolveWebSocketProtocol({ protocol, configDir } = {}) {
	const explicit = String(protocol || "").trim().toLowerCase();
	if (explicit === "ws" || explicit === "wss") {
		return explicit;
	}
	const instance = readUiInstanceLock(configDir);
	return String(instance?.protocol || "").trim().toLowerCase() === "https" ? "wss" : "ws";
}

function isPrivateOrLoopbackHost(host) {
	const normalized = String(host || "").trim().toLowerCase();
	if (!normalized) return false;
	if (normalized === "localhost" || normalized === "::1") return true;
	if (/^127\./.test(normalized)) return true;
	if (/^10\./.test(normalized)) return true;
	if (/^192\.168\./.test(normalized)) return true;
	if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(normalized)) return true;
	return false;
}

function shouldSkipTlsVerification({ host, protocol } = {}) {
	if (String(protocol || "").trim().toLowerCase() !== "wss") return false;
	if (["1", "true", "yes"].includes(String(process.env.BOSUN_TUI_INSECURE_TLS || "").toLowerCase())) {
		return true;
	}
	return isPrivateOrLoopbackHost(host);
}

function resolveTuiAuthToken(options = {}) {
	return resolveSharedTuiAuthToken({
		env: options.env || process.env,
		configDir: options.configDir || (options.cwd ? resolve(options.cwd, ".bosun") : defaultConfigDir()),
		cacheDir: options.cacheDir || (options.cwd ? resolve(options.cwd, ".bosun", ".cache") : undefined),
	});
}

function buildTuiWebSocketUrl({ host, port, token = "", protocol = "ws" }) {
	const url = new URL(`${normalizeWsProtocol(protocol)}://${host}:${port}/ws`);
	const normalizedToken = String(token || "").trim();
	if (normalizedToken) {
		url.searchParams.set("token", normalizedToken);
	}
	return url.toString();
}

function buildTuiHttpUrl({ host, port, path = "/", protocol = "ws" }) {
	const normalizedPath = String(path || "/").startsWith("/")
		? String(path || "/")
		: `/${String(path || "")}`;
	const httpProtocol = normalizeHttpProtocol(protocol);
	return new URL(`${httpProtocol}://${host}:${port}${normalizedPath}`).toString();
}

async function parseJsonResponse(response) {
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Expected JSON response but received: ${text.slice(0, 160)}`);
	}
}

class TuiWsBridge {
	constructor({ host, port, configDir, protocol = "ws", apiKey = "", WebSocketImpl = globalThis.WebSocket }) {
		this.host = host;
		this.port = port;
		this.configDir = configDir || defaultConfigDir();
		this.protocol = protocol;
		this.apiKey = String(apiKey || "").trim();
		this.WebSocketImpl = WebSocketImpl;
		this.ws = null;
		this.listeners = new Map();
		this.reconnectAttempts = 0;
		this.maxReconnectAttempts = 10;
		this.reconnectDelay = 1000;
		this.reconnectTimer = null;
		this._connected = false;
		this._connectionState = "offline";
		this._manualDisconnect = false;
		this._url = buildTuiWebSocketUrl({
			host,
			port,
			protocol: resolveWebSocketProtocol({ protocol, configDir: this.configDir }),
			token: this.apiKey ? "" : resolveTuiAuthToken({ configDir: this.configDir }),
		});
		this._insecureTls = shouldSkipTlsVerification({
			host,
			protocol: resolveWebSocketProtocol({ protocol, configDir: this.configDir }),
		});
	}

	connect() {
		if (this.ws && this.ws.readyState === this.WebSocketImpl?.OPEN) {
			return;
		}
		this._manualDisconnect = false;

		try {
			if (typeof this.WebSocketImpl !== "function") {
				throw new Error("WebSocket is not available in this runtime");
			}
			this._url = buildTuiWebSocketUrl({
				host: this.host,
				port: this.port,
				protocol: resolveWebSocketProtocol({ protocol: this.protocol, configDir: this.configDir }),
				token: this.apiKey ? "" : resolveTuiAuthToken({ configDir: this.configDir }),
			});
			this._insecureTls = shouldSkipTlsVerification({
				host: this.host,
				protocol: resolveWebSocketProtocol({ protocol: this.protocol, configDir: this.configDir }),
			});
			const headers = {};
			if (this.apiKey) {
				headers["x-api-key"] = this.apiKey;
			} else {
				const token = resolveTuiAuthToken({ configDir: this.configDir });
				if (token) headers.Authorization = `Bearer ${token}`;
			}
			const wsOptions = {};
			if (Object.keys(headers).length > 0) {
				wsOptions.headers = headers;
			}
			wsOptions.rejectUnauthorized = !this._insecureTls;
			this.ws = Object.keys(wsOptions).length > 0
				? new this.WebSocketImpl(this._url, wsOptions)
				: new this.WebSocketImpl(this._url);

			this.ws.onopen = () => {
				this._connected = true;
				this._connectionState = "connected";
				this.reconnectAttempts = 0;
				this.send("subscribe", {
					channels: ["monitor", "stats", "sessions", "tasks", "workflows", "tui"],
				});
				this._emit("connection:state", { state: this._connectionState });
				this._emit("connect", {});
			};

			this.ws.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					this._handleMessage(data);
				} catch (err) {
					this._emit("error", { message: err?.message || "Failed to parse message" });
				}
			};

			this.ws.onclose = () => {
				this._connected = false;
				this._connectionState = this._manualDisconnect ? "offline" : "reconnecting";
				this._emit("connection:state", { state: this._connectionState });
				this._emit("disconnect", {});
				if (!this._manualDisconnect) {
					this._scheduleReconnect();
				}
			};

			this.ws.onerror = (err) => {
				const message = err?.message || err?.error?.message || `WebSocket error (${this._url})`;
				this._emit("error", { message });
			};
		} catch (err) {
			this._emit("error", { message: err?.message || "Failed to connect" });
			this._scheduleReconnect();
		}
	}

	disconnect() {
		this._manualDisconnect = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this._connected = false;
		this._connectionState = "offline";
		this._emit("connection:state", { state: this._connectionState });
	}

	_scheduleReconnect() {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			this._connectionState = "offline";
			this._emit("connection:state", { state: this._connectionState });
			this._emit("error", { message: "Max reconnection attempts reached" });
			return;
		}

		const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
		this.reconnectAttempts++;
		this._connectionState = "reconnecting";
		this._emit("connection:state", {
			state: this._connectionState,
			attempt: this.reconnectAttempts,
			delayMs: delay,
		});
		this._emit("reconnecting", {
			attempt: this.reconnectAttempts,
			delayMs: delay,
		});

		this.reconnectTimer = setTimeout(() => {
			this.connect();
		}, delay);
	}

	_handleMessage(data) {
		const { type, payload } = data;

		switch (type) {
			case "monitor:stats":
			case "stats":
				this._emit("monitor:stats", payload);
				this._emit("stats", payload);
				break;
			case "sessions:update": {
				const sessions = Array.isArray(payload?.sessions)
					? payload.sessions
					: Array.isArray(payload)
						? payload
						: [];
				this._emit("sessions:update", sessions);
				break;
			}
			case "session:event": {
				this._emit("session:event", payload);
				const sessionEventReason = payload?.event?.reason || "";
				const sessionData = payload?.session || {};
				if (sessionEventReason === "session-started") {
					this._emit("session:start", sessionData);
				} else if (sessionEventReason === "session-ended") {
					this._emit("session:end", sessionData);
				} else {
					this._emit("session:update", sessionData);
				}
				break;
			}
			case "logs:stream":
				this._emit("logs:stream", payload);
				break;
			case "workflow:status":
				this._emit("workflow:status", payload);
				break;
			case "tasks:update": {
				this._emit("tasks:update", payload);
				const taskReason = payload?.reason || "";
				const taskSourceEvent = payload?.sourceEvent || "";
				const taskId = payload?.taskId ?? payload?.patch?.id;
				const taskPatch = { ...payload?.patch, id: taskId };
				if (taskReason === "task-created" || taskSourceEvent === "task:created") {
					this._emit("task:create", taskPatch);
				} else if (
					taskReason === "task-deleted"
					|| taskSourceEvent === "task:deleted"
					|| taskSourceEvent === "delete"
				) {
					this._emit("task:delete", taskId);
				} else {
					this._emit("task:update", taskPatch);
				}
				break;
			}
			case "pong":
				break;
			default:
				this._emit(type, payload);
		}
	}

	send(type, payload = {}) {
		if (this.ws && this.ws.readyState === this.WebSocketImpl?.OPEN) {
			const message = type === "subscribe"
				? { type, channels: Array.isArray(payload.channels) ? payload.channels : [] }
				: { type, payload };
			this.ws.send(JSON.stringify(message));
		}
	}

	on(event, callback) {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event).add(callback);
		return () => this.off(event, callback);
	}

	off(event, callback) {
		if (this.listeners.has(event)) {
			this.listeners.get(event).delete(callback);
		}
	}

	_emit(event, data) {
		if (this.listeners.has(event)) {
			for (const callback of this.listeners.get(event)) {
				callback(data);
			}
		}
	}

	get isConnected() {
		return this._connected;
	}

	get connectionState() {
		return this._connectionState;
	}

	async requestJson(path, options = {}) {
		const headers = {
			Accept: "application/json",
			...(options.body ? { "Content-Type": "application/json" } : {}),
			...(options.headers || {}),
		};
		if (this.apiKey) {
			if (!headers["x-api-key"] && !headers["X-API-Key"]) {
				headers["x-api-key"] = this.apiKey;
			}
		} else {
			const token = resolveTuiAuthToken({ configDir: this.configDir });
			if (token && !headers.Authorization) {
				headers.Authorization = `Bearer ${token}`;
			}
		}

		const url = buildTuiHttpUrl({
			host: this.host,
			port: this.port,
			path,
			protocol: resolveWebSocketProtocol({ protocol: this.protocol, configDir: this.configDir }),
		});
		const skipTlsVerification = shouldSkipTlsVerification({
			host: this.host,
			protocol: resolveWebSocketProtocol({ protocol: this.protocol, configDir: this.configDir }),
		});
		if (typeof globalThis.fetch === "function" && !(url.startsWith("https:") && skipTlsVerification)) {
			const response = await globalThis.fetch(url, {
				method: options.method || (options.body ? "POST" : "GET"),
				headers,
				body: options.body ? JSON.stringify(options.body) : undefined,
			});
			const payload = await parseJsonResponse(response);
			if (!response.ok || payload?.ok === false) {
				const message = String(payload?.error || payload?.message || response.statusText || "Request failed").trim();
				throw new Error(message || `HTTP ${response.status}`);
			}
			return payload;
		}
		const requestOptions = {
			method: options.method || (options.body ? "POST" : "GET"),
			headers,
			rejectUnauthorized: !skipTlsVerification,
		};
		const requester = url.startsWith("https:") ? httpsRequest : httpRequest;
		const payload = await new Promise((resolvePayload, rejectPayload) => {
			const req = requester(url, requestOptions, (res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					text += chunk;
				});
				res.on("end", () => {
					let parsed = null;
					if (text) {
						try {
							parsed = JSON.parse(text);
						} catch {
							rejectPayload(new Error(`Expected JSON response but received: ${text.slice(0, 160)}`));
							return;
						}
					}
					if (res.statusCode >= 200 && res.statusCode < 300 && parsed?.ok !== false) {
						resolvePayload(parsed);
						return;
					}
					const message = String(parsed?.error || parsed?.message || res.statusMessage || "Request failed").trim();
					rejectPayload(new Error(message || `HTTP ${res.statusCode}`));
				});
			});
			req.on("error", rejectPayload);
			req.on("timeout", () => req.destroy(new Error("Request timed out")));
			if (options.body) {
				req.write(JSON.stringify(options.body));
			}
			req.end();
		});
		return payload;
	}

	async createTask(task) {
		const response = await this.requestJson("/api/tasks/create", {
			method: "POST",
			body: task,
		});
		return response?.data || null;
	}

	async getConfigTree() {
		return this.requestJson("/api/tui/config");
	}

	async saveConfigField(path, value) {
		return this.requestJson("/api/tui/config", {
			method: "POST",
			body: { path, value },
		});
	}
}

let _instance = null;
let _lastHost = null;
let _lastPort = null;
let _lastConfigDir = null;
let _lastProtocol = null;
let _lastApiKey = null;
let _lastWebSocketImpl = null;

function createWsBridge({ host, port, configDir, protocol, apiKey, WebSocketImpl }) {
	_instance = new TuiWsBridge({ host, port, configDir, protocol, apiKey, WebSocketImpl });
	_lastHost = host;
	_lastPort = port;
	_lastConfigDir = configDir || defaultConfigDir();
	_lastProtocol = protocol || "ws";
	_lastApiKey = String(apiKey || "").trim();
	_lastWebSocketImpl = WebSocketImpl || globalThis.WebSocket;
	wsBridge._instance = _instance;
	return _instance;
}

function wsBridge({ host, port, configDir, protocol, apiKey, WebSocketImpl }) {
	const resolvedConfigDir = configDir || defaultConfigDir();
	const resolvedProtocol = protocol || "ws";
	const resolvedApiKey = String(apiKey || "").trim();
	const resolvedWebSocketImpl = WebSocketImpl || globalThis.WebSocket;
	if (
		_instance
		&& (
			host !== _lastHost
			|| port !== _lastPort
			|| resolvedConfigDir !== _lastConfigDir
			|| resolvedProtocol !== _lastProtocol
			|| resolvedApiKey !== _lastApiKey
			|| resolvedWebSocketImpl !== _lastWebSocketImpl
		)
	) {
		_instance.disconnect();
		return createWsBridge({
			host,
			port,
			configDir: resolvedConfigDir,
			protocol: resolvedProtocol,
			apiKey: resolvedApiKey,
			WebSocketImpl: resolvedWebSocketImpl,
		});
	}
	if (!_instance) {
		return createWsBridge({
			host,
			port,
			configDir: resolvedConfigDir,
			protocol: resolvedProtocol,
			apiKey: resolvedApiKey,
			WebSocketImpl: resolvedWebSocketImpl,
		});
	}
	return _instance;
}

wsBridge._instance = null;

export default wsBridge;
export {
	TuiWsBridge,
	buildTuiHttpUrl,
	buildTuiWebSocketUrl,
	createWsBridge,
	defaultConfigDir,
	readUiInstanceLock,
	resolveWebSocketProtocol,
	resolveTuiAuthToken,
};
