/**
 * FavoritesPage - Display favorite entities
 */
var UI = require('ui');
var BasePage = require('app/pages/BasePage');
var AppState = require('app/AppState');
var EntityListPage = require('app/pages/EntityListPage');
var helpers = require('app/helpers');

class FavoritesPage extends BasePage {
    constructor() {
        super();
    }

    show() {
        var appState = this.appState;
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

            // The store keeps the friendly name next to the id, so the list can
            // be drawn and read before any state has come back
            var placeholderNames = {};
            var withNames = appState.favoriteEntityStore.allWithNames() || [];
            for (var i = 0; i < withNames.length; i++) {
                if (withNames[i].name) {
                    placeholderNames[withNames[i].entity_id] = withNames[i].name;
                }
            }

            if (shouldShowDomains) {
                EntityListPage.showEntityDomainsFromList(favoriteEntities, "Favorites");
            } else {
                EntityListPage.showEntityList("Favorites", favoriteEntities, true, false, true,
                    favoriteProvider, placeholderNames);
            }
        } else {
            var noFavoritesCard = new UI.Card({
                title: "No Favorites",
                subtitle: "Long-press an entity and select 'Add Favorite'",
                status: false
            });
            noFavoritesCard.show();
        }
    }
}

/**
 * Show favorites (convenience function)
 */
function showFavorites() {
    var page = new FavoritesPage();
    page.show();
}

module.exports = FavoritesPage;
module.exports.showFavorites = showFavorites;
