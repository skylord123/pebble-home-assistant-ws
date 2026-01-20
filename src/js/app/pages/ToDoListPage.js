/**
 * ToDoListPage - To-Do lists display and management
 *
 * Features:
 * - showToDoLists() - List of all to-do lists
 * - showToDoList(entity_id) - Individual list view with items
 * - showToDoItemMenu(entity_id, item) - Item detail view
 * - Real-time subscription to item changes
 * - Voice dictation for adding/editing items
 * - Completion toggling
 */
var UI = require('ui');
var Vibe = require('ui/vibe');
var Voice = require('ui/voice');

var BasePage = require('app/pages/BasePage');
var AppState = require('app/AppState');
var helpers = require('app/helpers');

function showToDoLists() {
    var appState = AppState.getInstance();
    let toDoListsMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'To-Do Lists'
        }]
    });

    // Track subscription IDs for cleanup
    let subscriptionIds = {};

    // Function to get sorted todo lists
    function getSortedTodoLists() {
        let todoLists = [];
        for(let entity_id in appState.ha_state_dict) {
            if(entity_id.split('.')[0] !== "todo") {
                continue;
            }

            if(appState.ha_state_dict[entity_id].state === "unavailable" || appState.ha_state_dict[entity_id].state === "unknown") {
                continue;
            }

            if(!appState.ha_state_dict[entity_id].attributes || !appState.ha_state_dict[entity_id].attributes.friendly_name) {
                continue;
            }

            todoLists.push(appState.ha_state_dict[entity_id]);
        }

        // sort todoLists alphabetically by friendly_name
        todoLists.sort(function(a, b) {
            if (a.attributes.friendly_name < b.attributes.friendly_name) return -1;
            if (a.attributes.friendly_name > b.attributes.friendly_name) return 1;
            return 0;
        });

        return todoLists;
    }

    // Function to update menu items
    function updateMenuItems() {
        let todoLists = getSortedTodoLists();

        // Clear existing items
        toDoListsMenu.items(0, []);

        // Add menu items
        let items = [];
        todoLists.forEach(function(entity) {
            items.push({
                title: entity.attributes.friendly_name,
                subtitle: (entity.state || 0) + " item" + (entity.state > 1 ? 's' : ''),
                entity_id: entity.entity_id,
                on_click: function (e) {
                    showToDoList(e.item.entity_id);
                }
            });
        });

        toDoListsMenu.items(0, items);
    }

    toDoListsMenu.on('select', function(e) {
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        }
    });

    // Subscribe to all todo lists when menu is shown
    toDoListsMenu.on('show', function() {
        let todoLists = getSortedTodoLists();

        todoLists.forEach(function(entity) {
            let entity_id = entity.entity_id;

            subscriptionIds[entity_id] = appState.haws.subscribeTrigger({
                "type": "todo/item/subscribe",
                "entity_id": entity_id
            }, function(data) {
                // When items change, update the count in appState.ha_state_dict
                if (data.event && data.event.items) {
                    let itemCount = data.event.items.length;
                    if (appState.ha_state_dict[entity_id]) {
                        appState.ha_state_dict[entity_id].state = itemCount;
                    }
                    // Update the menu to reflect the new count
                    updateMenuItems();
                }
            }, function(error) {
                helpers.log_message(`todo/item/subscribe ERROR for ${entity_id}: ${JSON.stringify(error)}`);
            });
        });
    });

    // Unsubscribe when menu is hidden
    toDoListsMenu.on('hide', function() {
        for(let entity_id in subscriptionIds) {
            if (subscriptionIds[entity_id]) {
                appState.haws.unsubscribe(subscriptionIds[entity_id]);
            }
        }
        subscriptionIds = {};
    });

    // Initial menu population
    updateMenuItems();

    toDoListsMenu.show();
}

// show a specific todo list

