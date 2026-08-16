/**
 * FavoritesPage - Display favorite entities with colored icon frames
 */
var UI = require('ui');
var BasePage = require('app/pages/BasePage');
var MainMenuPage = require('app/pages/MainMenuPage');
var EntityService = require('app/EntityService');
var simply = require('ui/simply');
var RelativeTimeUpdater = require('app/RelativeTimeUpdater');
var helpers = require('app/helpers');

class FavoritesPage extends BasePage {
  constructor() {
    super();
    this._rows = [];
    this._elements = [];
    this._selectedIndex = 0;
    this._entityIndex = {};
    this._scrollOffset = 0;
    this._visibleCount = 4;
    this._titleHeight = 30;
  }

  show() {
    var favoriteEntities = this.appState.favoriteEntityStore.all();
    if (!favoriteEntities || !favoriteEntities.length) {
      var noFavoritesCard = new UI.Card({
        title: 'No Favorites',
        subtitle: 'Long-press an entity and select \'Add Favorite\'',
        status: false
      });
      noFavoritesCard.show();
      return;
    }

    var self = this;
    if (!this.menu) {
      this.menu = this.createMenu();
      this.setupEventHandlers();
    }
    this.onShow();
    this.menu.show();
    this.menu.buttonConfig({ back: true });
    this.menu.on('click', 'back', function() {
        self.menu.hide();
    });
  }

  createMenu() {
    var self = this;
    var win = new UI.Window({
      status: false,
      backgroundColor: 'black',
      scrollable: false
    });

    win.on('click', 'up', function() { self._moveSelection(-1); });
    win.on('click', 'down', function() { self._moveSelection(1); });
    win.on('click', 'select', function() { self._selectCurrent(); });
    win.on('longClick', 'select', function() { self._longSelectCurrent(); });

    return win;
  }

  onShow() {
    var win = this.menu;
    var toRemove = win._items ? win._items.slice() : [];
    for (var i = 0; i < toRemove.length; i++) {
      win.remove(toRemove[i]);
    }
    this._rows = [];
    this._elements = [];
    this._entityIndex = {};


    this.unsubscribe();
    if (this.relativeTimeUpdater) {
      this.relativeTimeUpdater.destroy();
    }

    var favoriteEntities = this.appState.favoriteEntityStore.all();
    var appState = this.appState;

    var self = this;
    this.relativeTimeUpdater = new RelativeTimeUpdater(function(entity_id, lastChanged) {
      var idx = self._entityIndex[entity_id];
      if (idx === undefined) {
        return;
      }
      var item = self._rows[idx];
      self._updateEntityRow(idx, {
        entity_id: entity_id,
        state: item.state,
        attributes: { friendly_name: item.friendlyName, unit_of_measurement: item.unit },
        last_changed: lastChanged
      });
    });

    this._selectedIndex = 0;
    if (this.appState.menuSelections &&
        typeof this.appState.menuSelections.favoritesMenu === 'number' &&
        this.appState.menuSelections.favoritesMenu < favoriteEntities.length) {
      this._selectedIndex = this.appState.menuSelections.favoritesMenu;
    }


    for (var i = 0; i < favoriteEntities.length; i++) {
      var entityId = favoriteEntities[i];
      var entity = appState.ha_state_dict[entityId];
      this._entityIndex[entityId] = i;
      var customName = this.appState.favoriteEntityStore.getCustomName(entityId);
      var titleText = customName || (entity && entity.attributes && entity.attributes.friendly_name
        ? entity.attributes.friendly_name
        : entityId);
      var friendlyName = titleText;
      var state = (entity && entity.state !== undefined) ? entity.state : '?';
      var unit = (entity && entity.attributes && entity.attributes.unit_of_measurement) ? entity.attributes.unit_of_measurement : '';
      var lastChanged = (entity && entity.last_changed) ? entity.last_changed : new Date().toISOString();
      var subtitle = state + (unit ? ' ' + unit : '') + ' > ' + helpers.humanDiff(new Date(), new Date(lastChanged));
      var item = {
        id: entityId,
        title: friendlyName,
        subtitle: subtitle,
        icon: EntityService.getIcon(entity),
        entity_id: entityId,
        friendlyName: friendlyName,
        customName: customName,
        state: state,
        unit: unit,
        lastChanged: lastChanged
      };
      this._addRow(win, item, i);
      this._rows.push(item);
    }

    if (simply.impl.state.launchReason === 'quickLaunch') {
      var mainMenuIndex = favoriteEntities.length;
      var mainMenuItem = {
        is_main_menu: true,
        title: 'Main Menu',
        subtitle: '',
        icon: 'images/icon_arrow_left.png',
        entity_id: null,
        id: '__main_menu__',
        friendlyName: 'Main Menu',
        state: '',
        unit: '',
        lastChanged: ''
      };
      this._entityIndex['__main_menu__'] = mainMenuIndex;
      this._addRow(win, mainMenuItem, mainMenuIndex);
      this._rows.push(mainMenuItem);
      this._selectedIndex = Math.min(this._selectedIndex, this._rows.length - 1);
    }

    var headerBg = new UI.Rect({
      position: new UI.Vector2(0, 0),
      size: new UI.Vector2(200, this._titleHeight),
      backgroundColor: 'vividCerulean'
    });
    win.add(headerBg);

    var headerIconBg = new UI.Rect({
      position: new UI.Vector2(0, 0),
      size: new UI.Vector2(29, this._titleHeight - 2),
      backgroundColor: 'white'
    });
    win.add(headerIconBg);

    var headerIcon = new UI.Image({
      image: 'images/logo_large.png',
      position: new UI.Vector2(4, 4),
      size: new UI.Vector2(20, 20),
      backgroundColor: 'clear',
      compositing: 'set'
    });
    win.add(headerIcon);

    var titleHeader = new UI.Text({
      text: 'Home Assistant',
      position: new UI.Vector2(32, -2),
      size: new UI.Vector2(116, this._titleHeight),
      color: 'black',
      font: 'gothic_24_bold',
      textAlign: 'left'
    });
    win.add(titleHeader);

    var time = new UI.TimeText({
      text: '%H:%M',
      position: new UI.Vector2(150, -2),
      size: new UI.Vector2(48, this._titleHeight),
      color: 'black',
      font: 'gothic_24_bold',
      textAlign: 'right'
    });
    win.add(time);




    this.subscribe(favoriteEntities, function(data) {
      var ev = data.event || {};

      if (ev.c) {
        for (var changedId in ev.c) {
          var patch = ev.c[changedId];
          var plus = patch['+'] || {};
          var cur = appState.ha_state_dict[changedId] || { entity_id: changedId, state: '', attributes: {} };

          var mergedAttrs = {};
          for (var k in cur.attributes) { mergedAttrs[k] = cur.attributes[k]; }
          if (plus.a) { for (var k in plus.a) { mergedAttrs[k] = plus.a[k]; } }

          var updatedEntity = {
            entity_id: changedId,
            state: plus.s !== undefined ? plus.s : cur.state,
            attributes: mergedAttrs,
            context: plus.c !== undefined ? plus.c : cur.context,
            last_changed: plus.lc !== undefined ? new Date(plus.lc * 1000).toISOString() : cur.last_changed
          };
          appState.setEntity(changedId, updatedEntity);

          var cIdx = self._entityIndex[changedId];
          if (cIdx !== undefined) {
            self._updateEntityRow(cIdx, updatedEntity);
            self.relativeTimeUpdater.update(changedId, updatedEntity.last_changed);
          }
        }
      }
    });

    for (var j = 0; j < this._rows.length; j++) {
      if (this._rows[j].entity_id) {
        this.relativeTimeUpdater.register(this._rows[j].entity_id, this._rows[j].lastChanged);
      }
    }

    this._scrollOffset = Math.max(0, this._selectedIndex - (this._visibleCount - 1)) * 44;
    this._applyScroll(this._scrollOffset);
    this._updateSelection();
  }

