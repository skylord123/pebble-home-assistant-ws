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

            if (shouldShowDomains) {
                EntityListPage.showEntityDomainsFromList(favoriteEntities, "Favorites");
            } else {
                EntityListPage.showEntityList("Favorites", favoriteEntities, true, false, true);
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
