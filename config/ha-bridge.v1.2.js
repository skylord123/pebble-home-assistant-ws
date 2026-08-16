// HA Bridge Adapter v1.4
// Home Assistant-specific PebbleBridge adapter and entity picker utilities
// v1.2 config variant: favorites added via the entity picker support custom display names
(function (global) {
	'use strict';

	const PebbleBridgeAdapter = {
		isAvailable: function () {
			return !!(global.pebbleBridge && global.pebbleBridge.version);
		},

		loadBaseConfig: function () {
			let config = {};
			const hash = global.location.hash ? global.location.hash.substring(1) : '';
			if (hash) {
				try {
					config = JSON.parse(decodeURIComponent(hash));
				} catch (e) {
					console.error('PebbleBridgeAdapter: error parsing hash config', e);
				}
			} else {
				try {
					const stored = global.localStorage.getItem('watch_config');
					if (stored) {
						config = JSON.parse(stored);
					}
				} catch (e) {
					console.error('PebbleBridgeAdapter: error parsing localStorage config', e);
				}
			}

			if (this.isAvailable() && global.pebbleBridge.config) {
				const bridgeConfig = {};
				for (const key in global.pebbleBridge.config) {
					const value = global.pebbleBridge.config[key];
					if (typeof value === 'string' && value.length > 1 &&
						(value.charAt(0) === '[' || value.charAt(0) === '{')) {
						try {
							bridgeConfig[key] = JSON.parse(value);
							continue;
						} catch (e) { /* keep string */ }
					}
					bridgeConfig[key] = value;
				}
				config = Object.assign({}, config, bridgeConfig);
			}

			return config;
		},

		wsUrlFromHaUrl: function (haUrl) {
			let url = (haUrl || '').replace(/\/+$/, '');
			if (url.indexOf('https://') === 0) {
				return url.replace(/^https/, 'wss') + '/api/websocket';
			}
			if (url.indexOf('http://') === 0) {
				return url.replace(/^http/, 'ws') + '/api/websocket';
			}
			throw new Error('Unsupported HA URL scheme: ' + haUrl);
		},

		fetchStates: async function (haUrl, token) {
			if (!this.isAvailable()) {
				throw new Error('PebbleBridge not available');
			}
			if (!haUrl || !token) {
				throw new Error('ha_url and token are required');
			}
			const url = haUrl.replace(/\/+$/, '') + '/api/states';
			const res = await global.pebbleBridge.fetch(url, {
				method: 'GET',
				headers: {
					'Authorization': 'Bearer ' + token,
					'Content-Type': 'application/json'
				}
			});
			if (!res.ok) {
				const text = await res.text();
				throw new Error('HTTP ' + res.status + ' ' + res.statusText + ': ' + text.substring(0, 200));
			}
			const data = await res.json();
			return data;
		},

		fetchRegistries: function (haUrl, token) {
			const self = this;
			return new Promise(function (resolve, reject) {
				if (!self.isAvailable()) {
						reject(new Error('PebbleBridge not available'));
					return;
				}
				if (!haUrl || !token) {
						reject(new Error('ha_url and token are required'));
					return;
				}

				let messageId = 1;
				const pending = {};
				const results = {};
				let socket;
				let timeout;

				function send(type) {
					const id = messageId++;
					const msg = { id: id, type: type };
					pending[id] = type;
					socket.send(JSON.stringify(msg));
				}

				function finishIfDone() {
					const keys = ['entities', 'areas', 'floors', 'devices', 'labels'];
					if (keys.every(function (k) { return results[k] !== undefined; })) {
						clearTimeout(timeout);
						resolve(results);
					}
				}

				try {
					// Home Assistant's WebSocket endpoint supports the 'ha' subprotocol.
					socket = new global.pebbleBridge.WebSocket(self.wsUrlFromHaUrl(haUrl), ['ha']);
				} catch (err) {
					reject(err);
					return;
				}

				let authTimeout;
				function clearAuthTimeout() {
					if (authTimeout) {
						clearTimeout(authTimeout);
						authTimeout = null;
					}
				}

				timeout = setTimeout(function () {
					socket.close();
					reject(new Error('Registry fetch timed out'));
				}, 30000);

				socket.onopen = function () {
					console.log('[PebbleBridgeAdapter] WebSocket opened, waiting for auth_required...');
					authTimeout = setTimeout(function () {
						console.error('[PebbleBridgeAdapter] did not receive auth_required within 10s');
						socket.close();
						reject(new Error('Did not receive auth_required from Home Assistant'));
					}, 10000);
				};

				socket.onmessage = function (event) {
					console.log('[PebbleBridgeAdapter] WS raw message', event.data);
					let msg;
					try {
						msg = JSON.parse(event.data);
					} catch (e) {
						console.error('[PebbleBridgeAdapter] invalid WS message', event.data);
						return;
					}

					clearAuthTimeout();
					if (msg.type === 'auth_required') {
						socket.send(JSON.stringify({ type: 'auth', access_token: token }));
					} else if (msg.type === 'auth_ok') {
						send('config/entity_registry/list');
						send('config/area_registry/list');
						send('config/floor_registry/list');
						send('config/device_registry/list');
						send('config/label_registry/list');
					} else if (msg.type === 'auth_invalid') {
						clearTimeout(timeout);
						socket.close();
						reject(new Error('HA auth invalid: ' + (msg.message || 'unknown')));
					} else if (msg.type === 'result' && msg.id && pending[msg.id]) {
						const type = pending[msg.id];
						delete pending[msg.id];
						const keyMap = {
							'config/entity_registry/list': 'entities',
							'config/area_registry/list': 'areas',
							'config/floor_registry/list': 'floors',
							'config/device_registry/list': 'devices',
							'config/label_registry/list': 'labels'
						};
						const key = keyMap[type];
						if (key) {
							results[key] = msg.result || [];
						}
						finishIfDone();
					}
				};

				socket.onerror = function (event) {
					console.error('[PebbleBridgeAdapter] WebSocket error', event);
					clearTimeout(timeout);
					reject(new Error('WebSocket error'));
				};

				socket.onclose = function (event) {
					console.log('[PebbleBridgeAdapter] WebSocket closed', event.code, event.reason, 'wasClean=', event.wasClean);
					clearTimeout(timeout);
					if (!event.wasClean) {
						reject(new Error('WebSocket closed unexpectedly: ' + event.code + ' ' + event.reason));
					}
				};
			});
		}
	};

	global.PebbleBridgeAdapter = PebbleBridgeAdapter;
})(window);

