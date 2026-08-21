/**
 * UpdatePage - update entity control page
 *
 * The state says whether an update is waiting: on when the latest version
 * is newer than the installed one, off when they match, when the latest
 * has been skipped, or when the two cannot be compared. Skipping is
 * therefore invisible in the state alone, so the skipped version is read
 * from its own attribute and offered back.
 *
 * Installing can take a service down and restart it, so it asks first.
 */
var UI = require('ui');
var Vibe = require('ui/vibe');

var AppState = require('app/AppState');
var EntityService = require('app/EntityService');
var helpers = require('app/helpers');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');

var GenericEntityPage = require('app/pages/entity/GenericEntityPage');

// UpdateEntityFeature bitfield values from Home Assistant
var UpdateEntityFeature = {
    INSTALL: 1,
    SPECIFIC_VERSION: 2,
    PROGRESS: 4,
    BACKUP: 8,
    RELEASE_NOTES: 16
};

function getUpdateData(entity) {
    var attrs = entity.attributes || {};
    var features = attrs.supported_features || 0;
    var percentage = null;
    if (typeof attrs.update_percentage === 'number') {
        percentage = Math.round(attrs.update_percentage);
    }
    return {
        friendly_name: attrs.title || attrs.friendly_name || entity.entity_id,
        unavailable: entity.state === 'unavailable' || entity.state === 'unknown',
        available: entity.state === 'on',
        installed_version: attrs.installed_version || null,
        latest_version: attrs.latest_version || null,
        skipped_version: attrs.skipped_version || null,
        release_summary: attrs.release_summary || null,
        auto_update: attrs.auto_update === true,
        // in_progress is the flag; the percentage is separate and may be
        // missing entirely for an installer that cannot report one
        in_progress: attrs.in_progress === true,
        percentage: percentage,
        can_install: !!(features & UpdateEntityFeature.INSTALL),
        can_backup: !!(features & UpdateEntityFeature.BACKUP),
        has_progress: !!(features & UpdateEntityFeature.PROGRESS),
        has_release_notes: !!(features & UpdateEntityFeature.RELEASE_NOTES)
    };
}

/**
 * What is waiting, in the space a subtitle has: "1.2.3 to 1.3.0" while an
 * update is available, the installed version alone when up to date, and
 * the progress while one is installing.
 */
function statusText(entity) {
    var data = getUpdateData(entity);
    if (data.unavailable) return entity.state;

    if (data.in_progress) {
        return data.percentage !== null ? 'Installing ' + data.percentage + '%' : 'Installing';
    }
    if (data.available) {
        if (data.installed_version && data.latest_version) {
            return data.installed_version + ' to ' + data.latest_version;
        }
        return data.latest_version ? 'Update to ' + data.latest_version : 'Update available';
    }
    // Off can mean up to date or quietly skipped, which are worth telling apart
    if (data.skipped_version) {
        return 'Skipped ' + data.skipped_version;
    }
    return data.installed_version ? 'Up to date, ' + data.installed_version : 'Up to date';
}

function callUpdateService(entity_id, service, data) {
    var appState = AppState.getInstance();
    appState.haws.callService(
        'update',
        service,
        data || {},
        { entity_id: entity_id },
        function(result) {
            Vibe.vibrate('short');
            helpers.log_message('update.' + service + ' called for ' + entity_id +
                ' with ' + JSON.stringify(data || {}));
        },
        function(error) {
            Vibe.vibrate('double');
            helpers.log_message('Error calling update.' + service + ': ' + JSON.stringify(error));
        }
    );
}

/**
 * Markdown release notes are written for a browser, so the heaviest of it
 * is flattened rather than shown as syntax on a watch
 */
