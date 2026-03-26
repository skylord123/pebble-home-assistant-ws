#include "simply_entities.h"

#include "simply_msg.h"
#include "simply_menu.h"

#include "simply.h"

#include "util/memory.h"
#include "util/platform.h"
#include "util/string.h"

#include <pebble.h>

typedef struct EntitySyncPacket EntitySyncPacket;

struct __attribute__((__packed__)) EntitySyncPacket {
  Packet packet;
  uint16_t section;
  uint16_t index;
  uint32_t icon;
  uint16_t name_length;
  uint16_t state_length;
  uint16_t domain_length;
  char buffer[];
};

typedef Packet EntityClearPacket;

typedef struct EntityCountPacket EntityCountPacket;

struct __attribute__((__packed__)) EntityCountPacket {
  Packet packet;
  uint16_t count;
};

typedef struct EntityActionPacket EntityActionPacket;

struct __attribute__((__packed__)) EntityActionPacket {
  Packet packet;
  uint16_t section;
  uint16_t index;
  uint8_t action;
};

static SimplyEntities *s_entities = NULL;

static bool entity_filter(List1Node *node, void *data) {
  SimplyEntity *entity = (SimplyEntity *)node;
  uint32_t key = (uint32_t)(uintptr_t)data;
  uint16_t section = key & 0xFFFF;
  uint16_t index = key >> 16;
  return (entity->section == section && entity->index == index);
}

static SimplyEntity *find_entity(SimplyEntities *self, uint16_t section, uint16_t index) {
  uint32_t key = section | (index << 16);
  return (SimplyEntity *)list1_find(self->entities, entity_filter, (void *)(uintptr_t)key);
}

static void destroy_entity(SimplyEntities *self, SimplyEntity *entity) {
  if (!entity) { return; }
  list1_remove(&self->entities, &entity->node);
  free(entity);
}

static void clear_all(SimplyEntities *self) {
  while (self->entities) {
    destroy_entity(self, (SimplyEntity *)self->entities);
  }
  self->count = 0;
  self->active = false;
}

static void handle_entity_sync_packet(Simply *simply, Packet *data) {
  SimplyEntities *self = simply->entities;
  if (!self) { return; }

  EntitySyncPacket *packet = (EntitySyncPacket *)data;

  SimplyEntity *entity = find_entity(self, packet->section, packet->index);
  if (!entity) {
    if ((int)list1_size(self->entities) >= MAX_CACHED_ENTITIES) {
      destroy_entity(self, (SimplyEntity *)list1_last(self->entities));
    }
    entity = malloc0(sizeof(SimplyEntity));
    if (!entity) { return; }
    list1_prepend(&self->entities, &entity->node);
  } else {
    list1_remove(&self->entities, &entity->node);
    list1_prepend(&self->entities, &entity->node);
  }

  entity->section = packet->section;
  entity->index = packet->index;
  entity->icon_id = packet->icon;

  const char *cursor = packet->buffer;
  size_t name_len = packet->name_length;
  size_t state_len = packet->state_length;
  size_t domain_len = packet->domain_length;

  if (name_len >= ENTITY_NAME_MAX) { name_len = ENTITY_NAME_MAX - 1; }
  if (state_len >= ENTITY_STATE_MAX) { state_len = ENTITY_STATE_MAX - 1; }
  if (domain_len >= ENTITY_DOMAIN_MAX) { domain_len = ENTITY_DOMAIN_MAX - 1; }

  memset(entity->name, 0, ENTITY_NAME_MAX);
  memset(entity->state, 0, ENTITY_STATE_MAX);
  memset(entity->domain, 0, ENTITY_DOMAIN_MAX);

  strncpy(entity->name, cursor, name_len);
  cursor += packet->name_length;

  strncpy(entity->state, cursor, state_len);
  cursor += packet->state_length;

  strncpy(entity->domain, cursor, domain_len);

  self->active = true;
}

static void handle_entity_clear_packet(Simply *simply, Packet *data) {
  SimplyEntities *self = simply->entities;
  if (!self) { return; }
  clear_all(self);
}

static void handle_entity_count_packet(Simply *simply, Packet *data) {
  SimplyEntities *self = simply->entities;
  if (!self) { return; }
  EntityCountPacket *packet = (EntityCountPacket *)data;
  self->count = packet->count;
  self->active = true;
}

SimplyEntity *simply_entities_get(SimplyEntities *self, uint16_t section, uint16_t index) {
  if (!self || !self->active) { return NULL; }
  return find_entity(self, section, index);
}

bool simply_entities_is_active(SimplyEntities *self) {
  return self && self->active;
}

bool simply_entities_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandEntitySync:
      handle_entity_sync_packet(simply, packet);
      return true;
    case CommandEntityClear:
      handle_entity_clear_packet(simply, packet);
      return true;
    case CommandEntityCount:
      handle_entity_count_packet(simply, packet);
      return true;
  }
  return false;
}

SimplyEntities *simply_entities_create(Simply *simply) {
  if (s_entities) {
    return s_entities;
  }

  SimplyEntities *self = malloc0(sizeof(*self));
  if (!self) { return NULL; }

  self->simply = simply;
  s_entities = self;

  return self;
}

void simply_entities_destroy(SimplyEntities *self) {
  if (!self) { return; }

  clear_all(self);
  free(self);
  s_entities = NULL;
}