/**
 * Build a flat, sorted list of entities for the config page picker.
 * Merges friendly names from /api/states with the entity registry.
 */
function buildAllEntities(states, entityRegistry) {
	const nameMap = {};
	if (Array.isArray(states)) {
		for (const state of states) {
			if (state && state.entity_id) {
				nameMap[state.entity_id] = (state.attributes && state.attributes.friendly_name) || state.entity_id;
			}
		}
	}

	const registryIds = new Set();
	if (Array.isArray(entityRegistry)) {
		for (const entry of entityRegistry) {
			if (entry && entry.entity_id) {
				registryIds.add(entry.entity_id);
			}
		}
	}

	// Prefer registry IDs; fall back to state IDs if the registry is empty.
	const ids = registryIds.size ? Array.from(registryIds) : Object.keys(nameMap);
	const entities = ids.map(function (entityId) {
		const domain = entityId.split('.')[0] || 'unknown';
		return {
			entity_id: entityId,
			name: nameMap[entityId] || entityId,
			domain: domain
		};
	});

	entities.sort(function (a, b) {
		const nameA = a.name.toLowerCase();
		const nameB = b.name.toLowerCase();
		if (nameA < nameB) return -1;
		if (nameA > nameB) return 1;
		return 0;
	});

	return entities;
}

/**
 * Initialize the entity picker UI in the config page.
 * Requires jQuery and a populated watch_config['all_entities'].
 */
