/**
 * FavoritesPage - Display favorite entities (Native Bridge)
 */
var simply = require('ui/simply');
var AppState = require('app/AppState');
var EntityListPage = require('app/pages/EntityListPage');
var helpers = require('app/helpers');

function showFavorites() {
    var appState = AppState.getInstance();
    var favoriteEntities = appState.favoriteEntityStore.all();

    helpers.log_message("Showing " + favoriteEntities.length + " favorite entities");

    if (favoriteEntities && favoriteEntities.length) {
        var shouldShowDomains = helpers.shouldShowDomainMenu(
            favoriteEntities,
            appState.domain_menu_favorites,
            {
                minEntities: appState.domain_menu_min_entities,
                minDomains: appState.domain_menu_min_domains
            }
        );

        var favoriteProvider = function() {
            return appState.favoriteEntityStore.all();
        };

        if (shouldShowDomains) {
            EntityListPage.showEntityDomainsFromList(favoriteEntities, "Favorites");
        } else {
            EntityListPage.showEntityList("Favorites", favoriteEntities, true, false, true, favoriteProvider);
        }
    } else {
        // Push a simple card via native bridge
        var screenId = 250;
        simply.impl.nativeMenuPush(screenId, 'No Favorites', 1, {
            onSelect: function() {},
            onLongSelect: function() {},
            onBack: function() {}
        });
        simply.impl.nativeMenuUpdate(screenId, 0, 0, "Long-press an entity", "to add favorites", 0);
    }
}

module.exports = {};
module.exports.showFavorites = showFavorites;
