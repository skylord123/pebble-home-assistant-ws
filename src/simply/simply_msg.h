#pragma once

#include "simply_msg_commands.h"

#include "simply.h"

#include "util/list1.h"

#include <pebble.h>

typedef struct SimplyMsg SimplyMsg;

struct SimplyMsg {
  Simply *simply;
  List1Node *send_queue;
  List1Node *receive_queue;
  uint32_t send_delay_ms;
  AppTimer *send_timer;
  uint8_t *send_buffer;
  size_t send_length;
};

typedef struct SimplyPacket SimplyPacket;

struct SimplyPacket {
  List1Node node;
  uint16_t length;
  void *buffer;
};

typedef struct Packet Packet;

struct __attribute__((__packed__)) Packet {
  uint16_t type;
  uint16_t length;
};

typedef void (*PacketHandler)(Simply *simply, Packet *packet);

SimplyMsg *simply_msg_create(Simply *simply);
void simply_msg_destroy(SimplyMsg *self);
bool simply_msg_has_communicated();
void simply_msg_show_disconnected(SimplyMsg *self);

bool simply_msg_send(uint8_t *buffer, size_t length);
bool simply_msg_send_packet(Packet *packet);