  _convertEntityData(entity_id, data) {
    return {
      entity_id: entity_id,
      state: data.s,
      attributes: data.a || {},
      context: data.c,
      last_changed: data.lc ? new Date(data.lc * 1000).toISOString() : new Date().toISOString()
    };
  }

  _addRow(win, item, index) {
    var y = this._titleHeight + (index * 44);
    var selected = (index === this._selectedIndex);
    var textColor = selected ? 'black' : 'white';
    var highlightColor = selected ? 'white' : 'black';

    var highlight = new UI.Rect({
      position: new UI.Vector2(0, y),
      size: new UI.Vector2(200, 44),
      backgroundColor: highlightColor
    });
    win.add(highlight);

    var color = item.is_main_menu ? 'black' : (this.appState.favoriteEntityStore.getColor(item.id) || 'blue');

    var border = new UI.Rect({
      position: new UI.Vector2(2, y + 5),
      size: new UI.Vector2(26, 34),
      backgroundColor: color
    });
    win.add(border);

    var icon = null;
    if (item.icon) {
      icon = new UI.Image({
        image: item.icon,
        position: new UI.Vector2(3, y + 10),
        size: new UI.Vector2(24, 24),
        backgroundColor: 'clear',
        compositing: 'set'
      });
      win.add(icon);
    }

    var title = new UI.Text({
      text: item.title || '',
      position: new UI.Vector2(32, item.is_main_menu ? y + 5 : (selected ? y - 4 : y + 4)),
      size: new UI.Vector2(168, 26),
      color: textColor,
      font: 'gothic_24_bold',
      textAlign: 'left',
      textOverflow: 'ellipsis'
    });
    win.add(title);

    var subtitle = new UI.Text({
      text: item.subtitle,
      position: new UI.Vector2(32, y + 20),
      size: new UI.Vector2(168, 18),
      color: textColor,
      font: 'gothic_18',
      textAlign: 'left',
      textOverflow: 'ellipsis'
    });
    win.add(subtitle);

    item.baseY = y;
    this._elements[index] = { highlight: highlight, border: border, icon: icon, title: title, subtitle: subtitle };
  }


