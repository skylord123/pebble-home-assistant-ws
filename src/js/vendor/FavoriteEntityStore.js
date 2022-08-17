let Settings = require('settings');

class FavoriteEntityStore {
    constructor() {
        this.favoriteEntities = [];
        this.load();
    }

    load() {
        this.favoriteEntities = Settings.data('favorite_entities');
        if(!this.favoriteEntities) {
            this.favoriteEntities = [];
        }
    }

    save() {
        Settings.data('favorite_entities', this.favoriteEntities);
    }

    add(id) {
        if (!this.has(id)) {
            this.favoriteEntities.push(id);
        }

        this.save();
    }

    remove(id) {
        let index = this.favoriteEntities.indexOf(id); // get index if value found otherwise -1

        if (index > -1) { //if found
            this.favoriteEntities.splice(index, 1);
        }

        this.save();
    }

    has(id) {
        return this.favoriteEntities.indexOf(id) > -1;
    }

    all() {
        return this.favoriteEntities;
    }
}

module.exports = FavoriteEntityStore;