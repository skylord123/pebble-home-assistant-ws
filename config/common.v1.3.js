// Common config page utilities v1.3
// Bridge integration helpers used by v1.3.html

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