function showToDoList(entity_id) {
    var appState = AppState.getInstance();
    let todoList = appState.ha_state_dict[entity_id];
    helpers.log_message(`showToDoList: ${entity_id}`);
    if(!todoList) {
        helpers.log_message(`showToDoList: ${entity_id} not found in appState.ha_state_dict`);
        throw new Error(`ToDo list ${entity_id} not found in appState.ha_state_dict`);
    }

    let todoListMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [
            {
                title: 'To Do'
            },
            {
                title: 'Completed'
            },
            {
                title: 'Actions'
            }
        ]
    });

    // Track the currently selected item by UID and section
    let selectedItemUid = null;
    let selectedSectionIndex = 0;
    let subscription_msg_id = null;
    let hasRenderedOnce = false;

    // Track the next item to select after toggling completion status
    let nextItemUidAfterToggle = null;

    /**
     * Helper function to determine the next item to select after toggling completion status
     * @param {Array} incompleteItems - Array of incomplete items
     * @param {Array} completedItems - Array of completed items
     * @param {string} currentUid - UID of the item being toggled
     * @param {number} currentSection - Section index of the item being toggled (0 or 1)
     * @param {string} currentStatus - Current status of the item ('needs_action' or 'completed')
     * @returns {string|null} - UID of the next item to select, or null if no suitable item
     */
    function getNextItemAfterToggle(incompleteItems, completedItems, currentUid, currentSection, currentStatus) {
        // Determine which section the item is currently in and where it will move to
        let isMarkingComplete = (currentStatus === 'needs_action'); // Will move from section 0 to section 1

        if (isMarkingComplete) {
            // Item is moving from incomplete (section 0) to completed (section 1)
            // Find the current item's index in the incomplete list
            let currentIndex = -1;
            for (let i = 0; i < incompleteItems.length; i++) {
                if (incompleteItems[i].uid === currentUid) {
                    currentIndex = i;
                    break;
                }
            }

            if (currentIndex === -1) {
                return null; // Item not found
            }

            // Try to select the next item in the incomplete section
            if (currentIndex + 1 < incompleteItems.length) {
                return incompleteItems[currentIndex + 1].uid;
            }

            // If there's no next incomplete item, try the item before the current one
            if (currentIndex > 0) {
                return incompleteItems[currentIndex - 1].uid;
            }

            // If no incomplete items remain, select the first completed item
            if (completedItems.length > 0) {
                return completedItems[0].uid;
            }

            // Otherwise, stay on the current item (it will be the only completed item)
            return currentUid;
        } else {
            // Item is moving from completed (section 1) to incomplete (section 0)
            // Find the current item's index in the completed list
            let currentIndex = -1;
            for (let i = 0; i < completedItems.length; i++) {
                if (completedItems[i].uid === currentUid) {
                    currentIndex = i;
                    break;
                }
            }

            if (currentIndex === -1) {
                return null; // Item not found
            }

            // Try to select the next item in the completed section
            if (currentIndex + 1 < completedItems.length) {
                return completedItems[currentIndex + 1].uid;
            }

            // If there's no next completed item, try the item before the current one
            if (currentIndex > 0) {
                return completedItems[currentIndex - 1].uid;
            }

            // If no completed items remain, select the first incomplete item
            if (incompleteItems.length > 0) {
                return incompleteItems[0].uid;
            }

            // Otherwise, stay on the current item (it will be the only incomplete item)
            return currentUid;
        }
    }

    // Function to update menu items based on subscription data
    function updateToDoListItems(items) {
        helpers.log_message(`updateToDoListItems: Updating ${items.length} items`);

        // Filter items into incomplete and completed
        let incompleteItems = [];
        let completedItems = [];

        items.forEach(function(item) {
            if (item.status === 'completed') {
                completedItems.push(item);
            } else {
                incompleteItems.push(item);
            }
        });

        // Clear existing items in all sections
        todoListMenu.items(0, []);
        todoListMenu.items(1, []);
        todoListMenu.items(2, []);

        // Add incomplete items to section 0
        incompleteItems.forEach(function(item, index) {
            let subtitle = '';

            // Priority: description > due date > empty
            if (item.description) {
                subtitle = item.description;
            } else if (item.due) {
                subtitle = `Due: ${item.due}`;
            }

            todoListMenu.item(0, index, {
                title: item.summary,
                subtitle: subtitle || '',
                uid: item.uid,
                status: item.status,
                description: item.description,
                due: item.due,
                on_click: function(e) {
                    helpers.log_message(`Todo item clicked: ${item.summary} (${item.uid})`);
                    // TODO: Show item details or actions menu
                    showToDoItemMenu(entity_id, item);
                }
            });
        });

        // Add completed items to section 1
        completedItems.forEach(function(item, index) {
            let subtitle = '';

            // Priority: description > due date > empty
            if (item.description) {
                subtitle = item.description;
            } else if (item.due) {
                subtitle = `Due: ${item.due}`;
            }

            todoListMenu.item(1, index, {
                title: item.summary,
                subtitle: subtitle || '',
                uid: item.uid,
                status: item.status,
                description: item.description,
                due: item.due,
                on_click: function(e) {
                    helpers.log_message(`Todo item clicked: ${item.summary} (${item.uid})`);
                    // TODO: Show item details or actions menu
                    showToDoItemMenu(entity_id, item);
                }
            });
        });

        // Add action items to section 2
        let actionIndex = 0;

        // Always show "Clear List" action
        todoListMenu.item(2, actionIndex++, {
            title: 'Clear List',
            on_click: function(e) {
                confirmAction(
                    'Clear all items from this list?',
                    function() {
                        // Success callback - clear all items in a single API call
                        helpers.log_message(`Clearing all items from ${entity_id}`);
                        let allItems = incompleteItems.concat(completedItems);
                        let allUids = allItems.map(function(item) { return item.uid; });

                        if (allUids.length > 0) {
                            appState.haws.callService(
                                'todo',
                                'remove_item',
                                { item: allUids },
                                { entity_id: entity_id },
                                function(data) {
                                    Vibe.vibrate('short');
                                    helpers.log_message(`Successfully cleared ${allUids.length} items from list`);
                                },
                                function(error) {
                                    Vibe.vibrate('double');
                                    helpers.log_message(`Error clearing list: ${JSON.stringify(error)}`);
                                }
                            );
                        } else {
                            helpers.log_message('No items to clear');
                        }
                    },
                    function() {
                        // Failure/cancel callback
                        helpers.log_message('Clear list cancelled');
                    }
                );
            }
        });

        // Only show "Clear Completed" if there are completed items
        if (completedItems.length > 0) {
            todoListMenu.item(2, actionIndex++, {
                title: 'Clear Completed',
                on_click: function(e) {
                    confirmAction(
                        'Clear all completed items?',
                        function() {
                            // Success callback - use the built-in service
                            helpers.log_message(`Clearing completed items from ${entity_id}`);
                            appState.haws.callService(
                                'todo',
                                'remove_completed_items',
                                {},
                                { entity_id: entity_id },
                                function(data) {
                                    Vibe.vibrate('short');
                                    helpers.log_message(`Cleared completed items successfully`);
                                },
                                function(error) {
                                    Vibe.vibrate('double');
                                    helpers.log_message(`Error clearing completed items: ${JSON.stringify(error)}`);
                                }
                            );
                        },
                        function() {
                            // Failure/cancel callback
                            helpers.log_message('Clear completed cancelled');
                        }
                    );
                }
            });
        }

        // Add "Add Item" action if microphone is available
        if (Feature.microphone(true, false)) {
            todoListMenu.item(2, actionIndex++, {
                title: 'Add Item',
                on_click: function(e) {
                    helpers.log_message('Starting voice dictation for new todo item');
                    Voice.dictate('start', true, function(voiceEvent) {
                        if (voiceEvent.err) {
                            if (voiceEvent.err === "systemAborted") {
                                helpers.log_message("Add item dictation cancelled by user");
                                return;
                            }
                            helpers.log_message(`Add item dictation error: ${voiceEvent.err}`);
                            return;
                        }

                        helpers.log_message(`Add item transcription received: ${voiceEvent.transcription}`);

                        // Add the new item to the todo list
                        appState.haws.callService(
                            'todo',
                            'add_item',
                            {
                                item: voiceEvent.transcription
                            },
                            { entity_id: entity_id },
                            function(data) {
                                Vibe.vibrate('short');
                                helpers.log_message(`Successfully added new item: ${JSON.stringify(data)}`);
                                // The subscription will automatically update the list with the new item
                            },
                            function(error) {
                                Vibe.vibrate('double');
                                helpers.log_message(`Error adding new item: ${JSON.stringify(error)}`);
                            }
                        );
                    });
                }
            });
        }

        // Restore selection after updating items
        let newSectionIndex = 0;
        let newItemIndex = 0;
        let foundSelection = false;

        // Determine which UID to select
        let targetUid = selectedItemUid;

        // If we have a next item to select after toggling, use that instead
        if (nextItemUidAfterToggle !== null) {
            targetUid = nextItemUidAfterToggle;
            selectedItemUid = nextItemUidAfterToggle;
            nextItemUidAfterToggle = null; // Clear the flag
            helpers.log_message(`Selecting next item after toggle: ${targetUid}`);
        }

        // If we had a previously selected item, try to find it by UID across all sections
        if (targetUid !== null && hasRenderedOnce) {
            // Search in incomplete items (section 0)
            for (let i = 0; i < incompleteItems.length; i++) {
                if (incompleteItems[i].uid === targetUid) {
                    newSectionIndex = 0;
                    newItemIndex = i;
                    foundSelection = true;
                    helpers.log_message(`Restored selection to section 0, index ${i} (UID: ${targetUid})`);
                    break;
                }
            }

            // If not found, search in completed items (section 1)
            if (!foundSelection) {
                for (let i = 0; i < completedItems.length; i++) {
                    if (completedItems[i].uid === targetUid) {
                        newSectionIndex = 1;
                        newItemIndex = i;
                        foundSelection = true;
                        helpers.log_message(`Restored selection to section 1, index ${i} (UID: ${targetUid})`);
                        break;
                    }
                }
            }

            // If we didn't find the previously selected item, it was deleted
            if (!foundSelection) {
                helpers.log_message(`Previously selected item (UID: ${targetUid}) no longer exists, selecting first item`);
                if (incompleteItems.length > 0) {
                    selectedItemUid = incompleteItems[0].uid;
                    newSectionIndex = 0;
                    newItemIndex = 0;
                } else if (completedItems.length > 0) {
                    selectedItemUid = completedItems[0].uid;
                    newSectionIndex = 1;
                    newItemIndex = 0;
                }
            }
        } else {
            // First time rendering, select the first item
            if (incompleteItems.length > 0) {
                selectedItemUid = incompleteItems[0].uid;
                newSectionIndex = 0;
                newItemIndex = 0;
            } else if (completedItems.length > 0) {
                selectedItemUid = completedItems[0].uid;
                newSectionIndex = 1;
                newItemIndex = 0;
            }
        }

        // Apply the selection
        if (incompleteItems.length > 0 || completedItems.length > 0) {
            todoListMenu.selection(newSectionIndex, newItemIndex);
        }

        hasRenderedOnce = true;
    }

    // Configuration: Set to true to use long-press for details and tap for toggle
    // Set to false to use tap for details and long-press for toggle
    let useLongPressForDetails = true;

    // Track selection changes (when user navigates with up/down buttons)
    todoListMenu.on('selection', function(e) {
        // Update the currently selected item UID and section when navigating
        if (e.item && e.item.uid) {
            selectedItemUid = e.item.uid;
            selectedSectionIndex = e.sectionIndex;
            helpers.log_message(`Selection changed to: ${e.item.title} (UID: ${selectedItemUid}, Section: ${e.sectionIndex})`);
        }
    });

    // Handle item selection
    todoListMenu.on('select', function(e) {
        // Update the currently selected item UID and section
        if (e.item && e.item.uid) {
            selectedItemUid = e.item.uid;
            selectedSectionIndex = e.sectionIndex;
            helpers.log_message(`Selected todo item: ${e.item.title} (UID: ${selectedItemUid}, Section: ${e.sectionIndex})`);
        }

        // For action items (section 2), always call on_click
        if (e.sectionIndex === 2) {
            if(typeof e.item.on_click == 'function') {
                e.item.on_click(e);
            }
            return;
        }

        // items with a uid are todo list items otherwise they are actions
        if (e.item && e.item.uid) {
            // Tap toggles completion status
            let newStatus = e.item.status === 'completed' ? 'needs_action' : 'completed';
            helpers.log_message(`Tap: Toggling item ${e.item.title} from ${e.item.status} to ${newStatus}`);

            // Get all items from the menu to calculate next selection
            let incompleteItems = [];
            let completedItems = [];

            // Extract items from section 0 (incomplete)
            let section0Items = todoListMenu.items(0);
            for (let i = 0; i < section0Items.length; i++) {
                incompleteItems.push(section0Items[i]);
            }

            // Extract items from section 1 (completed)
            let section1Items = todoListMenu.items(1);
            for (let i = 0; i < section1Items.length; i++) {
                completedItems.push(section1Items[i]);
            }

            // Calculate the next item to select after toggling
            nextItemUidAfterToggle = getNextItemAfterToggle(
                incompleteItems,
                completedItems,
                e.item.uid,
                e.sectionIndex,
                e.item.status
            );

            helpers.log_message(`Next item after toggle will be: ${nextItemUidAfterToggle}`);

            appState.haws.callService(
                'todo',
                'update_item',
                {
                    item: e.item.uid,
                    status: newStatus
                },
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
                    helpers.log_message(`Successfully updated item status: ${JSON.stringify(data)}`);
                },
                function(error) {
                    Vibe.vibrate('double');
                    helpers.log_message(`Error updating item status: ${JSON.stringify(error)}`);
                }
            );
        }
    });

    // Handle long-press
    todoListMenu.on('longSelect', function(e) {
        // Only handle long-press for actual todo items (sections 0 and 1), not actions
        if (e.sectionIndex === 2 || !e.item || !e.item.uid) {
            return;
        }

        // Long-press opens item details
        helpers.log_message(`Long-press: Opening details for item ${e.item.title}`);
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        }
    });

    // Unsubscribe when menu is hidden
    todoListMenu.on('hide', function() {
        if (subscription_msg_id) {
            helpers.log_message(`Unsubscribing from todo/item/subscribe for ${entity_id}`);
            appState.haws.unsubscribe(subscription_msg_id);
            subscription_msg_id = null;
        }
    });


    todoListMenu.on('show', function() {
        subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "todo/item/subscribe",
            "entity_id": entity_id
        }, function(data) {
            helpers.log_message(`todo/item/subscribe: ${JSON.stringify(data)}`);

            // Extract items from the event data
            if (data.event && data.event.items) {
                updateToDoListItems(data.event.items);
            }
        }, function(error) {
            helpers.log_message(`todo/item/subscribe ERROR: ${JSON.stringify(error)}`);
        });
    });

    todoListMenu.show();
}