function initEntityPicker() {
	const container = $('#entity-picker-container');
	const listEl = $('#entity-picker-list');
	const searchInput = $('#entity-picker-search');
	const status = $('#entity-picker-status');
	const selection = $('#entity-picker-selection');

	container.show();

	if (!watch_config || !watch_config['all_entities'] || !watch_config['all_entities'].length) {
		listEl.hide();
		searchInput.closest('.form-group').hide();
		selection.hide();
		$('#entity-picker-add-favorite, #entity-picker-add-pinned').hide();
		status.html('<div class="alert alert-warning mt-2" role="alert"><svg class="bi" width="20" height="20" role="img" aria-label="Warning:"><use xlink:href="#exclamation-triangle-fill"/></svg> This Pebble app version does not yet support access to Home Assistant through this configuration page. Select the entities within the watchapp.</div>');
		return;
	}

	status.text('');
	selection.text('');
	const btnFav = $('#entity-picker-add-favorite');
	const btnPinned = $('#entity-picker-add-pinned');

	const entities = watch_config['all_entities'].slice().sort(function(a, b) {
		const nameA = (a.name || a.entity_id || '').toLowerCase();
		const nameB = (b.name || b.entity_id || '').toLowerCase();
		return nameA.localeCompare(nameB);
	});

	const byDomain = {};
	for (const entity of entities) {
		const domain = entity.domain || 'unknown';
		if (!byDomain[domain]) {
			byDomain[domain] = [];
		}
		byDomain[domain].push(entity);
	}
	const domains = Object.keys(byDomain).sort();

	let selectedEntity = null;

	function escapeHtml(text) {
		return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function renderList() {
		const query = searchInput.val().trim().toLowerCase();
		const maxPerDomain = 500;
		let totalMatches = 0;
		let totalShown = 0;
		let remaining = 0;

		let html = '';
		for (const domain of domains) {
			const matched = [];
			for (const entity of byDomain[domain]) {
				const hay = ((entity.name || '') + ' ' + (entity.entity_id || '')).toLowerCase();
				if (!query || hay.indexOf(query) !== -1) {
					matched.push(entity);
				}
			}
			if (matched.length === 0) continue;

			totalMatches += matched.length;
			const show = matched.slice(0, maxPerDomain);
			const domainRemaining = matched.length - show.length;
			remaining += domainRemaining;
			totalShown += show.length;

			html += '<details class="entity-domain-group" style="margin:0.25rem 0;" data-domain="' + escapeHtml(domain) + '">';
			html += '<summary style="cursor:pointer;font-weight:bold;padding:0.25rem;">' + escapeHtml(domain) + ' (' + matched.length + ')</summary>';
			html += '<div class="entity-domain-items" style="padding-left:0.5rem;">';
			for (const entity of show) {
				const isSelected = selectedEntity && selectedEntity.entity_id === entity.entity_id;
				html += '<button type="button" class="entity-picker-item' + (isSelected ? ' selected' : '') + '" data-entity-id="' + escapeHtml(entity.entity_id) + '" data-name="' + escapeHtml(entity.name || entity.entity_id) + '" style="display:block;width:100%;text-align:left;padding:0.4rem 0.5rem;margin:0.1rem 0;background:var(--color-section-bg);border:1px solid var(--color-divider);border-radius:4px;color:var(--color-text);font-size:0.9rem;">';
				html += '<div class="entity-name" style="font-weight:500;">' + escapeHtml(entity.name || entity.entity_id) + '</div>';
				html += '<div class="entity-id" style="font-size:0.8rem;color:var(--color-text-muted);">' + escapeHtml(entity.entity_id) + '</div>';
				html += '</button>';
			}
			if (domainRemaining > 0) {
				html += '<div style="font-size:0.8rem;color:var(--color-text-muted);padding:0.25rem;">and ' + domainRemaining + ' more</div>';
			}
			html += '</div></details>';
		}

		if (!html) {
			html = '<div style="padding:0.5rem;color:var(--color-text-muted);">No matching entities.</div>';
		}
		listEl.html(html);

		status.text(totalShown + ' of ' + totalMatches + ' shown.');

		if (remaining > 0) {
			status.text(status.text() + ' Limited to 500 per group.');
		}
	}

	listEl.on('click', '.entity-picker-item', function () {
		const id = $(this).data('entity-id');
		const name = $(this).data('name');
		selectedEntity = { entity_id: id, name: name };
		listEl.find('.entity-picker-item').removeClass('selected').css('background', 'var(--color-section-bg)');
		$(this).addClass('selected').css('background', 'var(--color-accent)');
		selection.text('Selected: ' + (name !== id ? name + ' (' + id + ')' : id));
		status.text('');
	});

	let filterTimeout = null;
	function scheduleRender() {
		if (filterTimeout) clearTimeout(filterTimeout);
		filterTimeout = setTimeout(renderList, 150);
	}
	searchInput.on('input', scheduleRender);

	renderList();

	function addToList(listId, listKey, removeClass, withCustomName) {
		if (!selectedEntity) {
			status.text('Please select an entity first.');
			return;
		}
		const entityId = selectedEntity.entity_id;
		const name = selectedEntity.name;

		let exists = false;
		$(listId + ' li').each(function () {
			if ($(this).data('entity-id') === entityId) {
				exists = true;
				return false;
			}
		});
		if (exists) {
			status.text('Entity is already in the list.');
			return;
		}

		if (!Array.isArray(watch_config[listKey])) {
			watch_config[listKey] = [];
		}
		const entry = { entity_id: entityId, name: name };
		if (withCustomName) {
			// custom_name is only persisted once it has been set via the edit dialog
			entry.custom_name = '';
		}
		watch_config[listKey].push(entry);

		const displayHtml = name !== entityId ?
			'<div class="entity-info"><div class="entity-name">' + escapeHtml(name) + '</div><div class="entity-id">' + escapeHtml(entityId) + '</div></div>' :
			'<div class="entity-info"><div class="entity-name">' + escapeHtml(entityId) + '</div></div>';

		const editHtml = withCustomName ?
			'<a href="javascript:void(0)" class="edit-favorite-name" title="Set custom name"><i class="fa fa-pencil"></i></a>' :
			'';

		const li = $(
			'<li class="list-group-item" data-entity-id="' + escapeHtml(entityId) + '" data-friendly-name="' + escapeHtml(name || '') + '"' + (withCustomName ? ' data-custom-name=""' : '') + '>' +
			'<i class="fa fa-bars"></i>' +
			displayHtml +
			editHtml +
			'<a href="javascript:void(0)" class="' + removeClass + '"><i class="fa fa-trash"></i></a>' +
			'</li>'
		);

		const list = $(listId);
		list.append(li);
		if (list.hasClass('ui-sortable')) {
			list.sortable('refresh');
		} else {
			list.sortable({ handle: '.fa-bars' });
			list.disableSelection();
		}
		status.text('Added ' + name + '.');
	}

	btnFav.on('click', function () {
		addToList('#favorites-sortable', 'favorite_entities', 'remove-favorite', true);
		$('#favorites-container').show();
	});

	btnPinned.on('click', function () {
		addToList('#pinned-sortable', 'pinned_entities', 'remove-pinned');
		$('#pinned-container').show();
	});
}