function flattenMarkdown(text) {
    if (!text) return '';
    return String(text)
        .replace(/\r/g, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')        // images
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // links keep their text
        .replace(/^#{1,6}\s*/gm, '')                 // heading marks
        .replace(/(\*\*|__)(.*?)\1/g, '$2')          // bold
        .replace(/(\*|_)(.*?)\1/g, '$2')             // italics
        .replace(/`{1,3}/g, '')                      // code marks
        .replace(/^\s*[-*+]\s+/gm, '• ')        // bullets
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function showUpdateEntity(entity_id) {
    var appState = AppState.getInstance();
    let entity = appState.ha_state_dict[entity_id],
        subscription_msg_id = null,
        relativeTimeUpdater = null;
    if (!entity) {
        throw new Error(`Update entity ${entity_id} not found in appState.ha_state_dict`);
    }

    helpers.log_message(`Showing update entity ${entity_id}`, JSON.stringify(entity, null, 4));

    let updateMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: entity.attributes.friendly_name || entity_id
        }]
    });

    // Installing can restart whatever is being updated, so the version is
    // named and confirmed rather than fired from a single press
    function confirmInstall(withBackup) {
        let data = getUpdateData(appState.ha_state_dict[entity_id] || entity);
        let target = data.latest_version ? 'version ' + data.latest_version : 'the latest version';
        let body = 'Install ' + target + ' of ' + data.friendly_name + '?';
        if (withBackup) {
            body += '\n\nA backup will be taken first.';
        }
        body += '\n\nPress SELECT to start.';

        let confirmCard = new UI.Card({
            title: withBackup ? 'Back Up & Install' : 'Install Update',
            body: body,
            scrollable: true
        });
        confirmCard.on('click', 'select', function() {
            confirmCard.hide();
            // backup is only sent where the entity supports it; version is
            // left out so the latest is installed, since there is no way to
            // type a specific one here
            callUpdateService(entity_id, 'install', withBackup ? { backup: true } : {});
        });
        confirmCard.show();
    }

    function showReleaseNotes() {
        let data = getUpdateData(appState.ha_state_dict[entity_id] || entity);
        let loading = new UI.Card({
            title: 'Release Notes',
            body: 'Loading...',
            scrollable: true
        });
        loading.show();

        appState.haws.send({
            type: 'update/release_notes',
            entity_id: entity_id
        }, function(response) {
            let notes = flattenMarkdown(response && response.result);
            loading.body(notes.length ? notes : 'No release notes were provided.');
        }, function(error) {
            helpers.log_message('Error fetching release notes: ' + JSON.stringify(error));
            // The summary attribute is a shorter version of the same thing
            // and is often present even when the full notes fail
            loading.body(data.release_summary
                ? flattenMarkdown(data.release_summary)
                : 'Release notes could not be loaded.');
        });
    }

    function buildStatusItem(updatedEntity) {
        let data = getUpdateData(updatedEntity);
        let timeStr = helpers.humanDiff(new Date(), new Date(updatedEntity.last_changed));
        return {
            title: data.friendly_name,
            subtitle: `${statusText(updatedEntity)} > ${timeStr}`,
            icon: EntityService.getIcon(updatedEntity)
        };
    }

    let renderedSignature = null;

    function updateMenuItems(updatedEntity) {
        let data = getUpdateData(updatedEntity);
        let menuItems = [buildStatusItem(updatedEntity)];

        if (!data.unavailable) {
            // Nothing to offer while an install is running: the status row
            // carries the progress instead
            if (!data.in_progress) {
                if (data.available && data.can_install) {
                    menuItems.push({
                        title: 'Install',
                        subtitle: data.latest_version || '',
                        on_click: function() { confirmInstall(false); }
                    });
                    if (data.can_backup) {
                        menuItems.push({
                            title: 'Back Up & Install',
                            on_click: function() { confirmInstall(true); }
                        });
                    }
                    menuItems.push({
                        title: 'Skip',
                        subtitle: 'Stop asking for this version',
                        on_click: function() { callUpdateService(entity_id, 'skip'); }
                    });
                }
                // Only reachable while skipped, which reads as off
                if (data.skipped_version) {
                    menuItems.push({
                        title: 'Clear Skipped',
                        subtitle: data.skipped_version,
                        on_click: function() { callUpdateService(entity_id, 'clear_skipped'); }
                    });
                }
            }

            if (data.has_release_notes || data.release_summary) {
                menuItems.push({
                    title: 'Release Notes',
                    on_click: showReleaseNotes
                });
            }

            if (data.auto_update) {
                menuItems.push({
                    title: 'Auto Update',
                    subtitle: 'Installs on its own'
                });
            }
        }

        if (require('app/pages/HistoryPage').isSupported()) {
            menuItems.push({
                title: 'History',
                on_click: function() {
                    require('app/pages/HistoryPage').show(entity_id);
                }
            });
        }

        menuItems.push({
            title: 'More',
            on_click: function() {
                GenericEntityPage.showEntityMenu(entity_id);
            }
        });

        updateMenu.items(0, menuItems);

        // The rows change as an install starts, finishes or is skipped, so
        // the highlight follows the shape rather than any single attribute
        let signature = [data.unavailable, data.in_progress, data.available,
                         !!data.skipped_version].join(':');
        if (renderedSignature !== null && renderedSignature !== signature) {
            selectedIndex = 0;
            updateMenu.selection(0, 0);
        }
        renderedSignature = signature;
    }

    let selectedIndex = 0;

    updateMenu.on('select', function(e) {
        selectedIndex = e.itemIndex;
        helpers.log_message(`Update menu item ${e.item.title} was selected! Index: ${selectedIndex}`);
        if (typeof e.item.on_click === 'function') {
            e.item.on_click(e);
        }
    });

    updateMenu.on('show', function() {
        entity = appState.ha_state_dict[entity_id];
        updateMenuItems(entity);

        relativeTimeUpdater = new RelativeTimeUpdater(function(id, lastChanged) {
            let current = appState.ha_state_dict[entity_id];
            if (current) {
                updateMenu.item(0, 0, buildStatusItem(current));
            }
        });
        relativeTimeUpdater.register(entity_id, entity.last_changed);

        // Progress arrives as attribute changes on this subscription, so the
        // percentage climbs on its own while an install runs
        subscription_msg_id = appState.haws.subscribeEntities([entity_id], function(data) {
            let updatedEntity = EntityService.applyCompressedEvent(entity_id, data);
            if (updatedEntity) {
                helpers.log_message(`Update entity update for ${entity_id}: ${updatedEntity.state}`);
                updateMenuItems(updatedEntity);
                if (relativeTimeUpdater) {
                    relativeTimeUpdater.update(entity_id, updatedEntity.last_changed);
                }
            }
        }, function(error) {
            helpers.log_message(`ENTITY UPDATE ERROR [${entity_id}]: ${JSON.stringify(error)}`);
        });

        setTimeout(function() {
            if (selectedIndex > 0 && selectedIndex < updateMenu.items(0).length) {
                updateMenu.selection(0, selectedIndex);
            }
        }, 100);
    });

    updateMenu.on('hide', function() {
        if (subscription_msg_id) {
            appState.haws.unsubscribe(subscription_msg_id);
        }
        if (relativeTimeUpdater) {
            relativeTimeUpdater.destroy();
            relativeTimeUpdater = null;
        }
    });

    updateMenu.show();
}

module.exports.showUpdateEntity = showUpdateEntity;
module.exports.statusText = statusText;
module.exports.flattenMarkdown = flattenMarkdown;
