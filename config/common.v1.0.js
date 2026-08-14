// Common config page utilities v1.3
// Bridge integration helpers used by v1.3.html

const CONFIG_PASSPHRASE = 'pebble-ha-config-v1';

async function _deriveKey(salt) {
	const enc = new TextEncoder();
	const keyMaterial = await crypto.subtle.importKey(
		'raw', enc.encode(CONFIG_PASSPHRASE), 'PBKDF2', false, ['deriveKey']
	);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
		keyMaterial,
		{ name: 'AES-GCM', length: 256 },
		false, ['encrypt', 'decrypt']
	);
}

async function _compress(str) {
	const stream = new CompressionStream('deflate-raw');
	const writer = stream.writable.getWriter();
	writer.write(new TextEncoder().encode(str));
	writer.close();
	const chunks = [];
	const reader = stream.readable.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const total = chunks.reduce((a, c) => a + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) { out.set(c, offset); offset += c.length; }
	return out;
}

async function _decompress(bytes) {
	const stream = new DecompressionStream('deflate-raw');
	const writer = stream.writable.getWriter();
	writer.write(bytes);
	writer.close();
	const chunks = [];
	const reader = stream.readable.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const total = chunks.reduce((a, c) => a + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) { out.set(c, offset); offset += c.length; }
	return new TextDecoder().decode(out);
}

function _toBase64(bytes) {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _fromBase64(str) {
	str = str.replace(/-/g, '+').replace(/_/g, '/');
	while (str.length % 4) str += '=';
	const bin = atob(str);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function configEncode(obj) {
	const json = JSON.stringify(obj);
	const compressed = await _compress(json);
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await _deriveKey(salt);
	const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed);
	const result = new Uint8Array(16 + 12 + encrypted.byteLength);
	result.set(salt, 0);
	result.set(iv, 16);
	result.set(new Uint8Array(encrypted), 28);
	return _toBase64(result);
}

async function configDecode(str) {
	const bytes = _fromBase64(str);
	const salt = bytes.slice(0, 16);
	const iv = bytes.slice(16, 28);
	const data = bytes.slice(28);
	const key = await _deriveKey(salt);
	const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
	const json = await _decompress(new Uint8Array(decrypted));
	return JSON.parse(json);
}


/**
 * Parse JSON-encoded string values in an object in-place.
 * @param {object} obj - The object to process (mutated).
 */
function parseJsonStringValues(obj) {
	if (typeof obj !== 'object' || obj === null) return obj;
	for (const key in obj) {
		const value = obj[key];
		if (typeof value === 'string' && value.length > 1 &&
			(value.charAt(0) === '[' || value.charAt(0) === '{')) {
			try { obj[key] = JSON.parse(value); } catch (e) {}
		}
	}
	return obj;
}

/**
 * If the PebbleBridge is available, merge its config into watch_config and
 * fetch registries + states directly from Home Assistant.
 * @param {object} watch_config - The config object to merge into (mutated).
 */

async function mergeBridgeConfig(watch_config) {
	if (!window.PebbleBridgeAdapter || !window.PebbleBridgeAdapter.isAvailable()) {
		return;
	}

	console.log('[PebbleBridgeAdapter] bridge detected, merging config and fetching registries');
	Object.assign(watch_config, window.PebbleBridgeAdapter.loadBaseConfig());
	parseJsonStringValues(watch_config);

	if (!watch_config['ha_url'] || !watch_config['token']) {
		return;
	}

	try {
		const registries = await window.PebbleBridgeAdapter.fetchRegistries(
			watch_config['ha_url'],
			watch_config['token']
		);
		watch_config['entity_registry_cache'] = registries.entities;
		watch_config['area_registry_cache'] = registries.areas;
		watch_config['floor_registry_cache'] = registries.floors;
		watch_config['device_registry_cache'] = registries.devices;
		watch_config['label_registry_cache'] = registries.labels;

		try {
			const states = await window.PebbleBridgeAdapter.fetchStates(
				watch_config['ha_url'],
				watch_config['token']
			);
			watch_config['ha_state_cache'] = states;
			watch_config['all_entities'] = buildAllEntities(states, registries.entities);
		} catch (err) {
			console.error('[PebbleBridgeAdapter] failed to fetch states', err);
		}
	} catch (err) {
		console.error('[PebbleBridgeAdapter] failed to fetch registries', err);
	}
}