  _updateEntityRow(index, entity) {
    var item = this._rows[index];
    if (!item || !entity) {
      return;
    }

    var customName = this.appState.favoriteEntityStore.getCustomName(entity.entity_id);
    var friendlyName = customName || (entity.attributes && entity.attributes.friendly_name
      ? entity.attributes.friendly_name
      : entity.entity_id);
    var state = entity.state !== undefined ? entity.state : item.state;
    var unit = (entity.attributes && entity.attributes.unit_of_measurement)
      ? entity.attributes.unit_of_measurement
      : item.unit;
    var lastChanged = entity.last_changed !== undefined
      ? entity.last_changed
      : item.lastChanged;

    item.friendlyName = friendlyName;
    item.customName = customName;
    item.state = state;
    item.unit = unit;
    item.lastChanged = lastChanged;
    item.title = friendlyName;
    item.subtitle = state + (unit ? ' ' + unit : '') + ' > ' + helpers.humanDiff(new Date(), new Date(lastChanged));

    this._elements[index].title.text(item.title);
    this._elements[index].subtitle.text(item.subtitle);

    var iconImage = EntityService.getIcon(entity);
    if (iconImage !== item.icon) {
      item.icon = iconImage;
      if (this._elements[index].icon) {
        if (iconImage) {
          this._elements[index].icon.image(iconImage);
        } else {
          this.menu.remove(this._elements[index].icon);
          this._elements[index].icon = null;
        }
      } else if (iconImage) {
        var icon = new UI.Image({
          image: iconImage,
          position: new UI.Vector2(3, item.baseY + 10 - this._scrollOffset),
          size: new UI.Vector2(24, 24),
          backgroundColor: 'clear',
          compositing: 'set'
        });
        this.menu.add(icon);
        this._elements[index].icon = icon;
      }
    }
  }

  _applyScroll(offset) {
    for (var i = 0; i < this._rows.length; i++) {
      var item = this._rows[i];
      var baseY = item.baseY;
      var el = this._elements[i];
      if (!el) { continue; }
      var selected = (i === this._selectedIndex);
      var titleY = item.is_main_menu
        ? baseY + 5 - offset
        : baseY + (selected ? -4 : 4) - offset;
      el.highlight.position(new UI.Vector2(0, baseY - offset));
      el.border.position(new UI.Vector2(2, baseY + 5 - offset));
      if (el.icon) { el.icon.position(new UI.Vector2(3, baseY + 10 - offset)); }
      el.title.position(new UI.Vector2(32, titleY));
      el.subtitle.position(new UI.Vector2(32, baseY + 20 - offset));
    }
  }

  _moveSelection(delta) {
    var next = this._selectedIndex + delta;
    if (next < 0) {
      next = this._rows.length - 1;
    } else if (next >= this._rows.length) {
      next = 0;
    }
    this._selectedIndex = next;
    this._scrollOffset = Math.max(0, this._selectedIndex - (this._visibleCount - 1)) * 44;
    this._applyScroll(this._scrollOffset);
    this._updateSelection();
    this.onSelection({ itemIndex: this._selectedIndex });
  }

  _updateSelection() {
    for (var i = 0; i < this._elements.length; i++) {
      var selected = (i === this._selectedIndex);
      var el = this._elements[i];
      el.highlight.backgroundColor(selected ? 'white' : 'black');
      el.title.color(selected ? 'black' : 'white');
      el.subtitle.color(selected ? 'black' : 'white');
      el.subtitle.text(selected ? this._rows[i].subtitle : '');
    }
  }

  _selectCurrent() {
    var item = this._rows[this._selectedIndex];
    this.menu.emit('select', {
      item: item,
      itemIndex: this._selectedIndex,
      sectionIndex: 0
    });
  }

  _longSelectCurrent() {
    var item = this._rows[this._selectedIndex];
    this.menu.emit('longSelect', {
      item: item,
      itemIndex: this._selectedIndex,
      sectionIndex: 0
    });
  }

  onSelection(e) {
    this.appState.menuSelections = this.appState.menuSelections || {};
    this.appState.menuSelections.favoritesMenu = e.itemIndex;
  }

  onSelect(e) {
    this.appState.menuSelections = this.appState.menuSelections || {};
    this.appState.menuSelections.favoritesMenu = e.itemIndex;
    if (e.item && e.item.is_main_menu) {
      MainMenuPage.showMainMenu();
      return;
    }
    var entityPressBehavior = this.appState.entity_press_behavior !== false;
    if (e.item && e.item.entity_id && entityPressBehavior) {
      EntityService.handleLongPress(e.item.entity_id);
    } else if (typeof e.item.on_click === 'function') {
      e.item.on_click(e);
    } else if (e.item && e.item.entity_id) {
      EntityService.show(e.item.entity_id);
    }
  }

  onLongSelect(e) {
    var entityPressBehavior = this.appState.entity_press_behavior !== false;
    if (e.item && e.item.entity_id && entityPressBehavior) {
      EntityService.show(e.item.entity_id);
    } else if (e.item && e.item.entity_id) {
      EntityService.handleLongPress(e.item.entity_id);
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