// Helper function to show confirmation dialog
function confirmAction(message, successCallback, failureCallback) {
    helpers.log_message(`confirmAction: ${message}`);

    let confirmMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: message
        }]
    });

    // Add Confirm option
    confirmMenu.item(0, 0, {
        title: 'Confirm',
        on_click: function(e) {
            helpers.log_message('User confirmed action');
            confirmMenu.hide();
            if (typeof successCallback === 'function') {
                successCallback();
            }
        }
    });

    // Add Cancel option
    confirmMenu.item(0, 1, {
        title: 'Cancel',
        on_click: function(e) {
            helpers.log_message('User cancelled action');
            confirmMenu.hide();
            if (typeof failureCallback === 'function') {
                failureCallback();
            }
        }
    });

    // Handle selection
    confirmMenu.on('select', function(e) {
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        }
    });

    // Handle back button as cancel
    confirmMenu.on('hide', function() {
        helpers.log_message('Confirmation dialog closed');
    });

    confirmMenu.show();
}

// Show detailed view of a single todo item with editing capabilities

function showToDoItemMenu(entity_id, item) {
    var appState = AppState.getInstance();
    helpers.log_message(`showToDoItemMenu: ${item.summary} (${item.uid})`);

    let itemMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [
            {
                title: 'Item'
            },
            {
                title: 'Actions'
            }
        ]
    });

    let hasMicrophone = Feature.microphone(true, false);
    let subscription_msg_id = null;
    let currentItem = item; // Track the current item data

    // Function to update menu items based on subscription data
    function updateToDoItemMenu(items) {
        helpers.log_message(`updateToDoItemMenu: Searching for item ${currentItem.uid} in ${items.length} items`);

        // Find the current item by UID
        let updatedItem = null;
        for (let i = 0; i < items.length; i++) {
            if (items[i].uid === currentItem.uid) {
                updatedItem = items[i];
                break;
            }
        }

        // If item was deleted, close the menu
        if (!updatedItem) {
            helpers.log_message(`Item ${currentItem.uid} no longer exists, closing menu`);
            itemMenu.hide();
            return;
        }

        // Update current item reference
        currentItem = updatedItem;
        helpers.log_message(`Updating menu with latest item data: ${JSON.stringify(updatedItem)}`);

        // Update Section 0 - Item Fields
        let fieldIndex = 0;

        // 1. Update Name/Summary field
        itemMenu.item(0, fieldIndex++, {
            title: 'Name',
            subtitle: updatedItem.summary,
            on_click: hasMicrophone ? function(e) {
                helpers.log_message('Starting voice dictation for item name');
                Voice.dictate('start', true, function(voiceEvent) {
                    if (voiceEvent.err) {
                        if (voiceEvent.err === "systemAborted") {
                            helpers.log_message("Name dictation cancelled by user");
                            return;
                        }
                        helpers.log_message(`Name dictation error: ${voiceEvent.err}`);
                        return;
                    }

                    helpers.log_message(`Name transcription received: ${voiceEvent.transcription}`);

                    // Update the item name
                    appState.haws.callService(
                        'todo',
                        'update_item',
                        {
                            item: currentItem.uid,
                            rename: voiceEvent.transcription
                        },
                        { entity_id: entity_id },
                        function(data) {
                            Vibe.vibrate('short');
                            helpers.log_message(`Successfully updated item name: ${JSON.stringify(data)}`);
                        },
                        function(error) {
                            Vibe.vibrate('double');
                            helpers.log_message(`Error updating item name: ${JSON.stringify(error)}`);
                        }
                    );
                });
            } : undefined
        });

        // 2. Update Description field
        itemMenu.item(0, fieldIndex++, {
            title: 'Description',
            subtitle: updatedItem.description || '',
            on_click: hasMicrophone ? function(e) {
                // If description exists, show options menu
                if (currentItem.description) {
                    showToDoItemDescriptionOptionsMenu(entity_id, currentItem);
                } else {
                    // No description, go straight to voice dictation
                    startToDoItemDescriptionDictation(entity_id, currentItem);
                }
            } : undefined
        });

        // 3. Update Due Date field (read-only for now)
        itemMenu.item(0, fieldIndex++, {
            title: 'Due Date',
            subtitle: updatedItem.due || 'Not set'
        });

        // Update Section 1 - Actions
        // Clear actions section first
        itemMenu.items(1, []);
        let actionIndex = 0;

        // 1. Delete action (always present)
        itemMenu.item(1, actionIndex++, {
            title: 'Delete',
            on_click: function(e) {
                confirmAction(
                    'Delete this item?',
                    function() {
                        // Success callback - delete the item
                        helpers.log_message(`Deleting item: ${currentItem.summary} (${currentItem.uid})`);
                        appState.haws.callService(
                            'todo',
                            'remove_item',
                            { item: currentItem.uid },
                            { entity_id: entity_id },
                            function(data) {
                                Vibe.vibrate('short');
                                helpers.log_message(`Successfully deleted item: ${JSON.stringify(data)}`);
                                // Hide the menu to return to the todo list
                                itemMenu.hide();
                            },
                            function(error) {
                                Vibe.vibrate('double');
                                helpers.log_message(`Error deleting item: ${JSON.stringify(error)}`);
                            }
                        );
                    },
                    function() {
                        // Failure/cancel callback
                        helpers.log_message('Delete item cancelled');
                    }
                );
            }
        });

        // 2. Toggle completion status action (conditional based on current status)
        if (updatedItem.status !== 'completed') {
            itemMenu.item(1, actionIndex++, {
                title: 'Mark Completed',
                on_click: function(e) {
                    helpers.log_message(`Marking item as completed: ${currentItem.summary} (${currentItem.uid})`);
                    appState.haws.callService(
                        'todo',
                        'update_item',
                        {
                            item: currentItem.uid,
                            status: 'completed'
                        },
                        { entity_id: entity_id },
                        function(data) {
                            Vibe.vibrate('short');
                            helpers.log_message(`Successfully marked item as completed: ${JSON.stringify(data)}`);
                            // Menu remains open, subscription will update
                        },
                        function(error) {
                            Vibe.vibrate('double');
                            helpers.log_message(`Error marking item as completed: ${JSON.stringify(error)}`);
                        }
                    );
                }
            });
        } else {
            itemMenu.item(1, actionIndex++, {
                title: 'Mark Incomplete',
                on_click: function(e) {
                    helpers.log_message(`Marking item as incomplete: ${currentItem.summary} (${currentItem.uid})`);
                    appState.haws.callService(
                        'todo',
                        'update_item',
                        {
                            item: currentItem.uid,
                            status: 'needs_action'
                        },
                        { entity_id: entity_id },
                        function(data) {
                            Vibe.vibrate('short');
                            helpers.log_message(`Successfully marked item as incomplete: ${JSON.stringify(data)}`);
                            // Menu remains open, subscription will update
                        },
                        function(error) {
                            Vibe.vibrate('double');
                            helpers.log_message(`Error marking item as incomplete: ${JSON.stringify(error)}`);
                        }
                    );
                }
            });
        }
    }

    // Handle selection
    itemMenu.on('select', function(e) {
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        }
    });

    // Subscribe when menu is shown
    itemMenu.on('show', function() {
        helpers.log_message(`Subscribing to todo items for ${entity_id}`);
        subscription_msg_id = appState.haws.subscribeTrigger({
            "type": "todo/item/subscribe",
            "entity_id": entity_id
        }, function(data) {
            helpers.log_message(`todo/item/subscribe (item menu): ${JSON.stringify(data)}`);

            // Extract items from the event data
            if (data.event && data.event.items) {
                updateToDoItemMenu(data.event.items);
            }
        }, function(error) {
            helpers.log_message(`todo/item/subscribe ERROR (item menu): ${JSON.stringify(error)}`);
        });
    });

    // Unsubscribe when menu is hidden
    itemMenu.on('hide', function() {
        if (subscription_msg_id) {
            helpers.log_message(`Unsubscribing from todo/item/subscribe for ${entity_id} (item menu)`);
            appState.haws.unsubscribe(subscription_msg_id);
            subscription_msg_id = null;
        }
    });

    itemMenu.show();
}

