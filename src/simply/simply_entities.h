#pragma once

#include "simply_msg.h"
#include "simply.h"

#include "util/list1.h"
#include "util/platform.h"

#include <pebble.h>

#define MAX_CACHED_ENTITIES IF_APLITE_ELSE(6, 51)
#define ENTITY_NAME_MAX 32
#define ENTITY_STATE_MAX 16
#define ENTITY_DOMAIN_MAX 16

typedef struct SimplyEntity SimplyEntity;

struct SimplyEntity {
  List1Node node;
  uint16_t section;
  uint16_t index;
  uint32_t icon_id;
  char name[ENTITY_NAME_MAX];
  char state[ENTITY_STATE_MAX];
  char domain[ENTITY_DOMAIN_MAX];
};

typedef struct SimplyEntities SimplyEntities;

struct SimplyEntities {
  Simply *simply;
  List1Node *entities;
  uint16_t count;
  bool active;
};

SimplyEntities *simply_entities_create(Simply *simply);
void simply_entities_destroy(SimplyEntities *self);

bool simply_entities_handle_packet(Simply *simply, Packet *packet);

SimplyEntity *simply_entities_get(SimplyEntities *self, uint16_t section, uint16_t index);
bool simply_entities_is_active(SimplyEntities *self);