// Helper function to show todo item description options menu
function showToDoItemDescriptionOptionsMenu(entity_id, item) {
    helpers.log_message('Showing todo item description options menu');

    let descOptionsMenu = new UI.Menu({
        status: false,
        backgroundColor: 'black',
        textColor: 'white',
        highlightBackgroundColor: 'white',
        highlightTextColor: 'black',
        sections: [{
            title: 'Description'
        }]
    });

    // Update Description option
    descOptionsMenu.item(0, 0, {
        title: 'Update Desc',
        on_click: function(e) {
            descOptionsMenu.hide();
            startToDoItemDescriptionDictation(entity_id, item);
        }
    });

    // Remove Description option
    descOptionsMenu.item(0, 1, {
        title: 'Remove Desc',
        on_click: function(e) {
            helpers.log_message(`Removing description from item: ${item.summary} (${item.uid})`);
            descOptionsMenu.hide();

            appState.haws.callService(
                'todo',
                'update_item',
                {
                    item: item.uid,
                    description: null
                },
                { entity_id: entity_id },
                function(data) {
                    Vibe.vibrate('short');
                    helpers.log_message(`Successfully removed description: ${JSON.stringify(data)}`);
                },
                function(error) {
                    Vibe.vibrate('double');
                    helpers.log_message(`Error removing description: ${JSON.stringify(error)}`);
                }
            );
        }
    });

    // Handle selection
    descOptionsMenu.on('select', function(e) {
        if(typeof e.item.on_click == 'function') {
            e.item.on_click(e);
        }
    });

    descOptionsMenu.show();
}

// Helper function to start todo item description dictation
function startToDoItemDescriptionDictation(entity_id, item) {
    helpers.log_message('Starting voice dictation for todo item description');

    Voice.dictate('start', true, function(voiceEvent) {
        if (voiceEvent.err) {
            if (voiceEvent.err === "systemAborted") {
                helpers.log_message("Description dictation cancelled by user");
                return;
            }
            helpers.log_message(`Description dictation error: ${voiceEvent.err}`);
            return;
        }

        helpers.log_message(`Description transcription received: ${voiceEvent.transcription}`);

        // Update the item description
        appState.haws.callService(
            'todo',
            'update_item',
            {
                item: item.uid,
                description: voiceEvent.transcription
            },
            { entity_id: entity_id },
            function(data) {
                helpers.log_message(`Successfully updated item description: ${JSON.stringify(data)}`);
            },
            function(error) {
                helpers.log_message(`Error updating item description: ${JSON.stringify(error)}`);
            }
        );
    });
}

let entityListMenu = null;

// Entity list functions - delegate to EntityListPage module
function showEntityList(title, entity_id_list, ignoreEntityCache, sortItems, skipIgnoredDomains) {
    EntityListPage.showEntityList(title, entity_id_list, ignoreEntityCache, sortItems, skipIgnoredDomains);
}


/**
 * Show to-do lists (convenience function)
 */
function showToDoListsPage() {
    showToDoLists();
}

module.exports.showToDoLists = showToDoLists;
module.exports.showToDoList = showToDoList;
module.exports.showToDoItemMenu = showToDoItemMenu;
module.exports.showToDoListsPage = showToDoListsPage;
